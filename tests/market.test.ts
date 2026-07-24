import { describe, it, expect, beforeAll } from "vitest";
import {
  peakSaleMonth, seasonalMultiplier, seasonalBonus, grainUnitPrice, baleUnitPrice,
  SELLABLE_GRAINS, SELLABLE_BALES, grainInstantPrice,
} from "../src/sim/market";
import { tickAutoSell } from "../src/sim/economy";
import { ensureAgents, buyImplement } from "../src/sim/tasks";
import { buyBuildingAt } from "../src/sim/buildings";
import { newGame } from "../src/state/saveState";
import { minutesPerMonth, setDaysPerMonth } from "../src/sim/calendar";
import { setProjection } from "../src/geo/coords";
import { gameConfig } from "../src/config/gameConfig";

beforeAll(() => setProjection(15, "N"));
setDaysPerMonth(30);

// Month indices: Jan=0 … Dec=11.
describe("peakSaleMonth — a single fixed peak for every product", () => {
  it("is December", () => {
    expect(peakSaleMonth()).toBe(11);
  });
});

describe("seasonalMultiplier — one December-peaked curve, same for all products", () => {
  it("peaks +25% in December, tapering ±2 months to base", () => {
    expect(seasonalMultiplier("corn", 11)).toBeCloseTo(1.25, 6); // Dec, the peak
    expect(seasonalMultiplier("corn", 10)).toBeCloseTo(1.15, 6); // Nov (−1)
    expect(seasonalMultiplier("corn", 0)).toBeCloseTo(1.15, 6); // Jan (+1)
    expect(seasonalMultiplier("corn", 9)).toBeCloseTo(1.1, 6); // Oct (−2)
    expect(seasonalMultiplier("corn", 1)).toBeCloseTo(1.1, 6); // Feb (+2)
    // Everything three or more months from Dec is base.
    for (const m of [2, 3, 4, 5, 6, 7, 8]) expect(seasonalMultiplier("corn", m)).toBe(1);
  });
  it("is identical across products — soybeans & bales share corn's curve", () => {
    for (const m of [9, 10, 11, 0, 1, 6]) {
      expect(seasonalMultiplier("soybeans", m)).toBe(seasonalMultiplier("corn", m));
      expect(seasonalMultiplier("hay", m)).toBe(seasonalMultiplier("corn", m));
    }
  });
  it("seasonalBonus is the fraction above base", () => {
    expect(seasonalBonus("corn", 11)).toBeCloseTo(0.25, 6);
    expect(seasonalBonus("corn", 6)).toBe(0); // Jul = base
  });
});

describe("unit prices apply the multiplier to the base config price", () => {
  it("grain: base × multiplier", () => {
    const base = gameConfig.crops.corn.sellPricePerTon;
    expect(grainUnitPrice("corn", 6)).toBe(base); // Jul base
    expect(grainUnitPrice("corn", 11)).toBeCloseTo(base * 1.25, 6); // Dec peak
  });
  it("bale: base × multiplier", () => {
    const base = gameConfig.baleProducts.hay.pricePerBale;
    expect(baleUnitPrice("hay", 6)).toBe(base);
    expect(baleUnitPrice("hay", 11)).toBeCloseTo(base * 1.25, 6);
  });
});

describe("sellable product lists", () => {
  it("grains exclude the perennial forage crops", () => {
    expect(SELLABLE_GRAINS).toEqual(["corn", "soybeans", "wheat", "oats", "barley", "canola", "sunflowers", "potatoes"]);
  });
  it("bales exclude the unreachable forage product", () => {
    expect(SELLABLE_BALES).toEqual(["cornStover", "straw", "hay", "alfalfaHay"]);
  });
});

// The first Dec (month 11) since epoch is absolute-month 9 ((START_MONTH 2 + 9)
// % 12 = 11). So arming the cursor at abs 8 (the preceding Nov) and ticking to
// abs 9 crosses exactly that Dec — the +25% peak.
describe("tickAutoSell", () => {
  it("falls back to an instant sale when no Sell Point exists to haul to", () => {
    const save = newGame();
    save.grain.corn = 100;
    save.sellSchedule = { corn: { month: 11, auto: true } }; // Dec (the +25% peak)
    save.sellLastMonthAbs = 8; // preceding Nov
    const before = save.money;
    tickAutoSell(save, 9 * minutesPerMonth()); // cross into Dec
    expect(save.grain.corn).toBe(0);
    // No Sell Point, so nothing can be hauled — it takes the instant price
    // (base less the pickup fee, NO seasonal premium) rather than doing
    // nothing at all. A scheduled sell that silently no-ops would be worse.
    expect(save.money - before).toBe(Math.round(100 * grainInstantPrice("corn")));
  });

  it("QUEUES a haul instead of selling instantly once a Sell Point exists", () => {
    const save = newGame();
    ensureAgents(save, [0, 0]);
    buyImplement(save, "grainTrailer", "medium");
    buyBuildingAt(save, "sellPoint", [200, 200]);
    save.grain.corn = 100;
    save.sellSchedule = { corn: { month: 11, auto: true } };
    save.sellLastMonthAbs = 8;
    const before = save.money;

    tickAutoSell(save, 9 * minutesPerMonth());

    // Nothing is paid yet, and the grain is still in the bin — it gets picked
    // up and cashed in when the rig actually reaches the Sell Point.
    expect(save.money).toBe(before);
    expect(save.grain.corn).toBe(100);
    expect(save.tasks.some((t) => t.type === "sell" && t.sellProduct === "corn")).toBe(true);
  });

  it("does nothing when auto is off", () => {
    const save = newGame();
    save.grain.corn = 100;
    save.sellSchedule = { corn: { month: 11, auto: false } };
    save.sellLastMonthAbs = 8;
    tickAutoSell(save, 9 * minutesPerMonth());
    expect(save.grain.corn).toBe(100);
  });

  it("fires once even when several months elapse in one tick (time-compression)", () => {
    const save = newGame();
    save.grain.corn = 100;
    save.sellSchedule = { corn: { month: 11, auto: true } };
    save.sellLastMonthAbs = 8;
    tickAutoSell(save, 13 * minutesPerMonth()); // jump Nov → next Apr, crossing Dec once
    expect(save.grain.corn).toBe(0);
  });

  it("arms the cursor on first run and never retro-fires", () => {
    const save = newGame();
    save.grain.corn = 100;
    save.sellSchedule = { corn: { month: 11, auto: true } };
    // sellLastMonthAbs undefined → first call just arms, sells nothing even
    // though we're already at/after a scheduled Dec.
    tickAutoSell(save, 9 * minutesPerMonth());
    expect(save.grain.corn).toBe(100);
    expect(save.sellLastMonthAbs).toBe(9);
  });
});
