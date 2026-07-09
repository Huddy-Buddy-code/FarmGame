import { describe, it, expect } from "vitest";
import { areaMeters, areaAcres, boundsOf, padBounds } from "../src/geo/geometry";
import type { Meters } from "../src/geo/coords";

/**
 * Field geometry is measured in UTM meters (brief §3), so a square of side L must
 * measure exactly L² m² by the shoelace formula — this is what makes land cost and
 * (later) yield-per-acre physically real rather than screen-pixel guesses.
 */
describe("geometry (meters)", () => {
  // A 200 m x 200 m square = 40,000 m² = 4 ha ≈ 9.88 acres.
  const square: Meters[] = [
    [0, 0],
    [200, 0],
    [200, 200],
    [0, 200],
  ];

  it("computes polygon area independent of winding direction", () => {
    expect(areaMeters(square)).toBeCloseTo(40_000, 6);
    const reversed = [...square].reverse();
    expect(areaMeters(reversed)).toBeCloseTo(40_000, 6);
  });

  it("converts area to acres", () => {
    expect(areaAcres(square)).toBeCloseTo(9.884, 2);
  });

  it("bounds a ring and pads it symmetrically", () => {
    expect(boundsOf(square)).toEqual([0, 0, 200, 200]);
    expect(padBounds([0, 0, 200, 200], 5)).toEqual([-5, -5, 205, 205]);
  });
});
