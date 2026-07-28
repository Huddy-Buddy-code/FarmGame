/**
 * NAIP satellite base layer (brief §2, §12 step 1).
 *
 * USDA NAIP imagery is public domain and is the sanctioned satellite source
 * (Google/Esri imagery is explicitly forbidden — see brief §2). We consume it
 * from USDA's APFO ArcGIS ImageServer via its `exportImage` endpoint.
 *
 * Since 2026-07-28 tiles are addressed as `naip://tile/{z}/{x}/{y}` through
 * the custom protocol in tileCache.ts — cache-first against IndexedDB, hitting
 * the ImageServer only on a miss — instead of MapLibre's raw
 * {bbox-epsg-3857} template. main.ts must call `configureNaipCache()` with
 * the manifest's ImageServer and register the protocol BEFORE creating the
 * map; the manifest still owns the server URL, this just moves where it's
 * consumed.
 *
 * NOTE (data spike): USDA retired the per-state/per-year ImageServers; there is
 * now ONE national mosaic (USDA_CONUS_PRIME) covering the whole CONUS. Serving our
 * own Story County tile pyramid comes later; the spike only needs to prove NAIP
 * renders in MapLibre.
 */

import type { RasterSourceSpecification } from "maplibre-gl";
import type { NaipArcgisImagery } from "../county/types";
import { TILE_MAXZOOM } from "./tileCache";

/**
 * Build the MapLibre raster source for a county's NAIP imagery. The tile URLs
 * go through the "naip" protocol (see header); `maxzoom` overzooms past NAIP's
 * real ~1 m resolution instead of requesting z18+ server renders.
 */
export function naipSource(imagery: NaipArcgisImagery): RasterSourceSpecification {
  return {
    type: "raster",
    tiles: ["naip://tile/{z}/{x}/{y}"],
    tileSize: 256,
    maxzoom: TILE_MAXZOOM,
    attribution: imagery.attribution,
  };
}
