/**
 * A baler has no working width of its own (maintainer note, 2026-07-24):
 *
 *   "It's working width needs to be dependent on the rake's working width. The
 *    baler itself does not have a working width, but it will need to know what
 *    rake is working the field or worked the field last. For Straw baling, it's
 *    similar, but it's width will depend on the Harvester's working width
 *    because there is no rake task."
 *
 * A baler swallows a windrow, so the ground it clears per pass is whatever laid
 * that windrow down. The field carries the answer (`Field.windrowWidthM`),
 * written by whichever task last put material on the ground — harvest or mow
 * first, then the rake if the crop gets one. That ordering falls out for free
 * and is exactly the rule wanted: raked crops take the rake's width, and straw
 * (which skips the rake) keeps the combine header's.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { setProjection } from "../src/geo/coords";
import type { Meters } from "../src/geo/coords";
import { newGame } from "../src/state/saveState";
import type { Field, SaveState } from "../src/state/saveState";
import { tickFarming } from "../src/sim/farming";
import { buyAgent, buyImplement, enqueueTask, tickTasks, getCoveragePath, ensureAgents } from "../src/sim/tasks";
import { buyBuildingAt, assignSiloCrop } from "../src/sim/buildings";
import { minutesPerMonth } from "../src/sim/calendar";
import { gameConfig, FEET_TO_METERS } from "../src/config/gameConfig";
import type { EquipmentSize } from "../src/config/gameConfig";

beforeAll(() => setProjection(15, "N"));

const side = Math.sqrt(40 * 4046.8564224);
const boundary: Meters[] = [[0, 0], [side, 0], [side, side], [0, side]];
const APRIL_1 = minutesPerMonth();

function run(save: SaveState, done: () => boolean, cap = 300_000, step = 15): void {
  let now = APRIL_1;
  while (!done() && now - APRIL_1 < cap) {
    now += step;
    tickFarming(save, now);
    tickTasks(save, now, step, () => 0.5);
  }
}

/** The swath the active bale task is actually driving. */
function baleSwath(save: SaveState): number | undefined {
  const task = save.tasks.find((t) => t.type === "bale" && t.status === "active");
  return task ? getCoveragePath(save, task)?.swath : undefined;
}

describe("a raked crop bales at the RAKE's width", () => {
  function rakeThenBale(rakeSize: EquipmentSize): number {
    const save = newGame();
    save.money = 30_000_000;
    buyBuildingAt(save, "baleArea", [-400, -400]);
    // Two rigs so the rake and baler can run together, as they do in the game.
    buyAgent(save, "tractor", "large", [0, 0]);
    buyAgent(save, "tractor", "large", [0, 0]);
    buyImplement(save, "rake", rakeSize);
    buyImplement(save, "bailer", "medium");
    // Grass: a crop that needs raking (unlike straw).
    const field: Field = {
      id: "field-1", parcelId: "p", boundary, status: "harvested",
      crop: "grass", forageReady: true,
    };
    save.fields.push(field);
    enqueueTask(save, field, "rake", APRIL_1);
    enqueueTask(save, field, "bale", APRIL_1);

    let swath: number | undefined;
    run(save, () => {
      swath ??= baleSwath(save);
      return swath !== undefined;
    });
    expect(swath).toBeDefined();
    return swath!;
  }

  for (const size of ["small", "medium", "large"] as EquipmentSize[]) {
    it(`a ${size} rake (${gameConfig.equipment.rake[size].widthFt} ft) sets the baler's pass`, () => {
      expect(rakeThenBale(size)).toBeCloseTo(gameConfig.equipment.rake[size].widthFt * FEET_TO_METERS, 6);
    });
  }

  it("a wider rake really does mean a wider bale pass", () => {
    expect(rakeThenBale("large")).toBeGreaterThan(rakeThenBale("small"));
  });
});

describe("straw bales at the COMBINE HEADER's width", () => {
  /** Wheat, harvested with `headerSize`, then baled — no rake anywhere. */
  function harvestThenBale(headerSize: EquipmentSize): number {
    const save = newGame();
    save.money = 30_000_000;
    const silo = buyBuildingAt(save, "silo", [-500, -500], "large");
    assignSiloCrop(save, silo.id, "wheat");
    buyBuildingAt(save, "baleArea", [-400, -400]);
    buyAgent(save, "harvester", "large", [0, 0]);
    buyImplement(save, "grainHeader", headerSize);
    buyAgent(save, "tractor", "large", [0, 0]);
    buyImplement(save, "grainTrailer", "medium");
    buyAgent(save, "tractor", "large", [0, 0]);
    buyImplement(save, "bailer", "medium");
    // Deliberately NO rake owned — straw skips it.
    const field: Field = {
      id: "field-1", parcelId: "p", boundary, status: "ready", crop: "wheat",
      trueYieldTonsPerAcre: 2.9,
      plantedAt: APRIL_1 - gameConfig.crops.wheat.growMonths * minutesPerMonth(),
    };
    save.fields.push(field);
    enqueueTask(save, field, "harvest", APRIL_1);

    let swath: number | undefined;
    run(save, () => {
      if (field.status === "harvested" && field.forageReady && !save.tasks.some((t) => t.type === "bale")) {
        enqueueTask(save, field, "bale", APRIL_1);
      }
      swath ??= baleSwath(save);
      return swath !== undefined;
    }, 600_000);
    expect(swath).toBeDefined();
    expect(save.implements.some((i) => i.kind === "rake")).toBe(false);
    return swath!;
  }

  for (const size of ["small", "large"] as EquipmentSize[]) {
    it(`a ${size} grain header (${gameConfig.equipment.grainHeader[size].widthFt} ft) sets the straw pass`, () => {
      expect(harvestThenBale(size)).toBeCloseTo(gameConfig.equipment.grainHeader[size].widthFt * FEET_TO_METERS, 6);
    });
  }
});

describe("the rake has the final say when there is one", () => {
  it("a rake overwrites the width the harvest recorded", () => {
    // Ordering check: harvest writes the header width, then the rake (on a crop
    // that gets one) overwrites it. If that ever inverted, raked crops would
    // silently bale at header width.
    const save = newGame();
    save.money = 30_000_000;
    ensureAgents(save, [0, 0]);
    const field: Field = { id: "field-1", parcelId: "p", boundary, status: "harvested", crop: "grass", forageReady: true };
    save.fields.push(field);
    field.windrowWidthM = 999; // stand-in for whatever cut it
    buyAgent(save, "tractor", "large", [0, 0]);
    buyImplement(save, "rake", "large");
    enqueueTask(save, field, "rake", APRIL_1);

    run(save, () => (field.windrowWidthM ?? 999) !== 999);
    expect(field.windrowWidthM).toBeCloseTo(gameConfig.equipment.rake.large.widthFt * FEET_TO_METERS, 6);
  });
});

describe("save migration: the Large baler WAS the square baler", () => {
  it("converts a Large bailer into a Square Baler, keeping what was paid for", () => {
    const save = newGame();
    ensureAgents(save, [0, 0]);
    save.implements.push({ id: "bailer-9", kind: "bailer", size: "large", purchaseCost: 260_000 });
    ensureAgents(save, [0, 0]); // reload
    expect(save.implements.some((i) => i.kind === "bailer" && i.size === "large")).toBe(false);
    const square = save.implements.find((i) => i.kind === "squareBaler");
    expect(square).toBeDefined();
    expect(square!.size).toBe("medium");
  });

  it("promotes a Small bailer to Medium — the tier is gone", () => {
    const save = newGame();
    ensureAgents(save, [0, 0]);
    save.implements.push({ id: "bailer-8", kind: "bailer", size: "small", purchaseCost: 90_000 });
    ensureAgents(save, [0, 0]);
    expect(save.implements.some((i) => i.kind === "bailer" && i.size === "small")).toBe(false);
    expect(save.implements.some((i) => i.kind === "bailer" && i.size === "medium")).toBe(true);
  });
});
