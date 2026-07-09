/**
 * Real-road routing (brief §2, §9, §12 step 4).
 *
 * The economy hinges on real drive-time + distance between fields and buyers, so
 * routing must run on the actual road graph — not straight lines. For the data
 * spike we prove this end to end against the public OSRM demo server.
 *
 * LATER: self-host OSRM/Valhalla with the Story County OSM extract only (brief §2),
 * so routing is offline, fast, and not rate-limited. This module's interface stays
 * the same; only the base URL changes.
 */

import type { LngLat } from "../geo/coords";

const OSRM_BASE = "https://router.project-osrm.org";

export interface RouteResult {
  /** Route geometry as lng/lat coords (render/ingest edge — convert to meters for logic). */
  geometry: LngLat[];
  /** Drive distance in meters. */
  distanceMeters: number;
  /** Drive time in seconds. */
  durationSeconds: number;
}

/** Query a driving route between two points on real roads. */
export async function route(from: LngLat, to: LngLat): Promise<RouteResult> {
  const coords = `${from[0]},${from[1]};${to[0]},${to[1]}`;
  const url = `${OSRM_BASE}/route/v1/driving/${coords}?overview=full&geometries=geojson`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OSRM ${res.status}`);
  const data = await res.json();
  if (data.code !== "Ok" || !data.routes?.length) {
    throw new Error(`OSRM: ${data.code ?? "no route"}`);
  }
  const r = data.routes[0];
  return {
    geometry: r.geometry.coordinates as LngLat[],
    distanceMeters: r.distance,
    durationSeconds: r.duration,
  };
}
