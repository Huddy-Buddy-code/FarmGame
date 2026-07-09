/**
 * OSM roads overlay (brief §2, §12 step 1).
 *
 * For the data spike we prove roads render over NAIP by drawing the standard OSM
 * raster tiles as a semi-transparent overlay. This is only a *visual* proof that
 * road data lines up with the imagery in the same geo-space.
 *
 * The real system uses a county OSM extract (Geofabrik) for the routing graph and
 * for placing real buyers/elevators (Overpass). Road *geometry* for rendering will
 * later come from vector tiles built from that extract, not this raster overlay.
 *
 * License: OSM data is ODbL — attribution required (brief §2, §13).
 */

import type { RasterSourceSpecification } from "maplibre-gl";

export const OSM_ATTRIBUTION =
  '© OpenStreetMap contributors (ODbL)';

export function osmRoadsSource(): RasterSourceSpecification {
  return {
    type: "raster",
    tiles: [
      "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
      "https://b.tile.openstreetmap.org/{z}/{x}/{y}.png",
      "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png",
    ],
    tileSize: 256,
    attribution: OSM_ATTRIBUTION,
  };
}
