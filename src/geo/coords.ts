/**
 * COORDINATE SYSTEM (brief §3) — "the #1 architecture trap."
 *
 * ONE internal metric space: UTM meters for the ACTIVE county's zone. All game
 * logic (distances, speeds, areas, agent positions, field geometry) works in
 * meters. We convert ONLY at the edges:
 *   - render boundary: meters -> lng/lat for MapLibre
 *   - ingest boundary: lng/lat (OSM, routing) -> meters
 *
 * The UTM zone is per-county (a Palouse county sits in a different zone than an
 * Iowa one), so the projection is set from the loaded county manifest at startup
 * via `setProjection()`. Conversions before that throw, to catch ordering bugs.
 */

import proj4 from "proj4";

/** [easting, northing] in meters, in the active county's UTM zone. */
export type Meters = [number, number];
/** [longitude, latitude] in degrees (WGS84). Render/ingest edge only. */
export type LngLat = [number, number];

let utmDef: string | null = null;

/** Set the active metric projection from the county manifest. Call once at startup. */
export function setProjection(zone: number, hemisphere: "N" | "S"): void {
  utmDef =
    `+proj=utm +zone=${zone}` +
    (hemisphere === "S" ? " +south" : "") +
    " +datum=WGS84 +units=m +no_defs";
}

function def(): string {
  if (!utmDef) {
    throw new Error("coords: setProjection() must be called before any conversion");
  }
  return utmDef;
}

/** Ingest edge: lng/lat -> internal UTM meters. */
export function toMeters([lng, lat]: LngLat): Meters {
  const [e, n] = proj4("WGS84", def(), [lng, lat]);
  return [e, n];
}

/** Render edge: internal UTM meters -> lng/lat. */
export function toLngLat([e, n]: Meters): LngLat {
  const [lng, lat] = proj4(def(), "WGS84", [e, n]);
  return [lng, lat];
}

/** Euclidean distance in meters — valid because we're in a metric projection. */
export function distanceMeters(a: Meters, b: Meters): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}
