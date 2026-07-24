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
  agentPrice, windrowerWidthM,
} from "../src/sim/tasks";
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
