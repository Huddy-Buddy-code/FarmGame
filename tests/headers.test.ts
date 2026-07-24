/**
 * Combine headers (maintainer decision, 2026-07-24): "Separate implements,
 * required." A combine is no longer self-contained — it needs a header hitched,
 * and WHICH header depends on the crop. Corn is stripped off standing stalks by
 * row units; everything else is cut off at the base by a platform. So a
 * corn-and-beans rotation needs both, and a small-grains farm never buys a corn
 * head at all.
 *
 * The header is also what the coverage path is now measured by — that's the
 * point of buying a wide one, and it's why the combine's own `widthFt` demoted
 * to a nominal reference number.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { setProjection } from "../src/geo/coords";
import type { Meters } from "../src/geo/coords";
import { newGame } from "../src/state/saveState";
import type { Field, SaveState } from "../src/state/saveState";
import { tickFarming } from "../src/sim/farming";
import {
  ensureAgents, buyAgent, buyImplement, enqueueTask, tickTasks, blockedWork,
  harvestHeaderKind, getCoveragePath,
} from "../src/sim/tasks";
import { buyBuildingAt, assignSiloCrop } from "../src/sim/buildings";
import { minutesPerMonth } from "../src/sim/calendar";
import { gameConfig, FEET_TO_METERS } from "../src/config/gameConfig";
import type { CropId } from "../src/config/gameConfig";

beforeAll(() => setProjection(15, "N"));

const side = Math.sqrt(100 * 4046.8564224);
const boundary: Meters[] = [[0, 0], [side, 0], [side, side], [0, side]];
const APRIL_1 = minutesPerMonth();
/** Comfortably inside the 2-month harvest window, so a "this never starts"
 * assertion isn't quietly invalidated by the crop withering and the queued
 * task being binned. */
const WITHIN_WINDOW = minutesPerMonth();

function run(save: SaveState, from: number, done: () => boolean, cap = 100_000, step = 30): void {
  let now = from;
  while (!done() && now - from < cap) {
    now += step;
    tickFarming(save, now);
    tickTasks(save, now, step, () => 0.5);
  }
}

function readyField(crop: CropId): Field {
  return {
    id: "field-1", parcelId: "p", boundary, status: "ready", crop,
    trueYieldTonsPerAcre: 3,
    plantedAt: APRIL_1 - gameConfig.crops[crop].growMonths * minutesPerMonth(),
  };
}

/** A combine, a cart and a silo — but NO header, deliberately. */
function bareCombineFarm(crop: CropId): { save: SaveState; field: Field } {
  const save = newGame();
  save.money = 20_000_000;
  const silo = buyBuildingAt(save, "silo", [-400, -400], "large");
  assignSiloCrop(save, silo.id, crop);
  buyAgent(save, "harvester", "medium", [0, 0]);
  buyAgent(save, "tractor", "medium", [0, 0]);
  buyImplement(save, "grainTrailer", "medium");
  const field = readyField(crop);
  save.fields.push(field);
  return { save, field };
}

describe("which header a crop needs", () => {
  it("corn takes the corn header; everything else takes the grain header", () => {
    expect(harvestHeaderKind("corn")).toBe("cornHeader");
    for (const crop of ["soybeans", "wheat", "rye", "oats", "barley", "canola", "sunflowers"] as CropId[]) {
      expect(harvestHeaderKind(crop), crop).toBe("grainHeader");
    }
  });
});

describe("a combine can't cut without the right header", () => {
  it("a headerless combine never starts the harvest", () => {
    const { save, field } = bareCombineFarm("corn");
    enqueueTask(save, field, "harvest", APRIL_1);
    // Stay well inside the harvest window: past it the crop withers and
    // `dropStrandedHarvests` bins the queued task, so there'd be nothing left
    // to assert on.
    run(save, APRIL_1, () => save.tasks.some((t) => t.type === "harvest" && t.status === "active"), WITHIN_WINDOW);
    expect(save.tasks.find((t) => t.type === "harvest")?.status).toBe("queued");
    expect(field.status).toBe("ready");
  });

  it("...and says so, by name, in the blocked-work list", () => {
    const { save, field } = bareCombineFarm("corn");
    enqueueTask(save, field, "harvest", APRIL_1);
    const blocked = blockedWork(save).find((b) => b.type === "harvest");
    expect(blocked?.reason).toBe("No Corn Header owned");
  });

  it("a grain header does NOT let it cut corn", () => {
    const { save, field } = bareCombineFarm("corn");
    buyImplement(save, "grainHeader", "medium");
    enqueueTask(save, field, "harvest", APRIL_1);
    run(save, APRIL_1, () => save.tasks.some((t) => t.type === "harvest" && t.status === "active"), WITHIN_WINDOW);
    expect(save.tasks.find((t) => t.type === "harvest")?.status).toBe("queued");
    expect(blockedWork(save).find((b) => b.type === "harvest")?.reason).toBe("No Corn Header owned");
  });

  it("a corn header does NOT let it cut soybeans", () => {
    const { save, field } = bareCombineFarm("soybeans");
    buyImplement(save, "cornHeader", "medium");
    enqueueTask(save, field, "harvest", APRIL_1);
    expect(blockedWork(save).find((b) => b.type === "harvest")?.reason).toBe("No Grain Header owned");
  });

  it("with the right header it hitches itself and cuts", () => {
    const { save, field } = bareCombineFarm("corn");
    const header = buyImplement(save, "cornHeader", "medium");
    enqueueTask(save, field, "harvest", APRIL_1);
    run(save, APRIL_1, () => save.tasks.some((t) => t.type === "harvest" && t.status === "active"), WITHIN_WINDOW);
    const combine = save.agents.find((a) => a.kind === "harvester")!;
    expect(header.attachedTo).toBe(combine.id);
    run(save, APRIL_1, () => field.status === "harvested");
    expect(field.status).toBe("harvested");
  });

  it("a header too big for the combine is called out as such", () => {
    const save = newGame();
    save.money = 20_000_000;
    buyAgent(save, "harvester", "small", [0, 0]);
    buyImplement(save, "cornHeader", "large"); // owned, but won't fit a small combine
    const field = readyField("corn");
    save.fields.push(field);
    enqueueTask(save, field, "harvest", APRIL_1);
    expect(blockedWork(save).find((b) => b.type === "harvest")?.reason)
      .toBe("No combine big enough for the Corn Header");
  });
});

describe("the header's width drives the cut", () => {
  it("the coverage path is laid out at the header's width, not the combine's", () => {
    const { save, field } = bareCombineFarm("corn");
    buyImplement(save, "cornHeader", "small"); // 20 ft, vs the medium combine's 30 ft nominal
    enqueueTask(save, field, "harvest", APRIL_1);
    run(save, APRIL_1, () => save.tasks.some((t) => t.type === "harvest" && t.status === "active"), WITHIN_WINDOW);

    const task = save.tasks.find((t) => t.type === "harvest")!;
    const path = getCoveragePath(save, task)!;
    expect(path.swath).toBeCloseTo(gameConfig.equipment.cornHeader.small.widthFt * FEET_TO_METERS, 6);
    // The point of the change: it is NOT the combine tier's number any more.
    expect(path.swath).not.toBeCloseTo(gameConfig.equipment.harvester.medium.widthFt * FEET_TO_METERS, 6);
  });

  it("a wider header finishes the same field sooner", () => {
    const times: number[] = [];
    for (const size of ["small", "large"] as const) {
      const save = newGame();
      save.money = 20_000_000;
      const silo = buyBuildingAt(save, "silo", [-400, -400], "large");
      assignSiloCrop(save, silo.id, "corn");
      buyAgent(save, "harvester", "large", [0, 0]);
      // Large tractor for the large trailer — a medium one can't pull it, and
      // an uncrewed cart leaves the combine sat full forever.
      buyAgent(save, "tractor", "large", [0, 0]);
      buyImplement(save, "grainTrailer", "large");
      buyImplement(save, "cornHeader", size);
      const field = readyField("corn");
      save.fields.push(field);
      enqueueTask(save, field, "harvest", APRIL_1);

      let now = APRIL_1;
      while (field.status !== "harvested" && now - APRIL_1 < 400_000) {
        now += 30;
        tickFarming(save, now);
        tickTasks(save, now, 30, () => 0.5);
      }
      expect(field.status).toBe("harvested");
      times.push(now - APRIL_1);
    }
    expect(times[1]).toBeLessThan(times[0]!);
  });
});

describe("headers are granted to saves that predate them", () => {
  it("a fresh farm starts with both, corn head fitted", () => {
    const save = newGame();
    ensureAgents(save, [0, 0]);
    const combine = save.agents.find((a) => a.kind === "harvester")!;
    expect(save.implements.filter((i) => i.kind === "cornHeader")).toHaveLength(1);
    expect(save.implements.filter((i) => i.kind === "grainHeader")).toHaveLength(1);
    expect(save.implements.find((i) => i.kind === "cornHeader")?.attachedTo).toBe(combine.id);
  });

  it("an existing save with the starter flag already set still gets them", () => {
    // The exact shape of a pre-2026-07-24 save: fleet granted long ago, so the
    // starter block is skipped entirely. Without its own flag the combine would
    // be silently bricked by this update.
    const save = newGame();
    ensureAgents(save, [0, 0]);
    save.implements = save.implements.filter((i) => i.kind !== "cornHeader" && i.kind !== "grainHeader");
    save.headersGranted = undefined;
    expect(save.starterFleetGranted).toBe(true);

    ensureAgents(save, [0, 0]);
    expect(save.implements.some((i) => i.kind === "cornHeader")).toBe(true);
    expect(save.implements.some((i) => i.kind === "grainHeader")).toBe(true);
  });

  it("doesn't re-grant them after the player sells one", () => {
    const save = newGame();
    ensureAgents(save, [0, 0]);
    save.implements = save.implements.filter((i) => i.kind !== "cornHeader");
    ensureAgents(save, [0, 0]); // reload
    expect(save.implements.some((i) => i.kind === "cornHeader")).toBe(false);
  });
});
