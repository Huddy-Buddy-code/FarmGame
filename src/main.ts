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
import type { Feature } from "geojson";
import { setProjection, toMeters, toLngLat, distanceMeters } from "./geo/coords";
import type { LngLat, Meters } from "./geo/coords";
import { naipSource } from "./map/naip";
import { addRoadsLayer } from "./map/roadsLayer";
import { route } from "./map/routing";
import { OverlayEngine } from "./map/overlay";
import { newGame } from "./state/saveState";
import type { SaveState } from "./state/saveState";
import { buyFieldFromBoundary } from "./field/fields";

// Which county to play. Later this comes from a save / county picker (see COUNTIES).
const COUNTY_ID = "story-ia";

// One in-memory save-state for the session (IndexedDB persistence is a later slice).
const save: SaveState = newGame();

// Only one map interaction is active at a time, so route-picking and field-drawing
// don't both consume the same clicks.
type Mode = "none" | "route" | "field";
let mode: Mode = "none";

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

  document.querySelector("#hud h1")!.textContent = m.name;
  setStatus("status-osm", `Roads: ${county.roads.features.length} loaded ✓`, "ok");
  updateMoney();
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
    const overlay = new OverlayEngine(map);
    wireRouting(map);
    wireFieldDrawing(map, overlay);
  });
}

function updateMoney() {
  setStatus("status-money", `Cash: $${save.money.toLocaleString()}`);
}

// --- Routing test: click two points, draw the real-road route. ---
function wireRouting(map: maplibregl.Map) {
  const picks: LngLat[] = [];

  document.getElementById("btn-route")!.addEventListener("click", () => {
    mode = "route";
    picks.length = 0;
    clearRoute(map);
    setStatus("status-route", "Routing: click 2 points on the map…");
  });

  map.on("click", async (e) => {
    if (mode !== "route") return;
    picks.push([e.lngLat.lng, e.lngLat.lat]);
    new maplibregl.Marker().setLngLat(e.lngLat).addTo(map);
    if (picks.length < 2) return;

    mode = "none";
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

// --- Field drawing (brief §12 step 2): click a polygon, double-click to close,
//     then buy the land under it and render it through the overlay engine. ---
function wireFieldDrawing(map: maplibregl.Map, overlay: OverlayEngine) {
  const verts: Meters[] = [];
  const draftId = "field-draft";

  function updateDraft() {
    const line: LngLat[] = verts.map((m) => toLngLat(m));
    const data: Feature = {
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: line },
    };
    const src = map.getSource(draftId) as maplibregl.GeoJSONSource | undefined;
    if (src) {
      src.setData(data);
    } else {
      map.addSource(draftId, { type: "geojson", data });
      map.addLayer({
        id: draftId,
        type: "line",
        source: draftId,
        paint: { "line-color": "#ffe36e", "line-width": 2, "line-dasharray": [2, 1] },
      });
    }
  }

  function clearDraft() {
    verts.length = 0;
    if (map.getLayer(draftId)) map.removeLayer(draftId);
    if (map.getSource(draftId)) map.removeSource(draftId);
  }

  document.getElementById("btn-field")!.addEventListener("click", () => {
    mode = "field";
    clearDraft();
    map.doubleClickZoom.disable(); // dbl-click means "finish the polygon" here.
    setStatus("status-field", "Buy field: click vertices, double-click to close…");
  });

  map.on("click", (e) => {
    if (mode !== "field") return;
    verts.push(toMeters([e.lngLat.lng, e.lngLat.lat]));
    updateDraft();
  });

  map.on("dblclick", (e) => {
    if (mode !== "field") return;
    // The double-click's two single clicks each pushed a vertex at the same spot;
    // drop the duplicate finishing vertex before closing.
    verts.pop();
    void e;
    finishField();
  });

  function finishField() {
    mode = "none";
    map.doubleClickZoom.enable();
    const boundary = verts.slice();
    clearDraft();
    if (boundary.length < 3) {
      setStatus("status-field", "Buy field: need at least 3 vertices — try again", "err");
      return;
    }
    try {
      const { field, acres, cost } = buyFieldFromBoundary(map, overlay, save, boundary);
      updateMoney();
      setStatus(
        "status-field",
        `Bought ${field.id}: ${acres.toFixed(1)} ac for $${cost.toLocaleString()} ✓`,
        "ok",
      );
    } catch (err) {
      setStatus("status-field", "Buy field: " + (err as Error).message, "err");
    }
  }
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
