import { describe, it, expect } from "vitest";
import type { Meters } from "../src/geo/coords";
import { offsetPolygonInward, areaMeters, pointInPolygon } from "../src/geo/geometry";
import { buildHeadlandLaps, buildHeadlandCoveragePath, buildCoveragePath } from "../src/sim/coverage";

/** An L-shaped field: a square with one quadrant bitten out. One reflex
 * (>180 degrees) vertex — the simplest shape the centroid heuristic gets wrong. */
const L_SHAPE: Meters[] = [
  [0, 0], [400, 0], [400, 200], [200, 200], [200, 400], [0, 400],
];

/** A plus/cross-shaped field — four reflex vertices, 12 corners. */
const PLUS: Meters[] = [
  [200, 0], [400, 0], [400, 200], [600, 200], [600, 400], [400, 400],
  [400, 600], [200, 600], [200, 400], [0, 400], [0, 200], [200, 200],
];

/** A rectangle with a notch cut into one edge (a farmstead cut-out). */
const NOTCHED: Meters[] = [
  [0, 0], [600, 0], [600, 400], [350, 400], [350, 250], [250, 250], [250, 400], [0, 400],
];

const SQUARE: Meters[] = [[0, 0], [400, 0], [400, 400], [0, 400]];

describe("offsetPolygonInward on concave shapes", () => {
  for (const [name, ring] of [["L-shape", L_SHAPE], ["plus", PLUS], ["notched rectangle", NOTCHED]] as const) {
    it(`shrinks a ${name} instead of giving up`, () => {
      const out = offsetPolygonInward(ring, 10);
      expect(out).not.toBeNull();
      // A real inward offset is strictly smaller, but not degenerate.
      const a0 = Math.abs(areaMeters(ring));
      const a1 = Math.abs(areaMeters(out!));
      expect(a1).toBeLessThan(a0);
      expect(a1).toBeGreaterThan(a0 * 0.5);
    });

    it(`keeps every ${name} offset vertex INSIDE the original`, () => {
      const out = offsetPolygonInward(ring, 10)!;
      for (const p of out) expect(pointInPolygon(p, ring)).toBe(true);
    });
  }

  it("still shrinks a plain square by the exact offset", () => {
    const out = offsetPolygonInward(SQUARE, 10)!;
    expect(Math.abs(areaMeters(out))).toBeCloseTo(380 * 380, 6);
  });

  it("refuses when the shape is smaller than the offset", () => {
    expect(offsetPolygonInward(SQUARE, 500)).toBeNull();
  });
});

describe("buildHeadlandLaps on complex shapes", () => {
  for (const [name, ring] of [["L-shape", L_SHAPE], ["plus", PLUS], ["notched rectangle", NOTCHED]] as const) {
    it(`traces real perimeter laps around a ${name}`, () => {
      const { rings } = buildHeadlandLaps(ring, 8, 3);
      expect(rings.length).toBe(3);
      for (const r of rings) for (const p of r) expect(pointInPolygon(p, ring)).toBe(true);
    });
  }
});

describe("headland coverage paths on complex shapes", () => {
  for (const [name, ring] of [["L-shape", L_SHAPE], ["plus", PLUS], ["notched rectangle", NOTCHED]] as const) {
    it(`${name}: swept area still accounts for the real field area`, () => {
      const swath = 8;
      const path = buildHeadlandCoveragePath(ring, swath, 3, "first");
      // totalWork x swath should approximate the polygon's area. Headland laps
      // overlap slightly at corners, so allow a generous band -- the point is
      // that it neither falls far short (texture reveal would stall before the
      // field filled) nor wildly overshoots (it would finish early).
      const swept = path.totalWork * swath;
      const actual = areaMeters(ring);
      expect(swept).toBeGreaterThan(actual * 0.75);
      expect(swept).toBeLessThan(actual * 1.35);
    });

    it(`${name}: actually drives headland laps rather than degrading to a plain path`, () => {
      const withHeadland = buildHeadlandCoveragePath(ring, 8, 3, "first");
      const plain = buildCoveragePath(ring, 8);
      // A degraded path is byte-identical to the plain one -- that silent
      // fallback is exactly what the centroid bug was causing.
      expect(withHeadland.pts.length).not.toBe(plain.pts.length);
    });
  }
});
