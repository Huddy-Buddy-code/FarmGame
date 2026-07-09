/**
 * NAIP satellite base layer (brief §2, §12 step 1).
 *
 * USDA NAIP imagery is public domain and is the sanctioned satellite source
 * (Google/Esri imagery is explicitly forbidden — see brief §2). We consume it
 * from USDA's APFO ArcGIS ImageServer via its `exportImage` endpoint, which
 * MapLibre can drive as a raster source using the {bbox-epsg-3857} template.
 *
 * NOTE (data spike): USDA retired the per-state/per-year ImageServers; there is
 * now ONE national mosaic (USDA_CONUS_PRIME) covering the whole CONUS. Serving our
 * own Story County tile pyramid comes later; the spike only needs to prove NAIP
 * renders in MapLibre.
 */

import type { RasterSourceSpecification } from "maplibre-gl";
import type { NaipArcgisImagery } from "../county/types";

/**
 * Build a MapLibre raster source from a county's NAIP imagery manifest entry.
 * `exportImage` returns a rendered image for the requested web-mercator bbox.
 * The ImageServer URL comes from the county package, not a hardcoded constant.
 */
export function naipSource(imagery: NaipArcgisImagery): RasterSourceSpecification {
  const params = new URLSearchParams({
    bbox: "{bbox-epsg-3857}",
    bboxSR: "3857",
    imageSR: "3857",
    size: "256,256",
    format: "jpgpng",
    transparent: "false",
    f: "image",
  });
  // URLSearchParams encodes the {bbox-epsg-3857} braces; MapLibre needs them raw.
  const query = decodeURIComponent(params.toString());
  return {
    type: "raster",
    tiles: [`${imagery.imageServer}/exportImage?${query}`],
    tileSize: 256,
    attribution: imagery.attribution,
  };
}
