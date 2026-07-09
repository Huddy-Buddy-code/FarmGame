/**
 * COORDINATE SYSTEM (brief §3) — "the #1 architecture trap."
 *
 * ONE internal metric space: UTM meters for the county's zone. All game logic
 * (distances, speeds, areas, agent positions, field geometry) works in meters.
 * We convert ONLY at the edges:
 *   - render boundary: meters -> lng/lat for MapLibre
 *   - ingest boundary: lng/lat (OSM, routing) -> meters
 *
 * Keeping conversion at the edges is what stops fields, dots, and paint overlay
 * from silently drifting apart.
 */

import proj4 from "proj4";
import { gameConfig } from "../config/gameConfig";

/** [easting, northing] in meters, in the county's UTM zone. */
export type Meters = [number, number];
/** [longitude, latitude] in degrees (WGS84). Render/ingest edge only. */
export type LngLat = [number, number];

const { utmZone, utmHemisphere } = gameConfig.county;

// EPSG for WGS84 lng/lat is built into proj4 as "WGS84".
const UTM_DEF =
  `+proj=utm +zone=${utmZone}` +
  (utmHemisphere === "S" ? " +south" : "") +
  " +datum=WGS84 +units=m +no_defs";

/** Ingest edge: lng/lat -> internal UTM meters. */
export function toMeters([lng, lat]: LngLat): Meters {
  const [e, n] = proj4("WGS84", UTM_DEF, [lng, lat]);
  return [e, n];
}

/** Render edge: internal UTM meters -> lng/lat. */
export function toLngLat([e, n]: Meters): LngLat {
  const [lng, lat] = proj4(UTM_DEF, "WGS84", [e, n]);
  return [lng, lat];
}

/** Euclidean distance in meters — valid because we're in a metric projection. */
export function distanceMeters(a: Meters, b: Meters): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}
