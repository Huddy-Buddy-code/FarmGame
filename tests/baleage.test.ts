import { describe, it, expect } from "vitest";
import {
  canWrapBales, applyWrapDone, applyBaleDone, baleageProductFor, isWrappedProduct, migrateLegacyBaleProducts,
} from "../src/sim/farming";
import { baleSpoilRateFor, tickBaleSpoilage, tickBaleAging } from "../src/sim/buildings";
import { gameConfig } from "../src/config/gameConfig";
import { minutesPerMonth } from "../src/sim/calendar";
import type { Field, SaveState, Building, Implement, FarmTask } from "../src/state/saveState";
import type { BaleProduct } from "../src/config/gameConfig";

/**
 * SILAGE PHASE 1 — baleage (wrapped bales).
 *
 * The rule that carries the whole feature is the SAME-MONTH window: bales can
 * only be wrapped in the calendar month they were baled. Get it wrong in
 * either direction and the feature is broken but silent — either baleage is
 * impossible, or hay from three seasons ago upgrades itself.
 */

const MONTH = minutesPerMonth();

function field(over: Partial<Field> = {}): Field {
  return {
    id: "f1",
    parcelId: "p1",
    boundary: [[0, 0], [100, 0], [100, 100], [0, 100]],
    // grassSilage (2026-08-13): wrap is gated on the crop now — a plain
    // "grass" field can never wrap even with bales/timing lined up.
    crop: "grassSilage",
    status: "harvested",
    baleLocations: [[10, 10], [20, 20]],
    baleProduct: "hay",
    baledAt: 0,
    ...over,
  } as Field;
}

describe("what can become baleage", () => {
  it("maps the two round FORAGE products to their wrapped twins", () => {
    expect(baleageProductFor("hay")).toBe("hayBaleage");
    expect(baleageProductFor("alfalfaHay")).toBe("alfalfaBaleage");
  });

  it("refuses straw and stover — dry residue has nothing to ferment", () => {
    expect(baleageProductFor("straw")).toBeUndefined();
    expect(baleageProductFor("cornStover")).toBeUndefined();
  });

  it("wraps SQUARE grass/alfalfa bales too (2026-08-13) — straw squares still can't", () => {
    expect(baleageProductFor("haySquare")).toBe("haySquareBaleage");
    expect(baleageProductFor("alfalfaHaySquare")).toBe("alfalfaHaySquareBaleage");
    expect(baleageProductFor("strawSquare")).toBeUndefined();
  });

  it("refuses to re-wrap something already wrapped", () => {
    expect(baleageProductFor("hayBaleage")).toBeUndefined();
    expect(baleageProductFor("alfalfaBaleage")).toBeUndefined();
  });

  it("flags exactly the eight wrapped products (2026-08-15: 4 fresh + 4 crop-specific aged)", () => {
    const wrapped = (Object.keys(gameConfig.baleProducts) as BaleProduct[]).filter(isWrappedProduct);
    expect(wrapped.sort()).toEqual(
      [
        "alfalfaBaleage", "alfalfaHaySquareBaleage", "hayBaleage", "haySquareBaleage",
        "alfalfaBaleageAged", "alfalfaHaySquareBaleageAged", "hayBaleageAged", "haySquareBaleageAged",
      ].sort(),
    );
  });
});

describe("the same-month wrapping window", () => {
  it("opens on bales baled this month", () => {
    expect(canWrapBales(field({ baledAt: 0 }), 0)).toBe(true);
    // Later the SAME month still counts — the rule is calendar month, not hours.
    expect(canWrapBales(field({ baledAt: 0 }), MONTH * 0.9)).toBe(true);
  });

  it("SHUTS the moment the month turns", () => {
    expect(canWrapBales(field({ baledAt: 0 }), MONTH)).toBe(false);
    expect(canWrapBales(field({ baledAt: 0 }), MONTH * 1.1)).toBe(false);
  });

  it("shuts a year later too — same month number, different year", () => {
    // The guard has to compare year AND month, or bales would become wrappable
    // again every twelve months forever.
    expect(canWrapBales(field({ baledAt: 0 }), MONTH * 12)).toBe(false);
  });

  it("is closed for a field with no bales on the ground", () => {
    expect(canWrapBales(field({ baleLocations: [] }), 0)).toBe(false);
    expect(canWrapBales(field({ baleLocations: undefined }), 0)).toBe(false);
  });

  it("is closed for products that can't be wrapped at all", () => {
    expect(canWrapBales(field({ baleProduct: "straw" }), 0)).toBe(false);
    // haySquare CAN be wrapped now (2026-08-13) — see the square-baleage tests.
    expect(canWrapBales(field({ baleProduct: "hayBaleage" }), 0)).toBe(false); // already wrapped
  });

  it("treats legacy bales with no timestamp as too old — never retro-upgrades an old save", () => {
    expect(canWrapBales(field({ baledAt: undefined }), 0)).toBe(false);
  });
});

describe("wrapping a field (2026-08-14 redesign: merges the already-sealed pile back in)", () => {
  it("converts the product and spends the window", () => {
    // `wrappedBaleLocations` stands in for what the wrap task's tick loop
    // would have built up by visiting each bale one at a time — `baleProduct`
    // stays the UNWRAPPED id right up until this merge (see the Field
    // comment). `baleLocations: undefined` matches the real precondition:
    // applyWrapDone only ever runs once that pile is drained.
    const f = field({ baleLocations: undefined, wrappedBaleLocations: [[10, 10], [20, 20]] });
    applyWrapDone(f);
    expect(f.baleProduct).toBe("hayBaleage");
    expect(f.baledAt).toBeUndefined();
    expect(f.wrappedBaleLocations).toBeUndefined();
    expect(canWrapBales(f, 0)).toBe(false); // can't be wrapped twice
  });

  it("does NOT change the bale count — wrapping preserves bales, it doesn't make them", () => {
    const f = field({ baleLocations: undefined, wrappedBaleLocations: [[1, 1], [2, 2], [3, 3]] });
    applyWrapDone(f);
    expect(f.baleLocations).toHaveLength(3);
  });

  it("no-ops on a field with nothing wrapped yet — there's no pile to merge", () => {
    const f = field({ baleProduct: "straw" }); // default fixture: bales down, no wrappedBaleLocations
    applyWrapDone(f);
    expect(f.baleProduct).toBe("straw");
    expect(f.baledAt).toBe(0); // window untouched — nothing happened
  });

  it("alfalfa wraps to its own product, not grass baleage", () => {
    const f = field({
      crop: "alfalfaSilage", baleProduct: "alfalfaHay",
      baleLocations: undefined, wrappedBaleLocations: [[10, 10], [20, 20]],
    });
    applyWrapDone(f);
    expect(f.baleProduct).toBe("alfalfaBaleage");
  });
});

describe("baling stamps the window", () => {
  const perennial = (over: Partial<Field> = {}): Field =>
    field({ crop: "grassSilage", status: "harvested", baleProduct: undefined, baledAt: undefined, ...over });

  it("a round baler records WHEN, so the wrap window can be judged", () => {
    const f = perennial();
    applyBaleDone(f, false, 5000);
    // grassSilage shares plain Grass's "hay" id again (2026-08-15 cleanup —
    // see the BaleProduct union's comment); wrap-eligibility is judged off
    // the FIELD's crop (`cropProducesWrappedBale`), not the bale's own id.
    expect(f.baleProduct).toBe("hay");
    expect(f.baledAt).toBe(5000);
    expect(canWrapBales(f, 5000)).toBe(true);
  });

  it("a COMBI baler seals as it rolls — baleage straight off the field, no window to miss", () => {
    const f = perennial();
    applyBaleDone(f, false, 5000, true);
    expect(f.baleProduct).toBe("hayBaleage");
    // Nothing left to time: already wrapped.
    expect(f.baledAt).toBeUndefined();
    expect(canWrapBales(f, 5000)).toBe(false);
  });

  it("a combi on a crop it can't wrap just behaves like a round baler", () => {
    const f = perennial({ crop: undefined, lastCrop: "wheat" } as Partial<Field>);
    applyBaleDone(f, false, 5000, true);
    expect(f.baleProduct).toBe("straw");
    expect(f.baledAt).toBe(5000); // still a normal (unwrappable) window stamp
  });

  it("a SQUARE baler's bales are stamped and wrappable too (2026-08-13)", () => {
    const f = perennial();
    applyBaleDone(f, true, 5000);
    expect(f.baleProduct).toBe("haySquare");
    expect(canWrapBales(f, 5000)).toBe(true);
  });
});

describe("wrapped bales barely spoil — the whole payoff", () => {
  it("ignores the building and uses the wrapped rate, indoors or out", () => {
    const wrappedRate = gameConfig.forage.wrappedSpoilPctPerMonth;
    expect(baleSpoilRateFor("baleArea", "hayBaleage")).toBe(wrappedRate);
    expect(baleSpoilRateFor("baleBarn", "hayBaleage")).toBe(wrappedRate);
  });

  it("still applies the building's own rate to unwrapped hay", () => {
    expect(baleSpoilRateFor("baleArea", "hay")).toBe(gameConfig.buildings.baleArea.spoilPctPerMonth);
    expect(baleSpoilRateFor("baleBarn", "hay")).toBe(gameConfig.buildings.baleBarn.spoilPctPerMonth);
  });

  it("wrapped keeps FAR better than dry hay on an open pad", () => {
    expect(baleSpoilRateFor("baleArea", "hayBaleage"))
      .toBeLessThan(baleSpoilRateFor("baleArea", "hay") / 5);
  });

  it("outdoor baleage even beats hay under a roof — that's why the wrapper competes with the barn", () => {
    expect(baleSpoilRateFor("baleArea", "hayBaleage")).toBeLessThan(baleSpoilRateFor("baleBarn", "hay"));
  });

  it("over six months on an open pad, hay rots and baleage doesn't", () => {
    const store = (product: BaleProduct): Building => ({
      id: `b-${product}`, kind: "baleArea", pos: [0, 0], storedBales: { [product]: 1000 },
    } as Building);
    const hayStore = store("hay");
    const wrappedStore = store("hayBaleage");
    const save = { buildings: [hayStore, wrappedStore] } as SaveState;

    tickBaleSpoilage(save, MONTH * 6);

    const hayLeft = hayStore.storedBales!.hay ?? 0;
    const wrappedLeft = wrappedStore.storedBales!.hayBaleage ?? 0;
    // ~2.5%/mo compounded over six months ≈ 14% gone.
    expect(hayLeft).toBeLessThan(880);
    expect(hayLeft).toBeGreaterThan(840);
    // ~0.2%/mo ≈ 1.2% gone.
    expect(wrappedLeft).toBeGreaterThan(985);
  });

  it("spoilage is resolved PER PRODUCT — one store holding both loses only the hay", () => {
    // The bug this guards: reading the rate once per BUILDING (as the code did
    // before baleage) would rot the wrapped pile at the open-pad rate too.
    const mixed = {
      id: "b1", kind: "baleArea", pos: [0, 0],
      storedBales: { hay: 1000, hayBaleage: 1000 },
    } as Building;
    tickBaleSpoilage({ buildings: [mixed] } as SaveState, MONTH * 6);
    expect(mixed.storedBales!.hay!).toBeLessThan(880);
    expect(mixed.storedBales!.hayBaleage!).toBeGreaterThan(985);
  });
});

describe("tickBaleAging: wrapped bales already in storage age into their own Aged Baleage twin (2026-08-15)", () => {
  function store(product: BaleProduct, n: number): Building {
    return { id: "b1", kind: "baleArea", pos: [0, 0], storedBales: { [product]: n } } as Building;
  }

  it("does nothing before the aging window has passed", () => {
    const b = store("hayBaleage", 100);
    const save = { buildings: [b] } as SaveState;
    tickBaleAging(save, 0); // first tick just starts the clock
    tickBaleAging(save, MONTH * (gameConfig.forage.silageAgingMonths - 0.1));
    expect(b.storedBales!.hayBaleage).toBe(100);
    expect(b.storedBales!.hayBaleageAged).toBeUndefined();
  });

  it("folds the whole pile into its Aged Baleage twin once the window passes", () => {
    const b = store("hayBaleage", 100);
    const save = { buildings: [b] } as SaveState;
    tickBaleAging(save, 0); // starts the clock
    tickBaleAging(save, MONTH * gameConfig.forage.silageAgingMonths);
    expect(b.storedBales!.hayBaleage).toBeUndefined();
    expect(b.storedBales!.hayBaleageAged).toBe(100);
  });

  it("ages the square twin into its own square Aged Baleage, independent of the round pile", () => {
    const b = {
      id: "b1", kind: "baleArea", pos: [0, 0],
      storedBales: { alfalfaHaySquareBaleage: 40, hayBaleage: 10 },
    } as Building;
    const save = { buildings: [b] } as SaveState;
    tickBaleAging(save, 0);
    tickBaleAging(save, MONTH * gameConfig.forage.silageAgingMonths);
    expect(b.storedBales!.alfalfaHaySquareBaleage).toBeUndefined();
    expect(b.storedBales!.hayBaleage).toBeUndefined();
    expect(b.storedBales!.alfalfaHaySquareBaleageAged).toBe(40);
    expect(b.storedBales!.hayBaleageAged).toBe(10);
  });

  it("leaves unwrapped hay alone — it has nothing to age into", () => {
    const b = store("hay", 100);
    const save = { buildings: [b] } as SaveState;
    tickBaleAging(save, 0);
    tickBaleAging(save, MONTH * gameConfig.forage.silageAgingMonths * 2);
    expect(b.storedBales!.hay).toBe(100);
  });

  it("restarts the clock for a fresh delivery that arrives after a conversion", () => {
    const b = store("hayBaleage", 100);
    const save = { buildings: [b] } as SaveState;
    tickBaleAging(save, 0);
    tickBaleAging(save, MONTH * gameConfig.forage.silageAgingMonths); // converts the first 100
    b.storedBales!.hayBaleage = 50; // a fresh batch hauled in
    tickBaleAging(save, MONTH * gameConfig.forage.silageAgingMonths); // starts the fresh clock, doesn't convert yet
    expect(b.storedBales!.hayBaleage).toBe(50);
    expect(b.storedBales!.hayBaleageAged).toBe(100);
    tickBaleAging(save, MONTH * gameConfig.forage.silageAgingMonths * 2);
    expect(b.storedBales!.hayBaleage).toBeUndefined();
    expect(b.storedBales!.hayBaleageAged).toBe(150);
  });

  it("clears the clock once a product's pile sells/hauls down to zero", () => {
    const b = store("hayBaleage", 10);
    const save = { buildings: [b] } as SaveState;
    tickBaleAging(save, 0);
    delete b.storedBales!.hayBaleage; // hauled/sold off entirely
    tickBaleAging(save, MONTH * 0.5);
    b.storedBales!.hayBaleage = 10; // a fresh delivery
    tickBaleAging(save, MONTH * 0.5); // starts a FRESH clock, not the old one
    tickBaleAging(save, MONTH * (gameConfig.forage.silageAgingMonths - 0.1)); // still under the window since the restart
    expect(b.storedBales!.hayBaleage).toBe(10);
    expect(b.storedBales!.hayBaleageAged).toBeUndefined();
  });

  it("carries the +10% aged markup through, per crop (2026-08-15 pricing pass)", () => {
    expect(gameConfig.baleProducts.hayBaleageAged.pricePerBale).toBeGreaterThan(gameConfig.baleProducts.hayBaleage.pricePerBale);
    expect(gameConfig.baleProducts.alfalfaBaleageAged.pricePerBale).toBeGreaterThan(gameConfig.baleProducts.alfalfaBaleage.pricePerBale);
    expect(gameConfig.baleProducts.haySquareBaleageAged.pricePerBale).toBeGreaterThan(gameConfig.baleProducts.haySquareBaleage.pricePerBale);
    expect(gameConfig.baleProducts.alfalfaHaySquareBaleageAged.pricePerBale).toBeGreaterThan(gameConfig.baleProducts.alfalfaHaySquareBaleage.pricePerBale);
  });
});

describe("baleage balance", () => {
  it("prices baleage ABOVE the dry twin's $/ton — wrapping adds value, it isn't a water discount (rule 3)", () => {
    for (const [dry, wet] of [["hay", "hayBaleage"], ["alfalfaHay", "alfalfaBaleage"]] as const) {
      const dryPerTon = gameConfig.baleProducts[dry].pricePerBale / gameConfig.baleProducts[dry].tonsPerBale;
      const wetPerTon = gameConfig.baleProducts[wet].pricePerBale / gameConfig.baleProducts[wet].tonsPerBale;
      expect(wetPerTon).toBeGreaterThan(dryPerTon);
    }
  });

  it("keeps the SAME bales per acre as the dry twin — wrapping doesn't create bales, just seals them (rule 4)", () => {
    for (const [dry, wet] of [["hay", "hayBaleage"], ["alfalfaHay", "alfalfaBaleage"]] as const) {
      expect(gameConfig.baleProducts[wet].balesPerAcre).toBe(gameConfig.baleProducts[dry].balesPerAcre);
      expect(gameConfig.baleProducts[wet].tonsPerBale).toBeGreaterThan(gameConfig.baleProducts[dry].tonsPerBale);
    }
  });

  it("grosses noticeably more than dry hay per acre — heavier bales at a higher $/ton, not free money", () => {
    for (const [dry, wet] of [["hay", "hayBaleage"], ["alfalfaHay", "alfalfaBaleage"]] as const) {
      const dryGross = gameConfig.baleProducts[dry].pricePerBale * gameConfig.baleProducts[dry].balesPerAcre;
      const wetGross = gameConfig.baleProducts[wet].pricePerBale * gameConfig.baleProducts[wet].balesPerAcre;
      expect(wetGross).toBeGreaterThan(dryGross * 1.4);
      expect(wetGross).toBeLessThan(dryGross * 1.7);
    }
  });

  it("a combi baler costs far more than a round baler plus a wrapper — you pay for the one-pass guarantee", () => {
    const separate = gameConfig.equipment.bailer.medium.price + gameConfig.equipment.baleWrapper.medium.price;
    expect(gameConfig.equipment.combiBaler.medium.price).toBeGreaterThan(separate * 1.5);
  });
});

describe("migrateLegacyBaleProducts (2026-08-15)", () => {
  // The Silage crops' one-day-old "…Unwrapped" ids were cut as pricing-
  // identical duplicates of "hay"/"alfalfaHay"/"haySquare"/
  // "alfalfaHaySquare" (see the BaleProduct union's comment). A save
  // written during that one day could have the old ids sitting in a
  // field's pile, a storage building, a trailer's cargo tag, an in-flight
  // task, or a per-product sell override — every one of those needs to
  // still resolve to a real `gameConfig.baleProducts` entry, or lookups
  // like `isWrappedProduct` crash on `undefined`.
  it("remaps a field's own pile", () => {
    const f = field({ baleProduct: "grassRoundbaleUnwrapped" as BaleProduct });
    const save = { fields: [f], buildings: [], implements: [], tasks: [] } as unknown as SaveState;
    migrateLegacyBaleProducts(save);
    expect(f.baleProduct).toBe("hay");
  });

  it("remaps a storage building's counts, merging into any existing pile of the new id", () => {
    const b = {
      id: "b1", kind: "baleArea", pos: [0, 0],
      storedBales: { grassRoundbaleUnwrapped: 40, hay: 10, alfalfaSquareBaleUnwrapped: 5 },
    } as unknown as Building;
    const save = { fields: [], buildings: [b], implements: [], tasks: [] } as unknown as SaveState;
    migrateLegacyBaleProducts(save);
    expect(b.storedBales!.hay).toBe(50); // 40 remapped + the 10 already there
    expect(b.storedBales!.alfalfaHaySquare).toBe(5);
    expect(b.storedBales).not.toHaveProperty("grassRoundbaleUnwrapped");
    expect(b.storedBales).not.toHaveProperty("alfalfaSquareBaleUnwrapped");
  });

  it("remaps a trailer's cargo tag and an in-flight haul/sell task's product", () => {
    const i = { id: "i1", kind: "haySpikes", cargoBaleProduct: "alfalfaRoundbaleUnwrapped" as BaleProduct } as unknown as Implement;
    const haul = { id: "t1", type: "haulBales", baleProduct: "grassRoundbaleUnwrapped" as BaleProduct } as unknown as FarmTask;
    const sell = { id: "t2", type: "sell", sellProduct: "grassSquareBaleUnwrapped" } as unknown as FarmTask;
    const save = { fields: [], buildings: [], implements: [i], tasks: [haul, sell] } as unknown as SaveState;
    migrateLegacyBaleProducts(save);
    expect(i.cargoBaleProduct).toBe("alfalfaHay");
    expect(haul.baleProduct).toBe("hay");
    expect(sell.sellProduct).toBe("haySquare");
  });

  it("remaps a per-product sell-schedule override, without clobbering one already on the new id", () => {
    const save = {
      fields: [], buildings: [], implements: [], tasks: [],
      sellSchedule: {
        grassRoundbaleUnwrapped: { month: 5, auto: true },
        alfalfaRoundbaleUnwrapped: { month: 6, auto: true },
        alfalfaHay: { month: 2, auto: false }, // already has its own override
      },
    } as unknown as SaveState;
    migrateLegacyBaleProducts(save);
    expect(save.sellSchedule!.hay).toEqual({ month: 5, auto: true }); // moved over
    expect(save.sellSchedule!.alfalfaHay).toEqual({ month: 2, auto: false }); // untouched, not overwritten
    expect(save.sellSchedule).not.toHaveProperty("grassRoundbaleUnwrapped");
    expect(save.sellSchedule).not.toHaveProperty("alfalfaRoundbaleUnwrapped");
  });

  it("is a safe no-op on a save with nothing legacy to migrate", () => {
    const f = field({ baleProduct: "hay" });
    const save = { fields: [f], buildings: [], implements: [], tasks: [] } as unknown as SaveState;
    expect(() => migrateLegacyBaleProducts(save)).not.toThrow();
    expect(f.baleProduct).toBe("hay");
  });

  it("every retired id resolves to a real, still-lookup-able product", () => {
    // The actual crash this guards: `isWrappedProduct`/any `gameConfig.
    // baleProducts[x]` lookup throws on `undefined` for an id the config
    // no longer knows.
    for (const oldId of ["grassRoundbaleUnwrapped", "alfalfaRoundbaleUnwrapped", "grassSquareBaleUnwrapped", "alfalfaSquareBaleUnwrapped"]) {
      const f = field({ baleProduct: oldId as BaleProduct });
      const save = { fields: [f], buildings: [], implements: [], tasks: [] } as unknown as SaveState;
      migrateLegacyBaleProducts(save);
      expect(() => isWrappedProduct(f.baleProduct!)).not.toThrow();
      expect(gameConfig.baleProducts[f.baleProduct!]).toBeDefined();
    }
  });
});
