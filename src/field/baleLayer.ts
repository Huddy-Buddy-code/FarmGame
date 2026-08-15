/**
 * Dropped bales as a GPU symbol layer (2026-07-30).
 *
 * WAS: one `maplibregl.Marker` per bale — a DOM div holding inline SVG, capped
 * at 600 per field to keep the page usable. MapLibre reprojects and rewrites
 * `transform` on EVERY marker on EVERY pan/zoom frame, so a well-baled farm
 * put a thousand-odd DOM nodes in the way of the compositor and panning
 * visibly hitched.
 *
 * NOW: one GeoJSON source of points + one symbol layer. Each bale PRODUCT gets
 * an icon registered once via `map.addImage()` (its existing SVG rasterized at
 * 2x for retina), and the layer picks per-feature with `icon-image: ["get",
 * "product"]`. Drawing is on the GPU, count is essentially free, and the
 * per-field subsample ceiling is gone — every bale is now really drawn.
 *
 * `icon-allow-overlap` + `icon-ignore-placement` are BOTH on deliberately:
 * bales genuinely sit close together, we want them all, and skipping collision
 * detection is most of the win. That also means no label-style de-cluttering —
 * correct here, wrong for the field labels next door in fields.ts.
 */

import type { Map as MlMap, GeoJSONSource, LayerSpecification } from "maplibre-gl";
import type { Feature, FeatureCollection, Point } from "geojson";

import { toLngLat } from "../geo/coords";
import type { Meters } from "../geo/coords";
import type { Field } from "../state/saveState";
import type { BaleProduct } from "../config/gameConfig";
import { gameConfig } from "../config/gameConfig";
import { baleageProductFor } from "../sim/farming";
import { baleIconSvg, squareBaleIconSvg } from "../ui/icons";

export const BALE_SOURCE_ID = "bales";
export const BALE_LAYER_ID = "bales";

/** Rasterized icon size, CSS px (drawn at 2x — see ICON_PIXEL_RATIO). Matches
 * the 14 px the DOM markers used, so bales stay the size players know. */
export const ICON_PX = 14;
const ICON_PIXEL_RATIO = 2;

/**
 * Sanity ceiling on TOTAL bale features. A symbol layer eats tens of thousands
 * without complaint, so this is nowhere near the old per-field 600 — it exists
 * only so a pathological save can't hand the GPU an unbounded buffer. Realistic
 * play (a few thousand acres, ~3 bales/acre) stays well under.
 */
export const MAX_BALE_FEATURES = 25_000;

/** What a field's dropped (UNWRAPPED) bales ARE — drives the icon shape and
 * tint for `baleLocations`. */
export function baleProductOf(field: Field): BaleProduct {
  return field.baleProduct ?? "cornStover";
}

/** What a field's ALREADY-WRAPPED bales are (2026-08-14) — drives the icon
 * for `wrappedBaleLocations`, the pile the Wrap task has sealed so far.
 * Derived, not stored (see the Field.wrappedBaleLocations comment): falls
 * back to the unwrapped product itself if it somehow isn't wrappable (should
 * never happen — nothing pushes into `wrappedBaleLocations` for a product
 * `baleageProductFor` refuses), so a bad state still draws SOMETHING rather
 * than silently dropping those points. */
export function wrappedBaleProductOf(field: Field): BaleProduct {
  const product = baleProductOf(field);
  return baleageProductFor(product) ?? product;
}

/**
 * Every dropped bale on the farm as one point FeatureCollection — both the
 * still-unwrapped pile and the already-sealed one, each with its own product
 * (and so its own icon), which is what lets a field mid-wrap show a genuine
 * mix of green and white bales (2026-08-14). Pure — no map, no DOM — so the
 * feature-building rules are unit-testable.
 */
export function baleFeatureCollection(fields: Field[]): FeatureCollection<Point> {
  const features: Feature<Point>[] = [];
  for (const field of fields) {
    const pools: Array<[Meters[] | undefined, BaleProduct]> = [
      [field.baleLocations, baleProductOf(field)],
      [field.wrappedBaleLocations, wrappedBaleProductOf(field)],
    ];
    for (const [locs, product] of pools) {
      if (!locs || locs.length === 0) continue;
      for (const p of locs) {
        if (features.length >= MAX_BALE_FEATURES) return { type: "FeatureCollection", features };
        features.push({
          type: "Feature",
          properties: { product },
          geometry: { type: "Point", coordinates: toLngLat(p) },
        });
      }
    }
  }
  return { type: "FeatureCollection", features };
}

/**
 * A cheap change key for the whole bale picture: which fields have how many
 * bales, of what product, in each of the two piles. `setData` re-parses and
 * re-uploads the entire collection, so it must only run when something
 * actually moved.
 */
export function baleStateKey(fields: Field[]): string {
  const parts: string[] = [];
  for (const field of fields) {
    const n = field.baleLocations?.length ?? 0;
    if (n > 0) parts.push(`${field.id}:${n}:${baleProductOf(field)}`);
    const w = field.wrappedBaleLocations?.length ?? 0;
    if (w > 0) parts.push(`${field.id}:w${w}:${wrappedBaleProductOf(field)}`);
  }
  return parts.join("|");
}

/**
 * The icon for a bale PRODUCT — round or rectangular, tinted for hay / alfalfa
 * / straw (maintainer request, 2026-07-24: "make sure the Square Bales have an
 * icon on the Field and Inventory for a rectangular hay, straw, or alfalfa
 * bale").
 *
 * Round and square are separate products at separate prices, so telling them
 * apart at a glance is the whole job. Every bale drawn ANYWHERE — this layer's
 * icons, the inventory rows, the field panel — goes through here, so they can
 * never disagree about shape.
 */
export function baleIconFor(product: BaleProduct, px: number): string {
  const cfg = gameConfig.baleProducts[product];
  return cfg.square ? squareBaleIconSvg(px, cfg.color) : baleIconSvg(px, cfg.color);
}

/** Rasterize an SVG string to ImageData at `px` × `ICON_PIXEL_RATIO`. */
async function svgToImageData(svg: string, px: number): Promise<ImageData> {
  const size = px * ICON_PIXEL_RATIO;
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("bale icons: 2D canvas context unavailable");
    ctx.drawImage(img, 0, 0, size, size);
    return ctx.getImageData(0, 0, size, size);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Register one icon per bale product. Idempotent — safe to call again. */
async function registerBaleIcons(map: MlMap): Promise<void> {
  const products = Object.keys(gameConfig.baleProducts) as BaleProduct[];
  await Promise.all(
    products.map(async (product) => {
      if (map.hasImage(product)) return;
      const data = await svgToImageData(baleIconFor(product, ICON_PX), ICON_PX);
      // A concurrent call may have won the race while we rasterized.
      if (!map.hasImage(product)) map.addImage(product, data, { pixelRatio: ICON_PIXEL_RATIO });
    }),
  );
}

/**
 * The bale symbol layer, as a standalone spec so `tests/mapLayers.test.ts` can
 * validate it — a symbol layer with a bad expression draws nothing and logs
 * nothing, and Browser Preview is off in this project.
 *
 * Both overlap flags ON: bales genuinely sit close together, we want every one
 * of them, and skipping collision detection is most of the performance win
 * over the DOM markers this replaced. (`text-*` has the same defaults-to-culling
 * trap — it cost the field labels a bug the day this shipped.)
 */
export function baleSymbolLayer(): LayerSpecification {
  return {
    id: BALE_LAYER_ID,
    type: "symbol",
    source: BALE_SOURCE_ID,
    // Below 13 a bale is sub-pixel and the county view just gets noise.
    minzoom: 13,
    layout: {
      "icon-image": ["get", "product"],
      "icon-size": ["interpolate", ["linear"], ["zoom"], 13, 0.35, 16, 0.75, 19, 1.4],
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
      // Nudged up 25% of the icon's own height (maintainer request,
      // 2026-08-14) — in icon-pixel units (ICON_PX), so it scales with
      // icon-size automatically rather than needing its own zoom stops.
      // Negative Y is UP per the style spec.
      "icon-offset": [0, -ICON_PX * 0.25],
    },
  };
}

let installed = false;
let lastKey: string | null = null;

/**
 * Create the source + layer (once) and push the current bales into it.
 *
 * Async because the icons rasterize through `Image.decode()`. The source and
 * layer are added FIRST so ordering relative to other layers is deterministic
 * regardless of when the icons finish; MapLibre simply draws nothing until an
 * `icon-image` resolves.
 */
export async function updateBaleLayer(map: MlMap, fields: Field[]): Promise<void> {
  const key = baleStateKey(fields);

  if (!installed) {
    installed = true;
    map.addSource(BALE_SOURCE_ID, { type: "geojson", data: baleFeatureCollection(fields) });
    map.addLayer(baleSymbolLayer());
    lastKey = key;
    await registerBaleIcons(map);
    return;
  }

  if (key === lastKey) return; // nothing dropped, sold, or re-baled
  lastKey = key;
  const src = map.getSource(BALE_SOURCE_ID) as GeoJSONSource | undefined;
  src?.setData(baleFeatureCollection(fields));
}

/** Forget install state — for a map teardown/rebuild (and tests). */
export function resetBaleLayer(): void {
  installed = false;
  lastKey = null;
}
