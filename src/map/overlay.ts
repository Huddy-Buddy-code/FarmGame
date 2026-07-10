/**
 * PILLAR 3 — The geo-referenced raster overlay engine (brief §4).
 *
 * ONE module powers three features: (1) the 2D "painter" edits (§11), (2)
 * field-status textures (§10), (3) the fieldwork reveal (§10). The rule the brief
 * hammers on: **paint in geo-space, not screen-space.** Edits are pinned to real
 * UTM coordinates and composited OVER the NAIP imagery — we never modify the
 * satellite tiles, so everything is reversible and stays put on zoom/pan.
 *
 * Implementation: a `Surface` owns an off-DOM 2D `<canvas>` covering a rectangular
 * patch of ground (its `bounds`, in meters). MapLibre renders that canvas as a
 * `canvas` source pinned to the patch's four geographic corners, so the pixels are
 * glued to the earth. You draw with `paint()` using the meters->pixel transform;
 * the change is uploaded to the GPU on the next frame and then it goes idle again.
 *
 * Why per-patch canvases instead of one county-sized overlay: a whole county at
 * ~1 m/px would be gigapixels. Owned land is a tiny fraction of a county, so we
 * allocate raster only where the player actually paints (a field, an edited eyesore).
 * The engine tracks these surfaces so save/load and teardown stay simple.
 */

import type { Map as MlMap, CanvasSource } from "maplibre-gl";
import { toLngLat } from "../geo/coords";
import type { Meters } from "../geo/coords";
import type { BoundsMeters } from "../geo/geometry";

/** Raster resolution of the overlay, in meters per pixel. Technical quality knob,
 * NOT game balance — it does not live in gameConfig. ~1 m/px matches NAIP's native
 * ground resolution, so painted textures read at the same sharpness as the imagery. */
export const OVERLAY_METERS_PER_PIXEL = 1.0;

/** Hard cap on a single surface's pixel dimensions, so a stray huge polygon can't
 * allocate a runaway canvas. 4096 px @ 1 m/px = a 4 km patch, ample for one field. */
const MAX_SURFACE_PX = 4096;

/** A rectangular geo-referenced raster patch you can draw into. */
export class Surface {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly bounds: BoundsMeters;
  readonly metersPerPixel: number;
  private readonly map: MlMap;
  readonly sourceId: string;
  readonly layerId: string;
  private destroyed = false;

  constructor(map: MlMap, id: string, bounds: BoundsMeters, metersPerPixel: number) {
    this.map = map;
    this.bounds = bounds;
    this.metersPerPixel = metersPerPixel;
    this.sourceId = `overlay:${id}`;
    this.layerId = `overlay:${id}`;

    const [minE, minN, maxE, maxN] = bounds;
    const w = Math.min(MAX_SURFACE_PX, Math.max(1, Math.ceil((maxE - minE) / metersPerPixel)));
    const h = Math.min(MAX_SURFACE_PX, Math.max(1, Math.ceil((maxN - minN) / metersPerPixel)));

    this.canvas = document.createElement("canvas");
    this.canvas.width = w;
    this.canvas.height = h;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("overlay: 2D canvas context unavailable");
    this.ctx = ctx;

    // Pin the canvas to the ground: its four corners map to the patch's geographic
    // corners (converted meters->lng/lat at the render edge, per brief §3). Order is
    // top-left, top-right, bottom-right, bottom-left — canvas +y is DOWN = north-down.
    const corners: [[number, number], [number, number], [number, number], [number, number]] = [
      toLngLat([minE, maxN]),
      toLngLat([maxE, maxN]),
      toLngLat([maxE, minN]),
      toLngLat([minE, minN]),
    ];
    map.addSource(this.sourceId, {
      type: "canvas",
      canvas: this.canvas,
      coordinates: corners,
      // Static by default: MapLibre only re-uploads while "playing". We play() for a
      // single frame on markDirty(), so an idle overlay costs nothing.
      animate: false,
    });
    map.addLayer({
      id: this.layerId,
      type: "raster",
      source: this.sourceId,
      paint: { "raster-opacity": 1, "raster-resampling": "nearest", "raster-fade-duration": 0 },
    });
  }

  /** Meters -> this surface's canvas pixel coordinates (north-up ground, y flips). */
  toPixel([e, n]: Meters): [number, number] {
    const [minE, minN, maxE, maxN] = this.bounds;
    const sx = this.canvas.width / (maxE - minE);
    const sy = this.canvas.height / (maxN - minN);
    return [(e - minE) * sx, (maxN - n) * sy];
  }

  /**
   * Draw into the surface. The callback gets the 2D context and a meters->pixel
   * mapper; draw in geo-space and let the mapper place it. The result is uploaded
   * to the GPU on the next frame, then the source goes idle again.
   */
  paint(draw: (ctx: CanvasRenderingContext2D, toPixel: (m: Meters) => [number, number]) => void): void {
    if (this.destroyed) return;
    draw(this.ctx, (m) => this.toPixel(m));
    this.markDirty();
  }

  /** Trace a polygon ring (in meters) as a canvas path, ready to fill/clip/stroke. */
  tracePolygon(ring: Meters[]): void {
    this.ctx.beginPath();
    ring.forEach((pt, i) => {
      const [px, py] = this.toPixel(pt);
      if (i === 0) this.ctx.moveTo(px, py);
      else this.ctx.lineTo(px, py);
    });
    this.ctx.closePath();
  }

  /** Erase everything painted (keeps the surface allocated). */
  clear(): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.markDirty();
  }

  private animating = false;

  /**
   * Keep the canvas source re-uploading every frame (for a live animation like
   * the fieldwork reveal) vs. letting it idle. Cheaper and cleaner than calling
   * `markDirty()` per frame, which would register a fresh `once("idle")` handler
   * each time. Pair setAnimating(true) at the start with (false) at the end.
   */
  setAnimating(on: boolean): void {
    if (this.destroyed || on === this.animating) return;
    this.animating = on;
    const src = this.map.getSource(this.sourceId) as CanvasSource | undefined;
    if (!src) return;
    if (on) {
      src.play();
      this.map.triggerRepaint();
    } else {
      src.pause();
    }
  }

  /** Force a one-frame GPU re-upload of the canvas, then return to idle. */
  markDirty(): void {
    if (this.animating) {
      // Already re-uploading every frame; nothing to schedule.
      this.map.triggerRepaint();
      return;
    }
    if (this.destroyed) return;
    const src = this.map.getSource(this.sourceId) as CanvasSource | undefined;
    if (!src) return;
    src.play();
    this.map.once("idle", () => {
      if (!this.destroyed) src.pause();
    });
    this.map.triggerRepaint();
  }

  /** Remove the layer + source from the map. The surface is unusable afterward. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.map.getLayer(this.layerId)) this.map.removeLayer(this.layerId);
    if (this.map.getSource(this.sourceId)) this.map.removeSource(this.sourceId);
  }
}

/**
 * Owns every overlay surface on a map. Systems ask the engine for a surface over a
 * patch of ground; the engine names it, tracks it, and can tear them all down.
 */
export class OverlayEngine {
  private readonly map: MlMap;
  private readonly surfaces = new Map<string, Surface>();

  constructor(map: MlMap) {
    this.map = map;
  }

  /** Create (or replace) a named surface covering `bounds` (meters). */
  createSurface(id: string, bounds: BoundsMeters, metersPerPixel = OVERLAY_METERS_PER_PIXEL): Surface {
    this.surfaces.get(id)?.destroy();
    const surface = new Surface(this.map, id, bounds, metersPerPixel);
    this.surfaces.set(id, surface);
    return surface;
  }

  get(id: string): Surface | undefined {
    return this.surfaces.get(id);
  }

  remove(id: string): void {
    this.surfaces.get(id)?.destroy();
    this.surfaces.delete(id);
  }

  destroyAll(): void {
    for (const s of this.surfaces.values()) s.destroy();
    this.surfaces.clear();
  }
}
