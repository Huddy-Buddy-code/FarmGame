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

/** Ray-cast point-in-polygon test (meters). Used for click → field hit-testing. */
export function pointInPolygon([x, y]: Meters, ring: Meters[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Lightly bevel + round a closed ring's corners for DISPLAY ONLY (corner-cutting).
 * Each edge is replaced by two points a small fraction `cut` in from its ends, so
 * only the region right around each corner is affected and the long straight edges
 * stay straight — a subtle chamfer, not a blob. A second iteration turns the flat
 * bevel into a gentle fillet. Pure point-list math — no curves/canvas calls — so
 * the same ring works for both the canvas texture clip and the vector outline
 * (brief §4: smooth in meters before the lng/lat render conversion, not after).
 *
 * `cut` is the fraction of each edge taken off near a corner (0.1 = 10%); keep it
 * small so edges read as straight. Only for rendering: the true polygon (area,
 * hit-testing, auto-manage) is never replaced — a drawn field's stored boundary
 * stays exactly what the player clicked.
 */
export function smoothPolygon(ring: Meters[], iterations = 2, cut = 0.1): Meters[] {
  const c = Math.min(0.5, Math.max(0, cut));
  let pts = ring;
  for (let iter = 0; iter < iterations; iter++) {
    const next: Meters[] = [];
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i]!;
      const [x1, y1] = pts[(i + 1) % pts.length]!;
      next.push([x0 + (x1 - x0) * c, y0 + (y1 - y0) * c]);
      next.push([x0 + (x1 - x0) * (1 - c), y0 + (y1 - y0) * (1 - c)]);
    }
    pts = next;
  }
  return pts;
}

/** Convenience: area in hectares (1 ha = 10,000 m²) and acres (1 ac = 4046.8564 m²). */
export function areaHectares(ring: Meters[]): number {
  return areaMeters(ring) / 10_000;
}
export function areaAcres(ring: Meters[]): number {
  return areaMeters(ring) / 4046.8564224;
}
