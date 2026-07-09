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
import { boundsOf, padBounds, areaAcres } from "../geo/geometry";
import { gameConfig } from "../config/gameConfig";
import type { SaveState, Field } from "../state/saveState";
import type { OverlayEngine } from "../map/overlay";
import { paintFieldStatus } from "./fieldRender";

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
  const field: Field = { id: fieldId, parcelId, boundary, status: "stubble" };
  save.fields.push(field);
  save.money -= cost;

  renderField(map, overlay, field);
  return { field, acres, cost };
}

/** Render (or re-render) a field: procedural status texture + boundary outline. */
export function renderField(map: MlMap, overlay: OverlayEngine, field: Field): void {
  // Pad the surface a touch so the outline stroke isn't clipped at the edge.
  const bounds = padBounds(boundsOf(field.boundary), 4);
  const surface = overlay.createSurface(field.id, bounds);
  // Seed the texture from the field id so repaints stay stable across a session.
  paintFieldStatus(surface, field.boundary, field.status, hashSeed(field.id));
  drawOutline(map, field);
}

// Accumulates outline features so setData can rebuild the whole collection.
const outlineFeatures = new Map<string, Feature>();

/** Vector outline of every field boundary, so the edge reads crisply on the imagery. */
function drawOutline(map: MlMap, field: Field): void {
  const sourceId = "field-outlines";
  outlineFeatures.set(field.id, {
    type: "Feature",
    id: field.id,
    properties: { id: field.id },
    geometry: {
      type: "Polygon",
      coordinates: [[...field.boundary, field.boundary[0]!].map((m) => toLngLat(m))],
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
  map.addLayer({
    id: "field-outlines",
    type: "line",
    source: sourceId,
    layout: { "line-join": "round" },
    paint: { "line-color": "#ffffff", "line-width": 2, "line-opacity": 0.9 },
  });
}

/** Deterministic 32-bit seed from a string id (FNV-1a), for stable textures. */
function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
