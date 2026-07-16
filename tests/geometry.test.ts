import { describe, it, expect } from "vitest";
import { areaMeters, areaAcres, boundsOf, padBounds, smoothPolygon, nearestPointOnPolygon } from "../src/geo/geometry";
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

  /**
   * smoothPolygon is DISPLAY-ONLY rounding (Chaikin corner-cutting) for field
   * textures/outlines — it must never be mistaken for the real stored boundary,
   * so these tests pin its shape properties rather than exact coordinates.
   */
  describe("smoothPolygon (display-only corner rounding)", () => {
    it("doubles the point count per iteration and stays inside the original bounds", () => {
      const once = smoothPolygon(square, 1);
      expect(once).toHaveLength(square.length * 2);
      const twice = smoothPolygon(square, 2);
      expect(twice).toHaveLength(square.length * 4);

      // Chaikin cutting only ever moves points toward the interior of each edge,
      // so the smoothed ring can't extend past the original square's bounds.
      const b = boundsOf(twice);
      expect(b[0]).toBeGreaterThanOrEqual(0);
      expect(b[1]).toBeGreaterThanOrEqual(0);
      expect(b[2]).toBeLessThanOrEqual(200);
      expect(b[3]).toBeLessThanOrEqual(200);
    });

    it("cuts corners away rather than passing through the original vertices", () => {
      const smoothed = smoothPolygon(square, 2);
      // No point of a rounded square should land exactly on a sharp 90° corner.
      for (const corner of square) {
        expect(smoothed).not.toContainEqual(corner);
      }
    });

    it("leaves the input ring untouched (pure function)", () => {
      const copy = square.map((p) => [...p] as Meters);
      smoothPolygon(square, 3);
      expect(square).toEqual(copy);
    });
  });

  describe("nearestPointOnPolygon", () => {
    // Access-point gates must stay glued to the fence line, never drift into
    // the field's interior or off into open ground.
    it("projects an interior point onto the nearest edge", () => {
      const p = nearestPointOnPolygon([50, 10], square); // closer to the bottom edge than any other
      expect(p).toEqual([50, 0]);
    });

    it("projects a point beyond a corner onto that corner, not past it", () => {
      const p = nearestPointOnPolygon([-50, -50], square);
      expect(p).toEqual([0, 0]);
    });

    it("leaves a point already on an edge unchanged", () => {
      const p = nearestPointOnPolygon([100, 0], square);
      expect(p).toEqual([100, 0]);
    });
  });
});
