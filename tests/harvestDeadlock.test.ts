/**
 * The cart-reservation rule must never strand the machine it's reserving FOR.
 *
 * Maintainer report, 2026-07-25: "game stuck, waiting on a harvester for a
 * queued task. The harvester is Idle. I have the correct headers and the field
 * is ready to harvest."
 *
 * `shouldReserveForHarvest` holds an idle cart-capable TRACTOR back from field
 * work so it stays free to crew a combine's unload (2026-07-20). The pickup
 * loop, though, runs it over every idle agent — and every condition in it was
 * satisfiable by a COMBINE:
 *
 *   - "can use a grain trailer": `canPull` only compares SIZE classes, and a
 *     loose trailer is available to anything big enough;
 *   - "a combine exists in the fleet": trivially true;
 *   - "an uncrewed harvest exists": the queued harvest counts ITSELF;
 *   - "not enough free carts": a farm with no spare tractor has zero.
 *
 * So the combine stood down to be a grain cart for the very harvest it was
 * meant to be driving, and nothing ever moved. Worse, the ⚠️ blocked-work panel
 * stayed silent: every ownership and size check genuinely passed.
 *
 * Only tractors ever run `unloadHarvester` (TASK_AGENT_KIND), so nothing else
 * should ever stand down for one.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { setProjection } from "../src/geo/coords";
import type { Meters } from "../src/geo/coords";
import { newGame } from "../src/state/saveState";
import type { Field, SaveState } from "../src/state/saveState";
import { tickFarming } from "../src/sim/farming";
import { buyAgent, buyImplement, enqueueTask, tickTasks, blockedWork } from "../src/sim/tasks";
import { buyBuildingAt, assignSiloCrop } from "../src/sim/buildings";
import { minutesPerMonth } from "../src/sim/calendar";
import { gameConfig } from "../src/config/gameConfig";

beforeAll(() => setProjection(15, "N"));

const APRIL_1 = minutesPerMonth();

function readyCornField(acres = 40): Field {
  const side = Math.sqrt(acres * 4046.8564224);
  return {
    id: "field-1", parcelId: "p",
    boundary: [[0, 0], [side, 0], [side, side], [0, side]] as Meters[],
    accessPoints: [[side / 2, 0], [side / 2, side]] as Meters[],
    status: "ready", crop: "corn", trueYieldTonsPerAcre: 6,
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

describe("a combine never stands down as a grain cart", () => {
  it("harvests even when a loose Grain Trailer and no spare tractor exist", () => {
    // The exact reported shape: one combine, the right header at a size it can
    // carry, a Grain Trailer owned but unhitched, and NO tractor to pull it.
    const save = newGame();
    save.money = 30_000_000;
    const silo = buyBuildingAt(save, "silo", [-400, -400], "large");
    assignSiloCrop(save, silo.id, "corn");
    const combine = buyAgent(save, "harvester", "large", [0, 0]);
    buyImplement(save, "cornHeader", "large");
    buyImplement(save, "grainTrailer", "medium");
    const field = readyCornField();
    save.fields.push(field);
    const task = enqueueTask(save, field, "harvest", APRIL_1);

    run(save, 500);

    expect(task.status).toBe("active");
    expect(task.agentId).toBe(combine.id);
    expect(task.doneAcres).toBeGreaterThan(0);
  });

  it("...and the panel had nothing to report, which is why it read as a hang", () => {
    // Guards the diagnosis rather than the fix: this deadlock was invisible to
    // `blockedWork` because every ownership/size check passed. If a future
    // change makes the combine stall again, it will look like a hang again.
    const save = newGame();
    save.money = 30_000_000;
    buyAgent(save, "harvester", "large", [0, 0]);
    buyImplement(save, "cornHeader", "large");
    buyImplement(save, "grainTrailer", "medium");
    const field = readyCornField();
    save.fields.push(field);
    enqueueTask(save, field, "harvest", APRIL_1);

    expect(blockedWork(save)).toHaveLength(0);
  });

  it("still harvests with no Grain Trailer owned at all", () => {
    // The other side of the guard: nothing to reserve for, so nothing to stall.
    const save = newGame();
    save.money = 30_000_000;
    const silo = buyBuildingAt(save, "silo", [-400, -400], "large");
    assignSiloCrop(save, silo.id, "corn");
    buyAgent(save, "harvester", "medium", [0, 0]);
    buyImplement(save, "grainHeader", "medium");
    const field = { ...readyCornField(), crop: "soybeans" as const };
    save.fields.push(field);
    const task = enqueueTask(save, field, "harvest", APRIL_1);

    run(save, 500);
    expect(task.status).toBe("active");
  });

  it("a windrower isn't stalled by a loose Grain Trailer either", () => {
    // Same guard, same reason: the reserve check was reachable by ANY non-
    // tractor agent, and a windrower is sized "large", so a loose Medium
    // trailer looked like something it could go and crew with.
    const save = newGame();
    save.money = 30_000_000;
    buyAgent(save, "harvester", "medium", [0, 0]); // satisfies "a combine exists"
    buyAgent(save, "windrower", "large", [0, 0]);
    buyImplement(save, "grainTrailer", "medium");
    buyImplement(save, "grainHeader", "medium"); // deliberately the WRONG head for corn,
    // so the harvest can never start and `uncrewed` stays non-zero for good.

    const side = Math.sqrt(40 * 4046.8564224);
    const hay: Field = {
      id: "field-2", parcelId: "p",
      boundary: [[0, 0], [side, 0], [side, side], [0, side]] as Meters[],
      status: "ready", crop: "grass",
    };
    // The corn field sits well clear of the hay — an earlier version of this
    // test overlapped the two exactly and didn't reproduce the stall at all.
    const corn: Field = {
      id: "field-1", parcelId: "p",
      boundary: [[3000, 0], [3000 + side, 0], [3000 + side, side], [3000, side]] as Meters[],
      status: "ready", crop: "corn", trueYieldTonsPerAcre: 6,
      plantedAt: APRIL_1 - gameConfig.crops.corn.growMonths * minutesPerMonth(),
    };
    save.fields.push(hay, corn);
    enqueueTask(save, corn, "harvest", APRIL_1);
    const mow = enqueueTask(save, hay, "mow", APRIL_1);

    run(save, 20);
    expect(mow.status).toBe("active");
  });

  // NOTE: that a TRACTOR still stands down — the behaviour this guard narrows
  // rather than removes — is already covered, and covered better, by
  // "proactively pulls a free tractor onto a waiting combine ahead of queued
  // field work" in harvestUnload.test.ts. That one samples the whole run
  // instead of a single instant, so it can't pass by catching a lucky tick.
});
