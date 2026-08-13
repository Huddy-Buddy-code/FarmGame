/**
 * Building markers on the map. Point fixtures (not polygons like fields), so
 * they're plain MapLibre `Marker`s — one per building, following the same
 * "create once, move/update after" shape as `updateAgentMarkers` in main.ts.
 * Clicking a marker opens a small popup with capacity info + a sell button;
 * the popup's DOM is built by the caller (main.ts owns save-state mutation
 * and toasts) via the `onOpen` callback.
 *
 * ART (2026-07-30, maintainer: "instead of just tags, lets use real placeable
 * assets"): each building draws its own elevation artwork — a PNG from
 * `src/assets/Structures/` when one exists, else the hand-drawn SVG in
 * `ui/structureIcons.ts` — anchored at its BASE so it stands on the ground
 * instead of floating. It replaced an emoji in a cream box, which read as a
 * map pin rather than a structure.
 *
 * SIZING is the interesting part. Real farm structures are TINY at the zooms
 * this game is played at: a 10 m grain bin is ~6 screen px at z16, i.e.
 * invisible. So a sprite is drawn at its true ground width but CLAMPED to a
 * readable range — zoom in far enough and the building settles onto its real
 * footprint; zoom out and it stops shrinking, so it stays findable and
 * clickable. `structureWidthM` is what "true" means per kind.
 *
 * The zoom→pixels conversion is published as ONE CSS custom property on
 * <html> (`--px-per-m`), refreshed per move frame, and each sprite sizes
 * itself with `clamp()` off its own `--w-m`. That's a single style write per
 * frame regardless of how many buildings exist, rather than one per marker.
 */

import maplibregl from "maplibre-gl";
import { toLngLat } from "../geo/coords";
import type { Building, BuildingKind } from "../state/saveState";
import { BUILDING_NAME } from "../sim/buildings";
import { structureImageUrl } from "../ui/structureImages";
import {
  siloSvg, baleBarnSvg, baleAreaSvg, tractorBarnSvg, implementBarnSvg, farmYardSvg, sellPointSvg, silageBunkerSvg,
} from "../ui/structureIcons";

/** Emoji per kind — still used in popup titles and panel rows, where a small
 * inline glyph beside a heading is exactly right. No longer used on the map. */
export const BUILDING_ICON: Record<BuildingKind, string> = {
  silo: "🛢️",
  baleBarn: "🏚️",
  baleArea: "🌾",
  tractorBarn: "🏠",
  implementBarn: "🧰",
  farmYard: "🚩",
  sellPoint: "💵",
  silageBunker: "🧱",
};

/**
 * Real footprint WIDTH in meters — what a sprite's width means on the ground.
 * Visual/world data, NOT game balance, so it lives here rather than in
 * gameConfig (same call as `OVERLAY_METERS_PER_PIXEL` in map/overlay.ts).
 *
 * Ordinary Midwest farmstead sizes: a machine shed that swallows a combine is
 * ~24 m wide, a hay barn ~18 m, an implement shed ~14 m. Silos vary by tier
 * and are indexed separately (a 10 000-bushel bin is ~5.5 m across, a 50 000
 * one ~11 m).
 */
export const STRUCTURE_WIDTH_M: Record<BuildingKind, number> = {
  silo: 5.5, // per-tier; see SILO_WIDTH_M
  baleBarn: 18,
  baleArea: 24,
  tractorBarn: 24,
  implementBarn: 14,
  farmYard: 30,
  sellPoint: 20,
  silageBunker: 20, // per-tier; see BUNKER_WIDTH_M
};

const SILO_WIDTH_M: Record<string, number> = { small: 5.5, medium: 8, large: 11 };
/** A bunker is a long walled slab — far wider than a bin at every tier. */
const BUNKER_WIDTH_M: Record<string, number> = { small: 14, medium: 20, large: 28 };

/** Screen-size guard rails, px. Below MIN a building is unfindable and awkward
 * to click; above MAX a farmyard would swallow the viewport at max zoom. */
const MIN_PX = 26;
const MAX_PX = 190;
export const STRUCTURE_MIN_PX = MIN_PX;
export const STRUCTURE_MAX_PX = MAX_PX;

/** The structure's true ground width, meters. */
export function structureWidthM(kind: BuildingKind, size?: string | null): number {
  if (kind === "silo") return SILO_WIDTH_M[size ?? "small"] ?? SILO_WIDTH_M.small!;
  if (kind === "silageBunker") return BUNKER_WIDTH_M[size ?? "small"] ?? BUNKER_WIDTH_M.small!;
  return STRUCTURE_WIDTH_M[kind];
}

/**
 * On-screen width in px for a structure — the same curve the CSS `clamp()`
 * applies, exported so the sizing behaviour is testable without a browser.
 */
export function structurePx(widthM: number, pxPerM: number): number {
  return Math.min(MAX_PX, Math.max(MIN_PX, widthM * pxPerM));
}

/** The artwork for a building: a PNG if one's been dropped in, else the SVG. */
export function structureArtHtml(kind: BuildingKind, size?: string | null): string {
  const url = structureImageUrl(kind, size);
  if (url) return `<img src="${url}" alt="" draggable="false" />`;
  switch (kind) {
    case "silo":
      return siloSvg((size as "small" | "medium" | "large" | undefined) ?? "small");
    case "baleBarn":
      return baleBarnSvg();
    case "baleArea":
      return baleAreaSvg();
    case "tractorBarn":
      return tractorBarnSvg();
    case "implementBarn":
      return implementBarnSvg();
    case "farmYard":
      return farmYardSvg();
    case "sellPoint":
      return sellPointSvg();
    case "silageBunker":
      return silageBunkerSvg();
  }
}

/**
 * Screen pixels per ground meter at the map's current view. MapLibre's own
 * projection knows this exactly (latitude included), so measure with it rather
 * than re-deriving the web-mercator scale here.
 */
export function pxPerMeter(map: maplibregl.Map): number {
  const c = map.getCenter();
  const a = map.project(c);
  // 0.001° of LATITUDE ≈ 111.32 m everywhere (unlike longitude, which shrinks
  // toward the poles) — a clean north-south ruler at the current center.
  const b = map.project([c.lng, c.lat + 0.001]);
  return Math.hypot(b.x - a.x, b.y - a.y) / 111.32;
}

let scaleWired = false;

/** Publish `--px-per-m` on <html>; every sprite sizes itself off it. */
function wireGroundScale(map: maplibregl.Map): void {
  if (scaleWired) return;
  scaleWired = true;
  const apply = (): void => {
    document.documentElement.style.setProperty("--px-per-m", String(pxPerMeter(map)));
  };
  map.on("move", apply); // covers zoom, pan and flyTo — one write per frame
  apply();
}

const buildingMarkers = new Map<string, maplibregl.Marker>();
/** What each marker was last drawn as, so a silo whose tier changed redraws
 * without re-running innerHTML on every tick. */
const markerArtKey = new Map<string, string>();

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
  wireGroundScale(map);

  for (const building of buildings) {
    let marker = buildingMarkers.get(building.id);
    if (!marker) {
      const el = document.createElement("div");
      el.className = "structure";
      el.title = BUILDING_NAME[building.kind];
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        onClick(building, el);
      });
      // `anchor: "bottom"` puts the building's BASE on its coordinate — the
      // reason it reads as standing on the ground rather than pinned to it.
      marker = new maplibregl.Marker({ element: el, anchor: "bottom" })
        .setLngLat(toLngLat(building.pos))
        .addTo(map);
      buildingMarkers.set(building.id, marker);
    }
    const artKey = `${building.kind}|${building.size ?? ""}`;
    if (markerArtKey.get(building.id) !== artKey) {
      markerArtKey.set(building.id, artKey);
      const el = marker.getElement();
      el.style.setProperty("--w-m", String(structureWidthM(building.kind, building.size)));
      el.innerHTML = structureArtHtml(building.kind, building.size);
    }
  }

  for (const [id, marker] of buildingMarkers) {
    if (!buildings.some((b) => b.id === id)) {
      marker.remove();
      buildingMarkers.delete(id);
      markerArtKey.delete(id);
    }
  }
}
