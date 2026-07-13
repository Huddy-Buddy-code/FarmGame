import { describe, it, expect, beforeAll } from "vitest";
import { setProjection } from "../src/geo/coords";
import type { Meters } from "../src/geo/coords";
import { newGame } from "../src/state/saveState";
import type { Field, SaveState } from "../src/state/saveState";
import { ensureAgents, enqueueTask, tickTasks } from "../src/sim/tasks";
import { tickFarming, applyPlow, applyPlant } from "../src/sim/farming";
import { minutesPerMonth } from "../src/sim/calendar";
import { gameConfig } from "../src/config/gameConfig";

beforeAll(() => setProjection(15, "N"));

const side = Math.sqrt(20 * 4046.8564224);
const boundary: Meters[] = [[500, 500], [500 + side, 500], [500 + side, 500 + side], [500, 500 + side]];

// The display year runs Mar → Feb (sim time 0 = March 1), so month M is
// (M − 2) months in.
const APRIL = 1 * minutesPerMonth();
const JUNE = 3 * minutesPerMonth();

function plantedCornField(save: SaveState, now: number): Field {
  const field: Field = { id: "field-1", parcelId: "parcel-1", boundary, status: "stubble" };
  save.fields.push(field);
  applyPlow(field);
  applyPlant(field, "corn", now, () => 0.5);
  return field;
}

function runUntil(save: SaveState, from: number, done: () => boolean, capMinutes = 300_000, step = 30): number {
  let now = from;
  while (!done() && now - from < capMinutes) {
    now += step;
    tickFarming(save, now);
    tickTasks(save, now, step, () => 0.5);
  }
  return now;
}

describe("weed pressure (maintainer request, 2026-07-12)", () => {
  it("weeds flush once the weeding window opens on a standing crop", () => {
    const save = newGame();
    const field = plantedCornField(save, APRIL);
    tickFarming(save, APRIL + 1);
    expect(field.weedy).toBeUndefined(); // April — window not open yet
    const { changed } = tickFarming(save, JUNE + 1);
    expect(field.weedy).toBe(true);
    expect(changed.some((f) => f.id === field.id)).toBe(true); // repaint requested
  });

  it("a weeding pass clears the weeds and blocks a re-flush for this crop", () => {
    const save = newGame();
    ensureAgents(save, [500, 500]);
    // The farm needs a sprayer to weed.
    save.implements.push({ id: "sprayer-1", kind: "sprayer", size: "medium" });
    const field = plantedCornField(save, APRIL);
    let now = JUNE + 1;
    tickFarming(save, now);
    expect(field.weedy).toBe(true);

    enqueueTask(save, field, "weed", now);
    now = runUntil(save, now, () => !field.weedy);
    expect(field.weedy).toBeFalsy();
    expect(field.weeded).toBe(true);
    // Still June, still a standing crop — but no second flush.
    tickFarming(save, now + 60);
    expect(field.weedy).toBeFalsy();
  });

  it("the weed cycle resets with the next planting", () => {
    const save = newGame();
    const field = plantedCornField(save, APRIL);
    tickFarming(save, JUNE + 1);
    field.weedy = undefined;
    field.weeded = true;
    // New season: harvest happened, replow + replant.
    field.status = "harvested";
    field.crop = undefined;
    field.plantedAt = undefined;
    field.forageReady = undefined;
    applyPlow(field);
    applyPlant(field, "soybeans", 12 * minutesPerMonth() + APRIL, () => 0.5);
    expect(field.weeded).toBeUndefined();
    tickFarming(save, 12 * minutesPerMonth() + JUNE + 1); // June of year 2
    expect(field.weedy).toBe(true);
  });

  it("weeds die with the crop: cleared when the field is no longer standing/ready", () => {
    const save = newGame();
    const field = plantedCornField(save, APRIL);
    tickFarming(save, JUNE + 1);
    expect(field.weedy).toBe(true);
    field.status = "harvested";
    field.crop = undefined;
    field.plantedAt = undefined;
    const { changed } = tickFarming(save, JUNE + 2);
    expect(field.weedy).toBeUndefined();
    expect(changed.some((f) => f.id === field.id)).toBe(true);
  });

  it("weeding costs book to the cashflow ledger as Field Expenses", () => {
    const save = newGame();
    ensureAgents(save, [500, 500]);
    save.implements.push({ id: "sprayer-1", kind: "sprayer", size: "medium" });
    const field = plantedCornField(save, APRIL);
    tickFarming(save, JUNE + 1);
    enqueueTask(save, field, "weed", JUNE + 1);
    const y = save.ledger?.[save.finance.openYear];
    const expected = -Math.round(20 * gameConfig.weedCostPerAcre);
    expect(Math.round(y?.fieldExpenses?.["Weeding"] ?? 0)).toBeCloseTo(expected, -1);
  });
});
