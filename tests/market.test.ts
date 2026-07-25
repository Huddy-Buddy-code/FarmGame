import { describe, it, expect, beforeAll } from "vitest";
import {
  peakSaleMonth, seasonalMultiplier, seasonalBonus, grainUnitPrice, baleUnitPrice,
  SELLABLE_GRAINS, SELLABLE_BALES, grainInstantPrice,
  ALL_MARKET_PRODUCTS, effectiveSellPlan,
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
    expect(SELLABLE_GRAINS).toEqual(["corn", "soybeans", "wheat", "rye", "oats", "barley", "canola", "sunflowers"]);
  });
  it("bales exclude the unreachable forage product, and include the square variants", () => {
    expect(SELLABLE_BALES).toEqual([
      "cornStover", "straw", "hay", "alfalfaHay",
      "strawSquare", "haySquare", "alfalfaHaySquare",
    ]);
    expect(SELLABLE_BALES).not.toContain("forage");
  });
});

// The first Dec (month 11) since epoch is absolute-month 9 ((START_MONTH 2 + 9)
// % 12 = 11). So arming the cursor at abs 8 (the preceding Nov) and ticking to
// abs 9 crosses exactly that Dec — the +25% peak.
describe("farm-wide auto-sell (the master toggle)", () => {
  // Maintainer request, 2026-07-24: "give me a toggle to auto sell all crops.
  // This includes current, and any future adds." Stored as a DEFAULT rather
  // than stamped across every product, so a crop the player has never grown
  // still inherits it the first time it lands in store — which is the half
  // that a bulk "turn them all on" button could never do.

  it("covers a product that has no schedule row of its own", () => {
    const save = newGame();
    save.sellAll = { month: 11, auto: true };
    expect(effectiveSellPlan(save, "corn")).toEqual({ month: 11, auto: true, fromAll: true });
    // ...and every other product too, including bales.
    for (const p of ALL_MARKET_PRODUCTS) expect(effectiveSellPlan(save, p).auto, p).toBe(true);
  });

  it("the master WINS over a product's own row while it's on", () => {
    // Precedence was the other way round when this landed; the maintainer
    // inverted it 2026-07-24 — "when they hit the master toggle it overrides
    // all the individual ones and moves them to on". The UI hides the
    // per-product controls while the master is on for exactly this reason.
    const save = newGame();
    save.sellAll = { month: 11, auto: true };
    save.sellSchedule = { corn: { month: 5, auto: false } };
    expect(effectiveSellPlan(save, "corn")).toEqual({ month: 11, auto: true, fromAll: true });
  });

  it("per-product rows take over again once the master is off", () => {
    const save = newGame();
    save.sellAll = { month: 11, auto: false };
    save.sellSchedule = { corn: { month: 5, auto: true } };
    expect(effectiveSellPlan(save, "corn")).toEqual({ month: 5, auto: true, fromAll: false });
    expect(effectiveSellPlan(save, "soybeans").auto).toBe(false); // no row, master off
  });

  it("off by default — a fresh farm sells nothing automatically", () => {
    const save = newGame();
    for (const p of ALL_MARKET_PRODUCTS) expect(effectiveSellPlan(save, p).auto, p).toBe(false);
  });

  it("actually sells a crop that was never configured individually", () => {
    // The end-to-end version: no sellSchedule at all, master on, and the crop
    // goes when its month turns.
    const save = newGame();
    save.grain.soybeans = 40;
    save.sellAll = { month: 11, auto: true };
    save.sellLastMonthAbs = 8;
    const before = save.money;
    tickAutoSell(save, 9 * minutesPerMonth()); // cross into Dec
    expect(save.grain.soybeans).toBe(0);
    expect(save.money - before).toBe(Math.round(40 * grainInstantPrice("soybeans")));
  });

  it("sells a product whose own row says OFF, because the master outranks it", () => {
    const save = newGame();
    save.grain.corn = 40;
    save.grain.soybeans = 40;
    save.sellAll = { month: 11, auto: true };
    save.sellSchedule = { corn: { month: 11, auto: false } };
    save.sellLastMonthAbs = 8;
    tickAutoSell(save, 9 * minutesPerMonth());
    expect(save.grain.corn).toBe(0); // master overrode the row
    expect(save.grain.soybeans).toBe(0);
  });

  it("a held-back product stays held back once the master is off", () => {
    const save = newGame();
    save.grain.corn = 40;
    save.grain.soybeans = 40;
    save.sellAll = { month: 11, auto: false };
    save.sellSchedule = { soybeans: { month: 11, auto: true } };
    save.sellLastMonthAbs = 8;
    tickAutoSell(save, 9 * minutesPerMonth());
    expect(save.grain.corn).toBe(40); // no row, master off — nothing happens
    expect(save.grain.soybeans).toBe(0); // its own row said sell
  });

  it("sells on the MASTER's month, not the peak, when one is chosen", () => {
    const save = newGame();
    save.grain.corn = 40;
    save.sellAll = { month: 0, auto: true }; // January
    save.sellLastMonthAbs = 9; // Dec
    tickAutoSell(save, 10 * minutesPerMonth()); // cross into Jan
    expect(save.grain.corn).toBe(0);
  });
});

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
