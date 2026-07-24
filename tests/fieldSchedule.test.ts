import { describe, it, expect, beforeAll } from "vitest";
import { setProjection } from "../src/geo/coords";
import type { Meters } from "../src/geo/coords";
import type { Field, FieldPlan } from "../src/state/saveState";
import {
  legalMonthsFor, effectiveMonthFor, setScheduleOverride,
} from "../src/sim/schedule";
import { inWeedingWindow, canFertilizeNow, deriveStatus, inPlowWindow, inPlantingWindow } from "../src/sim/farming";
import { minutesPerMonth, setDaysPerMonth, MONTHS_PER_YEAR, START_MONTH } from "../src/sim/calendar";
import { gameConfig } from "../src/config/gameConfig";

beforeAll(() => setProjection(15, "N"));
setDaysPerMonth(30);

const side = Math.sqrt(100 * 4046.8564224);
const boundary: Meters[] = [[0, 0], [side, 0], [side, side], [0, side]];

function freshField(status: Field["status"] = "tilled"): Field {
  return { id: "field-1", parcelId: "parcel-1", boundary, status };
}

describe("legalMonthsFor", () => {
  it("plow: the fixed winter window for annual crops, empty for perennials", () => {
    expect(legalMonthsFor("plow", "corn")).toEqual(gameConfig.plowMonths);
    expect(legalMonthsFor("plow", "soybeans")).toEqual(gameConfig.plowMonths);
    expect(legalMonthsFor("plow", "grass")).toEqual([]);
    expect(legalMonthsFor("plow", "alfalfa")).toEqual([]);
  });

  it("plant: each crop's real plantMonths, verbatim", () => {
    for (const crop of Object.keys(gameConfig.crops) as (keyof typeof gameConfig.crops)[]) {
      expect(legalMonthsFor("plant", crop)).toEqual(gameConfig.crops[crop].plantMonths);
    }
  });

  it("weed/fertilize: empty for perennials or when no plant month is given", () => {
    expect(legalMonthsFor("weed", "grass", 2)).toEqual([]);
    expect(legalMonthsFor("fertilize", "alfalfa", 2)).toEqual([]); // perennial fertilize is fixed, not in schedule.ts
    expect(legalMonthsFor("weed", "corn")).toEqual([]); // no plantMonth
    expect(legalMonthsFor("fertilize", "corn")).toEqual([]);
  });

  it("weed/fertilize: derived from the chosen plant month, matching the real farming.ts gates", () => {
    // Corn: plantMonths [3,4], growMonths 4.
    expect(legalMonthsFor("weed", "corn", 3)).toEqual([5, 6]); // plantMonth+2 .. plantMonth+growMonths-1
    expect(legalMonthsFor("fertilize", "corn", 3)).toEqual([4, 5, 6]); // plantMonth+1 .. plantMonth+growMonths-1
  });

  it("harvest: delay-only, bounded by the crop's harvest WINDOW", () => {
    // Corn planted month 3 (Apr), growMonths 4 -> ready month 7 (Aug). The
    // window is harvestWindowMonths (2) long, so Aug and Sep — past that the
    // crop withers, so no later month may be offered (2026-07-23).
    expect(legalMonthsFor("harvest", "corn", 3)).toEqual([7, 8]);
    // Wraps past December rather than clamping there (the old December clamp
    // is what left Winter Wheat's Harvest row blank).
    expect(legalMonthsFor("harvest", "corn", 10)).toEqual([2, 3]);
  });

  it("the harvest window never offers a month the crop would already have died in", () => {
    // The Schedule tab must not hand the player a way to destroy their own
    // crop: every legal month has to fall inside the window that
    // harvestWindowClosed() enforces in the sim.
    for (const crop of ["corn", "soybeans", "wheat", "potatoes", "sunflowers"] as const) {
      const pm = gameConfig.crops[crop].plantMonths[0]!;
      expect(legalMonthsFor("harvest", crop, pm)).toHaveLength(gameConfig.harvestWindowMonths);
    }
  });

  it("Winter Wheat's harvest/mulch rows are populated (regression: the blank-row bug)", () => {
    // Wheat plants month 8 (Sep) and grows 9 months -> ready month 17 = Jun.
    // Under the old December clamp both of these came back empty, so the
    // Schedule tab drew Harvest, Mulch and Rake/Bale as blank rows.
    const harvest = legalMonthsFor("harvest", "wheat", 8);
    expect(harvest[0]).toBe(5); // June
    expect(harvest.length).toBeGreaterThan(0);
    const mulch = legalMonthsFor("mulch", "wheat", 8);
    expect(mulch[0]).toBe(6); // July, the month after harvest
    expect(mulch.length).toBeGreaterThan(0);
  });

  it("cross-checks weed/fertilize legal months against the real farming.ts gates", () => {
    for (const plantMonth of [3, 4]) {
      const plantedAt = plantMonth * minutesPerMonth();
      const legalWeed = legalMonthsFor("weed", "corn", plantMonth);
      const legalFert = legalMonthsFor("fertilize", "corn", plantMonth);
      for (let m = 0; m < MONTHS_PER_YEAR; m++) {
        // Same-year comparison only (this crop's cycle never wraps a year).
        const now = m * minutesPerMonth();
        if (now < plantedAt) continue; // before planting, not a meaningful comparison
        const field = freshField("planted");
        field.crop = "corn";
        field.plantedAt = plantedAt;
        field.status = deriveStatus(field, now);
        expect(legalWeed.includes(m)).toBe(inWeedingWindow(field, now));
        expect(legalFert.includes(m)).toBe(canFertilizeNow(field, now));
      }
    }
  });
});

describe("effectiveMonthFor", () => {
  it("falls back to the earliest legal month with no override (today's behavior)", () => {
    expect(effectiveMonthFor("plant", "corn", undefined)).toBe(3);
    expect(effectiveMonthFor("plow", "corn", undefined)).toBe(gameConfig.plowMonths[0]);
  });

  it("honors a valid override", () => {
    expect(effectiveMonthFor("plant", "corn", 4)).toBe(4);
  });

  it("falls back to earliest legal again if the stored override is no longer legal", () => {
    // e.g. the plan's crop changed to soybeans (plantMonths [4,5]) after an
    // override of month 3 (corn's window) was set — 3 isn't legal for soy.
    expect(effectiveMonthFor("plant", "soybeans", 3)).toBe(4);
  });

  it("returns undefined when there's no legal month at all (e.g. plow on a perennial plan)", () => {
    expect(effectiveMonthFor("plow", "grass", undefined)).toBeUndefined();
  });
});

describe("setScheduleOverride", () => {
  it("throws on an illegal month", () => {
    const plan: FieldPlan = { crop: "corn" };
    expect(() => setScheduleOverride(plan, "plant", 0)).toThrow(/legal/);
    expect(plan.schedule).toBeUndefined();
  });

  it("stores the override on a legal month", () => {
    const plan: FieldPlan = { crop: "corn" };
    setScheduleOverride(plan, "plant", 4);
    expect(plan.schedule?.plant).toBe(4);
  });

  it("validates weed/fertilize/harvest against the plant-month-dependent legal set", () => {
    const plan: FieldPlan = { crop: "corn" };
    expect(() => setScheduleOverride(plan, "weed", 5, 3)).not.toThrow();
    expect(plan.schedule?.weed).toBe(5);
    expect(() => setScheduleOverride(plan, "weed", 11, 3)).toThrow(/legal/);
    expect(() => setScheduleOverride(plan, "harvest", 8, 3)).not.toThrow();
    expect(() => setScheduleOverride(plan, "harvest", 3, 3)).toThrow(/legal/); // before ready — not delay
  });
});

// Sanity: legalMonthsFor's plow/plant sets actually correspond to the real
// gate functions, not just gameConfig field reads (guards against the two
// drifting if gameConfig or the gate functions ever change independently).
// The campaign clock's epoch starts in March (calendar.ts's START_MONTH), so
// calendar month `m` corresponds to sim-time `((m - START_MONTH + 12) % 12) *
// minutesPerMonth()`, not `m * minutesPerMonth()` directly.
function timeForMonth(m: number): number {
  return (((m - START_MONTH) % MONTHS_PER_YEAR + MONTHS_PER_YEAR) % MONTHS_PER_YEAR) * minutesPerMonth();
}

describe("legalMonthsFor agrees with the real plow/plant gate functions", () => {
  it("every plow-legal month passes inPlowWindow, every other month fails", () => {
    const legal = legalMonthsFor("plow", "corn");
    for (let m = 0; m < MONTHS_PER_YEAR; m++) {
      expect(legal.includes(m)).toBe(inPlowWindow(timeForMonth(m)));
    }
  });

  it("every plant-legal month passes inPlantingWindow, every other month fails", () => {
    const legal = legalMonthsFor("plant", "corn");
    for (let m = 0; m < MONTHS_PER_YEAR; m++) {
      expect(legal.includes(m)).toBe(inPlantingWindow("corn", timeForMonth(m)));
    }
  });
});
