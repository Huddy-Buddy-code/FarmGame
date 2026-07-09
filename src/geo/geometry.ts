/**
 * Planar geometry helpers, all in UTM meters (the internal metric space, brief §3).
 *
 * These are pure math on `Meters` points — no projection state — so they're valid
 * for any active county. Kept separate from `coords.ts` (which owns the projection)
 * because this is geometry, not coordinate conversion.
 */

import type { Meters } from "./coords";

/** Axis-aligned bounds of a polygon: [minE, minN, maxE, maxN] in meters. */
export type BoundsMeters = [number, number, number, number];

/** Bounding box of a ring of points. Throws on empty input. */
export function boundsOf(points: Meters[]): BoundsMeters {
  if (points.length === 0) throw new Error("boundsOf: empty point list");
  let minE = Infinity, minN = Infinity, maxE = -Infinity, maxN = -Infinity;
  for (const [e, n] of points) {
    if (e < minE) minE = e;
    if (e > maxE) maxE = e;
    if (n < minN) minN = n;
    if (n > maxN) maxN = n;
  }
  return [minE, minN, maxE, maxN];
}

/** Grow bounds outward by `pad` meters on all sides. */
export function padBounds([minE, minN, maxE, maxN]: BoundsMeters, pad: number): BoundsMeters {
  return [minE - pad, minN - pad, maxE + pad, maxN + pad];
}

/**
 * Signed area of a polygon ring (shoelace), in square meters. Positive for a
 * counter-clockwise ring. Use `Math.abs` for magnitude. Valid because we're in a
 * metric projection, so 1 unit = 1 meter in both axes.
 */
export function signedAreaMeters(ring: Meters[]): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    sum += xj * yi - xi * yj;
  }
  return sum / 2;
}

/** Absolute polygon area in square meters. */
export function areaMeters(ring: Meters[]): number {
  return Math.abs(signedAreaMeters(ring));
}

/** Convenience: area in hectares (1 ha = 10,000 m²) and acres (1 ac = 4046.8564 m²). */
export function areaHectares(ring: Meters[]): number {
  return areaMeters(ring) / 10_000;
}
export function areaAcres(ring: Meters[]): number {
  return areaMeters(ring) / 4046.8564224;
}
