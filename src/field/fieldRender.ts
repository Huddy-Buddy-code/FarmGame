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
  const seed = p.seed ?? 1;
  const angle = dominantAngle(boundary, surface);

  surface.paint((ctx) => {
    ctx.save();
    surface.tracePolygon(boundary);
    ctx.clip();
    const w = surface.canvas.width, h = surface.canvas.height;

    switch (p.status) {
      case "stubble":
        ground(ctx, w, h, seed, "#b1a179", "#98875f", "#c2b28a");
        rows(ctx, w, h, angle, 3, "#c8b98f", 1, 0.16); // faint combine passes
        break;

      case "tilled":
        // Fresh-turned soil: dark, with clear plow furrows.
        ground(ctx, w, h, seed, "#6f5c44", "#5d4c37", "#7f6b50");
        rows(ctx, w, h, angle, 2.5, "#54432f", 1.1, 0.35);
        rows(ctx, w, h, angle, 2.5, "#837056", 0.7, 0.25, 1.25); // lit furrow edges
        break;

      case "planted": {
        // Seeded soil: a touch lighter than tilled, faint green rows emerging.
        ground(ctx, w, h, seed, "#7c6a50", "#6a5a43", "#8c795d");
        rows(ctx, w, h, angle, 3, "#5d7444", 1, 0.3);
        break;
      }

      case "growing": {
        const t = clamp01(((p.progress ?? 0) - 0.15) / 0.85); // 0 at emergence → 1 at ready
        // Base ground closes over: soil → green canopy.
        const base = lerpColor("#7c6a50", "#4f6b39", smooth(t));
        const dark = lerpColor("#6a5a43", "#42592f", smooth(t));
        const light = lerpColor("#8c795d", "#5d7c44", smooth(t));
        ground(ctx, w, h, seed, base, dark, light);
        // Young crop: crisp green rows that thicken, then dissolve into canopy.
        const rowAlpha = t < 0.5 ? 0.55 : 0.55 - (t - 0.5) * 0.8; // fade as canopy closes
        rows(ctx, w, h, angle, 3, "#4a6a35", 1 + t * 1.6, Math.max(0.12, rowAlpha));
        // Late season: canopy micro-texture (crown mottling).
        if (t > 0.5) canopyMottle(ctx, w, h, seed + 7, "#3f5a2d", "#61814a", (t - 0.5) * 2);
        break;
      }

      case "ready": {
        // Mature, drying crop — corn goes golden-tan, soybeans ochre.
        const [base, dark, light] =
          p.crop === "soybeans"
            ? ["#a3924f", "#8a7a3e", "#b5a563"]
            : ["#b09a58", "#977f43", "#c2ad6d"];
        ground(ctx, w, h, seed, base!, dark!, light!);
        canopyMottle(ctx, w, h, seed + 7, dark!, light!, 0.8);
        rows(ctx, w, h, angle, 3, dark!, 0.8, 0.18);
        break;
      }

      case "harvested":
        // Cut stubble: pale straw with strong parallel cut lines + chaff rows.
        ground(ctx, w, h, seed, "#b3a375", "#9a8a5e", "#c4b489");
        rows(ctx, w, h, angle, 3, "#93835a", 1.2, 0.3);
        rows(ctx, w, h, angle, 9, "#c9ba90", 2.2, 0.28, 4.5); // windrowed chaff lines
        break;
    }

    ctx.restore();
  });
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
function dominantAngle(boundary: Meters[], surface: Surface): number {
  let best = 0, bestLen = -1;
  for (let i = 0; i < boundary.length; i++) {
    const a = surface.toPixel(boundary[i]!);
    const b = surface.toPixel(boundary[(i + 1) % boundary.length]!);
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = dx * dx + dy * dy;
    if (len > bestLen) {
      bestLen = len;
      best = Math.atan2(dy, dx);
    }
  }
  return best;
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
