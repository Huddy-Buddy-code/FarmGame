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

  it("appendCompletedTask logs a sale with no field/agent", () => {
    const save = newGame();
    appendCompletedTask(save, { id: "sale-1", type: "sellGrain", crop: "corn", label: "Corn", tons: 10, revenue: 1500, completedAt: 0 });
    expect(save.completedTasks!.length).toBe(1);
    expect(save.completedTasks![0]!.costPaid).toBeUndefined();
    expect(save.completedTasks![0]!.revenue).toBe(1500);
  });

  it("caps the log at 200 entries, dropping the oldest", () => {
    const save = newGame();
    // Field-work completions are never merged, so they still accumulate one
    // row each — this is what the cap exists for.
    appendCompletedTask(save, { id: "first", type: "plow", fieldId: "f", acres: 10, costPaid: 200, completedAt: 0 });
    for (let i = 0; i < 250; i++) {
      appendCompletedTask(save, { id: `plow-${i}`, type: "plow", fieldId: "f", acres: 10, costPaid: 200, completedAt: i });
    }
    expect(save.completedTasks!.length).toBe(200);
    expect(save.completedTasks!.some((t) => t.id === "first")).toBe(false);
  });

  describe("sales accumulate into one row per product (maintainer request, 2026-07-23)", () => {
    it("folds repeat deliveries of the same crop into a single running total", () => {
      const save = newGame();
      // Three trips of a 150 t sell run, all in the same month.
      for (const tons of [60, 60, 30]) {
        appendCompletedTask(save, {
          id: `sale-${tons}`, type: "sellGrain", crop: "corn", label: "Corn",
          tons, revenue: tons * 180, completedAt: 100,
        });
      }
      const sales = save.completedTasks!.filter((c) => c.type === "sellGrain");
      expect(sales).toHaveLength(1);
      expect(sales[0]!.tons).toBe(150);
      expect(sales[0]!.revenue).toBe(150 * 180);
    });

    it("keeps different products apart", () => {
      const save = newGame();
      appendCompletedTask(save, { id: "a", type: "sellGrain", crop: "corn", label: "Corn", tons: 10, revenue: 1800, completedAt: 0 });
      appendCompletedTask(save, { id: "b", type: "sellGrain", crop: "wheat", label: "Winter Wheat", tons: 10, revenue: 2100, completedAt: 0 });
      appendCompletedTask(save, { id: "c", type: "sellBales", label: "Hay", bales: 5, revenue: 325, completedAt: 0 });
      expect(save.completedTasks).toHaveLength(3);
    });

    it("starts a fresh row in a new month — the panel only shows this month", () => {
      const save = newGame();
      const MPM = minutesPerMonth();
      appendCompletedTask(save, { id: "a", type: "sellGrain", crop: "corn", label: "Corn", tons: 10, revenue: 1800, completedAt: 0 });
      appendCompletedTask(save, { id: "b", type: "sellGrain", crop: "corn", label: "Corn", tons: 10, revenue: 1800, completedAt: 4 * MPM });
      expect(save.completedTasks).toHaveLength(2);
    });

    it("moves the merged row to the newest time so an in-progress run stays visible", () => {
      const save = newGame();
      appendCompletedTask(save, { id: "a", type: "sellGrain", crop: "corn", label: "Corn", tons: 10, revenue: 1800, completedAt: 10 });
      appendCompletedTask(save, { id: "b", type: "sellGrain", crop: "corn", label: "Corn", tons: 10, revenue: 1800, completedAt: 900 });
      expect(save.completedTasks![0]!.completedAt).toBe(900);
    });

    it("drops the field attribution once a total spans more than one source", () => {
      const save = newGame();
      appendCompletedTask(save, { id: "a", type: "sellBales", fieldId: "field-1", label: "Hay", bales: 4, revenue: 260, completedAt: 0 });
      appendCompletedTask(save, { id: "b", type: "sellBales", fieldId: "field-2", label: "Hay", bales: 6, revenue: 390, completedAt: 0 });
      const row = save.completedTasks!.find((c) => c.type === "sellBales")!;
      expect(row.bales).toBe(10);
      expect(row.fieldId).toBeUndefined(); // no longer honest to name one field
    });

    it("never merges field work — two plows on one field stay two rows", () => {
      const save = newGame();
      appendCompletedTask(save, { id: "p1", type: "plow", fieldId: "f", acres: 10, costPaid: 200, completedAt: 0 });
      appendCompletedTask(save, { id: "p2", type: "plow", fieldId: "f", acres: 10, costPaid: 200, completedAt: 5 });
      expect(save.completedTasks).toHaveLength(2);
    });
  });
});
