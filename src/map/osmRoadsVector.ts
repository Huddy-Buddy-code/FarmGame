/**
 * OSM roads as VECTOR LINES over NAIP (brief §2, §12 step 1).
 *
 * Replaces the earlier translucent full-OSM raster overlay, which tinted the
 * imagery green (OSM's style fills fields/forests with colour). Here we fetch only
 * the road *geometry* for the current viewport from the Overpass API and draw it
 * as thin lines — no land fill, so the NAIP imagery stays clean and sharp.
 *
 * This also matches the real end state (brief §9): road geometry comes from OSM as
 * vector lines, not baked pixels. LATER this geometry comes from a pre-built Story
 * County extract (offline, no Overpass rate limits); the render code stays the same.
 *
 * License: OSM data is ODbL — attribution required (brief §2, §13).
 */

import type { Map as MlMap, GeoJSONSource } from "maplibre-gl";
import type { FeatureCollection } from "geojson";

// Public Overpass instances are flaky/rate-limited (they 406 or time out under
// load). Try them in order until one answers. This live-query path is a data-spike
// convenience; the robust end state bundles a pre-built Story County road extract
// so gameplay never depends on a live third-party call (brief §2, §9).
const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

// Below this zoom a viewport covers too much road to fetch responsibly.
const MIN_ZOOM = 11;

interface OverpassWay {
  type: "way";
  id: number;
  geometry?: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}

/** Road classes we care about, coarse -> fine, for width styling. */
const MAJOR = new Set(["motorway", "trunk", "primary", "secondary"]);

function buildQuery(b: { s: number; w: number; n: number; e: number }): string {
  const bbox = `${b.s},${b.w},${b.n},${b.e}`;
  return (
    `[out:json][timeout:25];` +
    `way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service)$"](${bbox});` +
    `out geom;`
  );
}

async function fetchRoads(b: {
  s: number;
  w: number;
  n: number;
  e: number;
}): Promise<FeatureCollection> {
  const body = "data=" + encodeURIComponent(buildQuery(b));
  let lastErr = "no endpoint";
  let data: { elements: OverpassWay[] } | undefined;
  for (const url of OVERPASS_URLS) {
    try {
      const res = await fetch(url, { method: "POST", body });
      if (!res.ok) {
        lastErr = `${new URL(url).host} ${res.status}`;
        continue;
      }
      data = await res.json();
      break;
    } catch (e) {
      lastErr = `${new URL(url).host}: ${(e as Error).message}`;
    }
  }
  if (!data) throw new Error(lastErr);
  const features = (data.elements as OverpassWay[])
    .filter((el) => el.type === "way" && el.geometry?.length)
    .map((el) => ({
      type: "Feature" as const,
      properties: {
        major: MAJOR.has(el.tags?.highway ?? "") ? 1 : 0,
      },
      geometry: {
        type: "LineString" as const,
        coordinates: el.geometry!.map((p) => [p.lon, p.lat]),
      },
    }));
  return { type: "FeatureCollection", features };
}

/**
 * Wire a viewport-following road layer onto the map. Fetches roads for the current
 * view, then refetches (debounced) whenever the map settles after a pan/zoom.
 * `onStatus` reports load state to the HUD.
 */
export function attachOsmRoads(
  map: MlMap,
  onStatus: (text: string, cls?: "ok" | "err") => void,
): void {
  map.addSource("osm-roads", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  // Casing under a lighter core so roads read on both light fields and dark trees.
  map.addLayer({
    id: "osm-roads-casing",
    type: "line",
    source: "osm-roads",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": "#1a1a1a",
      "line-opacity": 0.5,
      "line-width": ["case", ["==", ["get", "major"], 1], 5, 2.5],
    },
  });
  map.addLayer({
    id: "osm-roads-core",
    type: "line",
    source: "osm-roads",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["case", ["==", ["get", "major"], 1], "#ffe36e", "#ffffff"],
      "line-opacity": 0.9,
      "line-width": ["case", ["==", ["get", "major"], 1], 2.5, 1],
    },
  });

  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let first = true;

  async function refresh() {
    if (map.getZoom() < MIN_ZOOM) {
      onStatus(`OSM roads: zoom in to load (≥ ${MIN_ZOOM})`);
      return;
    }
    const bounds = map.getBounds();
    const mine = ++seq;
    if (first) onStatus("OSM roads: loading…");
    try {
      const fc = await fetchRoads({
        s: bounds.getSouth(),
        w: bounds.getWest(),
        n: bounds.getNorth(),
        e: bounds.getEast(),
      });
      if (mine !== seq) return; // a newer request superseded this one
      (map.getSource("osm-roads") as GeoJSONSource).setData(fc);
      onStatus(`OSM roads: ${fc.features.length} loaded ✓`, "ok");
      first = false;
    } catch (err) {
      onStatus("OSM roads: FAILED — " + (err as Error).message, "err");
    }
  }

  const debouncedRefresh = () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 500);
  };

  map.on("moveend", debouncedRefresh);
  if (map.isStyleLoaded()) refresh();
  else map.once("idle", refresh);
}
