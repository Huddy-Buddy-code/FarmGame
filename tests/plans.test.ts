import { describe, it, expect, beforeAll } from "vitest";
import { setProjection } from "../src/geo/coords";
import type { Meters } from "../src/geo/coords";
import { newGame } from "../src/state/saveState";
import type { Field, SaveState } from "../src/state/saveState";
import { tickFarming } from "../src/sim/farming";
import { ensureAgents, buyImplement, tickTasks, autoManageAll, activePlan } from "../src/sim/tasks";
import { minutesPerMonth } from "../src/sim/calendar";

beforeAll(() => setProjection(15, "N"));

const side = Math.sqrt(100 * 4046.8564224);
const boundary: Meters[] = [[0, 0], [side, 0], [side, side], [0, side]];
const APRIL_1 = minutesPerMonth();

function gameWithAgents(): SaveState {
  const save = newGame();
  ensureAgents(save, [0, 0]); // medium tractor + combine + plow + planter
  return save;
}

/** Tick growth + auto-manage + agents until `done()` (or a cap). */
function runUntil(save: SaveState, from: number, done: () => boolean, cap = 1_000_000, step = 240): number {
  let now = from;
  while (!done() && now - from < cap) {
    now += step;
    tickFarming(save, now);
    autoManageAll(save, now);
    tickTasks(save, now, step, () => 0.5);
  }
  return now;
}

describe("activePlan — one plan per campaign year, looping", () => {
  it("advances each year and loops after the last plan", () => {
    const field: Field = {
      id: "f", parcelId: "p", boundary, status: "stubble",
      plans: [{ crop: "corn" }, { crop: "soybeans" }],
    };
    const mpm = minutesPerMonth();
    expect(activePlan(field, 0).crop).toBe("corn"); // Yr 1
    expect(activePlan(field, 10 * mpm).crop).toBe("soybeans"); // Yr 2
    expect(activePlan(field, 22 * mpm).crop).toBe("corn"); // Yr 3 (loops)
    expect(activePlan(field, 34 * mpm).crop).toBe("soybeans"); // Yr 4
  });

  it("falls back to a default corn plan when a field has none", () => {
    const field: Field = { id: "f", parcelId: "p", boundary, status: "stubble" };
    expect(activePlan(field, 0).crop).toBe("corn");
  });
});

describe("auto-manage runs the field's rotation plan", () => {
  it("crop-rotates: plants the Yr1 crop, then the Yr2 crop the next year", () => {
    const save = gameWithAgents();
    const field: Field = {
      id: "field-1", parcelId: "p", boundary, status: "tilled", autoManage: true,
      plans: [{ crop: "corn" }, { crop: "soybeans" }],
    };
    save.fields.push(field);

    // Year 1 plants corn (its plan's crop).
    const afterCorn = runUntil(save, APRIL_1, () => field.crop === "corn");
    expect(field.crop).toBe("corn");

    // Carry on across the year boundary; the next crop the field plants is the
    // Year-2 plan's crop — soybeans — never corn again.
    runUntil(save, afterCorn, () => field.crop === "soybeans");
    expect(field.crop).toBe("soybeans");
  });

  it("folds in weeding & fertilizing when the plan asks for them (once each)", () => {
    const save = gameWithAgents();
    buyImplement(save, "sprayer", "medium"); // needed for weed/fertilize
    const field: Field = {
      id: "field-1", parcelId: "p", boundary, status: "tilled", autoManage: true,
      plans: [{ crop: "corn", weed: true, fertilize: true }],
    };
    save.fields.push(field);

    runUntil(save, APRIL_1, () => !!field.autoWeedDone && !!field.autoFertDone);
    expect(field.autoWeedDone).toBe(true);
    expect(field.autoFertDone).toBe(true);
  });

  it("a plan without baling plows the residue under (no bales) even with the gear", () => {
    const save = gameWithAgents();
    buyImplement(save, "rake", "small");
    buyImplement(save, "bailer", "medium");
    const field: Field = {
      id: "field-1", parcelId: "p", boundary, status: "tilled", autoManage: true,
      plans: [{ crop: "corn", bale: false }],
    };
    save.fields.push(field);

    // Grow & harvest the corn, then let it come back around and re-plow.
    const afterHarvest = runUntil(save, APRIL_1, () => field.status === "harvested");
    expect(field.crop).toBeUndefined();
    // It plows under instead of baling — the field re-tills and never drops bales.
    runUntil(save, afterHarvest, () => field.status === "tilled");
    expect(field.baleLocations ?? []).toHaveLength(0);
  });
});
