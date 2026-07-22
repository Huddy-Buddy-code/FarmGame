import { describe, it, expect, beforeAll } from "vitest";
import { setProjection } from "../src/geo/coords";
import type { Meters } from "../src/geo/coords";
import { newGame } from "../src/state/saveState";
import type { Field, SaveState } from "../src/state/saveState";
import { tickFarming } from "../src/sim/farming";
import { ensureAgents, buyImplement, tickTasks, autoManageAll, activePlan } from "../src/sim/tasks";
import { buyBuildingAt, assignSiloCrop } from "../src/sim/buildings";
import { minutesPerMonth } from "../src/sim/calendar";

beforeAll(() => setProjection(15, "N"));

const side = Math.sqrt(100 * 4046.8564224);
const boundary: Meters[] = [[0, 0], [side, 0], [side, side], [0, side]];
const APRIL_1 = minutesPerMonth();

/** Also gives a Silo per crop + a Grain Trailer (maintainer request,
 * 2026-07-12: the combine now has a real hopper and needs somewhere to haul
 * to) — these tests drive full harvests and need the storage/hauling gear. */
function gameWithAgents(): SaveState {
  const save = newGame();
  ensureAgents(save, [0, 0]); // medium tractor + combine + plow + planter
  const cornSilo = buyBuildingAt(save, "silo", [-50, -50], "large");
  assignSiloCrop(save, cornSilo.id, "corn");
  const soySilo = buyBuildingAt(save, "silo", [-50, -60], "large");
  assignSiloCrop(save, soySilo.id, "soybeans");
  buyImplement(save, "grainTrailer", "medium");
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

  it("field.plans with no schedule set behaves byte-identical to before (regression guard)", () => {
    const save = gameWithAgents();
    const field: Field = {
      id: "field-1", parcelId: "p", boundary, status: "tilled", autoManage: true,
      plans: [{ crop: "corn" }],
    };
    save.fields.push(field);
    expect(field.plans![0]!.schedule).toBeUndefined();
    runUntil(save, APRIL_1, () => field.crop === "corn");
    expect(field.crop).toBe("corn"); // plants at the earliest legal month, same as always
  });

  it("a plow override skips an otherwise-legal winter month and fires once the chosen month arrives", () => {
    const save = gameWithAgents();
    const field: Field = {
      id: "field-1", parcelId: "p", boundary, status: "stubble", autoManage: true,
      plans: [{ crop: "corn", schedule: { plow: 0 } }], // Jan only (Dec/Feb are also normally legal)
    };
    save.fields.push(field);

    const DEC_1 = 9 * minutesPerMonth();
    // Run through the whole of December without ever satisfying `done` — the
    // override should keep it un-plowed despite Dec being a legal plow month.
    const afterDec = runUntil(save, DEC_1, () => false, minutesPerMonth() - 1);
    expect(field.status).toBe("stubble");
    // Continue into January — the chosen month — and it fires.
    runUntil(save, afterDec, () => field.status === "tilled");
    expect(field.status).toBe("tilled");
  });

  it("a plant override skips the earliest legal month and fires once the chosen month arrives", () => {
    const save = gameWithAgents();
    const field: Field = {
      id: "field-1", parcelId: "p", boundary, status: "tilled", autoManage: true,
      // Corn's plantMonths are [3,4] (Apr,May) — earliest legal is April;
      // override to May instead.
      plans: [{ crop: "corn", schedule: { plant: 4 } }],
    };
    save.fields.push(field);

    const afterApril = runUntil(save, APRIL_1, () => false, minutesPerMonth() - 1);
    expect(field.crop).toBeUndefined(); // not planted in April despite being legal
    runUntil(save, afterApril, () => field.crop === "corn");
    expect(field.crop).toBe("corn"); // fires once May arrives
  });

  it("a harvest override delays queueing past the natural ready month, then fires once reached", () => {
    const save = gameWithAgents();
    const field: Field = {
      id: "field-1", parcelId: "p", boundary, status: "tilled", autoManage: true,
      // Corn planted in April, growMonths 4 -> naturally ready in August (month
      // 7). Delay the harvest to October (month 9) instead.
      plans: [{ crop: "corn", schedule: { harvest: 9 } }],
    };
    save.fields.push(field);

    const afterPlant = runUntil(save, APRIL_1, () => field.status === "ready");
    expect(field.status).toBe("ready");
    // Ready, but not yet harvested — run through Aug/Sep without ever
    // satisfying `done`, well past the natural ready point.
    const afterWait = runUntil(save, afterPlant, () => false, 2 * minutesPerMonth() - 1);
    expect(field.status).toBe("ready"); // still waiting on the override month
    runUntil(save, afterWait, () => field.status === "harvested");
    expect(field.status).toBe("harvested"); // fires once October arrives
  });

  it("a weed override still fires later in the legal window if it's scheduled at its LAST legal month, not just the first tick checked", () => {
    const save = gameWithAgents();
    buyImplement(save, "sprayer", "medium");
    const field: Field = {
      id: "field-1", parcelId: "p", boundary, status: "tilled", autoManage: true,
      // Corn planted April: weed's legal window is [Jun, Jul] (plantMonth+2..
      // plantMonth+growMonths-1). Schedule it at the LAST legal month (Jul).
      plans: [{ crop: "corn", weed: true, schedule: { weed: 6 } }],
    };
    save.fields.push(field);

    runUntil(save, APRIL_1, () => !!field.autoWeedDone);
    expect(field.autoWeedDone).toBe(true);
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
