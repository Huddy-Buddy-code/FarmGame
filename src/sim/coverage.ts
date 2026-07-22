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
import { boundsOf, offsetPolygonInward } from "../geo/geometry";
import type { TaskType } from "../state/saveState";

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

  // Each lane's INSIDE x-intervals. A concave notch (farmstead/yard cut out of
  // the boundary) yields TWO intervals on the lanes that cross it — the path must
  // skip the gap between them, not sweep across it.
  const laneSpans = laneYs.map((y) => ({ y, spans: horizontalSpans(local, y) }));

  // Boustrophedon CELLULAR DECOMPOSITION: group vertically-adjacent, x-overlapping
  // intervals into "cells" (columns). Each cell is a gap-free strip swept fully
  // before the next, so the machine never drives a WORKING pass through a cutout —
  // it only TRANSITS (non-work) between cells. This keeps `totalWork` equal to the
  // true field area (excluding the cutout), so the texture reveal fills exactly to
  // completion instead of running out early.
  interface Lane { y: number; xL: number; xR: number; }
  const overlap = (aL: number, aR: number, bL: number, bR: number) => Math.min(aR, bR) - Math.max(aL, bL) > 1e-6;
  const cells: Lane[][] = [];
  let open: Lane[][] = [];
  for (const { y, spans } of laneSpans) {
    const nextOpen: Lane[][] = [];
    const used = spans.map(() => false);
    for (const cell of open) {
      const last = cell[cell.length - 1]!;
      const matches = spans.map((_, i) => i).filter((i) => !used[i] && overlap(last.xL, last.xR, spans[i]![0], spans[i]![1]));
      // Clean 1-to-1 continuation only (a span not also claimed by another open
      // cell). Splits/merges/dead-ends close the cell and open fresh ones.
      if (matches.length === 1) {
        const i = matches[0]!;
        const contested = open.some((c) => c !== cell && overlap(c[c.length - 1]!.xL, c[c.length - 1]!.xR, spans[i]![0], spans[i]![1]));
        if (!contested) {
          used[i] = true;
          cell.push({ y, xL: spans[i]![0], xR: spans[i]![1] });
          nextOpen.push(cell);
          continue;
        }
      }
      cells.push(cell);
    }
    for (let i = 0; i < spans.length; i++) {
      if (!used[i]) nextOpen.push([{ y, xL: spans[i]![0], xR: spans[i]![1] }]);
    }
    open = nextOpen;
  }
  cells.push(...open);

  // Emit the route: serpentine each cell, chained by a straight TRANSIT between
  // cells and headland U-turns between lanes within a cell. `seg[i]` flags whether
  // localPts[i]→[i+1] is a working pass (only lane passes are).
  const localPts: Meters[] = [];
  const seg: boolean[] = [];
  const push = (p: Meters, inField: boolean) => {
    if (localPts.length > 0) seg.push(inField);
    localPts.push(p);
  };
  let prev: Meters | null = null;
  for (const cell of cells) {
    let lanes = cell.slice().sort((a, b) => a.y - b.y);
    if (lanes.length === 0) continue;
    // Enter the cell from whichever end (top/bottom lane) is nearer where we left
    // off — less wasted transit, and it tends to keep transits inside the field.
    if (prev && Math.abs(lanes[lanes.length - 1]!.y - prev[1]) < Math.abs(lanes[0]!.y - prev[1])) {
      lanes = lanes.reverse();
    }
    let forward = true;
    if (prev) {
      const l0 = lanes[0]!;
      forward = Math.hypot(l0.xL - prev[0], l0.y - prev[1]) <= Math.hypot(l0.xR - prev[0], l0.y - prev[1]);
    }
    for (let li = 0; li < lanes.length; li++) {
      const lane = lanes[li]!;
      const start: Meters = forward ? [lane.xL, lane.y] : [lane.xR, lane.y];
      const end: Meters = forward ? [lane.xR, lane.y] : [lane.xL, lane.y];
      if (localPts.length === 0) {
        push(start, false);
      } else if (li === 0) {
        push(start, false); // straight transit between cells (non-work)
      } else {
        // Headland U-turn from the previous lane's end to this lane's start.
        for (const q of turnArc(localPts[localPts.length - 1]!, start)) push(q, false);
        push(start, false);
      }
      push(end, true);
      prev = end;
      forward = !forward;
    }
  }
  if (localPts.length === 0) {
    // Degenerate: no lane crossed the field — fall back to a single mid line.
    push([minE, (minN + maxN) / 2], false);
    push([maxE, (minN + maxN) / 2], true);
  }

  // Rotate the route back to meters.
  const pts = localPts.map((p) => rot(p, angle));

  return accumulatePath(pts, seg, swath, angle);
}

/** Build a `CoveragePath` from an already-decided route: walk consecutive
 * points, summing full-route length (`cum`) and in-field-only length (`work`)
 * as it goes. Split out of `buildCoveragePath` so headland-lap routes
 * (boundary loops + interior lane-fill, stitched together) can reuse the exact
 * same accounting instead of duplicating it. */
export function accumulatePath(pts: Meters[], inField: boolean[], swath: number, angle: number): CoveragePath {
  const cum = [0];
  const work = [0];
  let total = 0;
  let totalWork = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    total += len;
    if (inField[i]) totalWork += len;
    cum.push(total);
    work.push(totalWork);
  }
  return { pts, cum, work, inField, total, totalWork, swath, angle };
}

/** Per-task-type headland behavior: how many perimeter laps a tractor drives
 * around the field boundary, and whether that happens before or after the
 * straight interior lane-fill (maintainer spec, 2026-07-20). Read by both the
 * sim (which path to actually drive) and the renderer (how wide a boundary
 * frame the finished texture shows) — see `field/fieldRender.ts`. */
export interface HeadlandConfig {
  laps: number;
  order: "first" | "last";
}
export const TASK_HEADLANDS: Partial<Record<TaskType, HeadlandConfig>> = {
  plow: { laps: 6, order: "last" },
  plant: { laps: 3, order: "last" },
  fertilize: { laps: 1, order: "last" },
  weed: { laps: 1, order: "last" },
  mow: { laps: 3, order: "first" },
  mulch: { laps: 3, order: "first" },
  rake: { laps: 3, order: "first" },
  bale: { laps: 3, order: "first" },
  harvest: { laps: 3, order: "first" },
};

/** Trace up to `laps` ring CENTERLINES, one implement-width apart, the first
 * inset half a swath from the true boundary — same convention the interior
 * lane-fill already uses for its own first/last lane, so a lap's outer edge
 * touches the true boundary exactly instead of the tractor driving ON the
 * property line. Stops early (not erroring) once `offsetPolygonInward` runs
 * out of field to shrink. `innerBoundary` is whatever's left over for the
 * interior lane-fill — inset a further half-swath past the last ring traced,
 * so the two fills tile with no gap or overlap; the original boundary itself
 * if not even one lap fits. */
export function buildHeadlandLaps(boundary: Meters[], swath: number, laps: number): { rings: Meters[][]; innerBoundary: Meters[] } {
  const rings: Meters[][] = [];
  let centerline = offsetPolygonInward(boundary, swath / 2);
  while (centerline && rings.length < laps) {
    rings.push(centerline);
    centerline = offsetPolygonInward(centerline, swath);
  }
  if (rings.length === 0) return { rings: [], innerBoundary: boundary };
  const last = rings[rings.length - 1]!;
  const innerBoundary = offsetPolygonInward(last, swath / 2) ?? last;
  return { rings, innerBoundary };
}

/** One piece of a route: `work[i]` flags whether `pts[i]`→`pts[i+1]` is
 * productive field work (mirrors `CoveragePath.inField`, before the pieces are
 * stitched together and their cumulative distances computed). */
interface PathPiece {
  pts: Meters[];
  work: boolean[];
}

/** One full lap around `ring`, back to its own start — the whole loop counts
 * as work (it's a real driven pass, same as an interior lane). */
function ringPiece(ring: Meters[]): PathPiece {
  return { pts: [...ring, ring[0]!], work: ring.map(() => true) };
}

function pathToPiece(path: CoveragePath): PathPiece {
  return { pts: path.pts, work: path.inField };
}

/** Concatenate route pieces end to end, with a non-work TRANSIT segment
 * bridging wherever one piece ends and the next begins — same convention
 * `buildCoveragePath` already uses between cells. */
function joinPieces(pieces: PathPiece[]): { pts: Meters[]; inField: boolean[] } {
  const pts: Meters[] = [];
  const inField: boolean[] = [];
  const append = (p: Meters, segIsWork: boolean) => {
    if (pts.length > 0) inField.push(segIsWork);
    pts.push(p);
  };
  for (const piece of pieces) {
    append(piece.pts[0]!, false); // transit in from the previous piece (ignored if this is the very first point)
    for (let i = 1; i < piece.pts.length; i++) append(piece.pts[i]!, piece.work[i - 1]!);
  }
  return { pts, inField };
}

/**
 * A coverage path that drives `laps` loops around the field boundary either
 * before or after the normal straight-lane interior fill (brief §10 follow-up,
 * 2026-07-20 — real headland passes: several laps around the edge, then fill
 * the middle in straight rows, or the reverse). The interior fill itself is
 * built by the UNMODIFIED `buildCoveragePath` on whatever boundary the laps
 * leave behind — cellular decomposition, concave-notch handling, etc. all
 * carry over untouched.
 *
 * If the field is too small/narrow for even one lap, this degrades to a plain
 * `buildCoveragePath(boundary, swath)` — same as a task with no headland config.
 */
export function buildHeadlandCoveragePath(boundary: Meters[], swath: number, laps: number, order: "first" | "last"): CoveragePath {
  const { rings, innerBoundary } = buildHeadlandLaps(boundary, swath, laps);
  const interior = buildCoveragePath(innerBoundary, swath);
  if (rings.length === 0) return interior;

  const ringPieces = rings.map(ringPiece);
  const pieces = order === "first"
    ? [...ringPieces, pathToPiece(interior)] // outer lap in -> ... -> innermost lap -> interior
    : [pathToPiece(interior), ...[...ringPieces].reverse()]; // interior -> innermost lap out -> ... -> outer lap (true boundary) last

  const { pts, inField } = joinPieces(pieces);
  return accumulatePath(pts, inField, swath, interior.angle);
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

/** The INSIDE x-intervals where the horizontal line y=`y` crosses polygon `ring`
 * (local frame): all edge crossings sorted and paired (0–1, 2–3, …). A convex
 * field gives one interval; a concave notch gives two (with the cutout as the
 * gap between them), so the coverage path can skip it instead of sweeping across. */
function horizontalSpans(ring: Meters[], y: number): Array<[number, number]> {
  const xs: number[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const ay = a[1];
    const by = b[1];
    if (ay === by) continue;
    const t = (y - ay) / (by - ay);
    if (t < 0 || t >= 1) continue; // half-open, so a shared vertex is counted once
    xs.push(a[0] + (b[0] - a[0]) * t);
  }
  xs.sort((p, q) => p - q);
  const out: Array<[number, number]> = [];
  for (let i = 0; i + 1 < xs.length; i += 2) {
    if (xs[i + 1]! - xs[i]! > 1e-6) out.push([xs[i]!, xs[i + 1]!]);
  }
  return out;
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
