/**
 * Entry point (brief §12).
 *
 * Loads a COUNTY PACKAGE (the playable "map") by id, then builds the map from it:
 *   1. NAIP satellite imagery (source from the county manifest).
 *   2. The county's bundled OSM road extract (offline — no live Overpass).
 *   3. Routing between two clicked points on real roads.
 *
 * Everything is driven by the loaded manifest, so a new county is a data drop-in.
 */

import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import { loadCounty } from "./county/registry";
import { setProjection, toMeters, distanceMeters } from "./geo/coords";
import type { LngLat } from "./geo/coords";
import { naipSource } from "./map/naip";
import { addRoadsLayer } from "./map/roadsLayer";
import { route } from "./map/routing";

// Which county to play. Later this comes from a save / county picker (see COUNTIES).
const COUNTY_ID = "story-ia";

function setStatus(id: string, text: string, cls?: "ok" | "err") {
  const el = document.getElementById(id)!;
  el.textContent = text;
  el.className = "row" + (cls ? " " + cls : "");
}

async function main() {
  const county = await loadCounty(COUNTY_ID);
  const m = county.manifest;

  // Establish the internal metric space for THIS county before any conversion.
  setProjection(m.utm.zone, m.utm.hemisphere);

  document.querySelector("#hud h1")!.textContent = `${m.name} — Data Spike`;
  setStatus("status-osm", `Roads: ${county.roads.features.length} loaded ✓`, "ok");
  document.getElementById("attr")!.innerHTML =
    `${m.imagery.attribution} · ${m.roads.attribution}`;

  const map = new maplibregl.Map({
    container: "map",
    center: m.center,
    zoom: m.defaultZoom,
    maxBounds: [
      [m.bbox[0] - 0.15, m.bbox[1] - 0.15],
      [m.bbox[2] + 0.15, m.bbox[3] + 0.15],
    ],
    attributionControl: { compact: false },
    style: {
      version: 8,
      sources: { naip: naipSource(m.imagery) },
      layers: [{ id: "naip", type: "raster", source: "naip" }],
    },
  });

  map.addControl(new maplibregl.NavigationControl(), "top-right");

  let naipOk = false;
  map.on("sourcedata", (e) => {
    if (e.isSourceLoaded && e.sourceId === "naip" && !naipOk) {
      naipOk = true;
      setStatus("status-naip", "NAIP imagery: loaded ✓", "ok");
    }
  });

  map.on("load", () => {
    addRoadsLayer(map, county.roads);
    wireRouting(map);
  });
}

// --- Routing test: click two points, draw the real-road route. ---
function wireRouting(map: maplibregl.Map) {
  let pickMode = false;
  const picks: LngLat[] = [];

  document.getElementById("btn-route")!.addEventListener("click", () => {
    pickMode = true;
    picks.length = 0;
    clearRoute(map);
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
      drawRoute(map, r.geometry);
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
}

function clearRoute(map: maplibregl.Map) {
  if (map.getLayer("route-line")) map.removeLayer("route-line");
  if (map.getSource("route")) map.removeSource("route");
}

function drawRoute(map: maplibregl.Map, coords: LngLat[]) {
  clearRoute(map);
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
    paint: { "line-color": "#ff4d4d", "line-width": 4 },
  });
}

main().catch((err) => {
  setStatus("status-naip", "Failed to load county: " + (err as Error).message, "err");
  console.error(err);
});
