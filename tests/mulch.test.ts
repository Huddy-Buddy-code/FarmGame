import { describe, it, expect, beforeAll } from "vitest";
import { setProjection } from "../src/geo/coords";
import type { Meters } from "../src/geo/coords";
import { newGame } from "../src/state/saveState";
import type { Field, FarmTask, SaveState } from "../src/state/saveState";
import { tickFarming, productivityMultiplier, applyHarvestDone } from "../src/sim/farming";
import { ensureAgents, buyImplement, tickTasks, autoManageAll, canMulch, taskCost } from "../src/sim/tasks";
import { legalMonthsFor } from "../src/sim/schedule";
import { buyBuildingAt, assignSiloCrop } from "../src/sim/buildings";
import { minutesPerMonth } from "../src/sim/calendar";

beforeAll(() => setProjection(15, "N"));

const side = Math.sqrt(100 * 4046.8564224); // exactly 100 acres
const boundary: Meters[] = [[0, 0], [side, 0], [side, side], [0, side]];
const APRIL_1 = minutesPerMonth();

/** A freshly-harvested annual field (crop cleared, prior crop remembered). */
function harvestedAnnual(over: Partial<Field> = {}): Field {
  return { id: "f", parcelId: "p", boundary, status: "harvested", lastCrop: "corn", ...over };
}

function rakeTask(fieldId: string): FarmTask {
  return { id: "t1", type: "rake", fieldId, totalAcres: 100, doneAcres: 0, status: "queued", costPaid: 0 };
}

describe("canMulch — annual residue that isn't baled or already mulched", () => {
  it("true for a freshly-harvested annual with no rake/bale lined up", () => {
    expect(canMulch(newGame(), harvestedAnnual())).toBe(true);
  });
  it("false for a perennial stand (crop stays set on grass/alfalfa)", () => {
    expect(canMulch(newGame(), harvestedAnnual({ crop: "grass" }))).toBe(false);
  });
  it("false once the residue has already been mulched this cycle", () => {
    expect(canMulch(newGame(), harvestedAnnual({ residueMulched: true }))).toBe(false);
  });
  it("false before harvest (nothing to mulch yet)", () => {
    expect(canMulch(newGame(), harvestedAnnual({ status: "growing", crop: "corn" }))).toBe(false);
  });
  it("false when the field is headed for baling (a rake is queued)", () => {
    const save = newGame();
    save.tasks.push(rakeTask("f"));
    expect(canMulch(save, harvestedAnnual())).toBe(false);
  });
});

describe("mulch yield bonus (+7%, additive) via productivityMultiplier", () => {
  it("adds a flat 0.07 when residue was mulched", () => {
    expect(productivityMultiplier({ ...harvestedAnnual({ crop: "corn", lastCrop: undefined }) }, 0)).toBe(1);
    expect(productivityMultiplier({ ...harvestedAnnual({ crop: "corn", lastCrop: undefined, residueMulched: true }) }, 0))
      .toBeCloseTo(1.07, 6);
  });
  it("stacks additively with the crop-rotation bonus", () => {
    // soybeans after corn = +10% rotation, plus +7% mulch = 1.17.
    const f: Field = { id: "f", parcelId: "p", boundary, status: "growing", crop: "soybeans", lastCrop: "corn", residueMulched: true };
    expect(productivityMultiplier(f, 0)).toBeCloseTo(1.17, 6);
  });
  it("is consumed by the next harvest (applyHarvestDone clears it)", () => {
    const f: Field = { id: "f", parcelId: "p", boundary, status: "ready", crop: "corn", residueMulched: true };
    applyHarvestDone(f);
    expect(f.residueMulched).toBeUndefined();
  });
});

describe("legalMonthsFor mulch — the months following harvest", () => {
  it("corn planted April (harvest Aug): Sep/Oct/Nov", () => {
    expect(legalMonthsFor("mulch", "corn", 3)).toEqual([8, 9, 10]);
  });
  it("wraps past December for a late crop instead of coming back empty", () => {
    // Corn planted month 6 -> harvest month 10 (Nov) -> mulch Dec/Jan/Feb.
    // The old December clamp returned [] here, silently disabling the row.
    expect(legalMonthsFor("mulch", "corn", 6)).toEqual([11, 0, 1]);
  });
  it("empty for a perennial (its residue is never mulched)", () => {
    expect(legalMonthsFor("mulch", "grass", 3)).toEqual([]);
  });
});

describe("mulch task cost", () => {
  it("charges mulchCostPerAcre × acres", () => {
    expect(taskCost(harvestedAnnual(), "mulch")).toBe(800); // 100 acres × $8
  });
});

// --- Auto-manage integration ------------------------------------------------

function gameWithAgents(): SaveState {
  const save = newGame();
  ensureAgents(save, [0, 0]); // medium tractor + combine + plow + planter
  const cornSilo = buyBuildingAt(save, "silo", [-50, -50], "large");
  assignSiloCrop(save, cornSilo.id, "corn");
  buyImplement(save, "grainTrailer", "medium");
  return save;
}

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

describe("auto-manage folds in a mulch pass after harvest", () => {
  it("mulches an un-baled annual, stamping the +7% flag for next year", () => {
    const save = gameWithAgents();
    buyImplement(save, "mulcher", "medium");
    const field: Field = {
      id: "field-1", parcelId: "p", boundary, status: "tilled", autoManage: true,
      plans: [{ crop: "corn", mulch: true, bale: false }],
    };
    save.fields.push(field);

    runUntil(save, APRIL_1, () => field.residueMulched === true);
    expect(field.residueMulched).toBe(true);
    expect(field.autoMulchDone).toBe(true);
  });

  it("does nothing when the plan's mulch toggle is off", () => {
    const save = gameWithAgents();
    buyImplement(save, "mulcher", "medium");
    const field: Field = {
      id: "field-1", parcelId: "p", boundary, status: "tilled", autoManage: true,
      plans: [{ crop: "corn", mulch: false, bale: false }],
    };
    save.fields.push(field);

    // Grow → harvest → re-plow, all the way around, without ever mulching.
    const afterHarvest = runUntil(save, APRIL_1, () => field.status === "harvested");
    runUntil(save, afterHarvest, () => field.status === "tilled");
    expect(field.residueMulched).toBeFalsy();
  });
});
