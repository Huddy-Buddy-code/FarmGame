/**
 * Fields & parcels (brief §12 step 2: "buy one parcel -> draw one field").
 *
 * A drawn field becomes real game state: it's stored in the save-state as a parcel
 * (the owned land) plus a field (the worked unit), both as polygons in UTM meters
 * (brief §3 — never lng/lat). Rendering goes through the overlay engine (§4): each
 * field gets a geo-referenced raster surface over its footprint, filled with its
 * procedural status texture (§10) and outlined so the boundary reads on the imagery.
 *
 * Buying costs money (brief §8, capital) — the first real economic transaction,
 * deducted from the save-state so the money system has a reason to exist.
 */

import type { Map as MlMap, GeoJSONSource } from "maplibre-gl";
import type { Feature, FeatureCollection } from "geojson";

import { toLngLat } from "../geo/coords";
import type { Meters } from "../geo/coords";
import { boundsOf, padBounds, areaAcres, smoothPolygon } from "../geo/geometry";
import { gameConfig } from "../config/gameConfig";
import type { SaveState, Field } from "../state/saveState";
import type { OverlayEngine } from "../map/overlay";
import { paintField, fieldEdgeColor } from "./fieldRender";
import { growthProgress } from "../sim/farming";
import { releaseFieldTasks } from "../sim/tasks";
import { recordCash } from "../sim/ledger";
import type { SimTime } from "../sim/clock";

const seq: Record<string, number> = {};
const nextId = (prefix: string) => `${prefix}-${(seq[prefix] = (seq[prefix] ?? 0) + 1)}`;

/** After loading a save, continue id sequences past the highest existing ids. */
export function initIdCounters(save: SaveState): void {
  for (const id of [...save.parcels.map((p) => p.id), ...save.fields.map((f) => f.id)]) {
    const m = /^(.+)-(\d+)$/.exec(id);
    if (m) seq[m[1]!] = Math.max(seq[m[1]!] ?? 0, Number(m[2]));
  }
}

export interface BuyFieldResult {
  field: Field;
  acres: number;
  cost: number;
}

/**
 * Buy the land under `boundary` and turn it into one field. Mutates `save`
 * (adds a parcel + field, deducts the land cost) and renders the field via the
 * overlay engine. Returns the new field and the transaction figures for the HUD.
 * Throws if the player can't afford it (caller shows the message).
 */
export function buyFieldFromBoundary(
  map: MlMap,
  overlay: OverlayEngine,
  save: SaveState,
  boundary: Meters[],
): BuyFieldResult {
  const acres = areaAcres(boundary);
  const cost = Math.round(acres * gameConfig.landPricePerAcre);
  if (cost > save.money) {
    throw new Error(`Can't afford ${acres.toFixed(1)} ac (needs $${cost.toLocaleString()})`);
  }

  const parcelId = nextId("parcel");
  const fieldId = nextId("field");
  save.parcels.push({ id: parcelId, boundary, owned: true });
  // Remember what was actually paid, so selling later refunds THAT — not a
  // recompute at the (possibly different, once land prices become dynamic) rate.
  const field: Field = { id: fieldId, parcelId, boundary, status: "stubble", purchaseCost: cost };
  save.fields.push(field);
  save.money -= cost;
  recordCash(save, "landEquipment", "Land", -cost);

  renderField(map, overlay, field, 0); // fresh stubble; growth time is irrelevant
  return { field, acres, cost };
}

export interface SellFieldResult {
  field: Field;
  refund: number;
}

/**
 * Sell a field back for exactly what it cost to buy (maintainer request — not a
 * market resale value, the literal purchase price). Whatever's growing on it is
 * forfeited: no partial refund for inputs already paid. Removes the field, its
 * parcel, and its map rendering; throws if it's mid-harvest (nothing to hand back
 * a half-cut field to).
 */
export function sellField(map: MlMap, overlay: OverlayEngine, save: SaveState, fieldId: string): SellFieldResult {
  const idx = save.fields.findIndex((f) => f.id === fieldId);
  if (idx === -1) throw new Error(`Field ${fieldId} not found`);
  const field = save.fields[idx]!;
  // Refund any still-queued work; throws if a machine is actively on the field.
  releaseFieldTasks(save, field.id);

  const refund = field.purchaseCost ?? Math.round(areaAcres(field.boundary) * gameConfig.landPricePerAcre);
  save.fields.splice(idx, 1);
  const parcelIdx = save.parcels.findIndex((p) => p.id === field.parcelId);
  if (parcelIdx !== -1) save.parcels.splice(parcelIdx, 1);
  save.money += refund;
  recordCash(save, "landEquipment", "Land", refund);

  removeFieldRender(map, overlay, field);
  return { field, refund };
}

/** Tear down a field's map presence: its overlay texture surface and outline. */
export function removeFieldRender(map: MlMap, overlay: OverlayEngine, field: Field): void {
  overlay.remove(field.id);
  outlineFeatures.delete(field.id);
  const src = map.getSource("field-outlines") as GeoJSONSource | undefined;
  if (src) src.setData({ type: "FeatureCollection", features: [...outlineFeatures.values()] });
}

/** Render (or re-render) a field: procedural status texture + boundary outline.
 * `now` drives the stage-aware growing texture (young rows → closing canopy). */
export function renderField(map: MlMap, overlay: OverlayEngine, field: Field, now: SimTime): void {
  // Pad the surface a touch so the outline stroke isn't clipped at the edge.
  const bounds = padBounds(boundsOf(field.boundary), 4);
  const surface = overlay.createSurface(field.id, bounds);
  const paint = {
    status: field.status,
    crop: field.crop,
    progress: growthProgress(field, now),
    windrowed: field.status === "harvested" && !!field.windrowed,
    weedy: !!field.weedy,
    seed: hashSeed(field.id),
  };
  // Seed the texture from the field id so repaints stay stable across a session.
  paintField(surface, field.boundary, paint);
  // Feather the boundary in a colour that MATCHES the texture (not white).
  drawOutline(map, field, fieldEdgeColor(paint));
}

// Accumulates outline features so setData can rebuild the whole collection.
const outlineFeatures = new Map<string, Feature>();

/**
 * Field boundary as a THICK, BLURRY feather tinted to match the field's own
 * texture (via the `color` feature property + a data-driven paint expression),
 * NOT a contrasting white line. The blur softens the blocky raster edge of the
 * texture canvas into the surrounding imagery, so instead of a crisp survey line
 * tracing every 1 m stair-step, you get a natural field-margin fade. Rounded first
 * (smoothPolygon, matching the texture clip). Width scales with zoom so the feather
 * reads consistently whether you're zoomed to the county or a single field.
 */
function drawOutline(map: MlMap, field: Field, color: string): void {
  const sourceId = "field-outlines";
  const smoothed = smoothPolygon(field.boundary);
  outlineFeatures.set(field.id, {
    type: "Feature",
    id: field.id,
    properties: { id: field.id, color },
    geometry: {
      type: "Polygon",
      coordinates: [[...smoothed, smoothed[0]!].map((m) => toLngLat(m))],
    },
  });
  const data: FeatureCollection = {
    type: "FeatureCollection",
    features: [...outlineFeatures.values()],
  };

  const src = map.getSource(sourceId) as GeoJSONSource | undefined;
  if (src) {
    src.setData(data);
    return;
  }
  map.addSource(sourceId, { type: "geojson", data });
  // Widths/blur scale with zoom so the feather is a sensible on-screen thickness
  // whether you're viewing the whole county or a single field.
  // The texture now feathers its OWN edge into the imagery (see fieldRender), so
  // this is just a single faint, tight accent that gives the margin a touch of
  // definition — NOT a wide glowing halo. Kept small at every zoom.
  map.addLayer({
    id: "field-outlines",
    type: "line",
    source: sourceId,
    layout: { "line-join": "round", "line-cap": "round" },
    paint: {
      "line-color": ["get", "color"],
      "line-width": ["interpolate", ["linear"], ["zoom"], 12, 0.75, 16, 1.5, 19, 4],
      "line-opacity": 0.3,
      "line-blur": ["interpolate", ["linear"], ["zoom"], 12, 1, 16, 2, 19, 5],
    },
  });
}

/** Deterministic 32-bit seed from a string id (FNV-1a), for stable textures.
 * Exported so the sweep-reveal (main.ts) bakes with the SAME seed renderField
 * uses, keeping the revealed texture identical to the final repaint. */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
