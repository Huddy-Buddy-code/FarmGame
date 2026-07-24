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

/** Intersection of two infinite lines, each given as a point + direction.
 * `null` if they're parallel (or nearly so). */
function lineIntersect(p1: Meters, d1: Meters, p2: Meters, d2: Meters): Meters | null {
  const denom = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(denom) < 1e-9) return null;
  const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
  const t = (dx * d2[1] - dy * d2[0]) / denom;
  return [p1[0] + d1[0] * t, p1[1] + d1[1] * t];
}

/**
 * Inward-offset a polygon ring by `distance` meters — each edge's line moves
 * toward the polygon's interior, and consecutive offset lines are re-intersected
 * for the new vertices (used to trace successive headland laps, brief §10: each
 * lap is one implement-width further in from the last).
 *
 * Returns `null` if the offset has nowhere sensible left to go: the result
 * collapses to a sliver (area below 15% of the input ring's — a field too
 * small/narrow for another lap), an edge intersection is parallel/undefined, or
 * a vertex lands unreasonably far outside the original ring (a near-parallel
 * edge pair blowing up the intersection point). Callers stop lapping on `null`
 * rather than erroring — this is an expected "ran out of field" signal, not a bug.
 */
export function offsetPolygonInward(ring: Meters[], distance: number): Meters[] | null {
  const n = ring.length;
  if (n < 3 || distance <= 0) return null;
  const [minE, minN, maxE, maxN] = boundsOf(ring);
  const guardPad = distance * 4 + Math.max(maxE - minE, maxN - minN);

  // Which way is "in" comes from the ring's WINDING, not from pointing at the
  // centroid (2026-07-23). The centroid test is only valid on convex shapes:
  // at a concave vertex the interior can lie on the far side of the centroid,
  // so an edge bordering a notch got its normal flipped and that lap's vertices
  // landed OUTSIDE the field. Because one bad edge then failed the
  // edge-reversal check below, the whole offset returned null and
  // buildHeadlandCoveragePath silently degraded to a plain no-headland path —
  // the "headlands don't work on fields with several corners" report.
  //
  // For a counter-clockwise ring (positive signed area) the LEFT normal of
  // every edge points into the interior; for a clockwise ring it's the right
  // normal. That holds at every vertex, convex or reflex.
  const ccw = signedAreaMeters(ring) > 0;

  const lines: Array<{ p: Meters; dir: Meters }> = [];
  for (let i = 0; i < n; i++) {
    const a = ring[i]!, b = ring[(i + 1) % n]!;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const inward: Meters = ccw ? [-uy, ux] : [uy, -ux];
    lines.push({ p: [a[0] + inward[0] * distance, a[1] + inward[1] * distance], dir: [ux, uy] });
  }

  const out: Meters[] = [];
  for (let i = 0; i < n; i++) {
    const prev = lines[(i - 1 + n) % n]!;
    const cur = lines[i]!;
    const pt = lineIntersect(prev.p, prev.dir, cur.p, cur.dir);
    if (!pt || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) return null;
    if (pt[0] < minE - guardPad || pt[0] > maxE + guardPad || pt[1] < minN - guardPad || pt[1] > maxN + guardPad) return null;
    out.push(pt);
  }

  // A valid inward offset moves each edge along its OWN direction — it never
  // reverses one. Once the offset distance exceeds what an edge's local
  // geometry allows, the naive intersection still finds a small, simple-
  // looking polygon (a point-reflection through the shape's center, which
  // doesn't flip its overall winding sign — so that's not a reliable signal
  // here), but one or more edges come out backwards relative to the input.
  // Reject that rather than hand back a shape that looks plausible but isn't
  // the shrink it claims to be.
  for (let i = 0; i < n; i++) {
    const a = out[i]!, b = out[(i + 1) % n]!;
    const dot = (b[0] - a[0]) * lines[i]!.dir[0] + (b[1] - a[1]) * lines[i]!.dir[1];
    if (dot <= 0) return null;
  }

  const inputArea = areaMeters(ring);
  if (inputArea < 1e-6) return null;
  if (areaMeters(out) < inputArea * 0.15) return null;
  return out;
}

/** Convenience: area in hectares (1 ha = 10,000 m²) and acres (1 ac = 4046.8564 m²). */
export function areaHectares(ring: Meters[]): number {
  return areaMeters(ring) / 10_000;
}
export function areaAcres(ring: Meters[]): number {
  return areaMeters(ring) / 4046.8564224;
}
