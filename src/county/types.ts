/**
 * County packages — the playable "maps" (brief §1, §12).
 *
 * A county package is EITHER a self-contained bundled folder under
 * `public/counties/<id>/` (hand-tuned; instant, offline) OR — since the
 * hybrid model, 2026-07-26 — built at runtime for any CONUS county from the
 * national index + a live Overpass road fetch, cached in IndexedDB (see
 * registry.ts for the resolution order, builder.ts for the synthesis). The
 * engine downstream is generic over the manifest either way: "county + save
 * = session".
 *
 * A bundled package holds:
 *   - manifest.json  — identity, UTM zone, bounds, imagery source, attribution
 *   - roads.geojson  — pre-built OSM road extract (same recipe the runtime
 *     builder replicates — see overpass.ts)
 *   - boundary.geojson — the county polygon for the game-board edge (same
 *     recipe as the runtime TIGERweb fetch — see tigerweb.ts)
 *   - (later) buyers.geojson, storage sites, a self-hosted routing graph, and
 *     optionally cached NAIP tiles for fully-offline imagery.
 */

import type { FeatureCollection } from "geojson";
import type { CountyBoundary } from "./tigerweb";

export type CountyId = string;

/** NAIP imagery served from a USDA ArcGIS ImageServer (live). */
export interface NaipArcgisImagery {
  kind: "naip-arcgis";
  imageServer: string;
  attribution: string;
}

/** Room to grow: e.g. self-hosted/cached county tile pyramid for offline play. */
export type ImagerySource = NaipArcgisImagery;

export interface CountyManifest {
  id: CountyId;
  name: string;
  state: string;
  /** US county FIPS code. */
  fips: string;
  utm: { zone: number; hemisphere: "N" | "S" };
  /** [west, south, east, north] in lng/lat. */
  bbox: [number, number, number, number];
  /** Initial map view (lng/lat). */
  center: [number, number];
  defaultZoom: number;
  imagery: ImagerySource;
  roads: { file: string; attribution: string };
  /** Bundled packages name their boundary file; runtime manifests omit it
   * (the polygon comes from TIGERweb, not a file). Optional so hand-written
   * manifests that predate the game board still parse. */
  boundary?: { file: string };
}

/** A loaded county: its manifest plus the resolved data assets. The boundary
 * is cosmetic (game-board edge) — null means "no board", never a boot failure. */
export interface CountyPackage {
  manifest: CountyManifest;
  roads: FeatureCollection;
  boundary: CountyBoundary | null;
}
