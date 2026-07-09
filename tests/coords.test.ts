import { describe, it, expect } from "vitest";
import { toMeters, toLngLat, distanceMeters } from "../src/geo/coords";

/**
 * The coordinate system is the brief's "#1 architecture trap" (§3): one internal
 * UTM-meter space, converting only at the edges. These tests pin that the
 * conversions are consistent and that meter-space distances are physically real.
 */
describe("coords (UTM zone 15N, Story County)", () => {
  const ames: [number, number] = [-93.4635, 42.0308];

  it("round-trips lng/lat -> meters -> lng/lat within a millimeter", () => {
    const back = toLngLat(toMeters(ames));
    expect(back[0]).toBeCloseTo(ames[0], 7);
    expect(back[1]).toBeCloseTo(ames[1], 7);
  });

  it("produces plausible UTM coordinates for zone 15N", () => {
    const [e, n] = toMeters(ames);
    // Eastings are 0–1,000,000 m; Iowa northings are ~4.6M m above the equator.
    expect(e).toBeGreaterThan(0);
    expect(e).toBeLessThan(1_000_000);
    expect(n).toBeGreaterThan(4_500_000);
    expect(n).toBeLessThan(4_800_000);
  });

  it("measures real ground distance in meters", () => {
    // ~0.01° of latitude is ~1.11 km at this latitude.
    const a = toMeters(ames);
    const b = toMeters([ames[0], ames[1] + 0.01]);
    const d = distanceMeters(a, b);
    expect(d).toBeGreaterThan(1050);
    expect(d).toBeLessThan(1150);
  });
});
