import { describe, it, expect, beforeAll } from "vitest";
import { setProjection } from "../src/geo/coords";
import { newGame } from "../src/state/saveState";
import type { Field, SaveState } from "../src/state/saveState";
import {
  tickFarming, growthProgress, yieldRange, deriveStatus, applyPlant,
} from "../src/sim/farming";
import {
  ensureAgents, enqueueTask, cancelTask, tickTasks, autoManageAll,
  effectiveStatus, isFieldHarvesting, taskCost,
} from "../src/sim/tasks";
import { sellGrain } from "../src/sim/economy";
import {
  dateOf, formatDate, nextMonthStart, MINUTES_PER_DAY, minutesPerMonth,
  getDaysPerMonth, setDaysPerMonth,
} from "../src/sim/calendar";
import { gameConfig } from "../src/config/gameConfig";
import type { Meters } from "../src/geo/coords";

beforeAll(() => setProjection(15, "N"));

// A 100-acre-ish square field: 636 m sides ≈ 404,686 m² ≈ 100 ac.
const side = Math.sqrt(100 * 4046.8564224);
const boundary: Meters[] = [[0, 0], [side, 0], [side, side], [0, side]];

/** Most tests want ready-to-plant ground; the plow tests ask for raw stubble. */
function freshField(status: Field["status"] = "tilled"): Field {
  return { id: "field-1", parcelId: "parcel-1", boundary, status };
}

/** A game with the starting fleet parked at the origin (next to the field). */
function gameWithAgents(): SaveState {
  const save = newGame();
  ensureAgents(save, [0, 0]);
  return save;
}

/** Run the world forward `minutes` from `from` in `step`-minute ticks (growth +
 * auto-manage + agents), the same order main.ts ticks in. Returns the end time. */
function runWorld(save: SaveState, from: number, minutes: number, step = 60): number {
  let now = from;
  const end = from + minutes;
  while (now < end) {
    const dt = Math.min(step, end - now);
    now += dt;
    tickFarming(save, now);
    autoManageAll(save, now);
    tickTasks(save, now, dt, () => 0.5);
  }
  return now;
}

/** Campaign starts Mar 1 Yr 1; sim-time of April 1 Yr 1 (one month in). */
const APRIL_1 = minutesPerMonth();

describe("calendar", () => {
  it("starts on March 1, Year 1", () => {
    expect(formatDate(0)).toBe("Mar 1, Year 1");
  });

  it("rolls months and years on 30-day months", () => {
    expect(dateOf(minutesPerMonth()).month).toBe(3); // April
    expect(dateOf(10 * minutesPerMonth())).toMatchObject({ year: 2, month: 0 }); // Jan Yr 2
  });

  it("nextMonthStart lands on the 1st, strictly in the future", () => {
    const t = 5 * MINUTES_PER_DAY; // Mar 6
    const april = nextMonthStart(t, 3);
    expect(dateOf(april)).toMatchObject({ month: 3, day: 1, year: 1 });
    // Asking for the CURRENT month gives next year's.
    const march = nextMonthStart(t, 2);
    expect(dateOf(march)).toMatchObject({ month: 2, day: 1, year: 2 });
  });

  it("days-per-month is adjustable and reshapes month length live", () => {
    expect(getDaysPerMonth()).toBe(30);
    setDaysPerMonth(5);
    try {
      expect(minutesPerMonth()).toBe(5 * MINUTES_PER_DAY);
      // Same absolute sim-time, shorter month -> lands further into the calendar.
      expect(dateOf(minutesPerMonth())).toMatchObject({ month: 3, day: 1 }); // April 1
      expect(dateOf(2 * MINUTES_PER_DAY)).toMatchObject({ month: 2, day: 3 }); // Mar 3
      expect(() => setDaysPerMonth(0)).toThrow(/>= 1/);
    } finally {
      setDaysPerMonth(30); // don't leak state into other tests
    }
  });
});

describe("task queue + agents (brief §9, §10): plow → plant → grow → harvest", () => {
  it("queueing a plow pays on queue; canceling a queued task refunds in full", () => {
    const save = gameWithAgents();
    const field = freshField("stubble");
    save.fields.push(field);
    const cash = save.money;
    const cost = taskCost(field, "plow");
    const task = enqueueTask(save, field, "plow", 0);
    expect(cash - save.money).toBe(cost);
    expect(cost).toBe(Math.round(100 * gameConfig.plowCostPerAcre));
    // Can't queue plowing twice.
    expect(() => enqueueTask(save, field, "plow", 0)).toThrow(/already/);
    cancelTask(save, task.id);
    expect(save.money).toBe(cash);
    expect(save.tasks).toHaveLength(0);
  });

  it("refuses to queue what the (effective) field state doesn't allow", () => {
    const save = gameWithAgents();
    const field = freshField("stubble");
    save.fields.push(field);
    // Can't plant unplowed ground, can't harvest bare ground.
    expect(() => enqueueTask(save, field, "plant", APRIL_1, "corn")).toThrow(/[Pp]low/);
    expect(() => enqueueTask(save, field, "harvest", APRIL_1)).toThrow(/ready/);
    // But with a plow QUEUED, planting can chain behind it.
    enqueueTask(save, field, "plow", APRIL_1);
    expect(effectiveStatus(save, field)).toBe("tilled");
    expect(() => enqueueTask(save, field, "plant", APRIL_1, "corn")).not.toThrow();
  });

  it("rejects planting outside the window and unaffordable work", () => {
    const save = gameWithAgents();
    const field = freshField();
    save.fields.push(field);
    expect(() => enqueueTask(save, field, "plant", 0, "soybeans")).toThrow(/month/); // March: soy is May–Jun
    save.money = 0;
    expect(() => enqueueTask(save, field, "plant", APRIL_1, "corn")).toThrow(/cash/);
  });

  it("the tractor drives out and plows at the configured rate (realistic hours)", () => {
    const save = gameWithAgents();
    const field = freshField("stubble");
    save.fields.push(field);
    enqueueTask(save, field, "plow", 0);

    // 100 ac at plowAcresPerHour → this many minutes of work (plus a short drive).
    const workMin = (100 / gameConfig.work.plowAcresPerHour) * 60;
    runWorld(save, 0, workMin * 0.5, 30);
    expect(field.status).toBe("stubble"); // halfway: still working, not magically done
    expect(save.agents.find((a) => a.kind === "tractor")!.state).toBe("working");
    runWorld(save, workMin * 0.5, workMin * 0.6, 30);
    expect(field.status).toBe("tilled");
    expect(save.tasks).toHaveLength(0);
  });

  it("a queued plant waits for the plow, then the tractor does both in order", () => {
    const save = gameWithAgents();
    const field = freshField("stubble");
    save.fields.push(field);
    enqueueTask(save, field, "plow", APRIL_1);
    enqueueTask(save, field, "plant", APRIL_1, "corn");

    const plowMin = (100 / gameConfig.work.plowAcresPerHour) * 60;
    const plantMin = (100 / gameConfig.work.seedAcresPerHour) * 60;
    runWorld(save, APRIL_1, (plowMin + plantMin) * 1.1, 30);
    expect(field.status).toBe("planted");
    expect(field.crop).toBe("corn");
    const cfg = gameConfig.crops.corn;
    const t = field.trueYieldTonsPerAcre!;
    expect(t).toBeGreaterThanOrEqual(cfg.baseYieldTonsPerAcre * (1 - cfg.yieldUncertainty));
    expect(t).toBeLessThanOrEqual(cfg.baseYieldTonsPerAcre * (1 + cfg.yieldUncertainty));
  });

  it("the combine harvests a ready field over sim-hours and banks acres × true yield", () => {
    const save = gameWithAgents();
    const field = freshField();
    save.fields.push(field);
    applyPlant(field, "corn", APRIL_1, () => 0.5);
    const truth = field.trueYieldTonsPerAcre!;

    const ready = APRIL_1 + gameConfig.crops.corn.growMonths * minutesPerMonth();
    expect(growthProgress(field, ready)).toBe(1);
    expect(deriveStatus(field, ready)).toBe("ready");
    tickFarming(save, ready);
    enqueueTask(save, field, "harvest", ready);

    const harvestMin = (100 / gameConfig.work.harvestAcresPerHour) * 60;
    runWorld(save, ready, harvestMin * 0.5, 30);
    expect(isFieldHarvesting(save, field.id)).toBe(true);
    expect(save.grain.corn).toBeGreaterThan(0);
    expect(save.grain.corn).toBeLessThan(100 * truth);
    runWorld(save, ready + harvestMin * 0.5, harvestMin * 0.6, 30);
    expect(field.status).toBe("harvested");
    expect(field.crop).toBeUndefined();
    expect(save.grain.corn).toBeCloseTo(100 * truth, 0);
  });

  it("visible yield range narrows over the season and always contains the truth", () => {
    const field = freshField();
    applyPlant(field, "corn", APRIL_1, () => 0.9); // high roll, off-center
    const truth = field.trueYieldTonsPerAcre!;
    const growMin = gameConfig.crops.corn.growMonths * minutesPerMonth();
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

  it("growth is keyed to MONTHS: a crop ripens in the same season at any pace", () => {
    const grow = gameConfig.crops.corn.growMonths;
    const readyMonths = new Set<number>();
    for (const dpm of [30, 10, 5]) {
      setDaysPerMonth(dpm);
      try {
        const field = freshField();
        const plantedAt = minutesPerMonth(); // April 1 at this pace
        applyPlant(field, "corn", plantedAt, () => 0.5);
        const ready = plantedAt + grow * minutesPerMonth();
        expect(growthProgress(field, ready)).toBeCloseTo(1, 6);
        expect(growthProgress(field, plantedAt + 0.5 * grow * minutesPerMonth())).toBeCloseTo(0.5, 6);
        readyMonths.add(dateOf(ready).month);
      } finally {
        setDaysPerMonth(30);
      }
    }
    expect(readyMonths.size).toBe(1); // same calendar month whatever the pace
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
});

describe("auto-manage (idle mode, player-requested)", () => {
  it("queues plow, plant, and harvest itself with no manual calls, then loops", () => {
    const save = gameWithAgents();
    const field = freshField("stubble");
    field.autoManage = true;
    save.fields.push(field);

    // March: plowing queues immediately (no season restriction) and completes.
    runWorld(save, 0, 2 * MINUTES_PER_DAY, 60);
    expect(field.status).toBe("tilled");

    // Rest of March (stop a day short of April): still tilled — corn's window
    // (Apr–May) hasn't opened yet.
    runWorld(save, 2 * MINUTES_PER_DAY, APRIL_1 - 3 * MINUTES_PER_DAY, MINUTES_PER_DAY);
    expect(field.status).toBe("tilled");

    // April: window opens — auto-manage queues the plant and the tractor sows it.
    runWorld(save, APRIL_1 - MINUTES_PER_DAY, 3 * MINUTES_PER_DAY, 60);
    expect(field.status).toBe("planted");
    expect(field.crop).toBe("corn");

    // Grow to ready, then the combine auto-harvests and the loop re-plows.
    const ready = APRIL_1 + 2 * MINUTES_PER_DAY + gameConfig.crops.corn.growMonths * minutesPerMonth();
    runWorld(save, ready, 3 * MINUTES_PER_DAY, 60);
    expect(save.grain.corn).toBeGreaterThan(0);
    expect(field.status).toBe("tilled"); // already re-plowed for next season
  });

  it("silently waits (doesn't throw) when a step isn't affordable or in season", () => {
    const save = gameWithAgents();
    save.money = 0; // can't afford plowing
    const field = freshField("stubble");
    field.autoManage = true;
    save.fields.push(field);
    expect(() => runWorld(save, 0, 60, 60)).not.toThrow();
    expect(field.status).toBe("stubble"); // still waiting, no crash
    expect(save.tasks).toHaveLength(0);
  });
});
