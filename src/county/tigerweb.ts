/**
 * County boundary polygons from Census TIGERweb (2026-07-28).
 *
 * The game board edge (mask + border + label, src/map/countyBoard.ts) needs the
 * county's real polygon; the national index only carries a bbox. Bundled
 * counties ship `boundary.geojson` pre-fetched by `tools/fetch-county-boundary.mjs`;
 * runtime-built counties fetch it here with the SAME query recipe — keep the
 * two in sync so both tiers get the identical edge.
 *
 * TIGERweb is the Census Bureau's own ArcGIS service (same source family as
 * the index's cartographic shapefile), sends CORS `*`, and answers by GEOID
 * (county FIPS) — no name matching, no OSM tagging lottery. The boundary is
 * COSMETIC: every failure path returns null and the county boots without a
 * board edge rather than failing the build over it.
 */

import type { Feature, MultiPolygon, Polygon } from "geojson";

export type CountyBoundary = Feature<Polygon | MultiPolygon>;

const TIGERWEB_COUNTIES =
  "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1/query";

/** The query URL for one county's polygon. geometryPrecision=5 ≈ 1 m — plenty
 * for a border stroke, and it keeps the response ~20-50 KB. */
export function boundaryQueryUrl(fips: string): string {
  const params = new URLSearchParams({
    where: `GEOID='${fips}'`,
    outFields: "GEOID,NAME",
    returnGeometry: "true",
    geometryPrecision: "5",
    outSR: "4326",
    f: "geojson",
  });
  return `${TIGERWEB_COUNTIES}?${params}`;
}

/** Extract the boundary Feature from a TIGERweb GeoJSON response, or null. */
export function parseBoundaryResponse(json: unknown): CountyBoundary | null {
  const fc = json as { features?: { geometry?: { type?: string } }[] } | null;
  const feature = fc?.features?.[0];
  const t = feature?.geometry?.type;
  if (t !== "Polygon" && t !== "MultiPolygon") return null;
  return feature as CountyBoundary;
}

export interface FetchBoundaryOptions {
  timeoutMs?: number;
  /** Injectable for tests — no real network in the suite. */
  fetchFn?: typeof fetch;
}

/** Fetch one county's boundary polygon. Null on ANY failure (see header). */
export async function fetchCountyBoundary(
  fips: string,
  opts: FetchBoundaryOptions = {},
): Promise<CountyBoundary | null> {
  const fetchFn = opts.fetchFn ?? fetch;
  try {
    const res = await fetchFn(boundaryQueryUrl(fips), {
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
    if (!res.ok) return null;
    return parseBoundaryResponse(await res.json());
  } catch {
    return null;
  }
}
