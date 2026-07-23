import { describe, it, expect } from "vitest";
import { gameConfig } from "../src/config/gameConfig";
import type { CropId } from "../src/config/gameConfig";
import { baleProductForField } from "../src/sim/farming";
import type { Field } from "../src/state/saveState";
import { newGame } from "../src/state/saveState";

const cropIds = Object.keys(gameConfig.crops) as CropId[];

// Config invariants every crop must hold — guards the 2026-07-22 six-crop
// expansion (and anything added later) against the mistakes the sim can't
// tolerate: fractional growMonths (growth is start-of-month keyed), out-of-range
// plant months, a forage crop pointing at a bale product that doesn't exist.
describe("crop config invariants", () => {
  it("every crop has whole-number growMonths and valid 0-11 plant months", () => {
    for (const id of cropIds) {
      const c = gameConfig.crops[id];
      expect(Number.isInteger(c.growMonths), `${id}.growMonths`).toBe(true);
      expect(c.growMonths, `${id}.growMonths`).toBeGreaterThan(0);
      expect(c.plantMonths.length, `${id}.plantMonths`).toBeGreaterThan(0);
      for (const m of c.plantMonths) expect(m, `${id} plant month`).toBeGreaterThanOrEqual(0);
      for (const m of c.plantMonths) expect(m, `${id} plant month`).toBeLessThanOrEqual(11);
    }
  });

  it("grain crops price + yield positive; perennials realize value as bales instead", () => {
    for (const id of cropIds) {
      const c = gameConfig.crops[id];
      if (c.producesGrain !== false) {
        expect(c.sellPricePerTon, `${id}.sellPricePerTon`).toBeGreaterThan(0);
        expect(c.baseYieldTonsPerAcre, `${id}.baseYieldTonsPerAcre`).toBeGreaterThan(0);
      } else {
        expect(c.perennial, `${id} non-grain must be perennial forage`).toBe(true);
        expect(c.baleProduct, `${id}.baleProduct`).toBeDefined();
      }
    }
  });

  it("every forage crop's baleProduct exists in baleProducts config", () => {
    for (const id of cropIds) {
      const c = gameConfig.crops[id];
      if (!c.producesForage) continue;
      const product = c.baleProduct ?? "cornStover";
      expect(gameConfig.baleProducts[product], `${id} -> ${product}`).toBeDefined();
      expect(gameConfig.baleProducts[product].pricePerBale).toBeGreaterThan(0);
      expect(gameConfig.baleProducts[product].balesPerAcre).toBeGreaterThan(0);
    }
  });

  it("new-game grain bin carries a key for every crop", () => {
    const save = newGame();
    for (const id of cropIds) expect(save.grain[id], `grain.${id}`).toBe(0);
  });
});

describe("baleProductForField residue routing", () => {
  const harvested = (lastCrop: CropId | undefined): Field =>
    ({ id: "f", parcelId: "p", boundary: [], status: "harvested", lastCrop }) as unknown as Field;

  it("post-harvest annuals route residue by lastCrop: corn→stover, wheat→straw", () => {
    // Annual harvest clears field.crop and stamps lastCrop (applyHarvestDone) —
    // the later rake/bale run must still know what the residue IS.
    expect(baleProductForField(harvested("corn"))).toBe("cornStover");
    expect(baleProductForField(harvested("wheat"))).toBe("straw");
    expect(baleProductForField(harvested("oats"))).toBe("straw");
    expect(baleProductForField(harvested("barley"))).toBe("straw");
  });

  it("legacy save with no lastCrop still lands on corn stover", () => {
    expect(baleProductForField(harvested(undefined))).toBe("cornStover");
  });
});
