/**
 * Procedural field textures (brief §10) — the first consumer of the overlay engine.
 *
 * Fields are filled with a PROCEDURAL texture (chosen over baked images: lighter and
 * flexible — we can tint/blend per crop, growth stage, season, weather). Here in the
 * slice we render the field's current lifecycle status as a tinted, speckled fill,
 * clipped to the field polygon, painted into a geo-referenced overlay surface so it
 * sits over the NAIP imagery at real coordinates.
 *
 * Later, the fieldwork reveal (§10) will repaint only the swept path of this same
 * surface as the tractor works — the reason this is raster and geo-referenced.
 */

import type { Meters } from "../geo/coords";
import type { FieldStatus } from "../state/saveState";
import type { Surface } from "../map/overlay";

/** Base fill + speckle colors per lifecycle status. Purely visual, not balance. */
const PALETTE: Record<FieldStatus, { base: string; dark: string; light: string }> = {
  stubble:   { base: "#b8a06a", dark: "#8f7c4e", light: "#d0bb85" }, // pale straw
  tilled:    { base: "#6b4a33", dark: "#523725", light: "#815b41" }, // dark turned soil
  planted:   { base: "#7a5c3e", dark: "#5f4730", light: "#8a6f4e" }, // soil w/ faint rows
  growing:   { base: "#4e7a3a", dark: "#3a5c2c", light: "#69954f" }, // green canopy
  ready:     { base: "#c8b24a", dark: "#a08f38", light: "#e0cf6a" }, // ripe gold
  harvested: { base: "#a89566", dark: "#82724d", light: "#c1ae7d" }, // cut stubble
};

/**
 * Paint `field` (boundary in meters) at its current `status` into `surface`.
 * Deterministic per field so a repaint doesn't reshuffle the speckle (seeded RNG).
 */
export function paintFieldStatus(surface: Surface, boundary: Meters[], status: FieldStatus, seed = 1): void {
  const { base, dark, light } = PALETTE[status];
  surface.paint((ctx) => {
    ctx.save();
    // Clip to the field so the texture never spills past the boundary.
    surface.tracePolygon(boundary);
    ctx.clip();

    // Solid base tint.
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, surface.canvas.width, surface.canvas.height);

    // Procedural speckle for a worked-ground feel. Deterministic RNG so repaints
    // are stable. Density scales with area so big and small fields look consistent.
    const rng = mulberry32(seed);
    const w = surface.canvas.width, h = surface.canvas.height;
    const dots = Math.floor((w * h) / 40);
    for (let i = 0; i < dots; i++) {
      ctx.fillStyle = rng() < 0.5 ? dark : light;
      const x = rng() * w, y = rng() * h;
      const r = 0.5 + rng() * 1.5;
      ctx.globalAlpha = 0.25 + rng() * 0.35;
      ctx.fillRect(x, y, r, r);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  });
}

/** Small, fast, deterministic PRNG (mulberry32). Same seed -> same texture. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
