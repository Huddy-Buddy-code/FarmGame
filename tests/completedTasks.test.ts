import { describe, it, expect, beforeAll } from "vitest";
import { setProjection } from "../src/geo/coords";
import type { Meters } from "../src/geo/coords";
import { newGame } from "../src/state/saveState";
import type { Field, SaveState } from "../src/state/saveState";
import { ensureAgents, enqueueTask, tickTasks, buyImplement, appendCompletedTask } from "../src/sim/tasks";
import { tickFarming } from "../src/sim/farming";
import { minutesPerMonth } from "../src/sim/calendar";
import { areaAcres } from "../src/geo/geometry";
import { gameConfig } from "../src/config/gameConfig";

beforeAll(() => setProjection(15, "N"));

const side = Math.sqrt(40 * 4046.8564224); // ~40-acre square
const boundary: Meters[] = [[0, 0], [side, 0], [side, side], [0, side]];
const ACRES = areaAcres(boundary);
const WINTER = 9 * minutesPerMonth(); // Dec 1 — plow window

function runUntil(save: SaveState, from: number, done: () => boolean, cap = 400_000, step = 60): number {
  let now = from;
  while (!done() && now - from < cap) {
    now += step;
    tickFarming(save, now);
    tickTasks(save, now, step, () => 0.5);
  }
  return now;
}

describe("completed-task log (maintainer request, 2026-07-14 — Work Queue 'Completed' section)", () => {
  it("records a finished plow with acres and cost, then the live task is gone", () => {
    const save = newGame();
    ensureAgents(save, [0, 0]);
    const field: Field = { id: "field-1", parcelId: "parcel-1", boundary, status: "stubble" };
    save.fields.push(field);

    const task = enqueueTask(save, field, "plow", WINTER);
    expect(task.costPaid).toBeGreaterThan(0);
    runUntil(save, WINTER, () => save.tasks.length === 0);

    expect(save.tasks.length).toBe(0);
    const log = save.completedTasks ?? [];
    expect(log.length).toBe(1);
    expect(log[0]!.type).toBe("plow");
    expect(log[0]!.fieldId).toBe("field-1");
    expect(log[0]!.agentName).toBeTruthy(); // which machine did the work
    expect(log[0]!.acres).toBeCloseTo(ACRES, 0);
    expect(log[0]!.costPaid).toBe(task.costPaid);
    expect(log[0]!.tons).toBeUndefined();
  });

  it("records tons gathered and bales produced for a finished bale job", () => {
    const save = newGame();
    ensureAgents(save, [0, 0]);
    buyImplement(save, "rake", "small");
    buyImplement(save, "bailer", "medium");
    const field: Field = { id: "field-2", parcelId: "parcel-2", boundary, status: "harvested", forageReady: true };
    save.fields.push(field);

    enqueueTask(save, field, "rake", 0);
    enqueueTask(save, field, "bale", 0);
    runUntil(save, 0, () => save.tasks.length === 0);

    const bale = (save.completedTasks ?? []).find((t) => t.type === "bale");
    expect(bale).toBeDefined();
    expect(bale!.bales).toBeGreaterThan(0);
    expect(bale!.tons).toBeCloseTo(bale!.bales! * gameConfig.forage.baleTons, 5);
  });

  it("appendCompletedTask logs a sale (no field/agent) and caps the log at 200 entries", () => {
    const save = newGame();
    appendCompletedTask(save, { id: "sale-1", type: "sellGrain", crop: "corn", label: "Corn", tons: 10, revenue: 1500, completedAt: 0 });
    expect(save.completedTasks!.length).toBe(1);
    expect(save.completedTasks![0]!.costPaid).toBeUndefined();
    expect(save.completedTasks![0]!.revenue).toBe(1500);

    for (let i = 0; i < 250; i++) {
      appendCompletedTask(save, { id: `sale-${i}`, type: "sellBales", label: "Hay", bales: 1, revenue: 65, completedAt: i });
    }
    expect(save.completedTasks!.length).toBe(200);
    // Oldest entries were dropped — the very first sale is long gone.
    expect(save.completedTasks!.some((t) => t.id === "sale-1")).toBe(false);
  });
});
