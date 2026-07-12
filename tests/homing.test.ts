import { describe, it, expect, beforeAll } from "vitest";
import { setProjection } from "../src/geo/coords";
import type { Meters } from "../src/geo/coords";
import { newGame } from "../src/state/saveState";
import type { Field, SaveState } from "../src/state/saveState";
import { ensureAgents, enqueueTask, tickTasks } from "../src/sim/tasks";
import { tickFarming } from "../src/sim/farming";
import { buyBuildingAt } from "../src/sim/buildings";
import { gameConfig } from "../src/config/gameConfig";
import { minutesPerMonth } from "../src/sim/calendar";

/** Plowing is winter-only (Dec–Feb) — start these tests there. */
const WINTER_1 = 9 * minutesPerMonth();

beforeAll(() => setProjection(15, "N"));

// A 20-acre-ish square field, well away from the origin so "drive home"
// covers real distance.
const side = Math.sqrt(20 * 4046.8564224);
const boundary: Meters[] = [[500, 500], [500 + side, 500], [500 + side, 500 + side], [500, 500 + side]];

function freshField(): Field {
  return { id: "field-1", parcelId: "parcel-1", boundary, status: "stubble" };
}

/** Run the world forward until `done()` or the cap — plow only needs tasks,
 * not growth, but tickFarming is cheap and matches main.ts's tick order. */
function runUntil(save: SaveState, from: number, done: () => boolean, capMinutes = 200_000, step = 60): number {
  let now = from;
  while (!done() && now - from < capMinutes) {
    now += step;
    tickFarming(save, now);
    tickTasks(save, now, step, () => 0.5);
  }
  return now;
}

function samePos(a: Meters, b: Meters): boolean {
  return Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.5;
}

describe("equipment homing to Tractor Barn / Farm Yard (maintainer request, 2026-07-12)", () => {
  it("with no buildings, a tractor stays exactly where its task finished (unchanged pre-buildings behavior)", () => {
    const save = newGame();
    ensureAgents(save, [0, 0]);
    const field = freshField();
    save.fields.push(field);
    const tractor = save.agents.find((a) => a.kind === "tractor")!;

    let now = WINTER_1;
    enqueueTask(save, field, "plow", now);
    now = runUntil(save, now, () => field.status === "tilled");
    const posAtFinish: Meters = [...tractor.pos];
    now = runUntil(save, now, () => false, 5000); // let it idle a while longer
    expect(tractor.pos).toEqual(posAtFinish);
  });

  it("drives to the nearest Tractor Barn once one's been built, and stops there", () => {
    const save = newGame();
    ensureAgents(save, [0, 0]);
    const field = freshField();
    save.fields.push(field);
    const barn = buyBuildingAt(save, "tractorBarn", [50, 50]);
    const tractor = save.agents.find((a) => a.kind === "tractor")!;

    let now = WINTER_1;
    enqueueTask(save, field, "plow", now);
    now = runUntil(save, now, () => field.status === "tilled");
    now = runUntil(save, now, () => samePos(tractor.pos, barn.pos), 20_000);
    expect(samePos(tractor.pos, barn.pos)).toBe(true);
    expect(tractor.state).toBe("idle");
  });

  it("falls back to the nearest Farm Yard when every Tractor Barn is full", () => {
    const save = newGame();
    ensureAgents(save, [0, 0]);
    // A second tractor so the one barn slot (this test's farm builds a barn
    // with room for exactly its own starting fleet minus one) fills up.
    const field = freshField();
    save.fields.push(field);
    const barn = buyBuildingAt(save, "tractorBarn", [50, 50]);
    const yard = buyBuildingAt(save, "farmYard", [-500, -500]);
    const tractor = save.agents.find((a) => a.kind === "tractor")!;

    // Fill every barn slot with idle decoy tractors already parked there.
    for (let i = 0; i < gameConfig.buildings.tractorBarn.slots; i++) {
      save.agents.push({
        id: `decoy-${i}`, kind: "tractor", name: `Decoy ${i}`, size: "medium",
        pos: [barn.pos[0], barn.pos[1]], state: "idle",
      });
    }

    let now = WINTER_1;
    enqueueTask(save, field, "plow", now);
    now = runUntil(save, now, () => field.status === "tilled");
    now = runUntil(save, now, () => samePos(tractor.pos, yard.pos), 20_000);
    expect(samePos(tractor.pos, yard.pos)).toBe(true);
    expect(samePos(tractor.pos, barn.pos)).toBe(false);
  });

  it("picks the NEAREST Tractor Barn with room, not just the first one built", () => {
    const save = newGame();
    ensureAgents(save, [0, 0]);
    const field = freshField();
    save.fields.push(field);
    const far = buyBuildingAt(save, "tractorBarn", [5000, 5000]);
    const near = buyBuildingAt(save, "tractorBarn", [520, 520]);
    const tractor = save.agents.find((a) => a.kind === "tractor")!;

    let now = WINTER_1;
    enqueueTask(save, field, "plow", now);
    now = runUntil(save, now, () => field.status === "tilled");
    now = runUntil(save, now, () => samePos(tractor.pos, near.pos) || samePos(tractor.pos, far.pos), 20_000);
    expect(samePos(tractor.pos, near.pos)).toBe(true);
    expect(samePos(tractor.pos, far.pos)).toBe(false);
  });
});
