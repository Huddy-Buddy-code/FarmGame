import { describe, it, expect } from "vitest";
import {
  canWrapBales, applyWrapDone, applyBaleDone, baleageProductFor, isWrappedProduct,
} from "../src/sim/farming";
import { baleSpoilRateFor, tickBaleSpoilage } from "../src/sim/buildings";
import { gameConfig } from "../src/config/gameConfig";
import { minutesPerMonth } from "../src/sim/calendar";
import type { Field, SaveState, Building } from "../src/state/saveState";
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

  it("flags exactly the six wrapped products (2026-08-13: +2 square, +2 generic aged)", () => {
    const wrapped = (Object.keys(gameConfig.baleProducts) as BaleProduct[]).filter(isWrappedProduct);
    expect(wrapped.sort()).toEqual(
      ["alfalfaBaleage", "alfalfaHaySquareBaleage", "hayBaleage", "haySquareBaleage", "silageBale", "silageBaleSquare"].sort(),
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

describe("wrapping a field", () => {
  it("converts the product and spends the window", () => {
    const f = field();
    applyWrapDone(f, 0);
    expect(f.baleProduct).toBe("hayBaleage");
    expect(f.baledAt).toBeUndefined();
    expect(canWrapBales(f, 0)).toBe(false); // can't be wrapped twice
  });

  it("does NOT change the bale count — wrapping preserves bales, it doesn't make them", () => {
    const f = field({ baleLocations: [[1, 1], [2, 2], [3, 3]] });
    applyWrapDone(f, 0);
    expect(f.baleLocations).toHaveLength(3);
  });

  it("leaves an unwrappable field completely alone", () => {
    const f = field({ baleProduct: "straw" });
    applyWrapDone(f, 0);
    expect(f.baleProduct).toBe("straw");
    expect(f.baledAt).toBe(0); // window untouched — nothing happened
  });

  it("alfalfa wraps to its own product, not grass baleage", () => {
    const f = field({ crop: "alfalfaSilage", baleProduct: "alfalfaHay" });
    applyWrapDone(f, 0);
    expect(f.baleProduct).toBe("alfalfaBaleage");
  });
});

describe("baling stamps the window", () => {
  const perennial = (over: Partial<Field> = {}): Field =>
    field({ crop: "grassSilage", status: "harvested", baleProduct: undefined, baledAt: undefined, ...over });

  it("a round baler records WHEN, so the wrap window can be judged", () => {
    const f = perennial();
    applyBaleDone(f, false, 5000);
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

describe("baleage balance", () => {
  it("prices both baleage products below their dry twin PER BALE (it's half water)", () => {
    expect(gameConfig.baleProducts.hayBaleage.pricePerBale)
      .toBeLessThan(gameConfig.baleProducts.hay.pricePerBale);
    expect(gameConfig.baleProducts.alfalfaBaleage.pricePerBale)
      .toBeLessThan(gameConfig.baleProducts.alfalfaHay.pricePerBale);
  });

  it("makes MORE bales per acre, each heavier and wetter — DM per acre is what's preserved", () => {
    for (const [dry, wet] of [["hay", "hayBaleage"], ["alfalfaHay", "alfalfaBaleage"]] as const) {
      expect(gameConfig.baleProducts[wet].balesPerAcre).toBeGreaterThan(gameConfig.baleProducts[dry].balesPerAcre);
      expect(gameConfig.baleProducts[wet].tonsPerBale).toBeGreaterThan(gameConfig.baleProducts[dry].tonsPerBale);
    }
  });

  it("grosses within ~15% of dry hay per acre, so the choice is about STORAGE not free money", () => {
    for (const [dry, wet] of [["hay", "hayBaleage"], ["alfalfaHay", "alfalfaBaleage"]] as const) {
      const dryGross = gameConfig.baleProducts[dry].pricePerBale * gameConfig.baleProducts[dry].balesPerAcre;
      const wetGross = gameConfig.baleProducts[wet].pricePerBale * gameConfig.baleProducts[wet].balesPerAcre;
      expect(wetGross).toBeGreaterThan(dryGross * 0.85);
      expect(wetGross).toBeLessThan(dryGross * 1.15);
    }
  });

  it("a combi baler costs far more than a round baler plus a wrapper — you pay for the one-pass guarantee", () => {
    const separate = gameConfig.equipment.bailer.medium.price + gameConfig.equipment.baleWrapper.medium.price;
    expect(gameConfig.equipment.combiBaler.medium.price).toBeGreaterThan(separate * 1.5);
  });
});
