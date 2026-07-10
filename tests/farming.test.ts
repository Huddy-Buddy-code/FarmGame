import { describe, it, expect, beforeAll } from "vitest";
import { setProjection } from "../src/geo/coords";
import { newGame } from "../src/state/saveState";
import type { Field } from "../src/state/saveState";
import {
  plant, plow, tickFarming, growthProgress, yieldRange, startHarvest, deriveStatus,
} from "../src/sim/farming";
import { sellGrain } from "../src/sim/economy";
import { dateOf, formatDate, nextMonthStart, MINUTES_PER_DAY, MINUTES_PER_MONTH } from "../src/sim/calendar";
import { gameConfig } from "../src/config/gameConfig";
import type { Meters } from "../src/geo/coords";

beforeAll(() => setProjection(15, "N"));

// A 100-acre-ish square field: 636 m sides ≈ 404,686 m² ≈ 100 ac.
const side = Math.sqrt(100 * 4046.8564224);
const boundary: Meters[] = [[0, 0], [side, 0], [side, side], [0, side]];

/** Most tests want ready-to-plant ground; the plow test asks for raw stubble. */
function freshField(status: Field["status"] = "tilled"): Field {
  return { id: "field-1", parcelId: "parcel-1", boundary, status };
}

/** Campaign starts Mar 1 Yr 1; sim-time of April 1 Yr 1 (one month in). */
const APRIL_1 = MINUTES_PER_MONTH;

describe("calendar", () => {
  it("starts on March 1, Year 1", () => {
    expect(formatDate(0)).toBe("Mar 1, Year 1");
  });

  it("rolls months and years on 30-day months", () => {
    expect(dateOf(MINUTES_PER_MONTH).month).toBe(3); // April
    expect(dateOf(10 * MINUTES_PER_MONTH)).toMatchObject({ year: 2, month: 0 }); // Jan Yr 2
  });

  it("nextMonthStart lands on the 1st, strictly in the future", () => {
    const t = 5 * MINUTES_PER_DAY; // Mar 6
    const april = nextMonthStart(t, 3);
    expect(dateOf(april)).toMatchObject({ month: 3, day: 1, year: 1 });
    // Asking for the CURRENT month gives next year's.
    const march = nextMonthStart(t, 2);
    expect(dateOf(march)).toMatchObject({ month: 2, day: 1, year: 2 });
  });
});

describe("plow → plant → grow → harvest (brief §10, §12.3, §6)", () => {
  it("plowing pays the working cost and tills the field; planting requires it", () => {
    const save = newGame();
    const field = freshField("stubble");
    save.fields.push(field);
    // Can't plant unplowed ground.
    expect(() => plant(save, field, "corn", APRIL_1, () => 0.5)).toThrow(/[Pp]low/);
    const cash = save.money;
    plow(save, field);
    expect(field.status).toBe("tilled");
    expect(cash - save.money).toBe(Math.round(100 * gameConfig.plowCostPerAcre));
    // Can't plow twice.
    expect(() => plow(save, field)).toThrow(/status/);
  });

  it("planting pays inputs and rolls a true yield inside the uncertainty band", () => {
    const save = newGame();
    const field = freshField("stubble");
    save.fields.push(field);
    plow(save, field);
    const cash = save.money;
    plant(save, field, "corn", APRIL_1, () => 0.5);
    expect(save.money).toBeLessThan(cash);
    expect(field.status).toBe("planted");
    const cfg = gameConfig.crops.corn;
    const t = field.trueYieldTonsPerAcre!;
    expect(t).toBeGreaterThanOrEqual(cfg.baseYieldTonsPerAcre * (1 - cfg.yieldUncertainty));
    expect(t).toBeLessThanOrEqual(cfg.baseYieldTonsPerAcre * (1 + cfg.yieldUncertainty));
  });

  it("rejects planting outside the window", () => {
    const save = newGame();
    const field = freshField();
    save.fields.push(field);
    expect(() => plant(save, field, "soybeans", 0, () => 0.5)).toThrow(/month/); // March: soy is May–Jun
  });

  it("visible yield range narrows over the season and always contains the truth", () => {
    const save = newGame();
    const field = freshField();
    save.fields.push(field);
    plant(save, field, "corn", APRIL_1, () => 0.9); // high roll, off-center
    const truth = field.trueYieldTonsPerAcre!;
    const growMin = gameConfig.crops.corn.growDays * MINUTES_PER_DAY;
    let prevWidth = Infinity;
    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
      const r = yieldRange(field, APRIL_1 + p * growMin)!;
      expect(r.low).toBeLessThanOrEqual(truth);
      expect(r.high).toBeGreaterThanOrEqual(truth);
      const width = r.high - r.low;
      expect(width).toBeLessThanOrEqual(prevWidth + 1e-9);
      prevWidth = width;
    }
    // By ready, the band is much tighter than at planting.
    const atPlant = yieldRange(field, APRIL_1)!;
    expect(prevWidth).toBeLessThan((atPlant.high - atPlant.low) * 0.3);
  });

  it("grows to ready, harvests over days, and banks grain = acres × true yield", () => {
    const save = newGame();
    const field = freshField();
    save.fields.push(field);
    plant(save, field, "corn", APRIL_1, () => 0.5);

    const ready = APRIL_1 + gameConfig.crops.corn.growDays * MINUTES_PER_DAY;
    expect(growthProgress(field, ready)).toBe(1);
    expect(deriveStatus(field, ready)).toBe("ready");

    const truth = field.trueYieldTonsPerAcre!;
    startHarvest(field, ready);
    // 100 ac at 100 ac/day = 1 day of harvesting; tick in 6 chunks.
    let now = ready;
    for (let i = 0; i < 6; i++) {
      const dt = MINUTES_PER_DAY / 4;
      now += dt;
      tickFarming(save, now, dt);
    }
    expect(field.status).toBe("harvested");
    expect(field.crop).toBeUndefined();
    expect(save.grain.corn).toBeCloseTo(100 * truth, 0);
  });

  it("sells grain from the bin at the flat price, clamped to what's stored", () => {
    const save = newGame();
    save.grain.corn = 50;
    const cash = save.money;
    const r = sellGrain(save, "corn", Infinity);
    expect(r.tons).toBe(50);
    expect(r.revenue).toBe(Math.round(50 * gameConfig.crops.corn.sellPricePerTon));
    expect(save.money).toBe(cash + r.revenue);
    expect(save.grain.corn).toBe(0);
    // Selling from an empty bin is a no-op.
    expect(sellGrain(save, "corn", 10)).toEqual({ tons: 0, revenue: 0 });
  });

  it("refuses to harvest an unready field", () => {
    const save = newGame();
    const field = freshField();
    save.fields.push(field);
    plant(save, field, "corn", APRIL_1, () => 0.5);
    expect(() => startHarvest(field, APRIL_1 + MINUTES_PER_DAY)).toThrow(/ready/);
  });
});
