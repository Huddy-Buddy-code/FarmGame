import { describe, it, expect, beforeAll } from "vitest";
import { setProjection } from "../src/geo/coords";
import type { Meters } from "../src/geo/coords";
import { newGame } from "../src/state/saveState";
import type { Field, SaveState } from "../src/state/saveState";
import type { BaleProduct } from "../src/config/gameConfig";
import { ensureAgents, tickTasks, enqueueTask, buyAgent, buyImplement, queueHaulBales, wrapPending, estimateTaskHours } from "../src/sim/tasks";
import { tickFarming } from "../src/sim/farming";
import { buyBuildingAt } from "../src/sim/buildings";
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
    // grassSilage (2026-08-13): wrap is crop-gated now — a real in-game
    // perennial keeps its crop set through baling, so tests need it too.
    crop: "grassSilage",
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

  it("refuses straw — dry residue has nothing to ferment", () => {
    const save = gameWithWrapper();
    const field = baledField(save, 12, "straw");
    expect(() => enqueueTask(save, field, "wrap", 0)).toThrow(/can't be wrapped/i);
  });

  it("wraps squares too (2026-08-13) — no longer refused", () => {
    const save = gameWithWrapper();
    const field = baledField(save, 12, "haySquare");
    enqueueTask(save, field, "wrap", 0);
    runTasks(save, 0, () => save.tasks.every((t) => t.type !== "wrap"));
    expect(field.baleProduct).toBe("haySquareBaleage");
  });

  it("refuses a crop that doesn't wrap at all — plain Grass isn't Grass (Silage)", () => {
    const save = gameWithWrapper();
    const field = baledField(save);
    field.crop = "grass";
    expect(() => enqueueTask(save, field, "wrap", 0)).toThrow(/crop can't be wrapped/i);
  });

  it("refuses bales that are already wrapped", () => {
    const save = gameWithWrapper();
    const field = baledField(save, 12, "hayBaleage");
    expect(() => enqueueTask(save, field, "wrap", 0)).toThrow(/already wrapped/i);
  });
});

describe("wrap before haul", () => {
  const planToWrap = (field: Field): void => {
    field.plans = [{ crop: "grassSilage", bale: true, wrap: true }];
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

  it("HOLDS a field even with no wrapper owned — buy one, don't haul it unwrapped", () => {
    // This used to release the haul instead (2026-08-14 maintainer report):
    // a Silage-crop field with a plain baler and no Bale Wrapper owned was
    // hauling off unwrapped bales as if they were plain hay — exactly the
    // scenario `wrapPending` exists to prevent. The wrap task `tryEnqueue`
    // puts in the queue just sits there — correctly visible in the Work
    // Queue's blocked-work list, since `TASK_IMPLEMENT.wrap` is set — until
    // the player buys a wrapper or the same-month window closes.
    const save = newGame();
    ensureAgents(save, [0, 0]); // deliberately NO wrapper
    const field = baledField(save);
    planToWrap(field);
    expect(wrapPending(save, field, 0)).toBe(true);
    expect(queueHaulBales(save, field.id, 0)).toBeUndefined();
  });

  it("never holds a field whose crop doesn't wrap (plain Grass, not Grass (Silage))", () => {
    const save = gameWithWrapper();
    const field = baledField(save);
    field.crop = "grass"; // not a Silage crop — no auto-wrap
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

describe("the wrapper trails the baler (2026-08-14)", () => {
  // Maintainer request: it's fine for the wrap tractor to follow behind the
  // baler on the same field, same "starts once the lead machine has produced
  // something to work on" shape as the rake/baler relay. Proven live, not
  // via `baledField`'s pre-baked bales — this needs the bale task genuinely
  // still in progress when wrap starts.
  it("gets a wrap task running on the field before baling itself finishes", () => {
    const save = newGame();
    save.money = 20_000_000;
    buyBuildingAt(save, "baleArea", [-400, -400]);
    buyAgent(save, "tractor", "large", [0, 0]); // for the baler
    buyAgent(save, "tractor", "large", [0, 0]); // for the wrapper, running concurrently
    buyImplement(save, "bailer", "medium"); // plain round baler — NOT a combi, so wrap is its own pass
    buyImplement(save, "baleWrapper", "medium");
    const side = Math.sqrt(60 * 4046.8564224); // big enough to take several bales to finish
    const field: Field = {
      id: "field-1", parcelId: "p",
      boundary: [[0, 0], [side, 0], [side, side], [0, side]],
      status: "harvested", crop: "grassSilage", forageReady: true, windrowed: true,
      accessPoints: [[side / 2, 0], [side / 2, side]],
    };
    save.fields.push(field);
    enqueueTask(save, field, "bale", 0);

    let now = 0;
    let sawBothRunning = false;
    const stillWorking = () => save.tasks.some((t) => t.type === "bale" || t.type === "wrap");
    while (stillWorking() && now < 400_000) {
      now += 30;
      tickFarming(save, now);
      tickTasks(save, now, 30, () => 0.5);
      if (save.tasks.some((t) => t.type === "bale" && t.status === "active")
        && save.tasks.some((t) => t.type === "wrap" && t.status === "active")) {
        sawBothRunning = true;
      }
    }
    expect(sawBothRunning).toBe(true);
    // And the wrap mustn't have finished before every bale the baler ever
    // dropped got sealed — it structurally can't now (2026-08-14 redesign):
    // it only ever visits bale spots that already exist, and waits (see the
    // `wrap` tick block's "is baling still active" check) rather than
    // finishing early when it runs out. Every bale ends up sealed once both
    // tasks have run their course.
    expect(field.baleProduct).toBe("hayBaleage");
  });

  it("shows a genuine MIX of wrapped and unwrapped bales mid-run — not an all-or-nothing flip", () => {
    // The maintainer's core complaint about the old atomic version: "the
    // tractor seeks out Round Bales and Square Bales and wraps them...
    // changes the icon from a green bale to a white bale" — one at a time,
    // not the whole field converting together. Only one tractor here (no
    // second one for baling) so the field's `baleLocations` starts full and
    // stays fixed while wrap works through it — the clean way to catch a
    // mid-run snapshot with both piles non-empty at once.
    const save = newGame();
    save.money = 20_000_000;
    buyBuildingAt(save, "baleArea", [-400, -400]);
    buyAgent(save, "tractor", "large", [0, 0]);
    buyImplement(save, "baleWrapper", "medium");
    const side = Math.sqrt(30 * 4046.8564224);
    const n = 8;
    const baleLocations: Meters[] = [];
    for (let i = 0; i < n; i++) baleLocations.push([10 + i * 5, 10 + i * 5]);
    const field: Field = {
      id: "field-1", parcelId: "p",
      boundary: [[0, 0], [side, 0], [side, side], [0, side]],
      crop: "grassSilage", status: "harvested",
      baleLocations, baleProduct: "hay", baledAt: 0,
      accessPoints: [[side / 2, 0], [side / 2, side]],
    };
    save.fields.push(field);
    enqueueTask(save, field, "wrap", 0);

    // A fine tick step (2026-08-14 redesign completes fast — 8 close-together
    // bales are only ~3 sim-minutes of work total) so a mid-run snapshot
    // actually lands between bales instead of jumping straight to "all done"
    // within one coarse tick's budget.
    let now = 0;
    let sawMix = false;
    const STEP = 0.05;
    while (save.tasks.some((t) => t.type === "wrap") && now < 100) {
      now += STEP;
      tickTasks(save, now, STEP, () => 0.5);
      const wrapped = field.wrappedBaleLocations?.length ?? 0;
      const unwrapped = field.baleLocations?.length ?? 0;
      if (wrapped > 0 && unwrapped > 0) sawMix = true;
    }
    expect(sawMix).toBe(true);
    // Fully merged back once the task completes.
    expect(field.baleLocations).toHaveLength(n);
    expect(field.wrappedBaleLocations).toBeUndefined();
    expect(field.baleProduct).toBe("hayBaleage");
  });

  it("PERF: doesn't flag the field as 'changed' on every bale (2026-08-14 regression)", () => {
    // The bug this guards: sealing a bale used to push the field onto
    // tickTasks' `changed` list every time, and main.ts repaints every
    // `changed` field with a full canvas texture redraw (`renderField` —
    // "reallocates a multi-megabyte canvas", per its own comment). A field
    // with hundreds of bales meant hundreds of full repaints across the run,
    // which is what the maintainer saw as the game "bogging down or locking
    // up during each bale wrap." Wrapping never touches field texture/status
    // (only the bale MARKERS, refreshed separately via `baleStateKey`), so
    // `changed` should stay empty for the whole run — only the task's own
    // start/finish events should ever fire.
    const save = newGame();
    save.money = 20_000_000;
    buyBuildingAt(save, "baleArea", [-400, -400]);
    buyAgent(save, "tractor", "large", [0, 0]);
    buyImplement(save, "baleWrapper", "medium");
    const side = Math.sqrt(30 * 4046.8564224);
    const n = 30;
    const baleLocations: Meters[] = [];
    for (let i = 0; i < n; i++) baleLocations.push([10 + (i % 6) * 5, 10 + Math.floor(i / 6) * 5]);
    const field: Field = {
      id: "field-1", parcelId: "p",
      boundary: [[0, 0], [side, 0], [side, side], [0, side]],
      crop: "grassSilage", status: "harvested",
      baleLocations, baleProduct: "hay", baledAt: 0,
      accessPoints: [[side / 2, 0], [side / 2, side]],
    };
    save.fields.push(field);
    enqueueTask(save, field, "wrap", 0);

    let now = 0;
    let everFlaggedChanged = false;
    while (save.tasks.some((t) => t.type === "wrap") && now < 100) {
      now += 0.05;
      const { changed } = tickTasks(save, now, 0.05, () => 0.5);
      if (changed.length > 0) everFlaggedChanged = true;
    }
    expect(everFlaggedChanged).toBe(false);
    expect(field.baleLocations).toHaveLength(n); // sanity: the run really did finish
  });
});

describe("estimateTaskHours on an active wrap task (2026-08-14 regression)", () => {
  // The Work Queue calls this unconditionally for every active row. Wrap has
  // no coverage path any more (point-to-point between bale spots instead),
  // and its implement (Bale Wrapper) has a 0 ft width — before this was
  // guarded, calling this crashed trying to build a zero-swath coverage path
  // (`buildCoveragePath`'s "Invalid array length"), which would have taken
  // the whole Work Queue panel down the instant a wrap task went active.
  it("returns 0 instead of building a coverage path", () => {
    const save = newGame();
    save.money = 20_000_000;
    buyAgent(save, "tractor", "large", [0, 0]);
    buyImplement(save, "baleWrapper", "medium");
    const side = Math.sqrt(20 * 4046.8564224);
    const field: Field = {
      id: "field-1", parcelId: "p",
      boundary: [[0, 0], [side, 0], [side, side], [0, side]],
      crop: "grassSilage", status: "harvested",
      baleLocations: [[10, 10], [20, 20]], baleProduct: "hay", baledAt: 0,
      accessPoints: [[side / 2, 0], [side / 2, side]],
    };
    save.fields.push(field);
    const task = enqueueTask(save, field, "wrap", 0);
    tickTasks(save, 30, 30, () => 0.5); // agent picks it up, goes active
    expect(task.status).toBe("active");
    expect(() => estimateTaskHours(save, task)).not.toThrow();
    expect(estimateTaskHours(save, task)).toBe(0);
  });
});
