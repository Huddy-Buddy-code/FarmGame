import { describe, it, expect } from "vitest";
import { baleFeatureCollection, baleStateKey, baleProductOf, MAX_BALE_FEATURES } from "../src/field/baleLayer";
import { setProjection } from "../src/geo/coords";
import type { Field } from "../src/state/saveState";
import type { Meters } from "../src/geo/coords";

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
