import { describe, it, expect, beforeAll } from "vitest";
import { setProjection } from "../src/geo/coords";
import type { Meters } from "../src/geo/coords";
import { newGame } from "../src/state/saveState";
import type { Field, FarmTask, SaveState } from "../src/state/saveState";
import { tickFarming, productivityMultiplier, applyHarvestDone } from "../src/sim/farming";
import { ensureAgents, buyImplement, tickTasks, autoManageAll, canMulch, taskCost, enqueueTask } from "../src/sim/tasks";
import { gameConfig } from "../src/config/gameConfig";
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

describe("legalMonthsFor mulch — from the harvest month onward", () => {
  it("corn planted April: Aug (harvest) through Nov", () => {
    // Mulch may share the harvest month (2026-07-23) — canMulch still requires
    // the field to actually be harvested, so it can't jump the queue.
    expect(legalMonthsFor("mulch", "corn", 3)).toEqual([7, 8, 9, 10]);
  });
  it("wraps past December for a late crop instead of coming back empty", () => {
    // Corn planted month 6 -> harvest month 10 (Nov) -> Nov through Feb.
    // The old December clamp returned [] here, silently disabling the row.
    expect(legalMonthsFor("mulch", "corn", 6)).toEqual([10, 11, 0, 1]);
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

describe("harvest cost (2026-07-23 — was free)", () => {
  it("charges harvestCostPerAcre × acres", () => {
    const ready: Field = { id: "f", parcelId: "p", boundary, status: "ready", crop: "corn" };
    expect(taskCost(ready, "harvest")).toBe(100 * gameConfig.harvestCostPerAcre);
  });

  it("is the priciest per-acre fieldwork pass", () => {
    const f = harvestedAnnual();
    const others = [
      taskCost(f, "plow"), taskCost(f, "mulch"), taskCost(f, "mow"),
      taskCost(f, "weed"), taskCost(f, "rake"), taskCost(f, "bale"),
    ];
    for (const c of others) expect(taskCost({ ...f, status: "ready", crop: "corn" }, "harvest")).toBeGreaterThan(c);
  });

  it("books to the field ledger under Harvesting", () => {
    const save = newGame();
    const field: Field = { id: "field-1", parcelId: "p", boundary, status: "ready", crop: "corn", trueYieldTonsPerAcre: 5 };
    save.fields.push(field);
    const before = save.money;
    enqueueTask(save, field, "harvest", APRIL_1);
    expect(save.money).toBe(before - 100 * gameConfig.harvestCostPerAcre);
    expect(save.ledger?.[1]?.fieldExpenses?.["Harvesting"]).toBe(-100 * gameConfig.harvestCostPerAcre);
  });
});

describe("mulch bonus splits by whether the residue was baled off", () => {
  it("full rate when the residue went back in whole", () => {
    const f: Field = { ...harvestedAnnual(), status: "growing", crop: "soybeans", lastCrop: "soybeans", residueMulched: true };
    // lastCrop === crop, so no rotation bonus muddies the number.
    expect(productivityMultiplier(f, APRIL_1)).toBeCloseTo(1 + gameConfig.mulchBonusPct, 6);
  });

  it("reduced rate when it was baled off first", () => {
    const f: Field = {
      ...harvestedAnnual(), status: "growing", crop: "soybeans", lastCrop: "soybeans",
      residueMulched: true, residueBaled: true,
    };
    expect(productivityMultiplier(f, APRIL_1)).toBeCloseTo(1 + gameConfig.mulchBonusBaledPct, 6);
  });

  it("residueBaled alone (never mulched) is worth nothing", () => {
    const f: Field = { ...harvestedAnnual(), status: "growing", crop: "soybeans", lastCrop: "soybeans", residueBaled: true };
    expect(productivityMultiplier(f, APRIL_1)).toBeCloseTo(1, 6);
  });

  it("harvest consumes BOTH flags, so the next mulch isn't wrongly downgraded", () => {
    const f: Field = {
      id: "f", parcelId: "p", boundary, status: "ready", crop: "soybeans",
      residueMulched: true, residueBaled: true,
    };
    applyHarvestDone(f);
    expect(f.residueMulched).toBeUndefined();
    expect(f.residueBaled).toBeUndefined();
  });
});

describe("canMulch — every annual, baled or not", () => {
  it("allows a field left 'mulched' by a bale run (stubble still works in)", () => {
    const save = newGame();
    const f = harvestedAnnual({ status: "mulched", residueBaled: true });
    save.fields.push(f);
    expect(canMulch(save, f)).toBe(true);
  });

  it("still refuses while a bale task is queued — mulching would cancel it", () => {
    const save = newGame();
    const f = harvestedAnnual({ forageReady: true, lastCrop: "wheat" });
    save.fields.push(f);
    enqueueTask(save, f, "bale", APRIL_1);
    expect(canMulch(save, f)).toBe(false);
  });

  it("refuses a field already mulched this cycle", () => {
    const save = newGame();
    const f = harvestedAnnual({ status: "mulched", residueMulched: true });
    save.fields.push(f);
    expect(canMulch(save, f)).toBe(false);
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

  it("the plow WAITS for a planned mulch — never turns the residue under first", () => {
    // The regression this guards (maintainer request, 2026-07-23): mulch used
    // to be gated behind `!plowDue`, so a plow whose month arrived first ran
    // ahead of the mulch and silently cancelled it. Here the plow is forced
    // EARLY — onto the harvest month itself — yet the mulch must still go first.
    const save = gameWithAgents();
    buyImplement(save, "mulcher", "medium");
    // Start freshly HARVESTED (mid-cycle) so the only route to tilled is through
    // the mulch — a field that started "tilled" would trip the check on its own
    // initial state before any work ran.
    const field: Field = {
      id: "field-1", parcelId: "p", boundary, status: "harvested", lastCrop: "corn",
      autoManage: true,
      // Corn's plow window opens at its August harvest; force the plow there.
      plans: [{ crop: "corn", mulch: true, bale: false, schedule: { plow: 7 } }],
    };
    save.fields.push(field);

    // The field must reach "tilled" — but only THROUGH a completed mulch, never
    // straight from harvested.
    let sawMulched = false;
    let plowedBeforeMulch = false;
    const AUG = 7 * minutesPerMonth(); // in the plow window, so the plow is "due"
    runUntil(save, AUG, () => {
      if (field.residueMulched) sawMulched = true;
      if (field.status === "tilled" && !sawMulched) plowedBeforeMulch = true;
      return field.status === "tilled" && sawMulched;
    });

    expect(plowedBeforeMulch).toBe(false);
    expect(field.residueMulched).toBe(true); // mulch bonus survived to the plow
    expect(field.status).toBe("tilled"); // and the plow still happened after it
  });

  it("still plows on time when no mulch is planned", () => {
    // The wait is specific to a PLANNED mulch — a field that isn't mulching
    // must not be held back.
    const save = gameWithAgents();
    const field: Field = {
      id: "field-1", parcelId: "p", boundary, status: "harvested", lastCrop: "corn",
      autoManage: true, plans: [{ crop: "corn", mulch: false, bale: false }, { crop: "soybeans" }],
    };
    save.fields.push(field);

    runUntil(save, APRIL_1, () => field.status === "tilled");
    expect(field.status).toBe("tilled");
    expect(field.residueMulched).toBeFalsy();
  });
});
