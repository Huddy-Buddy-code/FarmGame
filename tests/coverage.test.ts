import { describe, it, expect } from "vitest";
import {
  buildCoveragePath, sampleAt, workDoneAt, distanceAtWork, longestEdgeAngle,
} from "../src/sim/coverage";
import { areaMeters, pointInPolygon } from "../src/geo/geometry";
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

  it("handles a field narrower than one swath (single pass)", () => {
    const sliver: Meters[] = [[0, 0], [300, 0], [300, 4], [0, 4]];
    const path = buildCoveragePath(sliver, 10);
    expect(path.inField.filter(Boolean).length).toBe(1);
    expect(path.totalWork).toBeGreaterThan(0);
  });
});
