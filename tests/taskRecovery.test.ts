/**
 * The stuck-task escape hatch (maintainer request, 2026-08-12): "sometimes
 * the game gets stuck on a task and I can't figure out how to reset it.
 * Reloading doesn't work." Reloading can't help because the SAVE STATE is
 * what's wedged — a corrupted cached path, a relay locked onto a destination
 * that's no longer valid, a phase that never resolves. Two tools:
 *
 *   - restartActiveTask: wipes cached runtime + phase state IN PLACE so the
 *     task re-derives everything fresh next tick, without losing the job or
 *     its agent.
 *   - forceCancelActiveTask: drops the task outright (no refund) and frees
 *     every agent on it, for when restarting isn't enough.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { setProjection } from "../src/geo/coords";
import type { Meters } from "../src/geo/coords";
import { newGame } from "../src/state/saveState";
import type { Field, FarmTask, SaveState } from "../src/state/saveState";
import {
  ensureAgents, tickTasks, enqueueTask, buyAgent, buyImplement,
  forceCancelActiveTask, restartActiveTask, resetQueuedTask,
} from "../src/sim/tasks";
import { tickFarming } from "../src/sim/farming";
import { buyBuildingAt, assignSiloCrop } from "../src/sim/buildings";
import { gameConfig } from "../src/config/gameConfig";
import { minutesPerMonth } from "../src/sim/calendar";

beforeAll(() => setProjection(15, "N"));

const APRIL_1 = minutesPerMonth();

function plowableField(acres = 400): Field {
  const side = Math.sqrt(acres * 4046.8564224);
  return {
    id: "field-1", parcelId: "p",
    boundary: [[0, 0], [side, 0], [side, side], [0, side]] as Meters[],
    status: "stubble",
  };
}

function readyCornField(acres = 10, tonsPerAcre = 6): Field {
  const side = Math.sqrt(acres * 4046.8564224);
  return {
    id: "field-1", parcelId: "p",
    boundary: [[0, 0], [side, 0], [side, side], [0, side]] as Meters[],
    status: "ready", crop: "corn", trueYieldTonsPerAcre: tonsPerAcre,
    plantedAt: APRIL_1 - gameConfig.crops.corn.growMonths * minutesPerMonth(),
  };
}

function run(save: SaveState, ticks: number, step = 10): void {
  let now = APRIL_1;
  for (let i = 0; i < ticks; i++) {
    now += step;
    tickFarming(save, now);
    tickTasks(save, now, step, () => 0.5);
  }
}

function findRelay(save: SaveState): FarmTask | undefined {
  return save.tasks.find((t) => t.type === "unloadHarvester");
}

/** Runs until `done()` or a generous cap — for driving a relay all the way
 * into "active" with a real phase, which a fixed tick count can't guarantee. */
function runUntilRelay(save: SaveState, done: (relay: FarmTask | undefined) => boolean): FarmTask {
  let now = APRIL_1;
  let relay = findRelay(save);
  for (let i = 0; i < 20000 && !done(relay); i++) {
    now += 10;
    tickFarming(save, now);
    tickTasks(save, now, 10, () => 0.5);
    relay = findRelay(save);
  }
  if (!done(relay)) throw new Error("relay never reached the expected state — fixture is broken, not the code under test");
  return relay!;
}

describe("forceCancelActiveTask", () => {
  it("removes the task and frees its agent, with NO refund", () => {
    const save = newGame();
    save.money = 1_000_000;
    const tractor = buyAgent(save, "tractor", "medium", [0, 0]);
    buyImplement(save, "plow", "medium");
    const field = plowableField();
    save.fields.push(field);
    const task = enqueueTask(save, field, "plow", APRIL_1);
    expect(task.costPaid).toBeGreaterThan(0); // sanity: this really is a paid task

    run(save, 50);
    expect(task.status).toBe("active");
    expect(task.agentId).toBe(tractor.id);
    const cashBefore = save.money;

    forceCancelActiveTask(save, task.id);

    expect(save.tasks).not.toContain(task);
    const freed = save.agents.find((a) => a.id === tractor.id)!;
    expect(freed.taskId).toBeUndefined();
    expect(freed.state).toBe("idle");
    expect(save.money).toBe(cashBefore); // no refund — this isn't cancelTask
  });

  it("throws on a QUEUED task — that's cancelTask's job, with a refund", () => {
    const save = newGame();
    save.money = 1_000_000;
    const field = plowableField();
    save.fields.push(field);
    const task = enqueueTask(save, field, "plow", APRIL_1);
    expect(task.status).toBe("queued");
    expect(() => forceCancelActiveTask(save, task.id)).toThrow(/isn't active/);
  });

  it("throws on an unknown task id", () => {
    const save = newGame();
    expect(() => forceCancelActiveTask(save, "nope")).toThrow(/not found/);
  });

  it("cascades to a relay actively servicing the canceled combine, so it isn't left stuck too", () => {
    const save = newGame();
    save.money = 1_000_000;
    ensureAgents(save, [0, 0]); // medium tractor (plow) + medium combine (corn header)
    buyImplement(save, "grainTrailer", "medium");
    const silo = buyBuildingAt(save, "silo", [-400, -400], "large");
    assignSiloCrop(save, silo.id, "corn");
    const field = readyCornField(10);
    save.fields.push(field);
    const harvestTask = enqueueTask(save, field, "harvest", APRIL_1);

    const relay = runUntilRelay(save, (r) => r?.status === "active");
    const cartTractor = save.agents.find((a) => a.id === relay.agentId)!;

    forceCancelActiveTask(save, harvestTask.id);

    expect(save.tasks.find((t) => t.id === harvestTask.id)).toBeUndefined();
    expect(save.tasks.find((t) => t.id === relay.id)).toBeUndefined();
    const combine = save.agents.find((a) => a.kind === "harvester")!;
    expect(combine.taskId).toBeUndefined();
    expect(combine.state).toBe("idle");
    const freedCart = save.agents.find((a) => a.id === cartTractor.id)!;
    expect(freedCart.taskId).toBeUndefined();
    expect(freedCart.state).toBe("idle");
  });
});

describe("restartActiveTask", () => {
  it("resets progress in place and the task keeps making fresh progress — not left stuck", () => {
    const save = newGame();
    save.money = 1_000_000;
    const tractor = buyAgent(save, "tractor", "medium", [0, 0]);
    buyImplement(save, "plow", "medium");
    const field = plowableField();
    save.fields.push(field);
    const task = enqueueTask(save, field, "plow", APRIL_1);

    run(save, 50);
    expect(task.status).toBe("active");
    expect(task.doneAcres).toBeGreaterThan(0);

    restartActiveTask(save, task.id);
    expect(task.doneAcres).toBe(0);
    expect(task.status).toBe("active"); // same job, not dropped
    expect(task.agentId).toBe(tractor.id); // same agent keeps it

    run(save, 50);
    expect(task.doneAcres).toBeGreaterThan(0); // genuinely not stuck after restart
  });

  it("throws on a QUEUED task — nothing to restart yet", () => {
    const save = newGame();
    save.money = 1_000_000;
    const field = plowableField();
    save.fields.push(field);
    const task = enqueueTask(save, field, "plow", APRIL_1);
    expect(() => restartActiveTask(save, task.id)).toThrow(/isn't active/);
  });

  it("throws on an unknown task id", () => {
    const save = newGame();
    expect(() => restartActiveTask(save, "nope")).toThrow(/not found/);
  });

  it("clears relay phase/destination state back to undefined, not just progress", () => {
    const save = newGame();
    save.money = 1_000_000;
    ensureAgents(save, [0, 0]);
    buyImplement(save, "grainTrailer", "medium");
    const silo = buyBuildingAt(save, "silo", [-400, -400], "large");
    assignSiloCrop(save, silo.id, "corn");
    const field = readyCornField(10);
    save.fields.push(field);
    enqueueTask(save, field, "harvest", APRIL_1);

    const relay = runUntilRelay(save, (r) => r?.status === "active" && !!r.unloadPhase);
    expect(relay.unloadPhase).toBeDefined(); // sanity: it really did pick up a phase

    restartActiveTask(save, relay.id);
    const after = save.tasks.find((t) => t.id === relay.id)!;
    expect(after.unloadPhase).toBeUndefined();
    expect(after.phaseTimer).toBeUndefined();
    expect(after.unloadDest).toBeUndefined();
    expect(after.status).toBe("active"); // relay kept, just reset
    expect(after.agentId).toBeDefined(); // agent kept, not freed like a cancel would
  });
});

describe("resetQueuedTask (2026-08-13)", () => {
  it("cancels and re-queues an equivalent task, refunding then re-paying the same cost", () => {
    const save = newGame();
    save.money = 1_000_000;
    const field = plowableField();
    save.fields.push(field);
    const task = enqueueTask(save, field, "plow", APRIL_1);
    expect(task.status).toBe("queued");
    const cost = task.costPaid;
    expect(cost).toBeGreaterThan(0); // sanity: this really is a paid task
    const cashAfterQueue = save.money;

    const fresh = resetQueuedTask(save, task.id, APRIL_1);

    expect(save.tasks).not.toContain(task); // the old task object is gone
    expect(fresh.id).not.toBe(task.id); // a genuinely new task, not the same one mutated
    expect(fresh.type).toBe("plow");
    expect(fresh.fieldId).toBe(field.id);
    expect(fresh.status).toBe("queued");
    expect(fresh.costPaid).toBe(cost);
    expect(save.money).toBe(cashAfterQueue); // refunded then re-paid the same amount — net zero
    expect(save.tasks).toContain(fresh);
  });

  it("carries the crop through for a plant task", () => {
    const save = newGame();
    save.money = 1_000_000;
    const field: Field = { ...plowableField(), status: "tilled" };
    save.fields.push(field);
    const task = enqueueTask(save, field, "plant", APRIL_1, "corn");
    expect(task.crop).toBe("corn");

    const fresh = resetQueuedTask(save, task.id, APRIL_1);
    expect(fresh.crop).toBe("corn");
  });

  it("throws on an ACTIVE task — nothing queued left to reset", () => {
    const save = newGame();
    save.money = 1_000_000;
    buyAgent(save, "tractor", "medium", [0, 0]);
    buyImplement(save, "plow", "medium");
    const field = plowableField();
    save.fields.push(field);
    const task = enqueueTask(save, field, "plow", APRIL_1);
    run(save, 50);
    expect(task.status).toBe("active");
    expect(() => resetQueuedTask(save, task.id, APRIL_1)).toThrow(/already underway/);
  });

  it("throws on an unknown task id", () => {
    const save = newGame();
    expect(() => resetQueuedTask(save, "nope", APRIL_1)).toThrow(/not found/);
  });
});

describe("stranded Haul Bales tasks are dropped automatically (2026-08-14)", () => {
  // Maintainer report: "a Haul Bales job gets stuck in the queued tasks but
  // there are no bales to haul and the task hangs up and keeps the auto
  // advance from happening." A queued CREW task (the 2nd/3rd hauler
  // `queueHaulBales` spawns while a field still has bales) can outlive the
  // very last bale on the field if a sibling hauler clears it first, before
  // this one is ever given an agent — `isStartable` then refuses it forever,
  // but nothing used to cancel a queued task that had gone permanently
  // un-startable. Fabricate that exact shape directly (a queued haulBales
  // task pointed at a field with zero bales) rather than driving the whole
  // crew-scaling system to it, which is what every other haul test already
  // covers.
  function haulTask(fieldId: string, over: Partial<FarmTask> = {}): FarmTask {
    return {
      id: "stuck-haul", type: "haulBales", fieldId, totalAcres: 1, doneAcres: 0,
      status: "queued", costPaid: 0, haulPhase: "toBale", ...over,
    } as FarmTask;
  }

  it("cancels a queued haul with no agent once its field has no bales and nothing more is coming", () => {
    const save = newGame();
    const field = plowableField(); // status irrelevant to haulBales — no bales is what matters
    field.baleLocations = [];
    save.fields.push(field);
    save.tasks.push(haulTask(field.id));

    tickTasks(save, APRIL_1, 10, () => 0.5);

    expect(save.tasks).toHaveLength(0);
  });

  it("leaves it alone while a bale run is still active on the field — more could still land", () => {
    const save = newGame();
    const field = plowableField();
    field.baleLocations = [];
    save.fields.push(field);
    save.tasks.push(haulTask(field.id));
    save.tasks.push({
      id: "still-baling", type: "bale", fieldId: field.id, totalAcres: 1, doneAcres: 0,
      status: "active", costPaid: 0, agentId: "someone",
    } as FarmTask);

    tickTasks(save, APRIL_1, 10, () => 0.5);

    expect(save.tasks.some((t) => t.id === "stuck-haul")).toBe(true);
  });

  it("leaves it alone while a wrap is in progress — sealed bales will come back to the field", () => {
    const save = newGame();
    const field = plowableField();
    field.crop = "grassSilage"; // wraps by design — no plan toggle needed
    field.baleLocations = [];
    field.wrappedBaleLocations = [[1, 1]]; // sealed, not yet merged back in
    save.fields.push(field);
    save.tasks.push(haulTask(field.id));
    save.tasks.push({
      id: "still-wrapping", type: "wrap", fieldId: field.id, totalAcres: 1, doneAcres: 0,
      status: "active", costPaid: 0, agentId: "someone",
    } as FarmTask);

    tickTasks(save, APRIL_1, 10, () => 0.5);

    expect(save.tasks.some((t) => t.id === "stuck-haul")).toBe(true);
  });

  it("leaves a genuinely startable queued haul alone — bales are still down", () => {
    const save = newGame();
    const field = plowableField();
    field.baleLocations = [[1, 1], [2, 2]];
    save.fields.push(field);
    save.tasks.push(haulTask(field.id));

    tickTasks(save, APRIL_1, 10, () => 0.5);

    // Not asserting it's gone — an agent may or may not have picked it up
    // yet — only that the stranding check didn't wrongly remove live work.
    expect(save.tasks.some((t) => t.id === "stuck-haul" || t.type === "haulBales")).toBe(true);
  });

  it("cancels it outright if the field itself is gone", () => {
    const save = newGame();
    save.tasks.push(haulTask("no-such-field"));

    tickTasks(save, APRIL_1, 10, () => 0.5);

    expect(save.tasks).toHaveLength(0);
  });
});
