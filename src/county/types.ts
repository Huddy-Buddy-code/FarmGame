/**
 * County packages — the playable "maps" (brief §1, §12).
 *
 * Each county a player can farm is a self-contained DATA package under
 * `public/counties/<id>/`, loaded by id at runtime. Adding a new county is a
 * data task (drop in a folder), never a code change — the engine and UI are
 * generic over the manifest. This mirrors the brief's "module + party = campaign"
 * principle: here it's "county + save = session".
 *
 * A package holds:
 *   - manifest.json  — identity, UTM zone, bounds, imagery source, attribution
 *   - roads.geojson  — pre-built OSM road extract (offline; no live Overpass)
 *   - (later) buyers.geojson, storage sites, a self-hosted routing graph, and
 *     optionally cached NAIP tiles for fully-offline imagery.
 */

import type { FeatureCollection } from "geojson";

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
}

/** A loaded county: its manifest plus the resolved data assets. */
export interface CountyPackage {
  manifest: CountyManifest;
  roads: FeatureCollection;
}
