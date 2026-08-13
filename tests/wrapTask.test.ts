import { describe, it, expect, beforeAll } from "vitest";
import { setProjection } from "../src/geo/coords";
import type { Meters } from "../src/geo/coords";
import { newGame } from "../src/state/saveState";
import type { Field, SaveState } from "../src/state/saveState";
import type { BaleProduct } from "../src/config/gameConfig";
import { ensureAgents, tickTasks, enqueueTask, buyImplement, queueHaulBales, wrapPending } from "../src/sim/tasks";
import { minutesPerMonth } from "../src/sim/calendar";

beforeAll(() => setProjection(15, "N"));

const MONTH = minutesPerMonth();

/**
 * The wrap TASK, end to end through the sim — and above all the interaction
 * that nearly broke it: bales are collectable the instant they hit the ground,
 * so without a guard the haulers carry a field's bales to storage as plain hay
 * while the wrap that was going to turn them into baleage hasn't run yet. Once
 * they're in a store there is no wrapping them.
 */

function baledField(save: SaveState, n = 12, product: BaleProduct = "hay", baledAt = 0): Field {
  const s = Math.sqrt(20 * 4046.8564224);
  const baleLocations: Meters[] = [];
  for (let i = 0; i < n; i++) {
    baleLocations.push([s * 0.3 + (i % 4) * s * 0.1, s * 0.3 + Math.floor(i / 4) * s * 0.1]);
  }
  const field: Field = {
    id: "field-1", parcelId: "parcel-1",
    boundary: [[0, 0], [s, 0], [s, s], [0, s]],
    status: "mulched", baleProduct: product, baleLocations, baledAt,
    accessPoints: [[s / 2, 0], [s / 2, s]],
  };
  save.fields.push(field);
  return field;
}

function gameWithWrapper(): SaveState {
  const save = newGame();
  ensureAgents(save, [0, 0]);
  buyImplement(save, "baleWrapper", "medium");
  return save;
}

function runTasks(save: SaveState, from: number, done: () => boolean, cap = 400_000, step = 30): number {
  let now = from;
  while (!done() && now - from < cap) {
    now += step;
    tickTasks(save, now, step, () => 0.5);
  }
  return now;
}

describe("queueing a wrap", () => {
  it("runs to completion and turns the field's bales into baleage", () => {
    const save = gameWithWrapper();
    const field = baledField(save);
    enqueueTask(save, field, "wrap", 0);
    runTasks(save, 0, () => save.tasks.every((t) => t.type !== "wrap"));
    expect(field.baleProduct).toBe("hayBaleage");
    expect(field.baleLocations).toHaveLength(12); // count preserved
  });

  it("charges the plastic up front, like every other pay-on-queue pass", () => {
    const save = gameWithWrapper();
    const field = baledField(save);
    const before = save.money;
    enqueueTask(save, field, "wrap", 0);
    expect(save.money).toBeLessThan(before);
  });

  it("REFUSES once the month has turned — the window is enforced at queue time", () => {
    // Enforced here, not just on completion: a wrap that could never convert
    // anything must not be startable, or the player buys plastic and gets hay.
    const save = gameWithWrapper();
    const field = baledField(save, 12, "hay", 0);
    expect(() => enqueueTask(save, field, "wrap", MONTH)).toThrow(/too old to wrap/i);
  });

  it("refuses a field with no bales down", () => {
    const save = gameWithWrapper();
    const field = baledField(save, 0);
    expect(() => enqueueTask(save, field, "wrap", 0)).toThrow(/no bales/i);
  });

  it("refuses straw and squares — neither makes baleage", () => {
    for (const product of ["straw", "haySquare"] as BaleProduct[]) {
      const save = gameWithWrapper();
      const field = baledField(save, 12, product);
      expect(() => enqueueTask(save, field, "wrap", 0)).toThrow(/can't be wrapped/i);
    }
  });

  it("refuses bales that are already wrapped", () => {
    const save = gameWithWrapper();
    const field = baledField(save, 12, "hayBaleage");
    expect(() => enqueueTask(save, field, "wrap", 0)).toThrow(/already wrapped/i);
  });
});

describe("wrap before haul", () => {
  const planToWrap = (field: Field): void => {
    field.plans = [{ crop: "grass", bale: true, wrap: true }];
  };

  it("HOLDS the auto-haul while a wrap is still owed", () => {
    const save = gameWithWrapper();
    const field = baledField(save);
    planToWrap(field);
    expect(wrapPending(save, field, 0)).toBe(true);
    expect(queueHaulBales(save, field.id, 0)).toBeUndefined();
    expect(save.tasks.filter((t) => t.type === "haulBales")).toHaveLength(0);
  });

  it("holds it while the wrap task itself is queued, plan or no plan", () => {
    const save = gameWithWrapper();
    const field = baledField(save);
    enqueueTask(save, field, "wrap", 0);
    expect(wrapPending(save, field, 0)).toBe(true);
    expect(queueHaulBales(save, field.id, 0)).toBeUndefined();
  });

  it("RELEASES the haul once the wrap has run — and it carries baleage", () => {
    const save = gameWithWrapper();
    const field = baledField(save);
    planToWrap(field);
    enqueueTask(save, field, "wrap", 0);
    const now = runTasks(save, 0, () => save.tasks.every((t) => t.type !== "wrap"));
    expect(field.baleProduct).toBe("hayBaleage");
    expect(wrapPending(save, field, now)).toBe(false);
    // Completing the wrap dispatches the haul itself, so by now one is already
    // on the field — that IS the release. (Asking queueHaulBales for another
    // returns undefined precisely because the first one exists.)
    expect(save.tasks.some((t) => t.type === "haulBales" && t.fieldId === field.id)).toBe(true);
  });

  it("releases the haul when the window SHUTS with no wrap — bales are never stranded", () => {
    // The failure this guards: holding on `plan.wrap` alone would strand a
    // field's bales forever if the wrap never happened.
    const save = gameWithWrapper();
    const field = baledField(save, 12, "hay", 0);
    planToWrap(field);
    expect(wrapPending(save, field, 0)).toBe(true);
    expect(wrapPending(save, field, MONTH)).toBe(false);
    expect(queueHaulBales(save, field.id, MONTH)).toBeDefined();
  });

  it("never holds a field the farm can't wrap anyway (no wrapper owned)", () => {
    const save = newGame();
    ensureAgents(save, [0, 0]); // deliberately NO wrapper
    const field = baledField(save);
    planToWrap(field);
    expect(wrapPending(save, field, 0)).toBe(false);
    expect(queueHaulBales(save, field.id, 0)).toBeDefined();
  });

  it("never holds a field whose plan doesn't ask for baleage", () => {
    const save = gameWithWrapper();
    const field = baledField(save);
    field.plans = [{ crop: "grass", bale: true }]; // wrap off
    expect(wrapPending(save, field, 0)).toBe(false);
    expect(queueHaulBales(save, field.id, 0)).toBeDefined();
  });

  it("never holds straw — it can't be wrapped, so waiting would be a permanent stall", () => {
    const save = gameWithWrapper();
    const field = baledField(save, 12, "straw");
    planToWrap(field);
    expect(wrapPending(save, field, 0)).toBe(false);
    expect(queueHaulBales(save, field.id, 0)).toBeDefined();
  });
});
