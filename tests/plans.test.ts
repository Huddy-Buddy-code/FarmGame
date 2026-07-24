import { describe, it, expect, beforeAll } from "vitest";
import { setProjection } from "../src/geo/coords";
import type { Meters } from "../src/geo/coords";
import { newGame } from "../src/state/saveState";
import type { Field, SaveState } from "../src/state/saveState";
import { tickFarming } from "../src/sim/farming";
import { ensureAgents, buyImplement, tickTasks, autoManageAll, activePlan, advanceRotation, planToPlant, cancelTask, removeRotationStep } from "../src/sim/tasks";
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

describe("activePlan — an ordered sequence, advanced by rotationIndex", () => {
  it("reads the step rotationIndex points at, and loops past the end", () => {
    const field: Field = {
      id: "f", parcelId: "p", boundary, status: "stubble",
      plans: [{ crop: "corn" }, { crop: "soybeans" }],
    };
    expect(activePlan(field).crop).toBe("corn"); // index unset = step 0
    advanceRotation(field);
    expect(activePlan(field).crop).toBe("soybeans");
    advanceRotation(field);
    expect(activePlan(field).crop).toBe("corn"); // wraps
  });

  it("no longer depends on the campaign year (the old rule)", () => {
    const field: Field = {
      id: "f", parcelId: "p", boundary, status: "stubble",
      plans: [{ crop: "corn" }, { crop: "soybeans" }],
    };
    const mpm = minutesPerMonth();
    // Years 1 through 4 — under the old `plans[(year-1) % len]` rule these
    // would have read corn/soy/corn/soy. The sequence ignores the clock.
    for (const t of [0, 10 * mpm, 22 * mpm, 34 * mpm]) {
      expect(activePlan(field, t).crop).toBe("corn");
    }
  });

  it("tolerates a rotationIndex left past the end by a shortened sequence", () => {
    const field: Field = {
      id: "f", parcelId: "p", boundary, status: "stubble",
      plans: [{ crop: "corn" }], rotationIndex: 3,
    };
    expect(activePlan(field).crop).toBe("corn");
  });

  it("falls back to a default corn plan when a field has none", () => {
    const field: Field = { id: "f", parcelId: "p", boundary, status: "stubble" };
    expect(activePlan(field).crop).toBe("corn");
  });
});

describe("removeRotationStep — the pointer follows the step it was on", () => {
  const threeStep = (idx: number): Field => ({
    id: "f", parcelId: "p", boundary, status: "growing",
    plans: [{ crop: "corn" }, { crop: "soybeans" }, { crop: "wheat" }],
    rotationIndex: idx,
  });

  it("removing a step BEFORE the running one keeps the same crop growing", () => {
    const field = threeStep(2); // running wheat
    removeRotationStep(field, 0); // drop corn
    expect(activePlan(field).crop).toBe("wheat");
    expect(field.rotationIndex).toBe(1);
  });

  it("removing a step AFTER the running one leaves the pointer alone", () => {
    const field = threeStep(0); // running corn
    removeRotationStep(field, 2); // drop wheat
    expect(activePlan(field).crop).toBe("corn");
    expect(field.rotationIndex).toBe(0);
  });

  it("removing the RUNNING step lands on whatever took its slot", () => {
    const field = threeStep(1); // running soybeans
    removeRotationStep(field, 1);
    expect(field.plans!.map((p) => p.crop)).toEqual(["corn", "wheat"]);
    expect(activePlan(field).crop).toBe("wheat"); // slid into slot 1
  });

  it("removing the running LAST step wraps to the front instead of pointing off the end", () => {
    const field = threeStep(2); // running wheat, the last step
    removeRotationStep(field, 2);
    expect(field.rotationIndex).toBe(0);
    expect(activePlan(field).crop).toBe("corn");
  });

  it("refuses to empty the sequence", () => {
    const field: Field = {
      id: "f", parcelId: "p", boundary, status: "stubble", plans: [{ crop: "corn" }],
    };
    removeRotationStep(field, 0);
    expect(field.plans).toHaveLength(1);
  });
});

describe("planToPlant — first planting vs. rotation handoff", () => {
  const twoStep = (): Field => ({
    id: "f", parcelId: "p", boundary, status: "tilled",
    plans: [{ crop: "corn" }, { crop: "soybeans" }],
  });

  it("plants the CURRENT step on a field that has never grown anything", () => {
    const field = twoStep();
    // Same object reference as activePlan — that's how autoManageField knows
    // this isn't a handoff and must not advance the sequence.
    expect(planToPlant(field)).toBe(activePlan(field));
    expect(planToPlant(field).crop).toBe("corn");
  });

  it("plants the NEXT step once a crop has come off the field", () => {
    const field = twoStep();
    field.lastCrop = "corn"; // set by applyHarvestDone
    expect(planToPlant(field).crop).toBe("soybeans");
    expect(planToPlant(field)).not.toBe(activePlan(field));
  });

  it("plants the NEXT step while a crop is still standing", () => {
    const field = twoStep();
    field.crop = "corn";
    expect(planToPlant(field).crop).toBe("soybeans");
  });
});

describe("auto-manage runs the field's rotation plan", () => {
  it("crop-rotates: plants step 1's crop, then step 2's once the first comes off", () => {
    const save = gameWithAgents();
    const field: Field = {
      id: "field-1", parcelId: "p", boundary, status: "tilled", autoManage: true,
      plans: [{ crop: "corn" }, { crop: "soybeans" }],
    };
    save.fields.push(field);

    // Never-planted field: its first crop is the step already current (corn),
    // and the sequence must NOT have advanced for it.
    const afterCorn = runUntil(save, APRIL_1, () => field.crop === "corn");
    expect(field.crop).toBe("corn");
    expect(field.rotationIndex ?? 0).toBe(0);

    // The next crop it plants is step 2's — soybeans — and starting that plant
    // is what moves the pointer.
    runUntil(save, afterCorn, () => field.crop === "soybeans");
    expect(field.crop).toBe("soybeans");
    expect(field.rotationIndex).toBe(1);
  });

  it("advances on PLANT START, not at harvest — residue work stays on the outgoing step", () => {
    const save = gameWithAgents();
    const field: Field = {
      id: "field-1", parcelId: "p", boundary, status: "tilled", autoManage: true,
      plans: [{ crop: "corn" }, { crop: "soybeans" }],
    };
    save.fields.push(field);

    runUntil(save, APRIL_1, () => field.crop === "corn");
    const afterHarvest = runUntil(save, APRIL_1, () => field.status === "harvested");
    // Corn is off the field, but nothing new is in the ground yet — the
    // pointer is still on corn, so corn's own bale/mulch/plow settings apply.
    expect(field.status).toBe("harvested");
    expect(field.rotationIndex ?? 0).toBe(0);
    expect(activePlan(field).crop).toBe("corn");

    runUntil(save, afterHarvest, () => field.crop === "soybeans");
    expect(field.rotationIndex).toBe(1);
  });

  it("a canceled plant leaves the sequence where it was (advance is at start, not enqueue)", () => {
    const save = gameWithAgents();
    const field: Field = {
      id: "field-1", parcelId: "p", boundary, status: "tilled", autoManage: true,
      plans: [{ crop: "corn" }, { crop: "soybeans" }],
      lastCrop: "corn", // pretend a crop already came off: next plant is a handoff
    };
    save.fields.push(field);

    // Queue the handoff plant without ever letting an agent pick it up.
    autoManageAll(save, APRIL_1 + minutesPerMonth()); // May — soybeans' window
    const plant = save.tasks.find((t) => t.type === "plant" && t.fieldId === field.id);
    expect(plant?.advancesRotation).toBe(true);
    expect(field.rotationIndex ?? 0).toBe(0); // not yet — it hasn't started

    cancelTask(save, plant!.id);
    expect(field.rotationIndex ?? 0).toBe(0);
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
