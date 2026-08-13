import { describe, it, expect } from "vitest";
import {
  structureWidthM, structurePx, structureArtHtml, BUILDING_ICON,
  STRUCTURE_MIN_PX, STRUCTURE_MAX_PX,
} from "../src/field/buildingRender";
import {
  siloSvg, baleBarnSvg, baleAreaSvg, tractorBarnSvg, implementBarnSvg, farmYardSvg, sellPointSvg,
} from "../src/ui/structureIcons";
import type { BuildingKind } from "../src/state/saveState";

const ALL_KINDS: BuildingKind[] = [
  "silo", "baleBarn", "baleArea", "tractorBarn", "implementBarn", "farmYard", "sellPoint", "silageBunker",
];

describe("structure footprints", () => {
  it("every building kind has a real ground width", () => {
    for (const kind of ALL_KINDS) {
      const w = structureWidthM(kind);
      expect(w, kind).toBeGreaterThan(0);
      expect(w, kind).toBeLessThan(100); // a farm building, not a county
    }
  });

  it("silos widen with their capacity tier", () => {
    const s = structureWidthM("silo", "small");
    const m = structureWidthM("silo", "medium");
    const l = structureWidthM("silo", "large");
    expect(m).toBeGreaterThan(s);
    expect(l).toBeGreaterThan(m);
  });

  it("silage bunkers widen with their tier too, and out-span a grain bin", () => {
    expect(structureWidthM("silageBunker", "large")).toBeGreaterThan(structureWidthM("silageBunker", "small"));
    // A bunker is a long walled slab; a bin is a narrow cylinder.
    expect(structureWidthM("silageBunker", "small")).toBeGreaterThan(structureWidthM("silo", "large"));
  });

  it("a machine shed is wider than a grain bin — proportions stay honest", () => {
    expect(structureWidthM("tractorBarn")).toBeGreaterThan(structureWidthM("silo", "large"));
  });

  it("falls back to the small tier for an unknown or missing silo size", () => {
    expect(structureWidthM("silo")).toBe(structureWidthM("silo", "small"));
    expect(structureWidthM("silo", "enormous")).toBe(structureWidthM("silo", "small"));
  });
});

describe("on-screen sizing curve", () => {
  // Story County sits near z12 by default (~0.03 px/m) and fieldwork happens
  // around z16-17 (~0.5-1 px/m).
  it("tracks true ground size in the middle of the range", () => {
    // 24 m shed at 2 px/m = 48 px — between the clamps, so it scales freely.
    expect(structurePx(24, 2)).toBeCloseTo(48, 6);
  });

  it("stops shrinking when zoomed out, so buildings stay findable and clickable", () => {
    // The real reason this clamp exists: a 5.5 m bin at county zoom is a
    // fraction of a pixel — mathematically right, completely unusable.
    expect(structurePx(5.5, 0.03)).toBe(STRUCTURE_MIN_PX);
    expect(structurePx(24, 0.001)).toBe(STRUCTURE_MIN_PX);
  });

  it("stops growing at max zoom, so a farmyard can't swallow the viewport", () => {
    expect(structurePx(30, 50)).toBe(STRUCTURE_MAX_PX);
  });

  it("is monotonic in zoom — a building never shrinks as you zoom in", () => {
    let last = 0;
    for (const pxPerM of [0.01, 0.05, 0.2, 1, 3, 8, 20, 60]) {
      const px = structurePx(18, pxPerM);
      expect(px).toBeGreaterThanOrEqual(last);
      last = px;
    }
  });

  it("orders buildings by real size once past the minimum clamp", () => {
    const pxPerM = 4; // zoomed in enough that nothing is clamped
    expect(structurePx(structureWidthM("tractorBarn"), pxPerM))
      .toBeGreaterThan(structurePx(structureWidthM("implementBarn"), pxPerM));
    expect(structurePx(structureWidthM("implementBarn"), pxPerM))
      .toBeGreaterThan(structurePx(structureWidthM("silo", "small"), pxPerM));
  });
});

describe("structure artwork", () => {
  it("every kind renders art — no kind falls through to nothing", () => {
    for (const kind of ALL_KINDS) {
      const html = structureArtHtml(kind);
      expect(html, kind).toContain("<svg");
      expect(html, kind).toContain("viewBox");
    }
  });

  it("silo art differs per tier (a Large bin should not draw as a Small one)", () => {
    expect(siloSvg("large")).not.toBe(siloSvg("small"));
    expect(structureArtHtml("silo", "large")).not.toBe(structureArtHtml("silo", "small"));
  });

  it("each kind draws something visually distinct", () => {
    const arts = ALL_KINDS.map((k) => structureArtHtml(k));
    expect(new Set(arts).size).toBe(ALL_KINDS.length);
  });

  it("art is authored on a shared 64-unit viewBox, so widths mean the same thing", () => {
    for (const art of [
      siloSvg(), baleBarnSvg(), baleAreaSvg(), tractorBarnSvg(),
      implementBarnSvg(), farmYardSvg(), sellPointSvg(),
    ]) {
      expect(art).toContain('viewBox="0 0 64 64"');
    }
  });

  it("art bottom-aligns, so a building's base sits on its coordinate", () => {
    // `anchor: "bottom"` on the marker only works if the drawing itself is
    // bottom-aligned inside its box — otherwise buildings hover.
    expect(siloSvg()).toContain('preserveAspectRatio="xMidYMax meet"');
    expect(baleBarnSvg()).toContain('preserveAspectRatio="xMidYMax meet"');
  });

  it("carries no baked background rect — it composites over satellite imagery", () => {
    for (const kind of ALL_KINDS) {
      // A full-bleed 0,0,64,64 fill would be an opaque box in the farmyard.
      expect(structureArtHtml(kind), kind).not.toMatch(/<rect[^>]*x="0"[^>]*y="0"[^>]*width="64"[^>]*height="64"/);
    }
  });

  it("keeps an emoji per kind for popup titles and panel rows", () => {
    for (const kind of ALL_KINDS) {
      expect(BUILDING_ICON[kind], kind).toBeTruthy();
    }
  });
});
