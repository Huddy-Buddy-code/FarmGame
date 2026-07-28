import { describe, it, expect } from "vitest";
import { boundaryBbox, unionBbox, countyMaskFeature } from "../src/map/countyBoard";
import type { CountyBoundary } from "../src/county/tigerweb";

const square: CountyBoundary = {
  type: "Feature",
  properties: {},
  geometry: {
    type: "Polygon",
    coordinates: [[[-93.7, 41.86], [-93.23, 41.86], [-93.23, 42.21], [-93.7, 42.21], [-93.7, 41.86]]],
  },
};

const twoPart: CountyBoundary = {
  type: "Feature",
  properties: {},
  geometry: {
    type: "MultiPolygon",
    coordinates: [
      [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
      [[[2, 2], [3, 2], [3, 4], [2, 4], [2, 2]]],
    ],
  },
};

describe("game board geometry", () => {
  it("boundaryBbox spans the polygon", () => {
    expect(boundaryBbox(square)).toEqual([-93.7, 41.86, -93.23, 42.21]);
  });

  it("boundaryBbox spans every part of a MultiPolygon", () => {
    expect(boundaryBbox(twoPart)).toEqual([0, 0, 3, 4]);
  });

  it("unionBbox fits both inputs — the manifest's hand-tuned bbox can be SMALLER than the county", () => {
    // Story's real case: manifest north 42.11, county north 42.209.
    const manifest: [number, number, number, number] = [-93.7, 41.86, -93.32, 42.11];
    expect(unionBbox(manifest, boundaryBbox(square))).toEqual([-93.7, 41.86, -93.23, 42.21]);
  });

  it("mask = world-sized outer ring with the county as a hole", () => {
    const mask = countyMaskFeature(square);
    expect(mask.geometry.type).toBe("Polygon");
    const [outer, hole] = mask.geometry.coordinates;
    expect(outer).toEqual([[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]);
    expect(hole).toEqual(square.geometry.coordinates[0]);
    expect(mask.geometry.coordinates).toHaveLength(2);
  });

  it("mask cuts one hole per MultiPolygon part", () => {
    const mask = countyMaskFeature(twoPart);
    expect(mask.geometry.coordinates).toHaveLength(3); // world + 2 holes
  });

  it("mask ignores interior enclave holes (they stay imagery, not dead spots)", () => {
    const withEnclave: CountyBoundary = {
      type: "Feature",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: [
          [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
          [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]], // independent-city enclave
        ],
      },
    };
    const mask = countyMaskFeature(withEnclave);
    expect(mask.geometry.coordinates).toHaveLength(2); // world + outer ring only
  });
});
