/**
 * Data spike entry point (brief §12 step 1).
 *
 * Proves the three biggest unknowns in one screen:
 *   1. NAIP satellite imagery renders in MapLibre for Story County, IA.
 *   2. OSM road data overlays in the same geo-space.
 *   3. Routing returns a real-road path between two clicked points.
 *
 * Nothing else is built until this is green (brief's hard gate).
 */

import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import { gameConfig } from "./config/gameConfig";
import { naipSource, NAIP_ATTRIBUTION } from "./map/naip";
import { osmRoadsSource } from "./map/roads";
import { route } from "./map/routing";
import type { LngLat } from "./geo/coords";
import { toMeters, distanceMeters } from "./geo/coords";

const { center, zoom } = gameConfig.county;

function setStatus(id: string, text: string, cls?: "ok" | "err") {
  const el = document.getElementById(id)!;
  el.textContent = text;
  el.className = "row" + (cls ? " " + cls : "");
}

const map = new maplibregl.Map({
  container: "map",
  center,
  zoom,
  attributionControl: { compact: false },
  // Style with no external glyphs/sprites needed for the raster-only spike.
  style: {
    version: 8,
    sources: {
      naip: naipSource(),
      "osm-roads": osmRoadsSource(),
    },
    layers: [
      { id: "naip", type: "raster", source: "naip" },
      {
        id: "osm-roads",
        type: "raster",
        source: "osm-roads",
        paint: { "raster-opacity": 0.45 },
      },
    ],
  },
});

map.addControl(new maplibregl.NavigationControl(), "top-right");

// --- Status wiring: detect whether each tile source actually loads. ---
let naipOk = false;
let osmOk = false;

map.on("sourcedata", (e) => {
  if (!e.isSourceLoaded) return;
  if (e.sourceId === "naip" && !naipOk) {
    naipOk = true;
    setStatus("status-naip", "NAIP imagery: loaded ✓", "ok");
  }
  if (e.sourceId === "osm-roads" && !osmOk) {
    osmOk = true;
    setStatus("status-osm", "OSM roads: loaded ✓", "ok");
  }
});

map.on("error", (e) => {
  const msg = String(e.error?.message ?? e.error ?? "");
  if (msg.includes("Iowa") || msg.includes("apfo")) {
    setStatus("status-naip", "NAIP imagery: FAILED — " + msg, "err");
  }
});

document.getElementById("attr")!.innerHTML =
  NAIP_ATTRIBUTION + " · © OpenStreetMap contributors (ODbL)";

// --- Routing test: click two points, draw the real-road route. ---
let pickMode = false;
const picks: LngLat[] = [];

document.getElementById("btn-route")!.addEventListener("click", () => {
  pickMode = true;
  picks.length = 0;
  clearRoute();
  setStatus("status-route", "Routing: click 2 points on the map…");
});

map.on("click", async (e) => {
  if (!pickMode) return;
  picks.push([e.lngLat.lng, e.lngLat.lat]);
  new maplibregl.Marker().setLngLat(e.lngLat).addTo(map);
  if (picks.length < 2) return;

  pickMode = false;
  setStatus("status-route", "Routing: querying OSRM…");
  try {
    const r = await route(picks[0]!, picks[1]!);
    drawRoute(r.geometry);
    // Cross-check: straight-line distance in our internal UTM meters vs. real road.
    const straight = distanceMeters(toMeters(picks[0]!), toMeters(picks[1]!));
    const km = (r.distanceMeters / 1000).toFixed(1);
    const min = (r.durationSeconds / 60).toFixed(0);
    const straightKm = (straight / 1000).toFixed(1);
    setStatus(
      "status-route",
      `Routing: ${km} km by road, ${min} min (${straightKm} km straight) ✓`,
      "ok",
    );
  } catch (err) {
    setStatus("status-route", "Routing: FAILED — " + (err as Error).message, "err");
  }
});

function clearRoute() {
  if (map.getLayer("route-line")) map.removeLayer("route-line");
  if (map.getSource("route")) map.removeSource("route");
}

function drawRoute(coords: LngLat[]) {
  clearRoute();
  map.addSource("route", {
    type: "geojson",
    data: {
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: coords },
    },
  });
  map.addLayer({
    id: "route-line",
    type: "line",
    source: "route",
    paint: { "line-color": "#ffd400", "line-width": 4 },
  });
}
