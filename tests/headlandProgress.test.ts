/**
 * Headland progress accounting (maintainer report, 2026-07-24): "many of the
 * tasks are completing ~10% early compared to the tractor and texture change.
 * This leads to the tractor making much of the last headland with no more
 * texture changes."
 *
 * Root cause: `doneAcres` was computed as swept-metres x swath and CLAMPED to
 * the field's true acreage. That's exact for a field wide enough to hold its
 * headland laps, but a NARROW field's inner laps collapse into each other — the
 * rings still contribute perimeter (and so "work"), with no fresh ground under
 * them. `path.totalWork * swath` then overshoots the real acreage by ~10%, so
 * `doneAcres` (and the texture reveal, which main.ts derives from it) saturated
 * while the tractor still had a lap and a half left to drive.
 *
 * Two invariants pin it down:
 *   1. GEOMETRY — laps stop before they eat the field, so a route's working
 *      length x swath stays honest about the ground it covers.
 *   2. SIM — progress is a FRACTION of the route, so `doneAcres` can only reach
 *      `totalAcres` on the tick the machine actually reaches the end of the
 *      path. This one holds no matter what the geometry does.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { setProjection } from "../src/geo/coords";
import type { Meters } from "../src/geo/coords";
import { areaMeters } from "../src/geo/geometry";
import { buildHeadlandCoveragePath, buildHeadlandLaps, TASK_HEADLANDS } from "../src/sim/coverage";
import { newGame } from "../src/state/saveState";
import type { Field, SaveState } from "../src/state/saveState";
import { ensureAgents, buyImplement, tickTasks, enqueueTask } from "../src/sim/tasks";
import { tickFarming } from "../src/sim/farming";

beforeAll(() => setProjection(15, "N"));

const ACRE_M2 = 4046.8564224;
const FT = 0.3048;
/** Sim-minutes per tick. The strip is ~35 minutes of driving, so this has to
 * be small enough to sample the last few percent of the route. */
const STEP = 0.25;

function rect(w: number, h: number): Meters[] {
  return [[0, 0], [w, 0], [w, h], [0, h]];
}

/** Perimeter of a closed ring (it returns to its own first point). */
function ringLength(ring: Meters[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    sum += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return sum;
}

/** The ground a route actually claims to work: in-field metres x swath. */
function sweptAcres(boundary: Meters[], swath: number, laps: number, order: "first" | "last"): number {
  const path = buildHeadlandCoveragePath(boundary, swath, laps, order);
  return (path.totalWork * path.swath) / ACRE_M2;
}

const SHAPES: Array<[string, Meters[]]> = [
  ["600x50 strip", rect(600, 50)],
  ["600x70 strip", rect(600, 70)],
  ["800x120 strip", rect(800, 120)],
  ["400x300 field", rect(400, 300)],
  ["L-shape", [[0, 0], [500, 0], [500, 200], [250, 200], [250, 400], [0, 400]]],
  ["notched", [[0, 0], [600, 0], [600, 400], [350, 400], [350, 250], [250, 250], [250, 400], [0, 400]]],
];

describe("headland laps never cover the same ground twice", () => {
  // The precise thing the lap cap fixes: every lap must earn its keep. The band
  // the laps occupy is (field - innerBoundary), and driving `n` rings of total
  // length L at `swath` wide sweeps L x swath. If those two agree, no ring is
  // running back over its neighbour.
  for (const [name, boundary] of SHAPES) {
    for (const widthFt of [10, 20, 30, 40, 50]) {
      it(`${name} @ ${widthFt} ft: lap length x swath == the headland band's area`, () => {
        const swath = widthFt * FT;
        const { rings, innerBoundary } = buildHeadlandLaps(boundary, swath, 6);
        if (rings.length === 0) return; // too narrow for a single lap — nothing to check
        const bandArea = areaMeters(boundary) - areaMeters(innerBoundary);
        const swept = rings.reduce((sum, ring) => sum + ringLength(ring), 0) * swath;
        expect(swept).toBeGreaterThan(bandArea * 0.97);
        expect(swept).toBeLessThan(bandArea * 1.03);
      });
    }
  }
});

describe("a route's working length stays close to the field's acreage", () => {
  // The maintainer's reported case — a 600x70 m strip worked by the 20 ft
  // (Large) plow's six laps — measured 1.117 before the lap cap.
  it("the reported ~10% overshoot is gone", () => {
    const boundary = rect(600, 70);
    const acres = areaMeters(boundary) / ACRE_M2;
    expect(sweptAcres(boundary, 20 * FT, 6, "last") / acres).toBeLessThan(1.05);
  });

  it("no headland config runs away on a narrow strip", () => {
    // A residual few percent survives on very thin fields, from the INTERIOR
    // fill rather than the laps: a remnant thinner than one swath still gets a
    // full-width lane's worth of credit (`buildCoveragePath`'s `height <= swath`
    // branch). That only stretches how long a job takes relative to its
    // acreage, which is defensible — an awkward field really is more driving —
    // and it can no longer desync anything, because progress is measured as a
    // fraction of the route (see the suite below). This guards the runaway.
    const boundary = rect(600, 70);
    const acres = areaMeters(boundary) / ACRE_M2;
    for (const [type, cfg] of Object.entries(TASK_HEADLANDS)) {
      for (const widthFt of [20, 35, 50]) {
        const ratio = sweptAcres(boundary, widthFt * FT, cfg!.laps, cfg!.order) / acres;
        expect(ratio, `${type} @ ${widthFt} ft`).toBeLessThan(1.1);
      }
    }
  });

  it("still covers the whole field — laps are capped, not dropped", () => {
    for (const [name, boundary] of SHAPES) {
      const acres = areaMeters(boundary) / ACRE_M2;
      for (const widthFt of [10, 20, 40]) {
        const swept = sweptAcres(boundary, widthFt * FT, 6, "last");
        expect(swept, `${name} @ ${widthFt} ft`).toBeGreaterThanOrEqual(acres * 0.97);
      }
    }
  });
});

describe("progress and the machine finish together", () => {
  /** A narrow field + the widest plow sold: the shape that used to saturate
   * `doneAcres` a lap and a half before the tractor stopped driving. */
  function plowingStrip(): { save: SaveState; field: Field } {
    const save = newGame();
    ensureAgents(save, [0, 0]);
    // Swap the starter medium plow for a large one, hitched — the swath has to
    // be the WIDE tool or the strip is roomy enough to hide the bug.
    save.implements = save.implements!.filter((i) => i.kind !== "plow");
    const plow = buyImplement(save, "plow", "large");
    const tractor = save.agents.find((a) => a.kind === "tractor")!;
    tractor.size = "large";
    plow.attachedTo = tractor.id;
    const field: Field = { id: "field-1", parcelId: "p", boundary: rect(600, 70), status: "stubble" };
    save.fields.push(field);
    enqueueTask(save, field, "plow", 0);
    return { save, field };
  }

  it("doneAcres never reaches totalAcres while the task is still running", () => {
    const { save, field } = plowingStrip();
    let saturatedWhileActive = false;
    // Fine steps: the old bug left ~10% of the route to drive after saturation,
    // and a coarse step (the route is only ~35 sim-minutes of driving) would
    // jump clean over it.
    for (let now = 0; now < 200_000 && field.status !== "tilled"; now += STEP) {
      tickFarming(save, now);
      tickTasks(save, now, STEP, () => 0.5);
      const task = save.tasks.find((t) => t.type === "plow");
      if (task?.status === "active" && task.doneAcres >= task.totalAcres - 1e-9) saturatedWhileActive = true;
    }
    expect(field.status).toBe("tilled");
    expect(saturatedWhileActive).toBe(false);
  });

  it("progress climbs all the way to the end instead of flat-lining", () => {
    const { save, field } = plowingStrip();
    // The fraction done at the LAST tick before completion should be close to
    // 1 — a flat-lined bar would have sat at exactly 1 for many ticks first.
    let lastActiveFraction = 0;
    for (let now = 0; now < 200_000 && field.status !== "tilled"; now += STEP) {
      tickFarming(save, now);
      tickTasks(save, now, STEP, () => 0.5);
      const task = save.tasks.find((t) => t.type === "plow");
      if (task?.status === "active" && task.totalAcres > 0) lastActiveFraction = task.doneAcres / task.totalAcres;
    }
    expect(lastActiveFraction).toBeGreaterThan(0.98);
    expect(lastActiveFraction).toBeLessThan(1);
  });
});
