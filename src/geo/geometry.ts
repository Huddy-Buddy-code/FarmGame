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

/** Closest point to `p` lying ON the polygon's boundary (its edges, not its
 * interior) — used to keep a dragged marker (e.g. a field's access gates)
 * sliding along the perimeter instead of floating anywhere on the map. */
export function nearestPointOnPolygon(p: Meters, ring: Meters[]): Meters {
  const [px, py] = p;
  let best: Meters = ring[0]!;
  let bestD = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lenSq = dx * dx + dy * dy;
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / lenSq));
    const cx = a[0] + dx * t;
    const cy = a[1] + dy * t;
    const d = (px - cx) ** 2 + (py - cy) ** 2;
    if (d < bestD) {
      bestD = d;
      best = [cx, cy];
    }
  }
  return best;
}

/**
 * Lightly bevel + round a closed ring's corners for DISPLAY ONLY (corner-cutting).
 * Each edge is replaced by two points near its ends, so only the region right
 * around each corner is affected and the long straight edges stay straight — a
 * subtle chamfer, not a blob. A second iteration turns the flat bevel into a
 * gentle fillet. Pure point-list math — no curves/canvas calls — so the same ring
 * works for both the canvas texture clip and the vector outline (brief §4: smooth
 * in meters before the lng/lat render conversion, not after).
 *
 * The cut is a FIXED DISTANCE in meters (`maxCutMeters`), not a fraction, so a
 * corner gets the same small bevel whether its edges are 40 m or 600 m long — a
 * percentage would over-round the big fields. `cut` only caps it on short edges
 * (never take more than that fraction of a stubby edge). Only for rendering: the
 * true polygon (area, hit-testing, auto-manage) is never replaced — a drawn
 * field's stored boundary stays exactly what the player clicked.
 */
export function smoothPolygon(ring: Meters[], iterations = 2, maxCutMeters = 10, cut = 0.15): Meters[] {
  const cap = Math.min(0.5, Math.max(0, cut));
  let pts = ring;
  for (let iter = 0; iter < iterations; iter++) {
    const next: Meters[] = [];
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i]!;
      const [x1, y1] = pts[(i + 1) % pts.length]!;
      const len = Math.hypot(x1 - x0, y1 - y0);
      // Fixed-distance bevel, but never more than `cap` of a short edge.
      const f = len > 0 ? Math.min(cap, maxCutMeters / len) : cap;
      next.push([x0 + (x1 - x0) * f, y0 + (y1 - y0) * f]);
      next.push([x0 + (x1 - x0) * (1 - f), y0 + (y1 - y0) * (1 - f)]);
    }
    pts = next;
  }
  return pts;
}

/** Area centroid of a polygon ring (shoelace-weighted), in meters. Falls back to
 * the vertex average for degenerate (zero-area) rings. Used as the "work here"
 * target agents drive to (brief §9). */
export function centroidOf(ring: Meters[]): Meters {
  const a = signedAreaMeters(ring);
  if (Math.abs(a) < 1e-6) {
    let sx = 0, sy = 0;
    for (const [x, y] of ring) { sx += x; sy += y; }
    return [sx / ring.length, sy / ring.length];
  }
  let cx = 0, cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    const cross = xj * yi - xi * yj;
    cx += (xi + xj) * cross;
    cy += (yi + yj) * cross;
  }
  return [cx / (6 * a), cy / (6 * a)];
}

/** Convenience: area in hectares (1 ha = 10,000 m²) and acres (1 ac = 4046.8564 m²). */
export function areaHectares(ring: Meters[]): number {
  return areaMeters(ring) / 10_000;
}
export function areaAcres(ring: Meters[]): number {
  return areaMeters(ring) / 4046.8564224;
}
