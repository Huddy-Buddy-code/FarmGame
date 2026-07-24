import { describe, it, expect, beforeAll } from "vitest";
import { setProjection } from "../src/geo/coords";
import type { Meters } from "../src/geo/coords";
import type { Field, FieldPlan } from "../src/state/saveState";
import {
  legalMonthsFor, effectiveMonthFor, setScheduleOverride, plowDueAt,
} from "../src/sim/schedule";
import { inWeedingWindow, canFertilizeNow, deriveStatus, inPlantingWindow } from "../src/sim/farming";
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
  it("plow: every month the ground isn't occupied, ordered from when it clears", () => {
    // Corn: planted Apr (3), in the ground 4 grow + 2 harvest-window = 6 months
    // (Apr–Sep). So plowing is open Oct through Mar, listed in that order.
    expect(legalMonthsFor("plow", "corn", 3)).toEqual([9, 10, 11, 0, 1, 2]);
  });

  it("plow: an overwintering crop leaves only the gap before its own planting", () => {
    // Winter Wheat: planted Sep (8), 9 grow + 2 window = 11 months occupied
    // (Sep through Jul). Only August is free.
    expect(legalMonthsFor("plow", "wheat", 8)).toEqual([7]);
  });

  it("plow: perennials get a window too — the stand still needs ground turned once", () => {
    // Returning [] here would leave a perennial unable to be established at all.
    expect(legalMonthsFor("plow", "grass").length).toBeGreaterThan(0);
    expect(legalMonthsFor("plow", "alfalfa").length).toBeGreaterThan(0);
  });

  it("plow: never offers a month the crop is standing in", () => {
    for (const crop of ["corn", "soybeans", "wheat", "potatoes", "sunflowers"] as const) {
      const pm = gameConfig.crops[crop].plantMonths[0]!;
      const legal = legalMonthsFor("plow", crop, pm);
      const occupied = gameConfig.crops[crop].growMonths + gameConfig.harvestWindowMonths;
      for (let i = 0; i < occupied; i++) {
        expect(legal).not.toContain((pm + i) % MONTHS_PER_YEAR);
      }
    }
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
  it("falls back to the earliest legal month with no override", () => {
    expect(effectiveMonthFor("plant", "corn", undefined)).toBe(3);
  });

  it("plow DEFAULTS TO JANUARY when January is in the window", () => {
    expect(effectiveMonthFor("plow", "corn", undefined, 3)).toBe(0);
    expect(effectiveMonthFor("plow", "soybeans", undefined, 4)).toBe(0);
  });

  it("plow on an overwintering crop defaults to the month after harvest instead", () => {
    // Winter Wheat is in the ground every January, so January can't be the
    // default — it falls back to the one free month, August, right before its
    // own September planting. Defaulting to January would schedule the plow
    // ten months AFTER the seed went in.
    expect(effectiveMonthFor("plow", "wheat", undefined, 8)).toBe(7);
  });

  it("honors a valid override", () => {
    expect(effectiveMonthFor("plant", "corn", 4)).toBe(4);
  });

  it("falls back to earliest legal again if the stored override is no longer legal", () => {
    // e.g. the plan's crop changed to soybeans (plantMonths [4,5]) after an
    // override of month 3 (corn's window) was set — 3 isn't legal for soy.
    expect(effectiveMonthFor("plant", "soybeans", 3)).toBe(4);
  });

  it("returns undefined when there's no legal month at all", () => {
    // Weed on a perennial: the stand is never weeded, so there is no month.
    expect(effectiveMonthFor("weed", "grass", undefined, 2)).toBeUndefined();
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
  it("plowDueAt fires from the chosen month onward, and never before it", () => {
    // Corn's window is Oct→Mar in that order, defaulting to January. So Oct/Nov/
    // Dec are too early, Jan onward is due, and a growing month is never due.
    const pm = 3;
    for (const m of [9, 10, 11]) expect(plowDueAt("corn", m, undefined, pm)).toBe(false);
    for (const m of [0, 1, 2]) expect(plowDueAt("corn", m, undefined, pm)).toBe(true);
    for (const m of [4, 5, 6, 7, 8]) expect(plowDueAt("corn", m, undefined, pm)).toBe(false);
  });

  it("plowDueAt honors an override and still retries after a missed month", () => {
    const pm = 3;
    expect(plowDueAt("corn", 9, 9, pm)).toBe(true); // chose October
    // Missed October (broke that tick)? Still due in November — the soft retry.
    expect(plowDueAt("corn", 10, 9, pm)).toBe(true);
    // But a month before the chosen one is not yet due.
    expect(plowDueAt("corn", 9, 11, pm)).toBe(false);
  });

  it("every plant-legal month passes inPlantingWindow, every other month fails", () => {
    const legal = legalMonthsFor("plant", "corn");
    for (let m = 0; m < MONTHS_PER_YEAR; m++) {
      expect(legal.includes(m)).toBe(inPlantingWindow("corn", timeForMonth(m)));
    }
  });
});

describe("baling can only be scheduled on crops that make bales (2026-07-23)", () => {
  it("crops with a bale product have one; the rest don't", () => {
    // The Schedule tab keys its Rake/Bale column off producesForage, so this is
    // the contract that stops the column appearing where a bale pass could
    // never actually run.
    for (const crop of ["wheat", "oats", "barley", "grass", "alfalfa"] as const) {
      expect(gameConfig.crops[crop].producesForage).toBe(true);
      expect(gameConfig.crops[crop].baleProduct).toBeDefined();
    }
    for (const crop of ["corn", "soybeans", "canola", "sunflowers", "potatoes"] as const) {
      expect(gameConfig.crops[crop].producesForage).toBeFalsy();
      expect(gameConfig.crops[crop].baleProduct).toBeUndefined();
    }
  });

  it("a crop that produces forage always names the product its bales become", () => {
    for (const crop of Object.keys(gameConfig.crops) as (keyof typeof gameConfig.crops)[]) {
      if (!gameConfig.crops[crop].producesForage) continue;
      const product = gameConfig.crops[crop].baleProduct!;
      expect(gameConfig.baleProducts[product]).toBeDefined();
    }
  });
});
