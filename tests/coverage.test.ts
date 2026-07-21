import { describe, it, expect } from "vitest";
import {
  buildCoveragePath, buildHeadlandLaps, buildHeadlandCoveragePath, sampleAt, workDoneAt, distanceAtWork, longestEdgeAngle,
} from "../src/sim/coverage";
import { areaMeters, pointInPolygon, boundsOf } from "../src/geo/geometry";
import type { Meters } from "../src/geo/coords";

// A 400 m × 200 m rectangle (longest edge horizontal → lanes run east-west).
const rect: Meters[] = [[0, 0], [400, 0], [400, 200], [0, 200]];

describe("coverage path (serpentine fieldwork route)", () => {
  it("runs lanes along the longest edge", () => {
    expect(longestEdgeAngle(rect)).toBeCloseTo(0, 6); // bottom edge, east
    // A tall field flips the dominant direction to vertical.
    const tall: Meters[] = [[0, 0], [200, 0], [200, 400], [0, 400]];
    expect(Math.abs(longestEdgeAngle(tall))).toBeCloseTo(Math.PI / 2, 6);
  });

  it("covers ≈ the field area: totalWork × swath matches within a few percent", () => {
    const swath = 10;
    const path = buildCoveragePath(rect, swath);
    const swept = path.totalWork * swath;
    const area = areaMeters(rect);
    expect(swept).toBeGreaterThan(area * 0.95);
    expect(swept).toBeLessThan(area * 1.05);
  });

  it("spaces lanes one swath apart (≈ height/swath lanes)", () => {
    const swath = 10;
    const path = buildCoveragePath(rect, swath);
    // 200 m tall / 10 m swath = 20 lanes; each ~400 m long.
    const laneSegments = path.inField.filter(Boolean).length;
    expect(laneSegments).toBeGreaterThanOrEqual(19);
    expect(laneSegments).toBeLessThanOrEqual(21);
  });

  it("stays essentially inside the field along the working lanes", () => {
    const swath = 10;
    const path = buildCoveragePath(rect, swath);
    // Sample many in-field points; they should sit within the (slightly padded)
    // rectangle. Turns bulge outside by design, so only check lane midpoints.
    for (let i = 0; i < path.pts.length - 1; i++) {
      if (!path.inField[i]) continue;
      const a = path.pts[i]!;
      const b = path.pts[i + 1]!;
      const mid: Meters = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      expect(pointInPolygon(mid, rect)).toBe(true);
    }
  });

  it("work length is monotonic and full length covers it", () => {
    const path = buildCoveragePath(rect, 10);
    for (let i = 1; i < path.work.length; i++) {
      expect(path.work[i]!).toBeGreaterThanOrEqual(path.work[i - 1]!);
      expect(path.cum[i]!).toBeGreaterThanOrEqual(path.cum[i - 1]!);
    }
    expect(path.totalWork).toBeLessThanOrEqual(path.total + 1e-6);
  });

  it("sampleAt / workDoneAt / distanceAtWork round-trip", () => {
    const path = buildCoveragePath(rect, 10);
    // Start and end anchor correctly.
    expect(workDoneAt(path, 0)).toBeCloseTo(0, 6);
    expect(workDoneAt(path, path.total)).toBeCloseTo(path.totalWork, 3);
    // Halfway through the WORK, inverting gives a distance that reproduces it.
    const halfWork = path.totalWork / 2;
    const d = distanceAtWork(path, halfWork);
    expect(workDoneAt(path, d)).toBeCloseTo(halfWork, 2);
    // The first segment is a lane (east pass); a point well inside it heads ~0.
    const s = sampleAt(path, Math.min(50, path.cum[1]! * 0.5));
    const h = Math.abs(s.heading);
    expect(Math.min(h, Math.abs(h - Math.PI))).toBeLessThan(0.05);
  });

  // A rectangle with a rectangular bite cut out of one edge (a farmstead/yard).
  const notched: Meters[] = [
    [0, 0], [900, 0], [900, 450], [540, 450], [540, 315], [360, 315], [360, 450], [0, 450],
  ];

  it("skips a concave cutout: every WORKING lane stays inside the field", () => {
    const path = buildCoveragePath(notched, 10);
    for (let i = 0; i < path.pts.length - 1; i++) {
      if (!path.inField[i]) continue; // transit/turn segments may cross the notch
      const a = path.pts[i]!;
      const b = path.pts[i + 1]!;
      const mid: Meters = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      expect(pointInPolygon(mid, notched)).toBe(true);
    }
  });

  it("works the TRUE field area on a concave field (cutout excluded), not the bbox", () => {
    const swath = 10;
    const path = buildCoveragePath(notched, swath);
    const swept = path.totalWork * swath;
    const area = areaMeters(notched); // excludes the notch
    expect(swept).toBeGreaterThan(area * 0.92);
    expect(swept).toBeLessThan(area * 1.06);
  });

  it("handles a field narrower than one swath (single pass)", () => {
    const sliver: Meters[] = [[0, 0], [300, 0], [300, 4], [0, 4]];
    const path = buildCoveragePath(sliver, 10);
    expect(path.inField.filter(Boolean).length).toBe(1);
    expect(path.totalWork).toBeGreaterThan(0);
  });
});

/**
 * Headland laps (maintainer spec, 2026-07-20): several perimeter passes around
 * the field boundary before/after the normal straight-lane interior fill. The
 * interior fill is the untouched `buildCoveragePath` above running on whatever
 * boundary the laps leave behind, so these tests focus on the NEW geometry:
 * lap tracing, graceful degradation on a too-small field, and the first/last
 * ordering — plus the resume-safety property the whole feature leans on (no
 * new persisted save field; reload rebuilds the identical deterministic path
 * and re-derives position from `doneAcres`, exactly like a plain path).
 */
describe("headland laps", () => {
  it("traces the requested lap count, each inset a further swath in", () => {
    const swath = 10;
    const { rings, innerBoundary } = buildHeadlandLaps(rect, swath, 3);
    expect(rings).toHaveLength(3);
    // Ring 0's centerline is inset swath/2 from the true boundary (so its
    // OUTER edge touches the boundary, not its centerline) — same convention
    // the interior lane-fill already uses for its own first/last lane.
    expect(boundsOf(rings[0]!)).toEqual([5, 5, 395, 195]);
    expect(boundsOf(rings[1]!)).toEqual([15, 15, 385, 185]);
    expect(boundsOf(rings[2]!)).toEqual([25, 25, 375, 175]);
    // The interior fill picks up exactly where the last ring's band ends.
    expect(boundsOf(innerBoundary)).toEqual([30, 30, 370, 170]);
  });

  it("degrades gracefully when a field is too small for the requested laps (e.g. plow's 6)", () => {
    const tiny: Meters[] = [[0, 0], [60, 0], [60, 60], [0, 60]];
    expect(() => buildHeadlandLaps(tiny, 10, 6)).not.toThrow();
    const { rings, innerBoundary } = buildHeadlandLaps(tiny, 10, 6);
    expect(rings.length).toBeGreaterThan(0);
    expect(rings.length).toBeLessThan(6); // ran out of field before 6 fit
    expect(innerBoundary.length).toBeGreaterThanOrEqual(3);
    for (const p of innerBoundary) {
      expect(Number.isFinite(p[0])).toBe(true);
      expect(Number.isFinite(p[1])).toBe(true);
    }
  });

  it("covers ≈ the full field area whether laps run first or last", () => {
    const swath = 10;
    for (const order of ["first", "last"] as const) {
      const path = buildHeadlandCoveragePath(rect, swath, 3, order);
      const swept = path.totalWork * swath;
      const area = areaMeters(rect);
      expect(swept).toBeGreaterThan(area * 0.9);
      expect(swept).toBeLessThan(area * 1.1);
    }
  });

  it('"first" starts on a lap (near the true boundary); "last" starts on the shrunken interior\'s own entry point', () => {
    const swath = 10;

    const first = buildHeadlandCoveragePath(rect, swath, 3, "first");
    // The first point is a lap vertex, inset only swath/2 — well outside where
    // the interior lane-fill's own first lane would start.
    expect(first.pts[0]![0]).toBeCloseTo(5, 6);

    const last = buildHeadlandCoveragePath(rect, swath, 3, "last");
    // "last" works the interior FIRST — its own entry point, on the boundary
    // the 3 laps left behind (inset 30 m), not the true field's edge.
    const { innerBoundary } = buildHeadlandLaps(rect, swath, 3);
    const interiorOnly = buildCoveragePath(innerBoundary, swath);
    expect(last.pts[0]).toEqual(interiorOnly.pts[0]);
  });

  it("falls back to a plain path when not even one lap fits", () => {
    const tiny: Meters[] = [[0, 0], [8, 0], [8, 8], [0, 8]];
    const path = buildHeadlandCoveragePath(tiny, 10, 6, "first");
    const plain = buildCoveragePath(tiny, 10);
    expect(path.pts).toEqual(plain.pts);
  });

  it("resumes correctly from doneAcres alone, like a plain path (no new save state needed)", () => {
    const swath = 10;
    const path = buildHeadlandCoveragePath(rect, swath, 3, "first");
    // Simulate "40% done, then reload": derive a distance from work-so-far,
    // rebuild the (deterministic) path fresh, and re-derive the same distance.
    const targetWork = path.totalWork * 0.4;
    const dist = distanceAtWork(path, targetWork);
    const rebuilt = buildHeadlandCoveragePath(rect, swath, 3, "first");
    expect(rebuilt.pts).toEqual(path.pts);
    const redistanced = distanceAtWork(rebuilt, workDoneAt(path, dist));
    expect(redistanced).toBeCloseTo(dist, 6);
  });
});
