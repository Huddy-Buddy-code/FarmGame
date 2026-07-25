/**
 * The config-only half of the 2026-07-24 equipment pass: new sizes, wider
 * windows for the small grains, and a real cap on outdoor bale storage.
 *
 * These are balance numbers, so most of them are only worth asserting where a
 * number feeds a RULE rather than a label — a wider `plantMonths` changes what
 * the planting gate accepts, a per-crop `harvestWindowMonths` changes when a
 * crop withers, and a finite bale-area capacity is what makes the hauler's
 * sell-instead-of-store fallback reachable at all.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { setProjection } from "../src/geo/coords";
import type { Meters } from "../src/geo/coords";
import { gameConfig } from "../src/config/gameConfig";
import type { CropId } from "../src/config/gameConfig";
import { newGame } from "../src/state/saveState";
import type { Field } from "../src/state/saveState";
import { harvestWindowMonthsFor, harvestWindowClosed, inPlantingWindow } from "../src/sim/farming";
import { legalMonthsFor } from "../src/sim/schedule";
import { buyBuildingAt } from "../src/sim/buildings";
import { ensureAgents, buyImplement, enqueueTask, estimateTaskHours } from "../src/sim/tasks";
import { baleStorageCapacityOf, baleStorageRoom, baleCapacity } from "../src/sim/buildings";
import { minutesPerMonth, MONTHS_PER_YEAR, START_MONTH } from "../src/sim/calendar";

beforeAll(() => setProjection(15, "N"));

function timeForMonth(m: number): number {
  return ((((m - START_MONTH) % MONTHS_PER_YEAR) + MONTHS_PER_YEAR) % MONTHS_PER_YEAR) * minutesPerMonth();
}

describe("oats & barley get an extra month at both ends", () => {
  for (const crop of ["oats", "barley"] as CropId[]) {
    it(`${crop} plants across three months, not two`, () => {
      expect(gameConfig.crops[crop].plantMonths).toEqual([2, 3, 4]);
      // The live gate has to agree with the config, or the Schedule tab would
      // offer a month the game then refuses.
      for (const m of [2, 3, 4]) expect(inPlantingWindow(crop, timeForMonth(m))).toBe(true);
      for (const m of [1, 5]) expect(inPlantingWindow(crop, timeForMonth(m))).toBe(false);
    });

    it(`${crop} stays harvestable for three months`, () => {
      expect(harvestWindowMonthsFor(crop)).toBe(gameConfig.harvestWindowMonths + 1);
      expect(legalMonthsFor("harvest", crop, 2)).toHaveLength(3);
    });

    it(`${crop} survives a month that would wither corn`, () => {
      const grow = gameConfig.crops[crop].growMonths;
      const field: Field = {
        id: "f", parcelId: "p", boundary: [[0, 0], [10, 0], [10, 10], [0, 10]] as Meters[],
        status: "ready", crop, plantedAt: 0,
      };
      // Two months past ripe: inside this crop's window, past the global one.
      const twoPastRipe = (grow + 2) * minutesPerMonth();
      expect(harvestWindowClosed(field, twoPastRipe)).toBe(false);
      // Three months past ripe closes it.
      expect(harvestWindowClosed(field, (grow + 3) * minutesPerMonth())).toBe(true);
    });
  }

  it("every other crop still uses the global window", () => {
    for (const crop of Object.keys(gameConfig.crops) as CropId[]) {
      if (crop === "oats" || crop === "barley") continue;
      expect(harvestWindowMonthsFor(crop), crop).toBe(gameConfig.harvestWindowMonths);
    }
  });
});

describe("new implement sizes", () => {
  it("rakes come in 15 / 30 / 50 ft", () => {
    expect(gameConfig.equipment.rake.small.widthFt).toBe(15);
    expect(gameConfig.equipment.rake.medium.widthFt).toBe(30);
    expect(gameConfig.equipment.rake.large.widthFt).toBe(50);
  });

  it("the Large bale trailer holds 30 bales", () => {
    expect(gameConfig.equipment.baleTrailer.large.capacityBales).toBe(30);
  });

  it("the Small sprayer is a real 30 ft boom", () => {
    expect(gameConfig.equipment.sprayer.small.widthFt).toBe(30);
  });

  it("every sized implement gets wider and dearer as it goes up", () => {
    // A size tier that doesn't actually buy you anything is a config typo.
    // Trailers are excluded: their widthFt is unused (they're not coverage
    // tools) and capacity is their tier, checked above.
    const sized = ["plow", "planter", "sprayer", "rake", "mulcher"] as const;
    for (const kind of sized) {
      const cfg = gameConfig.equipment[kind];
      expect(cfg.medium.widthFt, `${kind} medium`).toBeGreaterThan(cfg.small.widthFt);
      expect(cfg.large.widthFt, `${kind} large`).toBeGreaterThan(cfg.medium.widthFt);
      expect(cfg.medium.price, `${kind} medium price`).toBeGreaterThan(cfg.small.price);
      expect(cfg.large.price, `${kind} large price`).toBeGreaterThan(cfg.medium.price);
    }
  });
});

describe("the heavy passes run slower than the default", () => {
  // 2026-07-24: `fieldSpeedKmh` was the ONE speed for every non-forage pass,
  // which made it a compromise — right for planting and spraying, roughly
  // double a real combine. Harvest and plow now have their own.
  it("harvest and plow are 7 km/h, below the shared default", () => {
    expect(gameConfig.work.harvestSpeedKmh).toBe(7);
    expect(gameConfig.work.plowSpeedKmh).toBe(7);
    expect(gameConfig.work.harvestSpeedKmh).toBeLessThan(gameConfig.work.fieldSpeedKmh);
    expect(gameConfig.work.plowSpeedKmh).toBeLessThan(gameConfig.work.fieldSpeedKmh);
  });

  it("a combine really is quoted more hours than a planter over the same ground", () => {
    // The behavioural half — the config number has to actually reach the sim.
    // Same field, same implement width, so speed is the only difference.
    const save = newGame();
    save.money = 20_000_000;
    ensureAgents(save, [0, 0]);
    buyImplement(save, "cornHeader", "medium");
    const acres = 40;
    const side = Math.sqrt(acres * 4046.8564224);
    const boundary: Meters[] = [[0, 0], [side, 0], [side, side], [0, side]];

    const ready: Field = {
      id: "f-h", parcelId: "p", boundary, status: "ready", crop: "corn",
      trueYieldTonsPerAcre: 6,
      plantedAt: -gameConfig.crops.corn.growMonths * minutesPerMonth(),
    };
    const tilled: Field = { id: "f-p", parcelId: "p", boundary, status: "tilled" };
    save.fields.push(ready, tilled);

    const harvestHours = estimateTaskHours(save, enqueueTask(save, ready, "harvest", timeForMonth(7)));
    const plantHours = estimateTaskHours(save, enqueueTask(save, tilled, "plant", timeForMonth(3), "corn"));
    expect(harvestHours).toBeGreaterThan(0);
    expect(plantHours).toBeGreaterThan(0);
    // Harvest is slower per metre; the planter is also narrower, so this only
    // asserts the direction the speed change is responsible for.
    const harvestWidth = gameConfig.equipment.cornHeader.medium.widthFt;
    const plantWidth = gameConfig.equipment.planter.medium.widthFt;
    const harvestRate = gameConfig.work.harvestSpeedKmh * harvestWidth;
    const plantRate = gameConfig.work.fieldSpeedKmh * plantWidth;
    // acres/hour scales with speed x width; compare the quoted hours against it.
    expect(plantHours / harvestHours).toBeCloseTo(harvestRate / plantRate, 1);
  });
});

describe("outdoor bale storage is capped", () => {
  it("a Bale Area holds 1000 bales, not infinitely many", () => {
    expect(baleStorageCapacityOf("baleArea")).toBe(1000);
    expect(Number.isFinite(baleCapacity(newGame()))).toBe(true);
  });

  it("its room runs out, which is what makes the sell fallback reachable", () => {
    const save = newGame();
    save.money = 10_000_000;
    const area = buyBuildingAt(save, "baleArea", [0, 0]);
    expect(baleStorageRoom(area)).toBe(1000);
    area.storedBales = { straw: 1000 };
    expect(baleStorageRoom(area)).toBe(0);
  });
});
