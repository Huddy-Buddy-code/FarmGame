import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { utmZoneForLng, type CountyIndexEntry } from "../src/county/countyIndex";

/**
 * These tests validate the COMMITTED index.json (built by
 * tools/build-county-index.mjs), so a bad rebuild can't slip into a deploy —
 * the suite is the review gate for regenerated data.
 */
const file = JSON.parse(
  readFileSync(join(__dirname, "..", "public", "counties", "index.json"), "utf8"),
) as { version: number; source: string; counties: CountyIndexEntry[] };
const counties = file.counties;

describe("utmZoneForLng", () => {
  it("matches known county zones", () => {
    expect(utmZoneForLng(-93.46)).toBe(15); // Story, IA
    expect(utmZoneForLng(-117.64)).toBe(11); // Whitman, WA
    expect(utmZoneForLng(-76.3)).toBe(18); // Lancaster, PA
  });
  it("uses floor semantics at zone boundaries and clamps garbage", () => {
    expect(utmZoneForLng(-96)).toBe(15); // exactly on the 14/15 boundary -> east zone
    expect(utmZoneForLng(-96.0001)).toBe(14);
    expect(utmZoneForLng(180)).toBe(60);
    expect(utmZoneForLng(-180)).toBe(1);
  });
});

describe("committed county index", () => {
  it("has a plausible CONUS county count", () => {
    expect(counties.length).toBeGreaterThanOrEqual(3100);
    expect(counties.length).toBeLessThanOrEqual(3120);
  });

  it("ids and FIPS are unique; FIPS are 5-digit", () => {
    expect(new Set(counties.map((c) => c.id)).size).toBe(counties.length);
    expect(new Set(counties.map((c) => c.fips)).size).toBe(counties.length);
    expect(counties.every((c) => /^\d{5}$/.test(c.fips))).toBe(true);
  });

  it("excludes AK/HI/territories (no NAIP CONUS coverage)", () => {
    const excluded = new Set(["02", "15", "60", "66", "69", "72", "78"]);
    expect(counties.some((c) => excluded.has(c.fips.slice(0, 2)))).toBe(false);
  });

  it("every bbox sits inside a CONUS envelope with sane orientation", () => {
    for (const c of counties) {
      const [w, s, e, n] = c.bbox;
      expect(w).toBeLessThan(e);
      expect(s).toBeLessThan(n);
      expect(w).toBeGreaterThan(-125.5);
      expect(e).toBeLessThan(-66.5);
      expect(s).toBeGreaterThan(24);
      expect(n).toBeLessThan(49.5);
    }
  });

  it("story-ia matches the bundled county package", () => {
    const story = counties.find((c) => c.id === "story-ia")!;
    expect(story).toBeDefined();
    expect(story.fips).toBe("19169");
    expect(story.state).toBe("IA");
    // The bundled manifest's hand-set center must fall inside the Census bbox.
    const [w, s, e, n] = story.bbox;
    expect(w).toBeLessThan(-93.4635);
    expect(e).toBeGreaterThan(-93.4635);
    expect(s).toBeLessThan(42.0308);
    expect(n).toBeGreaterThan(42.0308);
  });

  it("zone spot-checks derive correctly from centers", () => {
    const whitman = counties.find((c) => c.id === "whitman-wa")!;
    const lancaster = counties.find((c) => c.id === "lancaster-pa")!;
    expect(utmZoneForLng(whitman.center[0])).toBe(11);
    expect(utmZoneForLng(lancaster.center[0])).toBe(18);
  });

  it("resolves famous name collisions with distinct ids", () => {
    // St. Louis city vs St. Louis County (MO); Richmond city vs County (VA).
    const stl = counties.filter((c) => c.state === "MO" && c.name.startsWith("St. Louis"));
    expect(stl).toHaveLength(2);
    expect(new Set(stl.map((c) => c.id)).size).toBe(2);
    const richmondVa = counties.filter((c) => c.state === "VA" && c.name.startsWith("Richmond"));
    expect(richmondVa).toHaveLength(2);
    expect(new Set(richmondVa.map((c) => c.id)).size).toBe(2);
  });
});
