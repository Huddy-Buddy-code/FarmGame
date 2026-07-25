/**
 * The Self-Propelled Windrower (maintainer decision, 2026-07-24) — a MACHINE,
 * not an implement. It cuts a hay field on its own: no tractor tied up, no
 * mower to hitch. That's the whole trade it offers, so the things worth pinning
 * are exactly the ways it differs from a tractor + Mower:
 *
 *   - it can take a `mow` task with no implement anywhere on the farm;
 *   - it cuts at ITS width, not an implement's;
 *   - it can't do anything else;
 *   - a tractor stands down from mowing while a windrower is free, so the
 *     specialist doesn't sit parked while a general-purpose machine does its job.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { setProjection } from "../src/geo/coords";
import type { Meters } from "../src/geo/coords";
import { newGame } from "../src/state/saveState";
import type { Field, SaveState } from "../src/state/saveState";
import { tickFarming } from "../src/sim/farming";
import {
  buyAgent, buyImplement, enqueueTask, tickTasks, blockedWork, agentCanDoTask,
  agentPrice, windrowerWidthM, estimateTaskHours,
} from "../src/sim/tasks";
import { buyBuildingAt } from "../src/sim/buildings";
import { minutesPerMonth } from "../src/sim/calendar";
import { gameConfig, FEET_TO_METERS } from "../src/config/gameConfig";

beforeAll(() => setProjection(15, "N"));

const side = Math.sqrt(40 * 4046.8564224);
const boundary: Meters[] = [[0, 0], [side, 0], [side, side], [0, side]];
const MAY_1 = minutesPerMonth() * 2;

function run(save: SaveState, from: number, done: () => boolean, cap = 200_000, step = 30): void {
  let now = from;
  while (!done() && now - from < cap) {
    now += step;
    tickFarming(save, now);
    tickTasks(save, now, step, () => 0.5);
  }
}

/** A grass field standing ready to cut. */
function hayField(): Field {
  return { id: "field-1", parcelId: "p", boundary, status: "ready", crop: "grass" };
}

describe("a windrower mows without a tractor or a mower", () => {
  it("takes the cut on a farm that owns no implements at all", () => {
    const save = newGame();
    save.money = 10_000_000;
    buyAgent(save, "windrower", "large", [0, 0]);
    const field = hayField();
    save.fields.push(field);
    enqueueTask(save, field, "mow", MAY_1);

    run(save, MAY_1, () => field.status === "harvested");
    expect(field.status).toBe("harvested");
    expect(save.implements).toHaveLength(0); // it needed nothing hitched
  });

  it("cuts at its own 40 ft width", () => {
    expect(gameConfig.equipment.windrower.widthFt).toBe(40);
    expect(windrowerWidthM()).toBeCloseTo(40 * FEET_TO_METERS, 6);
  });

  it("is priced as one size — `size` doesn't change what it costs", () => {
    expect(agentPrice("windrower", "small")).toBe(gameConfig.equipment.windrower.price);
    expect(agentPrice("windrower", "large")).toBe(gameConfig.equipment.windrower.price);
  });

  it("mowing is the ONLY thing it can do", () => {
    const save = newGame();
    save.money = 10_000_000;
    const w = buyAgent(save, "windrower", "large", [0, 0]);
    expect(agentCanDoTask(w, "mow")).toBe(true);
    for (const t of ["plow", "plant", "harvest", "weed", "fertilize", "rake", "bale", "mulch"] as const) {
      expect(agentCanDoTask(w, t), t).toBe(false);
    }
  });

  it("a queued cut isn't reported as blocked just because no Mower is owned", () => {
    const save = newGame();
    save.money = 10_000_000;
    buyAgent(save, "windrower", "large", [0, 0]);
    const field = hayField();
    save.fields.push(field);
    enqueueTask(save, field, "mow", MAY_1);
    expect(blockedWork(save).some((b) => b.type === "mow")).toBe(false);
  });

  it("...but a farm with neither windrower nor mower IS blocked", () => {
    const save = newGame();
    save.money = 10_000_000;
    buyAgent(save, "tractor", "medium", [0, 0]);
    const field = hayField();
    save.fields.push(field);
    enqueueTask(save, field, "mow", MAY_1);
    expect(blockedWork(save).some((b) => b.type === "mow")).toBe(true);
  });
});

describe("the specialist gets first refusal on a cut", () => {
  it("the windrower takes the job, leaving the tractor+mower free", () => {
    const save = newGame();
    save.money = 10_000_000;
    // A tractor that COULD do it, and a windrower. The windrower can do nothing
    // else, so it should be the one that goes.
    const tractor = buyAgent(save, "tractor", "medium", [0, 0]);
    buyImplement(save, "mower", "medium");
    buyAgent(save, "windrower", "large", [0, 0]);
    const field = hayField();
    save.fields.push(field);
    enqueueTask(save, field, "mow", MAY_1);

    run(save, MAY_1, () => save.tasks.some((t) => t.type === "mow" && t.status === "active"), 20_000);
    const task = save.tasks.find((t) => t.type === "mow")!;
    expect(save.agents.find((a) => a.id === task.agentId)?.kind).toBe("windrower");
    expect(tractor.taskId).toBeUndefined();
  });

  it("a tractor still mows when the windrower is already busy elsewhere", () => {
    const save = newGame();
    save.money = 10_000_000;
    buyAgent(save, "tractor", "medium", [0, 0]);
    buyImplement(save, "mower", "medium");
    const windrower = buyAgent(save, "windrower", "large", [0, 0]);
    windrower.taskId = "something-else";
    windrower.state = "working";

    const field = hayField();
    save.fields.push(field);
    enqueueTask(save, field, "mow", MAY_1);

    run(save, MAY_1, () => save.tasks.some((t) => t.type === "mow" && t.status === "active"), 20_000);
    const task = save.tasks.find((t) => t.type === "mow")!;
    expect(save.agents.find((a) => a.id === task.agentId)?.kind).toBe("tractor");
  });
});

describe("it goes home when it's done", () => {
  /** Maintainer report, 2026-07-24: "The Windrower is not returning to Machine
   * Storage or Farm Yard when task is complete." homeTargetFor() enumerated the
   * power units as tractor-or-harvester, so the windrower fell through and just
   * stopped wherever it finished cutting. */
  function mowAndIdle(build: (save: SaveState) => Meters) {
    const save = newGame();
    save.money = 10_000_000;
    const home = build(save);
    const windrower = buyAgent(save, "windrower", "large", [0, 0]);
    const field = hayField();
    // Well away from home, so "drove back" is unambiguous.
    field.boundary = boundary.map(([x, y]) => [x + 4000, y + 4000] as Meters);
    save.fields.push(field);
    enqueueTask(save, field, "mow", MAY_1);

    run(save, MAY_1, () => field.status === "harvested");
    expect(field.status).toBe("harvested");
    // Then let it drive home.
    run(save, MAY_1, () => windrower.state === "idle" && samePos(windrower.pos, home), 400_000);
    return { save, windrower, home };
  }

  const samePos = (a: Meters, b: Meters) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 2;

  it("parks in the Tractor Barn after a cut", () => {
    const { windrower, home } = mowAndIdle((save) => buyBuildingAt(save, "tractorBarn", [0, 0]).pos);
    expect(windrower.state).toBe("idle");
    expect(samePos(windrower.pos, home)).toBe(true);
  });

  it("falls back to the Farm Yard when there's no barn", () => {
    const { windrower, home } = mowAndIdle((save) => buyBuildingAt(save, "farmYard", [0, 0]).pos);
    expect(windrower.state).toBe("idle");
    expect(samePos(windrower.pos, home)).toBe(true);
  });

  it("counts against a barn's slots, so it can't be over-filled", () => {
    // The occupancy check enumerated power units the same way homeTargetFor
    // did, so a parked windrower was invisible to it — a full barn would have
    // accepted more machines on top.
    const save = newGame();
    save.money = 20_000_000;
    const barn = buyBuildingAt(save, "tractorBarn", [0, 0]);
    const slots = gameConfig.buildings.tractorBarn.slots;
    for (let i = 0; i < slots; i++) {
      const w = buyAgent(save, "windrower", "large", [0, 0]);
      w.pos = [barn.pos[0], barn.pos[1]];
      w.state = "idle";
    }
    // One more machine, parked out in a field, should NOT be sent to the barn.
    const extra = buyAgent(save, "tractor", "medium", [5000, 5000]);
    run(save, MAY_1, () => false, 200_000);
    expect(samePos(extra.pos, barn.pos)).toBe(false);
  });
});

describe("it carries no implement — it IS the mower", () => {
  it("never gets a mower hitched to it", () => {
    const save = newGame();
    save.money = 10_000_000;
    const w = buyAgent(save, "windrower", "large", [0, 0]);
    buyImplement(save, "mower", "medium"); // sitting in the yard, and staying there
    const field = hayField();
    save.fields.push(field);
    enqueueTask(save, field, "mow", MAY_1);

    run(save, MAY_1, () => field.status === "harvested");
    expect(field.status).toBe("harvested");
    expect(save.implements.some((i) => i.attachedTo === w.id)).toBe(false);
  });

  it("a queued cut is estimated at the WINDROWER's 40 ft, not a mower's width", () => {
    // estimateTaskHours looked up an owned Mower and, finding none, fell back
    // to a nominal "medium" 25 ft — so the Work Queue quoted a job length for
    // an implement the farm doesn't own (2026-07-24).
    const save = newGame();
    save.money = 10_000_000;
    buyAgent(save, "windrower", "large", [0, 0]);
    const field = hayField();
    save.fields.push(field);
    const task = enqueueTask(save, field, "mow", MAY_1);

    const hours = estimateTaskHours(save, task);
    // Same acreage at 40 ft vs the mower fallback's 25 ft: the windrower's
    // estimate has to be the shorter one, in the right proportion.
    const mowerFallbackFt = gameConfig.equipment.mower.medium.widthFt;
    const windrowerFt = gameConfig.equipment.windrower.widthFt;
    expect(hours).toBeGreaterThan(0);
    expect(windrowerFt).toBeGreaterThan(mowerFallbackFt); // guards the premise
    // hours scale inversely with width
    const impliedFt = mowerFallbackFt * (estimateWithMowerOnly(save, field) / hours);
    expect(impliedFt).toBeCloseTo(windrowerFt, 0);
  });

  /** The same estimate on a farm with a Mower and no windrower, for comparison. */
  function estimateWithMowerOnly(_save: SaveState, field: Field): number {
    const save = newGame();
    save.money = 10_000_000;
    buyAgent(save, "tractor", "medium", [0, 0]);
    buyImplement(save, "mower", "medium");
    const f = { ...field, id: "field-2" };
    save.fields.push(f);
    return estimateTaskHours(save, enqueueTask(save, f, "mow", MAY_1));
  }
});

describe("mower sizes", () => {
  it("comes in 15 / 25 / 50 ft", () => {
    expect(gameConfig.equipment.mower.small.widthFt).toBe(15);
    expect(gameConfig.equipment.mower.medium.widthFt).toBe(25);
    expect(gameConfig.equipment.mower.large.widthFt).toBe(50);
  });

  it("the 50 ft Large mower still cuts narrower than nothing at all is wide", () => {
    // Sanity on the trade: the windrower is 40 ft, so a Large mower is actually
    // WIDER — you buy the windrower to free a tractor, not for raw width.
    expect(gameConfig.equipment.mower.large.widthFt).toBeGreaterThan(gameConfig.equipment.windrower.widthFt);
  });
});
