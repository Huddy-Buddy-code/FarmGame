/**
 * The game board edge (2026-07-28) — makes the playable county read as a
 * defined board instead of imagery raggedly running out.
 *
 * Three layers from one county polygon (county/tigerweb.ts):
 *   1. MASK — a world-sized fill with the county cut out as a hole, in a dark
 *      "table" tone. Sits ABOVE imagery + roads, so everything outside the
 *      county (NAIP spill, bbox-fetched roads) vanishes behind it in one
 *      stroke — no per-source clipping.
 *   2. BORDER — a cased stroke along the polygon (wood casing, cream core,
 *      matching the UI palette).
 *   3. LABEL — a big county name pinned north of the boundary, an HTML marker
 *      because the style loads NO glyph fonts (a symbol text layer can't
 *      render); it hides past `labelMaxZoom` so it never crowds fieldwork.
 *
 * Layer order note: this is added on map "load", BEFORE field surfaces /
 * outlines / drawing layers are created, so player content stays on top.
 *
 * IMPORTANT: derive geometry from the BOUNDARY, never the manifest bbox —
 * bundled manifests hand-tune their bbox for the initial view and it can be
 * smaller than the county (Story's real north edge is 42.209; its manifest
 * says 42.11).
 */

import maplibregl from "maplibre-gl";
import type { Map as MlMap } from "maplibre-gl";
import type { Feature, Polygon, Position } from "geojson";
import type { CountyBoundary } from "../county/tigerweb";

/** [west, south, east, north] of the boundary geometry itself. */
export function boundaryBbox(boundary: CountyBoundary): [number, number, number, number] {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const ring of outerRings(boundary)) {
    for (const pt of ring) {
      const lng = pt[0]!; // GeoJSON Position is number[] — [0]/[1] always exist
      const lat = pt[1]!;
      if (lng < w) w = lng;
      if (lng > e) e = lng;
      if (lat < s) s = lat;
      if (lat > n) n = lat;
    }
  }
  return [w, s, e, n];
}

/** Smallest bbox containing both — the map's maxBounds must fit the manifest
 * view AND the true polygon (see header). */
export function unionBbox(
  a: [number, number, number, number],
  b: [number, number, number, number],
): [number, number, number, number] {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

/** The county's OUTER ring(s) — one for a Polygon, one per part of a
 * MultiPolygon. Interior holes (rare: independent-city enclaves) are ignored
 * for the mask, so an enclave still shows imagery instead of a dead spot. */
function outerRings(boundary: CountyBoundary): Position[][] {
  const g = boundary.geometry;
  return g.type === "Polygon" ? [g.coordinates[0]!] : g.coordinates.map((poly) => poly[0]!);
}

/** World-sized polygon with the county as hole(s) — the mask geometry. */
export function countyMaskFeature(boundary: CountyBoundary): Feature<Polygon> {
  const world: Position[] = [
    [-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85],
  ];
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [world, ...outerRings(boundary)] },
  };
}

export interface CountyBoardOptions {
  /** Display name, e.g. "Story County". */
  name: string;
  /** USPS state code, e.g. "IA". */
  state: string;
  /** Label shows at or below this zoom, fades out above it. */
  labelMaxZoom: number;
}

/** Add mask + border layers and the zoom-gated county label. */
export function addCountyBoard(map: MlMap, boundary: CountyBoundary, opts: CountyBoardOptions): void {
  map.addSource("county-mask", { type: "geojson", data: countyMaskFeature(boundary) });
  // Full geometry (incl. any enclave rings) so internal borders still draw.
  map.addSource("county-boundary", { type: "geojson", data: boundary });

  // Dark wood "table" outside the board — matches the page background family
  // (#111 body, cream/wood UI) rather than pretending to be more terrain.
  map.addLayer({
    id: "county-mask",
    type: "fill",
    source: "county-mask",
    paint: { "fill-color": "#221a10", "fill-opacity": 1 },
  });
  map.addLayer({
    id: "county-border-casing",
    type: "line",
    source: "county-boundary",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": "#6b4426", // --wood-dark
      "line-width": ["interpolate", ["linear"], ["zoom"], 9, 5, 16, 14],
    },
  });
  map.addLayer({
    id: "county-border",
    type: "line",
    source: "county-boundary",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": "#faf3e3", // --cream
      "line-width": ["interpolate", ["linear"], ["zoom"], 9, 1.6, 16, 4],
    },
  });

  // Label: north-edge midpoint, floating just off the board.
  const [w, , e, n] = boundaryBbox(boundary);
  const el = document.createElement("div");
  el.className = "county-label";
  el.innerHTML =
    `<div class="county-label-name"></div><div class="county-label-state"></div>`;
  // Bundled manifests may name the county "Story County, Iowa" while runtime
  // ones say "Story County" — the state gets its own line either way, so
  // strip anything after a comma or it reads twice.
  const displayName = opts.name.split(",")[0]!.trim();
  (el.firstElementChild as HTMLElement).textContent = displayName.toUpperCase();
  (el.lastElementChild as HTMLElement).textContent = opts.state;
  new maplibregl.Marker({ element: el, anchor: "bottom", offset: [0, -14] })
    .setLngLat([(w + e) / 2, n])
    .addTo(map);

  const gate = (): void => {
    el.classList.toggle("hidden", map.getZoom() > opts.labelMaxZoom);
  };
  map.on("zoom", gate);
  gate();
}
