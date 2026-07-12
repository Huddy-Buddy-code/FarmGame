/**
 * Building markers on the map. Point fixtures (not polygons like fields), so
 * they're plain MapLibre `Marker`s — one per building, following the same
 * "create once, move/update after" shape as `updateAgentMarkers` in main.ts.
 * Clicking a marker opens a small popup with capacity info + a sell button;
 * the popup's DOM is built by the caller (main.ts owns save-state mutation
 * and toasts) via the `onOpen` callback.
 */

import maplibregl from "maplibre-gl";
import { toLngLat } from "../geo/coords";
import type { Building, BuildingKind } from "../state/saveState";
import { BUILDING_NAME } from "../sim/buildings";

export const BUILDING_ICON: Record<BuildingKind, string> = {
  silo: "🛢️",
  baleBarn: "🏚️",
  baleArea: "🌾",
  tractorBarn: "🏠",
  implementBarn: "🧰",
  farmYard: "🚩",
};

const buildingMarkers = new Map<string, maplibregl.Marker>();

/**
 * Sync markers with `buildings`. `onClick(building, el)` is called when a
 * marker is clicked — the caller builds/opens the popup content (it owns the
 * sell-button wiring and toasts).
 */
export function updateBuildingMarkers(
  map: maplibregl.Map,
  buildings: Building[],
  onClick: (building: Building, el: HTMLElement) => void,
): void {
  for (const building of buildings) {
    let marker = buildingMarkers.get(building.id);
    if (!marker) {
      const el = document.createElement("div");
      el.className = "building-dot";
      el.title = BUILDING_NAME[building.kind];
      el.textContent = BUILDING_ICON[building.kind];
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        onClick(building, el);
      });
      marker = new maplibregl.Marker({ element: el }).setLngLat(toLngLat(building.pos)).addTo(map);
      buildingMarkers.set(building.id, marker);
    }
  }
  for (const [id, marker] of buildingMarkers) {
    if (!buildings.some((b) => b.id === id)) {
      marker.remove();
      buildingMarkers.delete(id);
    }
  }
}
