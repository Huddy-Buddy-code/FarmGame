/**
 * NAIP satellite base layer (brief §2, §12 step 1).
 *
 * USDA NAIP imagery is public domain and is the sanctioned satellite source
 * (Google/Esri imagery is explicitly forbidden — see brief §2). We consume it
 * via `exportImage` against one of a small set of NAIP-serving ImageServers
 * (tileCache.ts's NAIP_PROVIDERS) — same public-domain data, different
 * government hosts, so a player can switch if one goes down (2026-08-12: USDA
 * APFO refused every TLS handshake for an extended stretch).
 *
 * Tiles are addressed as `naip://tile/{provider}/{z}/{x}/{y}` through the
 * custom protocol in tileCache.ts — cache-first against IndexedDB, hitting
 * the ImageServer only on a miss — instead of MapLibre's raw
 * {bbox-epsg-3857} template. main.ts must call `configureNaipCache()` and
 * register the protocol BEFORE creating the map.
 *
 * NOTE (data spike): USDA retired the per-state/per-year ImageServers; there is
 * now ONE national mosaic (USDA_CONUS_PRIME) covering the whole CONUS. Serving our
 * own Story County tile pyramid comes later; the spike only needs to prove NAIP
 * renders in MapLibre.
 */

import type { RasterSourceSpecification } from "maplibre-gl";
import type { NaipArcgisImagery } from "../county/types";
import { TILE_MAXZOOM } from "./tileCache";

/** The naip:// tile URL template for one provider — shared by `naipSource`
 * and by the Settings-tab provider toggle, which calls
 * `source.setTiles([naipTileUrlTemplate(id)])` directly (it has no
 * NaipArcgisImagery handy, and attribution doesn't change on a switch). */
export function naipTileUrlTemplate(provider: string): string {
  return `naip://tile/${provider}/{z}/{x}/{y}`;
}

/**
 * Build the MapLibre raster source for a county's NAIP imagery. The tile URLs
 * go through the "naip" protocol (see header); `maxzoom` overzooms past NAIP's
 * real ~1 m resolution instead of requesting z18+ server renders. `provider`
 * (a NaipProviderDef id from tileCache.ts) rides in the URL itself — switching
 * it later via `source.setTiles([...])` with a new provider forces MapLibre to
 * drop its own tile cache and reload, which a same-URL toggle wouldn't do.
 */
export function naipSource(imagery: NaipArcgisImagery, provider: string): RasterSourceSpecification {
  return {
    type: "raster",
    tiles: [naipTileUrlTemplate(provider)],
    tileSize: 256,
    maxzoom: TILE_MAXZOOM,
    attribution: imagery.attribution,
  };
}
