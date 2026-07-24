/**
 * On-board grain storage is VOLUME, not weight (maintainer decision,
 * 2026-07-24: "make the amount stored dynamic and crop dependent — each crop
 * should have a volume per ton").
 *
 * A combine tank and a grain cart hold so many BUSHELS whatever's in them, so
 * how many TONS that is depends on the crop's test weight. Sunflowers are half
 * corn's density, so the same cart carries half the tonnage and the farm needs
 * twice the trips per ton hauled.
 *
 * The maintainer chose realistic numbers over preserving the old scale ("let it
 * bite") — a Medium combine went from a flat 50 t to 350 bu, under 10 t of corn.
 * Hauling is meant to be the bottleneck of harvest season.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { setProjection } from "../src/geo/coords";
import type { Meters } from "../src/geo/coords";
import { newGame } from "../src/state/saveState";
import type { Field, SaveState } from "../src/state/saveState";
import { tickFarming } from "../src/sim/farming";
import {
  buyAgent, buyImplement, enqueueTask, tickTasks,
  tonsPerBushel, harvesterCapacityTons, harvesterCapacityBushels,
  grainTrailerCapacityTons, grainTrailerCapacityBushels,
} from "../src/sim/tasks";
import { buyBuildingAt, assignSiloCrop } from "../src/sim/buildings";
import { minutesPerMonth } from "../src/sim/calendar";
import { gameConfig } from "../src/config/gameConfig";
import type { CropId, EquipmentSize } from "../src/config/gameConfig";

beforeAll(() => setProjection(15, "N"));

const APRIL_1 = minutesPerMonth();
const SIZES: EquipmentSize[] = ["small", "medium", "large"];

describe("test weights", () => {
  it("every grain crop declares one", () => {
    for (const crop of Object.keys(gameConfig.crops) as CropId[]) {
      const cfg = gameConfig.crops[crop];
      if (cfg.producesGrain === false) continue; // perennials yield bales, never a hopper load
      expect(cfg.bushelWeightLbs, crop).toBeGreaterThan(0);
    }
  });

  it("converts to tons at 2000 lb", () => {
    expect(tonsPerBushel("corn")).toBeCloseTo(56 / 2000, 9);
    expect(tonsPerBushel("soybeans")).toBeCloseTo(60 / 2000, 9);
    expect(tonsPerBushel("oats")).toBeCloseTo(32 / 2000, 9);
  });

  it("falls back to corn for a crop that declares none", () => {
    // Grass has no test weight — its yield is bales. Anything that asks anyway
    // must get a sane number rather than NaN or zero.
    expect(tonsPerBushel("grass")).toBe(tonsPerBushel("corn"));
    expect(tonsPerBushel("grass")).toBeGreaterThan(0);
  });

  it("oats and sunflowers really are the bulky ones", () => {
    // The whole point of the mechanic: light crops eat volume.
    expect(tonsPerBushel("oats")).toBeLessThan(tonsPerBushel("corn"));
    expect(tonsPerBushel("sunflowers")).toBeLessThan(tonsPerBushel("corn") * 0.6);
    expect(tonsPerBushel("soybeans")).toBeGreaterThan(tonsPerBushel("corn"));
  });
});

describe("capacity is volume, converted per crop", () => {
  for (const size of SIZES) {
    it(`a ${size} combine holds the same bushels of anything, but fewer tons of a light crop`, () => {
      const bu = harvesterCapacityBushels(size);
      expect(harvesterCapacityTons(size, "corn")).toBeCloseTo(bu * tonsPerBushel("corn"), 9);
      expect(harvesterCapacityTons(size, "sunflowers")).toBeLessThan(harvesterCapacityTons(size, "corn"));
      expect(harvesterCapacityTons(size, "soybeans")).toBeGreaterThan(harvesterCapacityTons(size, "corn"));
    });
  }

  it("the same holds for grain carts", () => {
    const bu = grainTrailerCapacityBushels("medium");
    expect(grainTrailerCapacityTons("medium", "corn")).toBeCloseTo(bu * tonsPerBushel("corn"), 9);
    expect(grainTrailerCapacityTons("medium", "oats")).toBeLessThan(grainTrailerCapacityTons("medium", "corn"));
  });

  it("defaults to corn when no crop is given (shop/display contexts)", () => {
    expect(harvesterCapacityTons("medium")).toBe(harvesterCapacityTons("medium", "corn"));
    expect(grainTrailerCapacityTons("large")).toBe(grainTrailerCapacityTons("large", "corn"));
  });

  it("the Small cart is smaller than the biggest tank, so partial drains stay reachable", () => {
    // Not incidental: if every cart were bigger than every hopper, the
    // "trailer can't empty the combine in one go" path would be dead code.
    expect(grainTrailerCapacityBushels("small")).toBeLessThan(harvesterCapacityBushels("large"));
  });

  it("both ladders go up with size", () => {
    expect(harvesterCapacityBushels("small")).toBeLessThan(harvesterCapacityBushels("medium"));
    expect(harvesterCapacityBushels("medium")).toBeLessThan(harvesterCapacityBushels("large"));
    expect(grainTrailerCapacityBushels("small")).toBeLessThan(grainTrailerCapacityBushels("medium"));
    expect(grainTrailerCapacityBushels("medium")).toBeLessThan(grainTrailerCapacityBushels("large"));
  });
});

describe("the combine actually stops at the crop's tonnage", () => {
  function harvestUntilFull(crop: CropId): number {
    const save: SaveState = newGame();
    save.money = 20_000_000;
    const silo = buyBuildingAt(save, "silo", [-400, -400], "large");
    assignSiloCrop(save, silo.id, crop);
    const combine = buyAgent(save, "harvester", "medium", [0, 0]);
    buyImplement(save, harvestHeaderFor(crop), "medium");
    const acres = 200;
    const side = Math.sqrt(acres * 4046.8564224);
    const field: Field = {
      id: "field-1", parcelId: "p",
      boundary: [[0, 0], [side, 0], [side, side], [0, side]] as Meters[],
      status: "ready", crop, trueYieldTonsPerAcre: 6,
      plantedAt: APRIL_1 - gameConfig.crops[crop].growMonths * minutesPerMonth(),
    };
    save.fields.push(field);
    enqueueTask(save, field, "harvest", APRIL_1);

    // No cart anywhere, so it fills and stops — exactly what's being measured.
    let now = APRIL_1;
    const cap = harvesterCapacityTons("medium", crop);
    while ((combine.grainOnboard ?? 0) < cap - 1e-6 && now - APRIL_1 < 50_000) {
      now += 5;
      tickFarming(save, now);
      tickTasks(save, now, 5, () => 0.5);
    }
    return combine.grainOnboard ?? 0;
  }

  const harvestHeaderFor = (crop: CropId) => (crop === "corn" ? "cornHeader" : "grainHeader") as const;

  it("corn fills to its own tonnage", () => {
    expect(harvestUntilFull("corn")).toBeCloseTo(harvesterCapacityTons("medium", "corn"), 3);
  });

  it("sunflowers fill the same tank with far less weight", () => {
    const corn = harvestUntilFull("corn");
    const sunflowers = harvestUntilFull("sunflowers");
    expect(sunflowers).toBeCloseTo(harvesterCapacityTons("medium", "sunflowers"), 3);
    expect(sunflowers).toBeLessThan(corn * 0.6);
  });
});
