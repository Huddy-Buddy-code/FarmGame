import { describe, it, expect } from "vitest";
import { boundaryQueryUrl, parseBoundaryResponse, fetchCountyBoundary } from "../src/county/tigerweb";

const storyish = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { GEOID: "19169", NAME: "Story" },
      geometry: { type: "Polygon", coordinates: [[[-93.7, 41.86], [-93.23, 41.86], [-93.23, 42.21], [-93.7, 42.21], [-93.7, 41.86]]] },
    },
  ],
};

function fakeFetch(body: unknown, ok = true): typeof fetch {
  return (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;
}

describe("TIGERweb boundary fetch", () => {
  it("queries by GEOID with GeoJSON output and ~1 m precision", () => {
    const url = boundaryQueryUrl("19169");
    expect(url).toContain("tigerweb.geo.census.gov");
    expect(url).toContain("GEOID%3D%2719169%27"); // URLSearchParams-encoded GEOID='19169'
    expect(url).toContain("f=geojson");
    expect(url).toContain("geometryPrecision=5");
    expect(url).toContain("outSR=4326");
  });

  it("parses the first polygon feature", () => {
    const f = parseBoundaryResponse(storyish);
    expect(f?.geometry.type).toBe("Polygon");
    expect(f?.properties?.GEOID).toBe("19169");
  });

  it("accepts MultiPolygon (coastal counties)", () => {
    const mp = {
      features: [{ type: "Feature", properties: {}, geometry: { type: "MultiPolygon", coordinates: [] } }],
    };
    expect(parseBoundaryResponse(mp)?.geometry.type).toBe("MultiPolygon");
  });

  it("returns null on empty / malformed / non-polygon responses", () => {
    expect(parseBoundaryResponse(null)).toBeNull();
    expect(parseBoundaryResponse({})).toBeNull();
    expect(parseBoundaryResponse({ features: [] })).toBeNull();
    expect(parseBoundaryResponse({ features: [{ geometry: { type: "Point" } }] })).toBeNull();
    // ArcGIS reports errors as 200s with an error body — must not throw.
    expect(parseBoundaryResponse({ error: { code: 400 } })).toBeNull();
  });

  it("fetches and parses via an injected fetch", async () => {
    const f = await fetchCountyBoundary("19169", { fetchFn: fakeFetch(storyish) });
    expect(f?.properties?.GEOID).toBe("19169");
  });

  it("is null on HTTP failure and on a throwing fetch — NEVER throws (boundary is cosmetic)", async () => {
    expect(await fetchCountyBoundary("19169", { fetchFn: fakeFetch({}, false) })).toBeNull();
    const throwing = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await fetchCountyBoundary("19169", { fetchFn: throwing })).toBeNull();
  });
});
