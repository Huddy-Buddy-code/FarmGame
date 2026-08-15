import { describe, it, expect, beforeAll } from "vitest";
import {
  peakSaleMonth, seasonalMultiplier, seasonalBonus, grainUnitPrice, baleUnitPrice,
  SELLABLE_GRAINS, SELLABLE_BALES, grainInstantPrice,
  ALL_MARKET_PRODUCTS, effectiveSellPlan, AUTO_SELL_HOLDS_UNTIL_AGED,
} from "../src/sim/market";
import { tickAutoSell } from "../src/sim/economy";
import { ensureAgents, buyImplement } from "../src/sim/tasks";
import { buyBuildingAt } from "../src/sim/buildings";
import type { Building } from "../src/state/saveState";
import { newGame } from "../src/state/saveState";
import { minutesPerMonth, setDaysPerMonth } from "../src/sim/calendar";
import { setProjection } from "../src/geo/coords";
import { gameConfig } from "../src/config/gameConfig";

beforeAll(() => setProjection(15, "N"));
setDaysPerMonth(30);

// Month indices: Jan=0 … Dec=11.
// 2026-07-25 realism pass: the peak moved from December to JULY and the premium
// from +25% to +12%. Cash grain bottoms at harvest and peaks the following early
// summer as old-crop supply tightens — a December peak topped out six weeks
// after the combines stopped, rewarding the one thing no grain farmer does. The
// point of the change is that autumn grain must now be STORED over the winter
// to catch the peak, which is what gives a silo a reason to exist.
describe("peakSaleMonth — a single fixed peak for every product", () => {
  it("is July", () => {
    expect(peakSaleMonth()).toBe(6);
  });
});

describe("seasonalMultiplier — one July-peaked curve, same for all products", () => {
  it("peaks +12% in July, tapering ±2 months to base", () => {
    expect(seasonalMultiplier("corn", 6)).toBeCloseTo(1.12, 6); // Jul, the peak
    expect(seasonalMultiplier("corn", 5)).toBeCloseTo(1.08, 6); // Jun (−1)
    expect(seasonalMultiplier("corn", 7)).toBeCloseTo(1.08, 6); // Aug (+1)
    expect(seasonalMultiplier("corn", 4)).toBeCloseTo(1.04, 6); // May (−2)
    expect(seasonalMultiplier("corn", 8)).toBeCloseTo(1.04, 6); // Sep (+2)
    // Everything three or more months from Jul is base — which is the whole
    // autumn harvest run, Oct through Dec.
    for (const m of [9, 10, 11, 0, 1, 2, 3]) expect(seasonalMultiplier("corn", m)).toBe(1);
  });
  it("is identical across products — soybeans & bales share corn's curve", () => {
    for (const m of [4, 5, 6, 7, 8, 11]) {
      expect(seasonalMultiplier("soybeans", m)).toBe(seasonalMultiplier("corn", m));
      expect(seasonalMultiplier("hay", m)).toBe(seasonalMultiplier("corn", m));
    }
  });
  it("seasonalBonus is the fraction above base", () => {
    expect(seasonalBonus("corn", 6)).toBeCloseTo(0.12, 6);
    expect(seasonalBonus("corn", 11)).toBe(0); // Dec = base now
  });
});

describe("unit prices apply the multiplier to the base config price", () => {
  it("grain: base × multiplier", () => {
    const base = gameConfig.crops.corn.sellPricePerTon;
    expect(grainUnitPrice("corn", 11)).toBe(base); // Dec base
    expect(grainUnitPrice("corn", 6)).toBeCloseTo(base * 1.12, 6); // Jul peak
  });
  it("bale: base × multiplier", () => {
    const base = gameConfig.baleProducts.hay.pricePerBale;
    expect(baleUnitPrice("hay", 11)).toBe(base);
    expect(baleUnitPrice("hay", 6)).toBeCloseTo(base * 1.12, 6);
  });
});

describe("sellable product lists", () => {
  it("grains exclude the perennial forage crops", () => {
    expect(SELLABLE_GRAINS).toEqual(["corn", "soybeans", "wheat", "rye", "oats", "barley", "canola", "sunflowers"]);
  });
  it("includes every real bale product — the unreachable 'forage' one was removed outright (2026-08-15)", () => {
    // Derived from `gameConfig.baleProducts` (2026-08-14 fix) rather than
    // hand-listed — the hardcoded list this replaced silently missed every
    // wrapped/baleage product ever added (7 of them), which meant a Bale
    // Storage building holding nothing BUT baleage showed "Empty" in the
    // Inventory tab despite a real non-zero count, and auto-sell never
    // covered wrapped bales at all (`ALL_MARKET_PRODUCTS` is built from this
    // list too). Spot-check the exact products that were missing, not just
    // the ones that happened to already be there.
    //
    // The "…Unwrapped" quad and "forage" itself are GONE from the config
    // now (product-list cleanup, 2026-08-15) rather than filtered out here —
    // see the BaleProduct union's comment.
    expect(SELLABLE_BALES).toEqual(expect.arrayContaining([
      "cornStover", "straw", "hay", "alfalfaHay",
      "strawSquare", "haySquare", "alfalfaHaySquare",
      "hayBaleage", "alfalfaBaleage", "haySquareBaleage", "alfalfaHaySquareBaleage",
      "hayBaleageAged", "alfalfaBaleageAged", "haySquareBaleageAged", "alfalfaHaySquareBaleageAged",
    ]));
    // Every key in gameConfig.baleProducts is accounted for — no filter left.
    expect(SELLABLE_BALES).toHaveLength(Object.keys(gameConfig.baleProducts).length);
  });

  it("auto-sell excludes fresh wrapped baleage, but still includes it manually and once aged (2026-08-14)", () => {
    for (const p of ["hayBaleage", "alfalfaBaleage", "haySquareBaleage", "alfalfaHaySquareBaleage"] as const) {
      expect(SELLABLE_BALES).toContain(p); // still sellable by hand from Inventory
      expect(ALL_MARKET_PRODUCTS).not.toContain(p); // but auto-sell skips it
    }
    // Its own crop-specific Aged Baleage twin IS covered — "just sell them
    // when they age" is the whole point, not "never auto-sell baleage".
    expect(ALL_MARKET_PRODUCTS).toContain("hayBaleageAged");
    expect(ALL_MARKET_PRODUCTS).toContain("alfalfaBaleageAged");
    expect(ALL_MARKET_PRODUCTS).toContain("haySquareBaleageAged");
    expect(ALL_MARKET_PRODUCTS).toContain("alfalfaHaySquareBaleageAged");
  });

  it("auto-sell holds fresh Corn Forage until it ages into Corn Silage (2026-08-15)", () => {
    expect(ALL_MARKET_PRODUCTS).not.toContain("cornForage"); // auto-sell skips the fresh-chopped form
    // Its cured bunker product IS covered.
    expect(ALL_MARKET_PRODUCTS).toContain("cornSilage");
  });
});

describe("auto-sell holds fresh wrapped baleage until it ages into Silage (2026-08-14)", () => {
  function baleAreaWith(product: string, n: number): Building {
    return { id: "b1", kind: "baleArea", pos: [0, 0], storedBales: { [product]: n } } as Building;
  }

  it("the farm-wide master toggle does not sell hayBaleage", () => {
    const save = newGame();
    save.buildings.push(baleAreaWith("hayBaleage", 10));
    save.sellAll = { month: 11, auto: true };
    save.sellLastMonthAbs = 8;
    tickAutoSell(save, 9 * minutesPerMonth()); // cross into Dec
    expect(save.buildings[0]!.storedBales!.hayBaleage).toBe(10); // untouched
  });

  it("an explicit per-product override on hayBaleage still doesn't sell it", () => {
    // AUTO_SELL_HOLDS_UNTIL_AGED is enforced in `ALL_MARKET_PRODUCTS` itself,
    // which `tickAutoSell` iterates — so even a product with its OWN "auto"
    // row set can't reach a sale; there's no override path around the hold.
    const save = newGame();
    save.buildings.push(baleAreaWith("hayBaleage", 10));
    save.sellSchedule = { hayBaleage: { month: 11, auto: true } };
    save.sellLastMonthAbs = 8;
    tickAutoSell(save, 9 * minutesPerMonth());
    expect(save.buildings[0]!.storedBales!.hayBaleage).toBe(10);
  });

  it("the same master toggle DOES sell it once it's aged into hayBaleageAged", () => {
    const save = newGame();
    save.buildings.push(baleAreaWith("hayBaleageAged", 10));
    save.sellAll = { month: 11, auto: true };
    save.sellLastMonthAbs = 8;
    tickAutoSell(save, 9 * minutesPerMonth());
    expect(save.buildings[0]!.storedBales!.hayBaleageAged ?? 0).toBe(0);
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
