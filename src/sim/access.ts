/**
 * Field access points (maintainer request, 2026-07-12): every field has TWO
 * entrance/exit gates on its boundary. Machines leave a field through its
 * nearest gate and enter the destination field through one, instead of
 * crossing the boundary anywhere (see the field-aware route composition in
 * `tasks.ts`). Gates are auto-placed at creation — the perimeter point
 * closest to a road, plus the point half a perimeter away — and the player
 * can drag them from the field panel's edit mode.
 */

import type { Meters } from "../geo/coords";
import { nearestRoadPoint } from "./roadNet";
import type { RoadNetwork } from "./roadNet";

/** Perimeter sampling step for gate auto-placement, meters. */
const SAMPLE_STEP_M = 20;

/** Points every ~SAMPLE_STEP_M along the boundary ring, plus each sample's
 * cumulative perimeter distance. */
function perimeterSamples(boundary: Meters[]): { pts: Meters[]; at: number[]; total: number } {
  const pts: Meters[] = [];
  const at: number[] = [];
  let walked = 0;
  for (let i = 0; i < boundary.length; i++) {
    const a = boundary[i]!;
    const b = boundary[(i + 1) % boundary.length]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.floor(len / SAMPLE_STEP_M));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      at.push(walked + len * t);
    }
    walked += len;
  }
  return { pts, at, total: walked };
}

/**
 * Auto-place a field's two gates: gate 1 at the perimeter point nearest a
 * road (where a farmer would actually cut the fence), gate 2 half a
 * perimeter away — far enough apart that whichever end of the field a
 * machine is at, one gate is close. With no road network, gate 1 falls back
 * to the first boundary vertex.
 */
export function defaultAccessPoints(boundary: Meters[], net: RoadNetwork | null): [Meters, Meters] {
  const { pts, at, total } = perimeterSamples(boundary);
  let bestIdx = 0;
  if (net) {
    let bestD = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const snap = nearestRoadPoint(net, pts[i]!);
      if (snap && snap.d < bestD) {
        bestD = snap.d;
        bestIdx = i;
      }
    }
  }
  // Gate 2: the sample closest to half a perimeter beyond gate 1.
  const targetAt = (at[bestIdx]! + total / 2) % total;
  let oppIdx = 0;
  let oppErr = Infinity;
  for (let i = 0; i < at.length; i++) {
    const d = Math.abs(at[i]! - targetAt);
    const wrapped = Math.min(d, total - d);
    if (wrapped < oppErr) {
      oppErr = wrapped;
      oppIdx = i;
    }
  }
  const g1 = pts[bestIdx]!;
  const g2 = pts[oppIdx]!;
  return [[g1[0], g1[1]], [g2[0], g2[1]]];
}
