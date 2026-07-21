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
  /** Raked: overlay windrows (gathered forage in spaced rows) on the harvested
   * surface. Visual-only — the field's lifecycle status stays "harvested". */
  windrowed?: boolean;
  /** Weed pressure: ragged bright-green weed patches scattered over the crop.
   * The weeding task's sweep-reveal repaints WITHOUT this flag strip-by-strip,
   * so the sprayer visibly cleans the field as it works. */
  weedy?: boolean;
  /** Freshly fertilized: the whole texture darkens ~20% (wet liquid spray).
   * The fertilizing task's sweep-reveal stamps the darkened texture strip-by-
   * strip; it dries back to normal on the month turn (visual-only). */
  fertilized?: boolean;
  /** Perennial stand in winter dormancy — override the whole texture with a
   * light-brown dead/dormant grass look (2026-07-14). */
  dormant?: boolean;
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

  // Stochastic detail (speckle/clods/weeds) is budgeted per GROUND area, not
  // per pixel — at 0.5 m/px a canvas has 4× the pixels of the old 1 m/px, and
  // pixel-proportional counts made every repaint (and the reveal bake at task
  // pickup) 4× slower for no extra visual density. `dot` converts a "draws
  // per px² at 1 m/px" density into a count for this canvas.
  const b0 = toPixel(boundary[0]!);
  const b1 = toPixel([boundary[0]![0] + 1, boundary[0]![1]]);
  const pxPerM = Math.max(0.5, Math.hypot(b1[0] - b0[0], b1[1] - b0[1]));
  const areaScale = 1 / (pxPerM * pxPerM);

  {
    ctx.save();
    tracePolygon(ctx, smoothed, toPixel);
    ctx.clip();

    const { base, dark, light } = palette(p);
    ground(ctx, w, h, seed, base, dark, light, areaScale);

    // Dormant winter perennial: a matted light-brown dead-grass sward — no
    // green, no crop rows, no overlays. Short-circuits the status texture.
    if (p.dormant) {
      swardStreaks(ctx, w, h, angle, seed + 5, dark, light, areaScale);
      canopyMottle(ctx, w, h, seed + 9, dark, light, 0.5, areaScale);
      ctx.restore();
      featherEdge(ctx, smoothed, toPixel);
      return;
    }

    // NOTE on scale: the overlay renders at 0.5 m/px, so "spacing 1.6" ≈ 0.8 m —
    // true corn-row scale. Constants below are px at that resolution.
    switch (p.status) {
      case "stubble":
        rows(ctx, w, h, angle, 6, "#c8b98f", 1.6, 0.14); // faint old combine passes
        rows(ctx, w, h, angle, 1.8, "#a89a72", 0.7, 0.1); // relic row stubs
        weedPatches(ctx, w, h, seed + 11, 0.35 * areaScale, "#6f7f4a", "#8b9a5d"); // volunteer growth
        break;

      case "tilled":
        // Fresh-turned soil: crisp plow furrows with lit shoulders + clod litter.
        rows(ctx, w, h, angle, 2.2, "#54432f", 1.2, 0.4);
        rows(ctx, w, h, angle, 2.2, "#837056", 0.7, 0.3, 1.1); // lit furrow edges
        clods(ctx, w, h, seed + 3, "#4c3d2b", "#8d7a5e", angle, areaScale);
        deadFurrows(ctx, w, h, angle, seed + 5, "#46372a");
        break;

      case "planted":
        // Seeded soil: planter row marks + the first faint green flush.
        rows(ctx, w, h, angle, 1.6, "#6b5a42", 0.6, 0.25); // seed trenches
        rows(ctx, w, h, angle, 1.6, "#5d7444", 0.8, 0.28, 0.5); // emerging seedlings
        tramlines(ctx, w, h, angle, "#6b5a42", 0.5);
        break;

      case "growing": {
        const t = clamp01(((p.progress ?? 0) - 0.15) / 0.85); // 0 at emergence → 1 at ready
        // Young crop: crisp green rows over visible soil that thicken with the
        // canopy, then dissolve into it.
        const rowAlpha = t < 0.5 ? 0.6 : 0.6 - (t - 0.5) * 0.9; // fade as canopy closes
        rows(ctx, w, h, angle, 1.6, "#4a6a35", 0.7 + t * 1.1, Math.max(0.12, rowAlpha));
        rows(ctx, w, h, angle, 1.6, "#5f8244", 0.4, Math.max(0.08, rowAlpha * 0.6), 0.4); // lit leaf rows
        // Sprayer wheel tracks stay visible until the canopy swallows them.
        tramlines(ctx, w, h, angle, "#6b5a42", Math.max(0, 0.5 - t * 0.6));
        // Late season: canopy micro-texture (crown mottling).
        if (t > 0.4) canopyMottle(ctx, w, h, seed + 7, "#3f5a2d", "#61814a", (t - 0.4) * 1.6, areaScale);
        break;
      }

      case "ready":
        if (p.crop === "grass" || p.crop === "alfalfa") {
          // Perennial hay stand ready to cut: no crop rows (it's a dense sward),
          // a soft wind-blown mottle, and — for alfalfa — a scatter of purple
          // bloom flecks (alfalfa flowers just before cutting).
          canopyMottle(ctx, w, h, seed + 7, dark, light, 1.1, areaScale);
          swardStreaks(ctx, w, h, angle, seed + 13, dark, light, areaScale);
          if (p.crop === "alfalfa") bloomFlecks(ctx, w, h, seed + 29, "#7d5aa6", "#9d78c4", areaScale);
          break;
        }
        canopyMottle(ctx, w, h, seed + 7, dark, light, 0.9, areaScale);
        rows(ctx, w, h, angle, 1.6, dark, 0.6, 0.16);
        lodgingPatches(ctx, w, h, seed + 17, angle, dark, light, areaScale);
        tramlines(ctx, w, h, angle, dark, 0.25);
        break;

      case "harvested":
        if (p.crop === "grass" || p.crop === "alfalfa") {
          // Freshly-mown hay: dark green cut stubble with mower-swath stripes —
          // regrowth already showing, not tan chaff like a combined grain field.
          rows(ctx, w, h, angle, 2.2, dark, 0.9, 0.3);
          rows(ctx, w, h, angle, 2.2, light, 0.6, 0.22, 1); // lit stubble tufts
          passStripes(ctx, w, h, angle, 18, 0.06); // mower passes
          canopyMottle(ctx, w, h, seed + 7, dark, light, 0.5, areaScale);
          break;
        }
        // Cut stubble: strong parallel cut lines, header-width pass stripes,
        // and pale chaff windrows out the back of the combine.
        rows(ctx, w, h, angle, 2.2, "#93835a", 0.9, 0.3);
        passStripes(ctx, w, h, angle, 18, 0.07); // alternating header passes
        rows(ctx, w, h, angle, 18, "#cfc094", 3.4, 0.3, 9); // chaff lines
        rows(ctx, w, h, angle, 18, "#a2905f", 1.2, 0.2, 11.5); // chaff shadow
        break;

      case "mulched":
        // Baled/mulched: clean, tidy surface with grass showing through — soft,
        // evenly-spaced mown lines, no rough stubble. (Bales themselves are drawn
        // as separate map markers.)
        rows(ctx, w, h, angle, 5, "#7f8f5e", 1.1, 0.22);
        rows(ctx, w, h, angle, 5, "#aebd88", 0.7, 0.18, 2.5); // lit mown edges
        passStripes(ctx, w, h, angle, 25, 0.05);
        break;
    }

    // Weed pressure: rank, bright patches strewn over whatever's underneath.
    // Painted LAST so weeds sit on top of rows/canopy; the weeding task's
    // reveal repaints without this flag, wiping them strip-by-strip.
    if (p.weedy) {
      weedPatches(ctx, w, h, seed + 23, areaScale, "#55712f", "#84a648");
      weedPatches(ctx, w, h, seed + 41, 0.5 * areaScale, "#6e8f3a", "#9cb45e");
    }

    // Wet fertilizer spray: darken everything ~20% (still inside the field
    // clip). Painted last so the whole look — rows, weeds, windrows — reads
    // as sprayed-over, the way wet ground photographs darker from the air.
    if (p.fertilized) {
      ctx.fillStyle = "rgba(20, 14, 6, 0.2)";
      ctx.fillRect(0, 0, w, h);
    }

    // Windrows (raked forage): thick, widely-spaced rows of gathered residue
    // over the cut stubble, along the field's run. Visual-only overlay for a
    // harvested-and-raked field (before the baler collects it).
    if (p.windrowed) {
      // Hay windrows (grass/alfalfa) are greener/paler than corn-stover rows.
      const hay = p.crop === "grass" || p.crop === "alfalfa";
      const pile = hay ? "#8f9152" : "#7a6a3f";
      const crest = hay ? "#bcbb7e" : "#a89263";
      const shade = hay ? "#5c5f33" : "#4f4529";
      rows(ctx, w, h, angle, 15, pile, 3.2, 0.5);       // the piled windrow
      rows(ctx, w, h, angle, 15, crest, 1.4, 0.4, 1.6); // sunlit crest
      rows(ctx, w, h, angle, 15, shade, 1.0, 0.3, -1.4); // shaded near edge
    }

    ctx.restore();
    featherEdge(ctx, smoothed, toPixel);
  }
}

/**
 * Feather the hard clip edge into transparency. The texture was clipped to a
 * crisp raster boundary; against the green imagery that reads as a dark line no
 * overlaid halo can fully hide. Stacked `destination-out` strokes along the
 * boundary — widest first, each erasing a little — carve a soft inward alpha
 * ramp: ~transparent at the very edge, full texture a few metres in, so the
 * field melts into the imagery like a real field margin.
 */
function featherEdge(ctx: CanvasRenderingContext2D, smoothed: Meters[], toPixel: (m: Meters) => [number, number]): void {
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  const featherPx = 6; // inward fade width (6 px ≈ 3 m at 0.5 m/px) — a tight, crisp margin
  const passes = 6;
  for (let k = 0; k < passes; k++) {
    ctx.globalAlpha = 0.3;
    ctx.lineWidth = 2 * featherPx * (1 - k / passes) + 1.5; // wide → narrow
    tracePolygon(ctx, smoothed, toPixel);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * The base/dark/light tones for a field's current look. Single source of truth so
 * the boundary outline (fields.ts) can tint itself to MATCH the texture instead of
 * a contrasting white line. `growing` lerps soil→canopy with progress; `ready`
 * shifts per crop — the outline follows both.
 */
function palette(p: FieldPaintParams): { base: string; dark: string; light: string } {
  // Dormant winter perennial: light-brown dead/matted grass, whatever the
  // underlying lifecycle status happens to be.
  if (p.dormant) return { base: "#b7a06f", dark: "#9c8757", light: "#c9b78a" };
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
      // Perennial forage stands are GREEN at cutting, not golden like grain.
      if (p.crop === "grass") return { base: "#7f9a4e", dark: "#65803a", light: "#9bb267" }; // lush tall grass
      if (p.crop === "alfalfa") return { base: "#5f7d40", dark: "#4c6733", light: "#7a9455" }; // deep alfalfa green
      return p.crop === "soybeans"
        ? { base: "#a3924f", dark: "#8a7a3e", light: "#b5a563" }
        : { base: "#b09a58", dark: "#977f43", light: "#c2ad6d" };
    case "harvested":
      // A freshly-cut hay stand is dark green stubble/regrowth, not tan chaff.
      if (p.crop === "grass" || p.crop === "alfalfa") return { base: "#4f6537", dark: "#3f522c", light: "#63794a" };
      return { base: "#b3a375", dark: "#9a8a5e", light: "#c4b489" };
    case "mulched":
      // Greener than stubble — grass retained under a clean, mown/baled surface.
      return { base: "#9aa771", dark: "#84925f", light: "#adba8b" };
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
function ground(ctx: CanvasRenderingContext2D, w: number, h: number, seed: number, base: string, dark: string, light: string, areaScale = 1): void {
  const rng = mulberry32(seed);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);

  // Large-scale mottling: a few big, soft, squashed ellipses at low alpha.
  const blobs = Math.max(6, Math.floor((w * h * areaScale) / 2500));
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
  const dots = Math.floor((w * h * areaScale) / 45);
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

/**
 * Weed patches: ragged clusters of overlapping tufts in rank greens, plus a
 * scatter of lone volunteers. Density scales with `strength` (0..1+). Used at
 * full strength for weed pressure and low strength for stubble volunteers.
 */
function weedPatches(
  ctx: CanvasRenderingContext2D, w: number, h: number,
  seed: number, strength: number, dark: string, light: string,
): void {
  const rng = mulberry32(seed);
  // Clumps: each an irregular blob of 6–14 overlapping soft circles.
  const clumps = Math.floor(((w * h) / 5200) * strength);
  for (let i = 0; i < clumps; i++) {
    const cx = rng() * w, cy = rng() * h;
    const n = 6 + Math.floor(rng() * 9);
    const spread = 3 + rng() * 9;
    for (let k = 0; k < n; k++) {
      ctx.fillStyle = rng() < 0.55 ? dark : light;
      ctx.globalAlpha = 0.18 + rng() * 0.3;
      const a = rng() * Math.PI * 2, r = rng() * spread;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.7, 0.8 + rng() * 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // Lone tufts between the clumps.
  const tufts = Math.floor(((w * h) / 900) * strength);
  for (let i = 0; i < tufts; i++) {
    ctx.fillStyle = rng() < 0.5 ? dark : light;
    ctx.globalAlpha = 0.12 + rng() * 0.2;
    ctx.beginPath();
    ctx.arc(rng() * w, rng() * h, 0.5 + rng() * 1.1, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/** Clod litter on fresh-plowed ground: short dark/lit dashes lying roughly
 * along the furrow direction — reads as turned earth, not flat paint. */
function clods(ctx: CanvasRenderingContext2D, w: number, h: number, seed: number, dark: string, light: string, angleRad: number, areaScale = 1): void {
  const rng = mulberry32(seed);
  const n = Math.floor((w * h * areaScale) / 260);
  ctx.save();
  ctx.lineCap = "round";
  for (let i = 0; i < n; i++) {
    ctx.strokeStyle = rng() < 0.6 ? dark : light;
    ctx.globalAlpha = 0.1 + rng() * 0.22;
    ctx.lineWidth = 0.6 + rng() * 1.1;
    const x = rng() * w, y = rng() * h;
    const a = angleRad + (rng() - 0.5) * 0.9;
    const len = 1 + rng() * 3;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    ctx.stroke();
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

/** Wind-lodged grain: a handful of irregular flattened patches, not a uniform
 * band across the whole field — real lodging follows gusts, not planting rows,
 * so each patch streaks at its own wind angle, independent of `angleRad`. */
function lodgingPatches(
  ctx: CanvasRenderingContext2D, w: number, h: number,
  seed: number, angleRad: number, dark: string, light: string, areaScale: number,
): void {
  const rng = mulberry32(seed);
  const count = Math.max(1, Math.floor((w * h * areaScale) / 16000));
  for (let i = 0; i < count; i++) {
    const cx = rng() * w, cy = rng() * h;
    const rx = (16 + rng() * 34) * Math.sqrt(areaScale);
    const ry = rx * (0.5 + rng() * 0.4);
    const patchAngle = rng() * Math.PI;
    const windAngle = angleRad + (rng() - 0.5) * 1.2;

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, patchAngle, 0, Math.PI * 2);
    ctx.clip();

    ctx.fillStyle = light;
    ctx.globalAlpha = 0.32;
    ctx.fillRect(cx - rx, cy - ry, rx * 2, ry * 2);

    rows(ctx, w, h, windAngle, 2.4, dark, 1.4, 0.22);
    rows(ctx, w, h, windAngle, 2.4, light, 0.8, 0.28, 1.2);

    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

/** A couple of "dead furrows" — the deeper trenches where plow passes meet —
 * spaced far apart, giving big fields the segmented look they have from the air. */
function deadFurrows(ctx: CanvasRenderingContext2D, w: number, h: number, angleRad: number, seed: number, color: string): void {
  const rng = mulberry32(seed);
  rows(ctx, w, h, angleRad, 60 + rng() * 30, color, 1.8, 0.28, rng() * 40);
}

/** Sprayer wheel tracks: PAIRED soil-colored lines on a wide spacing (a real
 * tramline is two wheel ruts ~2 m apart, every ~24 m). Fades with `alpha`. */
function tramlines(ctx: CanvasRenderingContext2D, w: number, h: number, angleRad: number, color: string, alpha: number): void {
  if (alpha <= 0.01) return;
  rows(ctx, w, h, angleRad, 48, color, 0.9, alpha, -2);
  rows(ctx, w, h, angleRad, 48, color, 0.9, alpha, 2);
}

/** Alternating light/dark bands at machine-pass width — the subtle striping
 * every worked field shows from the air (opposite driving directions lay the
 * residue differently). */
function passStripes(ctx: CanvasRenderingContext2D, w: number, h: number, angleRad: number, spacing: number, alpha: number): void {
  const diag = Math.hypot(w, h);
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate(angleRad);
  let flip = false;
  for (let d = -diag / 2; d <= diag / 2; d += spacing) {
    flip = !flip;
    ctx.fillStyle = flip ? "#ffffff" : "#000000";
    ctx.globalAlpha = alpha;
    ctx.fillRect(-diag / 2, d, diag, spacing);
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

/** Soft wind-combed streaks for a dense hay sward (perennial forage ready to
 * cut) — short, faint strokes roughly along the field run, so a mature stand
 * reads as leaning grass rather than crop rows. */
function swardStreaks(ctx: CanvasRenderingContext2D, w: number, h: number, angleRad: number, seed: number, dark: string, light: string, areaScale: number): void {
  const rng = mulberry32(seed);
  const n = Math.floor((w * h * areaScale) / 220);
  ctx.save();
  ctx.lineCap = "round";
  for (let i = 0; i < n; i++) {
    ctx.strokeStyle = rng() < 0.5 ? dark : light;
    ctx.globalAlpha = 0.05 + rng() * 0.13;
    ctx.lineWidth = 0.5 + rng() * 0.9;
    const x = rng() * w, y = rng() * h;
    const a = angleRad + (rng() - 0.5) * 0.5;
    const len = 2 + rng() * 5;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    ctx.stroke();
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

/** Scattered purple bloom flecks for a flowering alfalfa stand (it blooms just
 * before cutting) — tiny dots in two violet tones over the green sward. */
function bloomFlecks(ctx: CanvasRenderingContext2D, w: number, h: number, seed: number, dark: string, light: string, areaScale: number): void {
  const rng = mulberry32(seed);
  const n = Math.floor((w * h * areaScale) / 140);
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = rng() < 0.5 ? dark : light;
    ctx.globalAlpha = 0.25 + rng() * 0.35;
    ctx.beginPath();
    ctx.arc(rng() * w, rng() * h, 0.4 + rng() * 0.9, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/** Clumpy crown texture for closed canopies (late corn / ready crops). */
function canopyMottle(ctx: CanvasRenderingContext2D, w: number, h: number, seed: number, dark: string, light: string, strength: number, areaScale = 1): void {
  const rng = mulberry32(seed);
  const clumps = Math.floor((w * h * areaScale) / 60);
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
