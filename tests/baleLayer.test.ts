import { describe, it, expect } from "vitest";
import {
  baleFeatureCollection, baleStateKey, baleProductOf, wrappedBaleProductOf, MAX_BALE_FEATURES, baleIconPx, ICON_PX,
} from "../src/field/baleLayer";
import { setProjection } from "../src/geo/coords";
import type { Field } from "../src/state/saveState";
import type { Meters } from "../src/geo/coords";
import { gameConfig } from "../src/config/gameConfig";
import type { BaleProduct } from "../src/config/gameConfig";

setProjection(15, "N"); // Story County — toLngLat needs a projection

function field(id: string, locs: Meters[], product?: Field["baleProduct"]): Field {
  return {
    id,
    parcelId: `p-${id}`,
    boundary: [[0, 0], [100, 0], [100, 100], [0, 100]],
    status: "harvested",
    baleLocations: locs,
    baleProduct: product,
  } as Field;
}

describe("bale feature collection", () => {
  it("emits one point feature per dropped bale, tagged with its product", () => {
    const fc = baleFeatureCollection([field("f1", [[10, 10], [20, 20]], "hay")]);
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features).toHaveLength(2);
    expect(fc.features[0]!.geometry.type).toBe("Point");
    expect(fc.features[0]!.properties?.product).toBe("hay");
  });

  it("projects to lng/lat — the layer is geographic, the sim is UTM meters", () => {
    const [lng, lat] = baleFeatureCollection([field("f1", [[10, 10]], "hay")]).features[0]!.geometry.coordinates;
    expect(lng).toBeGreaterThan(-180);
    expect(lng).toBeLessThan(180);
    expect(lat).toBeGreaterThan(-90);
    expect(lat).toBeLessThan(90);
  });

  it("merges every field's bales into ONE collection (one source, one layer)", () => {
    const fc = baleFeatureCollection([
      field("f1", [[1, 1], [2, 2]], "hay"),
      field("f2", [[3, 3]], "strawSquare"),
    ]);
    expect(fc.features).toHaveLength(3);
    expect(fc.features.map((f) => f.properties?.product)).toEqual(["hay", "hay", "strawSquare"]);
  });

  it("skips fields with no bales, and handles a missing baleLocations array", () => {
    const bare = { id: "f3", parcelId: "p", boundary: [], status: "stubble" } as unknown as Field;
    expect(baleFeatureCollection([field("f1", []), bare]).features).toHaveLength(0);
  });

  it("defaults a product-less field to cornStover (legacy saves predate baleProduct)", () => {
    expect(baleProductOf(field("f1", [[1, 1]]))).toBe("cornStover");
    expect(baleFeatureCollection([field("f1", [[1, 1]])]).features[0]!.properties?.product).toBe("cornStover");
  });

  it("caps a pathological save at MAX_BALE_FEATURES", () => {
    const many: Meters[] = Array.from({ length: MAX_BALE_FEATURES + 500 }, (_, i) => [i, i] as Meters);
    expect(baleFeatureCollection([field("f1", many, "hay")]).features).toHaveLength(MAX_BALE_FEATURES);
  });

  it("the cap is far above the old 600-per-field DOM ceiling that motivated this", () => {
    expect(MAX_BALE_FEATURES).toBeGreaterThan(600 * 10);
  });
});

describe("bale state key", () => {
  it("changes when a bale drops", () => {
    const before = baleStateKey([field("f1", [[1, 1]], "hay")]);
    const after = baleStateKey([field("f1", [[1, 1], [2, 2]], "hay")]);
    expect(after).not.toBe(before);
  });

  it("changes when a field is RE-BALED into another product (round → square)", () => {
    // The old marker code had to special-case this or a square-baled field kept
    // its round icons; the key must catch it so setData re-runs.
    const round = baleStateKey([field("f1", [[1, 1]], "hay")]);
    const square = baleStateKey([field("f1", [[1, 1]], "haySquare")]);
    expect(square).not.toBe(round);
  });

  it("changes when bales are sold off a field", () => {
    const full = baleStateKey([field("f1", [[1, 1], [2, 2]], "hay")]);
    const sold = baleStateKey([field("f1", [], "hay")]);
    expect(sold).not.toBe(full);
  });

  it("is stable when nothing changed — the guard that stops needless setData churn", () => {
    const fields = [field("f1", [[1, 1], [2, 2]], "hay"), field("f2", [[3, 3]], "straw")];
    expect(baleStateKey(fields)).toBe(baleStateKey(fields));
  });

  it("is empty with no bales anywhere", () => {
    expect(baleStateKey([field("f1", [])])).toBe("");
  });
});

describe("wrapped pool rendering (2026-08-14) — a field mid-wrap shows a genuine mix", () => {
  // The Silage crops' bales share plain Grass/Alfalfa's "hay"/"alfalfaHay"/
  // "haySquare" ids again (2026-08-15 product-list cleanup dropped the
  // one-day-old distinct "…Unwrapped" ids — see the BaleProduct union's
  // comment, config/gameConfig.ts) — these tests are still exercising a
  // genuinely unwrapped pool, just under the shared name now.
  it("derives the wrapped product from the unwrapped one, not a stored field", () => {
    expect(wrappedBaleProductOf(field("f1", [], "hay"))).toBe("hayBaleage");
    expect(wrappedBaleProductOf(field("f1", [], "alfalfaHay"))).toBe("alfalfaBaleage");
    expect(wrappedBaleProductOf(field("f1", [], "haySquare"))).toBe("haySquareBaleage");
  });

  it("falls back to the unwrapped product itself if it somehow isn't wrappable — draws something, not nothing", () => {
    expect(wrappedBaleProductOf(field("f1", [], "straw"))).toBe("straw");
  });

  it("emits BOTH piles as separate features, each with its own product", () => {
    const f = field("f1", [[1, 1], [2, 2]], "hay");
    f.wrappedBaleLocations = [[3, 3]];
    const fc = baleFeatureCollection([f]);
    expect(fc.features).toHaveLength(3);
    const products = fc.features.map((feat) => feat.properties?.product);
    expect(products.filter((p) => p === "hay")).toHaveLength(2);
    expect(products.filter((p) => p === "hayBaleage")).toHaveLength(1);
  });

  it("counts toward the state key separately, so a bale flipping pools still repaints", () => {
    const unwrapped = field("f1", [[1, 1], [2, 2]], "hay");
    const f = field("f1", [[1, 1]], "hay");
    f.wrappedBaleLocations = [[2, 2]]; // one of the two just got sealed
    expect(baleStateKey([f])).not.toBe(baleStateKey([unwrapped]));
  });
});

describe("square bales render 35% bigger on the map (2026-08-16)", () => {
  it("gives every square product a 35% bigger icon than round", () => {
    for (const product of Object.keys(gameConfig.baleProducts) as BaleProduct[]) {
      const expected = gameConfig.baleProducts[product].square ? ICON_PX * 1.35 : ICON_PX;
      expect(baleIconPx(product), product).toBe(expected);
    }
  });

  it("round products keep the original size exactly", () => {
    expect(baleIconPx("hay")).toBe(ICON_PX);
    expect(baleIconPx("cornStover")).toBe(ICON_PX);
  });

  it("square products are visibly bigger, not just differently shaped", () => {
    expect(baleIconPx("haySquare")).toBeGreaterThan(baleIconPx("hay"));
    expect(baleIconPx("alfalfaHaySquare")).toBeGreaterThan(baleIconPx("alfalfaHay"));
  });
});
