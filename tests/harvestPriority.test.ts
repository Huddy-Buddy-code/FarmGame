/**
 * Two more scheduling calls from the maintainer, 2026-07-24:
 *
 *   "Prioritize largest harvester first"
 *   "Allow for bale collecting as soon as the bale is dropped, so during the
 *    baling task"
 *
 * Agents are picked over smallest-first, so the smallest capable tractor takes
 * a queued job and the big ones stay free for what only they can pull. That's
 * right for tractors and backwards for combines: header width is the whole
 * point of a big combine, and a harvest window is only `harvestWindowMonths`
 * long, so the biggest machine should claim the standing crop.
 *
 * Bale collection used to wait for the baler to finish the entire field. On a
 * big field that leaves the whole crop lying out while an idle hay-spikes rig
 * has nothing to do — the bales are collectable the moment they hit the ground.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { setProjection } from "../src/geo/coords";
import type { Meters } from "../src/geo/coords";
import { newGame } from "../src/state/saveState";
import type { Field, SaveState } from "../src/state/saveState";
import { tickFarming } from "../src/sim/farming";
import { buyAgent, buyImplement, enqueueTask, tickTasks } from "../src/sim/tasks";
import { buyBuildingAt, assignSiloCrop } from "../src/sim/buildings";
import { minutesPerMonth } from "../src/sim/calendar";
import { gameConfig } from "../src/config/gameConfig";

beforeAll(() => setProjection(15, "N"));

const side = Math.sqrt(100 * 4046.8564224); // 100 acres
const boundary: Meters[] = [[0, 0], [side, 0], [side, side], [0, side]];
const APRIL_1 = minutesPerMonth();

function run(save: SaveState, from: number, done: () => boolean, cap = 200_000, step = 30): void {
  let now = from;
  while (!done() && now - from < cap) {
    now += step;
    tickFarming(save, now);
    tickTasks(save, now, step, () => 0.5);
  }
}

describe("the biggest combine takes the harvest", () => {
  function twoCombines(bigFirst: boolean): SaveState {
    const save = newGame();
    save.money = 20_000_000;
    const silo = buyBuildingAt(save, "silo", [-400, -400], "large");
    assignSiloCrop(save, silo.id, "corn");
    // Buy in both orders across the two cases, so the result can't be an
    // accident of fleet order.
    for (const size of bigFirst ? (["large", "small"] as const) : (["small", "large"] as const)) {
      buyAgent(save, "harvester", size, [0, 0]);
      // One corn header each, matched to size — a combine can't cut without one
      // (2026-07-24), and a small one can't carry a large header.
      buyImplement(save, "cornHeader", size);
    }
    buyAgent(save, "tractor", "medium", [0, 0]);
    buyImplement(save, "grainTrailer", "medium");
    const field: Field = {
      id: "field-1", parcelId: "p", boundary, status: "ready", crop: "corn",
      trueYieldTonsPerAcre: 6,
      plantedAt: APRIL_1 - gameConfig.crops.corn.growMonths * minutesPerMonth(),
    };
    save.fields.push(field);
    enqueueTask(save, field, "harvest", APRIL_1);
    return save;
  }

  for (const bigFirst of [true, false]) {
    it(`the large combine claims it (bought ${bigFirst ? "first" : "second"})`, () => {
      const save = twoCombines(bigFirst);
      run(save, APRIL_1, () => save.tasks.some((t) => t.type === "harvest" && t.status === "active"), 20_000);
      const task = save.tasks.find((t) => t.type === "harvest")!;
      const agent = save.agents.find((a) => a.id === task.agentId);
      expect(agent?.kind).toBe("harvester");
      expect(agent?.size).toBe("large");
    });
  }

  it("tractors are still picked smallest-first", () => {
    // The combine rule must not leak into tractor selection: a small tractor
    // that can do the job should still take it and leave the big one free.
    const save = newGame();
    save.money = 20_000_000;
    buyAgent(save, "tractor", "large", [0, 0]);
    buyAgent(save, "tractor", "small", [0, 0]);
    buyImplement(save, "plow", "small");
    const field: Field = { id: "field-1", parcelId: "p", boundary, status: "stubble" };
    save.fields.push(field);
    enqueueTask(save, field, "plow", APRIL_1);

    run(save, APRIL_1, () => save.tasks.some((t) => t.status === "active"), 20_000);
    const task = save.tasks.find((t) => t.type === "plow")!;
    expect(save.agents.find((a) => a.id === task.agentId)?.size).toBe("small");
  });
});

describe("bales are collected while the baler is still working", () => {
  it("a haul job starts before the bale run finishes", () => {
    const save = newGame();
    save.money = 20_000_000;
    buyBuildingAt(save, "baleArea", [-400, -400]);
    // One rig to bale, one to collect.
    buyAgent(save, "tractor", "medium", [0, 0]);
    buyAgent(save, "tractor", "medium", [0, 0]);
    buyImplement(save, "bailer", "medium");
    buyImplement(save, "haySpikes", "medium");
    const field: Field = {
      id: "field-1", parcelId: "p", boundary, status: "harvested",
      lastCrop: "wheat", forageReady: true, windrowed: true, baleProduct: "straw",
    };
    save.fields.push(field);
    enqueueTask(save, field, "bale", APRIL_1);

    let haulSeenDuringBaling = false;
    run(save, APRIL_1, () => {
      const baling = save.tasks.some((t) => t.type === "bale");
      const hauling = save.tasks.some((t) => t.type === "haulBales" && t.fieldId === field.id);
      if (baling && hauling) haulSeenDuringBaling = true;
      return haulSeenDuringBaling;
    }, 200_000);

    expect(haulSeenDuringBaling).toBe(true);
  });

  it("still hauls when the bale run finishes before anything is free", () => {
    // No second tractor while baling — the end-of-run dispatch is still the
    // backstop, so the field never keeps its bales.
    const save = newGame();
    save.money = 20_000_000;
    buyBuildingAt(save, "baleArea", [-400, -400]);
    buyAgent(save, "tractor", "medium", [0, 0]);
    buyImplement(save, "bailer", "medium");
    buyImplement(save, "haySpikes", "medium");
    const field: Field = {
      id: "field-1", parcelId: "p", boundary, status: "harvested",
      lastCrop: "wheat", forageReady: true, windrowed: true, baleProduct: "straw",
    };
    save.fields.push(field);
    enqueueTask(save, field, "bale", APRIL_1);

    run(save, APRIL_1, () => !save.tasks.some((t) => t.type === "bale"), 200_000);
    expect(save.tasks.some((t) => t.type === "haulBales" && t.fieldId === field.id)).toBe(true);
  });
});
