/**
 * Procedural field textures (brief §10) — painted into the overlay engine.
 *
 * Goal: read as part of the NAIP satellite imagery, not stickers on top of it.
 * Three tricks do most of the work:
 *   1. MUTED, desaturated palettes sampled from real Iowa NAIP tones — satellite
 *      colors are hazier than "game" colors.
 *   2. MULTI-SCALE NOISE — big soft blotches (soil moisture / clay patches) under
 *      fine speckle, like real bare-earth imagery.
 *   3. ROWS — plow furrows and crop rows, oriented along the field's longest edge
 *      (how a farmer would actually run them), drawn in geo-space so they stay
 *      pinned at every zoom.
 *
 * The GROWING texture is stage-aware: young green rows on soil → canopy closing →
 * mature tone. Callers repaint when the stage bucket changes (cheap; per-field
 * canvas). All colors here are visual, not balance — they don't live in gameConfig.
 */

import type { Meters } from "../geo/coords";
import { smoothPolygon } from "../geo/geometry";
import type { FieldStatus } from "../state/saveState";
import type { CropId } from "../config/gameConfig";
import type { Surface } from "../map/overlay";

export interface FieldPaintParams {
  status: FieldStatus;
  crop?: CropId;
  /** Growth progress 0..1 (only meaningful for planted/growing/ready). */
  progress?: number;
  seed?: number;
}

/** Paint the field's current look into `surface`, clipped to `boundary`. */
export function paintField(surface: Surface, boundary: Meters[], p: FieldPaintParams): void {
  surface.paint((ctx) =>
    drawFieldTexture(ctx, surface.canvas.width, surface.canvas.height, (m) => surface.toPixel(m), boundary, p),
  );
}

/**
 * Draw the field's texture into ANY 2D context, given the canvas size and a
 * meters→pixel mapper. Split out from `paintField` so the sweep-reveal (main.ts)
 * can BAKE the target texture into an offscreen canvas and blit it in strip by
 * strip as the machine drives — using the exact same pixels the final repaint
 * will use, so there's no visible "pop" when the job completes.
 */
export function drawFieldTexture(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  toPixel: (m: Meters) => [number, number],
  boundary: Meters[],
  p: FieldPaintParams,
): void {
  const seed = p.seed ?? 1;
  // Row direction reads off the TRUE boundary (its longest real edge); only the
  // clip path is rounded, so smoothing doesn't skew "which way did the farmer
  // actually plant this field."
  const angle = dominantAngle(boundary, toPixel);
  const smoothed = smoothPolygon(boundary);

  {
    ctx.save();
    tracePolygon(ctx, smoothed, toPixel);
    ctx.clip();

    const { base, dark, light } = palette(p);
    ground(ctx, w, h, seed, base, dark, light);

    switch (p.status) {
      case "stubble":
        rows(ctx, w, h, angle, 3, "#c8b98f", 1, 0.16); // faint combine passes
        break;

      case "tilled":
        // Fresh-turned soil: clear plow furrows.
        rows(ctx, w, h, angle, 2.5, "#54432f", 1.1, 0.35);
        rows(ctx, w, h, angle, 2.5, "#837056", 0.7, 0.25, 1.25); // lit furrow edges
        break;

      case "planted":
        // Seeded soil: faint green rows emerging.
        rows(ctx, w, h, angle, 3, "#5d7444", 1, 0.3);
        break;

      case "growing": {
        const t = clamp01(((p.progress ?? 0) - 0.15) / 0.85); // 0 at emergence → 1 at ready
        // Young crop: crisp green rows that thicken, then dissolve into canopy.
        const rowAlpha = t < 0.5 ? 0.55 : 0.55 - (t - 0.5) * 0.8; // fade as canopy closes
        rows(ctx, w, h, angle, 3, "#4a6a35", 1 + t * 1.6, Math.max(0.12, rowAlpha));
        // Late season: canopy micro-texture (crown mottling).
        if (t > 0.5) canopyMottle(ctx, w, h, seed + 7, "#3f5a2d", "#61814a", (t - 0.5) * 2);
        break;
      }

      case "ready":
        canopyMottle(ctx, w, h, seed + 7, dark, light, 0.8);
        rows(ctx, w, h, angle, 3, dark, 0.8, 0.18);
        break;

      case "harvested":
        // Cut stubble: strong parallel cut lines + chaff rows.
        rows(ctx, w, h, angle, 3, "#93835a", 1.2, 0.3);
        rows(ctx, w, h, angle, 9, "#c9ba90", 2.2, 0.28, 4.5); // windrowed chaff lines
        break;
    }

    ctx.restore();

    // Feather the hard clip edge into transparency. The texture was clipped to a
    // crisp raster boundary; against the green imagery that reads as a dark line
    // no overlaid halo can fully hide. Stacked `destination-out` strokes along the
    // boundary — widest first, each erasing a little — carve a soft inward alpha
    // ramp: ~transparent at the very edge, full texture a few metres in, so the
    // field melts into the imagery like a real field margin.
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    const featherPx = 9; // inward fade width (≈ metres at 1 m/px)
    const passes = 8;
    for (let k = 0; k < passes; k++) {
      ctx.globalAlpha = 0.3;
      ctx.lineWidth = 2 * featherPx * (1 - k / passes) + 1.5; // wide → narrow
      tracePolygon(ctx, smoothed, toPixel);
      ctx.stroke();
    }
    ctx.restore();
  }
}

/**
 * The base/dark/light tones for a field's current look. Single source of truth so
 * the boundary outline (fields.ts) can tint itself to MATCH the texture instead of
 * a contrasting white line. `growing` lerps soil→canopy with progress; `ready`
 * shifts per crop — the outline follows both.
 */
function palette(p: FieldPaintParams): { base: string; dark: string; light: string } {
  switch (p.status) {
    case "stubble":
      return { base: "#b1a179", dark: "#98875f", light: "#c2b28a" };
    case "tilled":
      return { base: "#6f5c44", dark: "#5d4c37", light: "#7f6b50" };
    case "planted":
      return { base: "#7c6a50", dark: "#6a5a43", light: "#8c795d" };
    case "growing": {
      const t = clamp01(((p.progress ?? 0) - 0.15) / 0.85);
      return {
        base: lerpColor("#7c6a50", "#4f6b39", smooth(t)),
        dark: lerpColor("#6a5a43", "#42592f", smooth(t)),
        light: lerpColor("#8c795d", "#5d7c44", smooth(t)),
      };
    }
    case "ready":
      return p.crop === "soybeans"
        ? { base: "#a3924f", dark: "#8a7a3e", light: "#b5a563" }
        : { base: "#b09a58", dark: "#977f43", light: "#c2ad6d" };
    case "harvested":
      return { base: "#b3a375", dark: "#9a8a5e", light: "#c4b489" };
  }
}

/** The colour to feather a field's boundary with so the edge blends into (not
 * fights) the texture — only slightly darker than the base, so the halo reads as
 * a soft field margin rather than a dark drawn line where it laps over the green
 * surroundings. */
export function fieldEdgeColor(p: FieldPaintParams): string {
  const { base, dark } = palette(p);
  return lerpColor(base, dark, 0.3);
}

// --- texture building blocks ------------------------------------------------

/**
 * Ground fill: base color + large soft blotches (soil moisture patches) + fine
 * speckle. This is what makes the patch read as earth instead of flat paint.
 */
function ground(ctx: CanvasRenderingContext2D, w: number, h: number, seed: number, base: string, dark: string, light: string): void {
  const rng = mulberry32(seed);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);

  // Large-scale mottling: a few big, soft, squashed ellipses at low alpha.
  const blobs = Math.max(6, Math.floor((w * h) / 2500));
  for (let i = 0; i < blobs; i++) {
    ctx.fillStyle = rng() < 0.5 ? dark : light;
    ctx.globalAlpha = 0.04 + rng() * 0.08;
    const x = rng() * w, y = rng() * h;
    const rx = 8 + rng() * (w / 4), ry = 6 + rng() * (h / 6);
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, rng() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }

  // Fine speckle on top.
  const dots = Math.floor((w * h) / 45);
  for (let i = 0; i < dots; i++) {
    ctx.fillStyle = rng() < 0.5 ? dark : light;
    ctx.globalAlpha = 0.15 + rng() * 0.25;
    ctx.fillRect(rng() * w, rng() * h, 0.6 + rng(), 0.6 + rng());
  }
  ctx.globalAlpha = 1;
}

/**
 * Parallel field rows at `angleRad`, spaced `spacing` px (≈ meters at 1 m/px;
 * exaggerated vs real 0.76 m corn rows so they read at NAIP scale).
 */
function rows(
  ctx: CanvasRenderingContext2D, w: number, h: number,
  angleRad: number, spacing: number, color: string, width: number, alpha: number,
  phase = 0,
): void {
  const diag = Math.hypot(w, h);
  const cos = Math.cos(angleRad), sin = Math.sin(angleRad);
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate(angleRad);
  void cos; void sin;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  for (let d = -diag / 2 + phase; d <= diag / 2; d += spacing) {
    ctx.moveTo(-diag / 2, d);
    ctx.lineTo(diag / 2, d);
  }
  ctx.stroke();
  ctx.restore();
  ctx.globalAlpha = 1;
}

/** Clumpy crown texture for closed canopies (late corn / ready crops). */
function canopyMottle(ctx: CanvasRenderingContext2D, w: number, h: number, seed: number, dark: string, light: string, strength: number): void {
  const rng = mulberry32(seed);
  const clumps = Math.floor((w * h) / 60);
  for (let i = 0; i < clumps; i++) {
    ctx.fillStyle = rng() < 0.5 ? dark : light;
    ctx.globalAlpha = (0.06 + rng() * 0.12) * strength;
    const x = rng() * w, y = rng() * h, r = 1 + rng() * 2.5;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/**
 * Row direction: along the field's longest edge, in CANVAS pixel space (the
 * y-flip from north-up meters is handled by measuring edges after projection).
 */
function dominantAngle(boundary: Meters[], toPixel: (m: Meters) => [number, number]): number {
  let best = 0, bestLen = -1;
  for (let i = 0; i < boundary.length; i++) {
    const a = toPixel(boundary[i]!);
    const b = toPixel(boundary[(i + 1) % boundary.length]!);
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = dx * dx + dy * dy;
    if (len > bestLen) {
      bestLen = len;
      best = Math.atan2(dy, dx);
    }
  }
  return best;
}

/** Trace a polygon ring (meters) into `ctx` as a path, ready to clip/fill. */
function tracePolygon(ctx: CanvasRenderingContext2D, ring: Meters[], toPixel: (m: Meters) => [number, number]): void {
  ctx.beginPath();
  ring.forEach((pt, i) => {
    const [px, py] = toPixel(pt);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.closePath();
}

// --- small utils -------------------------------------------------------------

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function lerpColor(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const r = Math.round(((pa >> 16) & 255) + ((((pb >> 16) & 255) - ((pa >> 16) & 255)) * t));
  const g = Math.round(((pa >> 8) & 255) + ((((pb >> 8) & 255) - ((pa >> 8) & 255)) * t));
  const bl = Math.round((pa & 255) + (((pb & 255) - (pa & 255)) * t));
  return `rgb(${r},${g},${bl})`;
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
