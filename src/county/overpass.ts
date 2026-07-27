/**
 * Overpass query + conversion for runtime-built counties (2026-07-26).
 *
 * Replicates the bundled Story County extract's recipe EXACTLY, so a
 * runtime-built county feeds roadsLayer.ts / roadNet.ts the same shape of
 * data a bundled package does: LineString features with
 * `{ major: 0|1, hw: <highway class> }`, pre-clipped by the bbox query.
 *
 * Everything here is pure — the network call lives in builder.ts.
 */

import type { Feature, FeatureCollection, LineString } from "geojson";

/**
 * Version of the recipe below (query classes + conversion rules). Bump it
 * whenever either changes — cached counties in IndexedDB carry the version
 * they were built with, and a mismatch forces a rebuild (idbCache.ts).
 */
export const EXTRACT_RECIPE_VERSION = 1;

/** The 8 highway classes the Story extract ships — no _link variants. */
const HIGHWAY_CLASSES = [
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "unclassified",
  "residential",
  "track",
] as const;

/** Classes rendered as "major" (wide yellow) by roadsLayer.ts. */
const MAJOR = new Set<string>(["motorway", "trunk", "primary", "secondary"]);

/**
 * Overpass QL for every drivable-class way in a lng/lat bbox. NOTE Overpass
 * bbox order is (south, west, north, east) — not GeoJSON's (w, s, e, n).
 * `out geom` inlines each way's node coordinates so no second query is needed.
 */
export function buildOverpassQuery(bbox: [number, number, number, number]): string {
  const [w, s, e, n] = bbox;
  const re = `^(${HIGHWAY_CLASSES.join("|")})$`;
  return `[out:json][timeout:180];way["highway"~"${re}"](${s},${w},${n},${e});out geom;`;
}

interface OverpassElement {
  type?: string;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
}

/**
 * Overpass JSON → the roads FeatureCollection contract. Skips anything that
 * isn't a well-formed way with ≥2 geometry points (nodes, relations, ways
 * clipped to nothing). Tolerant of junk — a malformed element is dropped, not
 * thrown on, since this parses third-party data live in the field.
 */
export function overpassToRoads(json: unknown): FeatureCollection {
  const elements = (json as { elements?: OverpassElement[] } | null)?.elements ?? [];
  const features: Feature<LineString>[] = [];
  for (const el of elements) {
    if (el?.type !== "way") continue;
    const pts = el.geometry;
    if (!Array.isArray(pts) || pts.length < 2) continue;
    const hw = el.tags?.highway ?? "unclassified";
    features.push({
      type: "Feature",
      properties: { major: MAJOR.has(hw) ? 1 : 0, hw },
      geometry: {
        type: "LineString",
        coordinates: pts.map((p) => [p.lon, p.lat]),
      },
    });
  }
  return { type: "FeatureCollection", features };
}
