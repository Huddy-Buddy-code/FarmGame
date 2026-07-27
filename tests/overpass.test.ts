import { describe, it, expect } from "vitest";
import { buildOverpassQuery, overpassToRoads, EXTRACT_RECIPE_VERSION } from "../src/county/overpass";
import type { LineString } from "geojson";

describe("buildOverpassQuery", () => {
  const q = buildOverpassQuery([-93.7, 41.86, -93.32, 42.11]);

  it("asks for exactly the bundled extract's 8 highway classes, anchored", () => {
    expect(q).toContain(
      '["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|track)$"]',
    );
    expect(q).not.toContain("_link"); // Story extract ships no link roads
  });

  it("uses Overpass (south,west,north,east) bbox order — NOT GeoJSON order", () => {
    expect(q).toContain("(41.86,-93.7,42.11,-93.32)");
  });

  it("requests inline way geometry as JSON", () => {
    expect(q).toContain("[out:json]");
    expect(q).toContain("out geom;");
  });
});

describe("overpassToRoads", () => {
  const fixture = {
    elements: [
      {
        type: "way",
        tags: { highway: "primary", name: "US 30" },
        geometry: [
          { lat: 42.0, lon: -93.5 },
          { lat: 42.01, lon: -93.49 },
        ],
      },
      {
        type: "way",
        tags: { highway: "residential" },
        geometry: [
          { lat: 42.1, lon: -93.6 },
          { lat: 42.11, lon: -93.61 },
          { lat: 42.12, lon: -93.62 },
        ],
      },
      {
        type: "way",
        tags: { highway: "track" },
        geometry: [
          { lat: 42.2, lon: -93.7 },
          { lat: 42.21, lon: -93.71 },
        ],
      },
      // Everything below must be DROPPED:
      { type: "node", lat: 42.0, lon: -93.5 },
      { type: "relation", tags: { highway: "primary" } },
      { type: "way", tags: { highway: "primary" } }, // no geometry
      { type: "way", tags: { highway: "primary" }, geometry: [{ lat: 42, lon: -93 }] }, // 1 point
    ],
  };
  const fc = overpassToRoads(fixture);

  it("keeps only well-formed ways", () => {
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features).toHaveLength(3);
  });

  it("maps the major flag exactly like the bundled extract", () => {
    const props = fc.features.map((f) => f.properties as { major: number; hw: string });
    expect(props[0]).toEqual({ major: 1, hw: "primary" });
    expect(props[1]).toEqual({ major: 0, hw: "residential" });
    expect(props[2]).toEqual({ major: 0, hw: "track" });
  });

  it("emits LineStrings in [lng, lat] order (roadNet/roadsLayer contract)", () => {
    const g = fc.features[0]!.geometry as LineString;
    expect(g.type).toBe("LineString");
    expect(g.coordinates[0]).toEqual([-93.5, 42.0]);
  });

  it("tolerates junk input without throwing", () => {
    expect(overpassToRoads(null).features).toHaveLength(0);
    expect(overpassToRoads({}).features).toHaveLength(0);
    expect(overpassToRoads({ elements: "nope" }).features).toHaveLength(0);
  });

  it("exports a numeric recipe version for the cache", () => {
    expect(typeof EXTRACT_RECIPE_VERSION).toBe("number");
  });
});
