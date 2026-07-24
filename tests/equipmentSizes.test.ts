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
