/**
 * Coverage paths (brief §10) — the back-and-forth ("boustrophedon") route a
 * tractor/combine drives to work a whole field, aligned to the field's rows.
 *
 * Pure geometry in UTM meters (brief §3): no map, no DOM, so it's unit-testable
 * and shared by BOTH the sim (agent motion + how much work is done) and the
 * renderer (which strips of new texture to reveal). One source of truth for the
 * path means the tractor's dot and the texture reveal can never drift apart.
 *
 * The path runs lanes parallel to the field's LONGEST edge — the same direction
 * `fieldRender` draws furrows/rows — spaced one implement WIDTH apart, joined by
 * short headland U-turns at each end so the machine drives one continuous route.
 *
 * Two arc-lengths are tracked per point:
 *   - `cum`  — distance along the FULL route (lanes + turns); drives the dot.
 *   - `work` — distance along IN-FIELD lanes only (turns don't count); the
 *              machine only "works" here, so swept area = work-length × width.
 */

import type { Meters } from "../geo/coords";
import { boundsOf } from "../geo/geometry";

export interface CoveragePath {
  /** Ordered route points, in meters. */
  pts: Meters[];
  /** Cumulative FULL-route length at each point (pts[i]); cum[0] = 0. */
  cum: number[];
  /** Cumulative IN-FIELD (working) length at each point; flat across turns. */
  work: number[];
  /** Whether segment i (pts[i]→pts[i+1]) is productive field work (vs a turn). */
  inField: boolean[];
  /** Total full-route length (meters). */
  total: number;
  /** Total in-field working length (meters); totalWork × swath ≈ field area. */
  totalWork: number;
  /** Lane spacing = implement working width (meters). */
  swath: number;
  /** Lane heading in the meters frame (radians). */
  angle: number;
}

/** Angle (radians, meters frame) of the polygon's longest edge — the direction a
 * farmer runs the rows, and the direction `fieldRender` draws them. */
export function longestEdgeAngle(boundary: Meters[]): number {
  let best = 0;
  let bestLen = -1;
  for (let i = 0; i < boundary.length; i++) {
    const a = boundary[i]!;
    const b = boundary[(i + 1) % boundary.length]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = dx * dx + dy * dy;
    if (len > bestLen) {
      bestLen = len;
      best = Math.atan2(dy, dx);
    }
  }
  return best;
}

function rot([x, y]: Meters, a: number): Meters {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
}

/**
 * Build the coverage route for `boundary` at `swath` meters wide. Lanes run along
 * the longest edge; consecutive lanes alternate direction and are linked by a
 * semicircular headland turn so the whole thing is one drivable polyline.
 */
export function buildCoveragePath(boundary: Meters[], swath: number): CoveragePath {
  const angle = longestEdgeAngle(boundary);
  // Work in a frame where lanes are horizontal: rotate the polygon by -angle.
  const local = boundary.map((p) => rot(p, -angle));
  const [minE, minN, maxE, maxN] = boundsOf(local);

  // Lane centre-lines at y = minN + swath/2, + swath, … up through the field.
  const laneYs: number[] = [];
  const height = maxN - minN;
  if (height <= swath) {
    laneYs.push((minN + maxN) / 2); // field narrower than one pass: single lane
  } else {
    for (let y = minN + swath / 2; y <= maxN - swath / 2 + 1e-6; y += swath) laneYs.push(y);
    // Guarantee the far edge is covered even when it doesn't land on a step.
    const last = laneYs[laneYs.length - 1]!;
    if (maxN - swath / 2 - last > swath * 0.25) laneYs.push(maxN - swath / 2);
  }

  // Each lane's [xL, xR] = where the horizontal line meets the polygon.
  const lanes: Array<{ y: number; xL: number; xR: number }> = [];
  for (const y of laneYs) {
    const span = horizontalSpan(local, y);
    if (span) lanes.push({ y, xL: span[0], xR: span[1] });
  }
  if (lanes.length === 0) {
    // Degenerate: fall back to the bbox mid-line so there's always a route.
    lanes.push({ y: (minN + maxN) / 2, xL: minE, xR: maxE });
  }

  const localPts: Meters[] = [];
  for (let i = 0; i < lanes.length; i++) {
    const lane = lanes[i]!;
    const forward = i % 2 === 0;
    const start: Meters = [forward ? lane.xL : lane.xR, lane.y];
    const end: Meters = [forward ? lane.xR : lane.xL, lane.y];
    if (i > 0) {
      // Headland U-turn from the previous lane's end to this lane's start.
      const prev = localPts[localPts.length - 1]!;
      for (const p of turnArc(prev, start)) localPts.push(p);
    }
    localPts.push(start);
    localPts.push(end);
  }
  // Per-SEGMENT field-work flags: a lane pass keeps the same y and changes x; a
  // headland turn changes y. That cleanly separates work from turns.
  const segInField: boolean[] = [];
  for (let i = 0; i < localPts.length - 1; i++) {
    const a = localPts[i]!;
    const b = localPts[i + 1]!;
    segInField.push(Math.abs(a[1] - b[1]) < 1e-6 && Math.abs(a[0] - b[0]) > 1e-6);
  }

  // Rotate the route back to meters.
  const pts = localPts.map((p) => rot(p, angle));

  // Cumulative full + work lengths.
  const cum = [0];
  const work = [0];
  let total = 0;
  let totalWork = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    total += len;
    if (segInField[i]) totalWork += len;
    cum.push(total);
    work.push(totalWork);
  }

  return { pts, cum, work, inField: segInField, total, totalWork, swath, angle };
}

/** Semicircular headland turn linking `from` (a lane end) to `to` (next lane
 * start), in the local (lane-horizontal) frame. Returns intermediate points
 * (excluding the endpoints, which the caller already has/adds). */
function turnArc(from: Meters, to: Meters): Meters[] {
  const cx = (from[0] + to[0]) / 2;
  const cy = (from[1] + to[1]) / 2;
  const r = Math.hypot(to[0] - from[0], to[1] - from[1]) / 2;
  if (r < 1e-6) return [];
  const a0 = Math.atan2(from[1] - cy, from[0] - cx);
  const a1 = Math.atan2(to[1] - cy, to[0] - cx);
  // Bulge outward (away from the field) on the side the lanes advance toward.
  const steps = 5;
  const out: Meters[] = [];
  let delta = a1 - a0;
  // Normalise to the shorter sweep but force a half-turn (semicircle) direction
  // consistent with advancing to the next lane.
  if (delta <= -Math.PI) delta += 2 * Math.PI;
  if (delta > Math.PI) delta -= 2 * Math.PI;
  for (let s = 1; s < steps; s++) {
    const a = a0 + (delta * s) / steps;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

/** [xMin, xMax] where the horizontal line y=`y` crosses polygon `ring` (local
 * frame), or null if it doesn't. Uses the outermost crossings (robust for the
 * near-convex fields players draw; a concave notch is over-covered, which only
 * means a hair more sweep, never a gap). */
function horizontalSpan(ring: Meters[], y: number): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const ay = a[1];
    const by = b[1];
    if (ay === by) continue;
    const t = (y - ay) / (by - ay);
    if (t < 0 || t > 1) continue;
    const x = a[0] + (b[0] - a[0]) * t;
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  if (lo === Infinity || hi <= lo) return null;
  return [lo, hi];
}

export interface PathSample {
  pos: Meters;
  /** Travel heading at this point (radians, meters frame). */
  heading: number;
}

/** Position + heading at full-route distance `d` (clamped to the route). */
export function sampleAt(path: CoveragePath, d: number): PathSample {
  const dist = Math.max(0, Math.min(path.total, d));
  const i = segmentIndexFor(path.cum, dist);
  const a = path.pts[i]!;
  const b = path.pts[i + 1] ?? a;
  const segLen = path.cum[i + 1]! - path.cum[i]!;
  const t = segLen > 1e-9 ? (dist - path.cum[i]!) / segLen : 0;
  return {
    pos: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
    heading: Math.atan2(b[1] - a[1], b[0] - a[0]),
  };
}

/** In-field working length covered by full-route distance `d`. */
export function workDoneAt(path: CoveragePath, d: number): number {
  const dist = Math.max(0, Math.min(path.total, d));
  const i = segmentIndexFor(path.cum, dist);
  const segLen = path.cum[i + 1]! - path.cum[i]!;
  const t = segLen > 1e-9 ? (dist - path.cum[i]!) / segLen : 0;
  const segWork = path.work[i + 1]! - path.work[i]!;
  return path.work[i]! + segWork * t;
}

/** Inverse of `workDoneAt`: the full-route distance at which `targetWork` meters
 * of in-field work have been done (lands at the start of a turn if exactly at a
 * boundary — fine for reload restore). */
export function distanceAtWork(path: CoveragePath, targetWork: number): number {
  const w = Math.max(0, Math.min(path.totalWork, targetWork));
  for (let i = 0; i < path.work.length - 1; i++) {
    if (path.work[i + 1]! >= w - 1e-9) {
      const segWork = path.work[i + 1]! - path.work[i]!;
      if (segWork < 1e-9) return path.cum[i]!;
      const t = (w - path.work[i]!) / segWork;
      return path.cum[i]! + (path.cum[i + 1]! - path.cum[i]!) * t;
    }
  }
  return path.total;
}

function segmentIndexFor(cum: number[], dist: number): number {
  // Last index i with cum[i] <= dist (and i < last).
  let lo = 0;
  let hi = cum.length - 2;
  if (hi < 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid]! <= dist) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
