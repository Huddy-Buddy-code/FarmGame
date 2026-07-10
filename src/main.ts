/**
 * Entry point — the playable season loop (brief §12 steps 2–3).
 *
 * Loads a COUNTY PACKAGE (the playable "map") by id, builds the map (NAIP imagery +
 * bundled OSM roads), then runs the game: buy fields, plant corn/soy, watch them
 * grow on the sim clock, harvest into the grain bin.
 *
 * Time model (design decision, 2026-07-09): 1× is LITERAL real time — the game can
 * sit in a tab like an idle game. 60× (1 real second = 1 game minute) and 3600×
 * (1 real second = 1 game hour) speed it up, and "Skip to month" (with a short
 * montage) is the main lever for jumping seasons.
 */

import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Feature } from "geojson";

import { loadCounty } from "./county/registry";
import { setProjection, toMeters, toLngLat } from "./geo/coords";
import type { LngLat, Meters } from "./geo/coords";
import { areaAcres, pointInPolygon } from "./geo/geometry";
import { naipSource } from "./map/naip";
import { addRoadsLayer } from "./map/roadsLayer";
import { OverlayEngine } from "./map/overlay";
import { newGame } from "./state/saveState";
import type { SaveState, Field } from "./state/saveState";
import { buyFieldFromBoundary, renderField, initIdCounters, sellField } from "./field/fields";
import { persistGame, loadGame, clearSavedGame } from "./state/persistence";
import { sellGrain } from "./sim/economy";
import { SimClock } from "./sim/clock";
import {
  formatDate, dateOf, nextMonthStart, MONTH_NAMES, MONTH_SHORT,
  START_MONTH, MONTHS_PER_YEAR, MINUTES_PER_DAY,
  getDaysPerMonth, setDaysPerMonth, minutesPerMonth,
} from "./sim/calendar";
import {
  plant, tickFarming, growthProgress, yieldRange, startHarvest, isHarvesting,
  inPlantingWindow, getHarvestingIds, restoreHarvesting, plow, autoManageField,
} from "./sim/farming";
import { gameConfig } from "./config/gameConfig";
import type { CropId } from "./config/gameConfig";

// Which county to play. Later this comes from a save / county picker.
const COUNTY_ID = "story-ia";

// Load the persisted game if there is one; otherwise start fresh. The game
// auto-saves (see wirePersistence), so refreshes drop you where you were.
const loaded = loadGame();
const save: SaveState = loaded?.save ?? newGame();
const clock = new SimClock();
if (loaded) {
  clock.setTime(loaded.clockNow);
  restoreHarvesting(loaded.harvestingIds);
  initIdCounters(save);
  if (loaded.daysPerMonth) setDaysPerMonth(loaded.daysPerMonth);
}

// Only one map interaction is active at a time.
type Mode = "none" | "field";
let mode: Mode = "none";

let overlay: OverlayEngine;
let mapRef: maplibregl.Map;
let selectedFieldId: string | null = null;

const $ = (id: string) => document.getElementById(id)!;

function devStatus(id: string, text: string, cls?: "ok" | "err") {
  const el = $(id);
  el.textContent = text;
  el.className = "row" + (cls ? " " + cls : "");
}

async function main() {
  const county = await loadCounty(COUNTY_ID);
  const m = county.manifest;

  setProjection(m.utm.zone, m.utm.hemisphere);
  devStatus("status-osm", `Roads: ${county.roads.features.length} ✓`, "ok");
  $("attr").innerHTML = `${m.imagery.attribution} · ${m.roads.attribution}`;

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
  mapRef = map;
  map.addControl(new maplibregl.NavigationControl(), "top-right");

  let naipOk = false;
  map.on("sourcedata", (e) => {
    if (e.isSourceLoaded && e.sourceId === "naip" && !naipOk) {
      naipOk = true;
      devStatus("status-naip", "NAIP: loaded ✓", "ok");
    }
  });

  wireMiddleMousePan(map);

  map.on("load", () => {
    addRoadsLayer(map, county.roads);
    overlay = new OverlayEngine(map);
    wireFieldDrawing(map);
    wireFieldSelection(map);
    wireTimeControls();
    buildCropCalendar();
    wireInventory();
    wireFieldsTab();
    wirePersistence();
    // Re-render every field from the loaded save (textures + outlines).
    for (const f of save.fields) renderField(map, overlay, f, clock.time());
    clock.play(); // the world breathes from the start (idle-game 1×)
    requestAnimationFrame(gameLoop);
  });

  updateHud();
}

// ---------------------------------------------------------------------------
// Middle-mouse pan: left-click is taken by field select / field drawing, so
// panning gets the middle button. MapLibre has no built-in middle-button drag,
// so we drive panBy() from the raw pointer deltas ourselves.
// ---------------------------------------------------------------------------
function wireMiddleMousePan(map: maplibregl.Map) {
  const container = map.getCanvasContainer();
  let panning = false;
  let lastX = 0;
  let lastY = 0;

  container.addEventListener("mousedown", (e) => {
    if (e.button !== 1) return; // middle button only
    e.preventDefault(); // suppress the browser's middle-click autoscroll
    panning = true;
    lastX = e.clientX;
    lastY = e.clientY;
    container.style.cursor = "grabbing";
  });

  // On window so a drag that leaves the canvas still tracks and releases.
  window.addEventListener("mousemove", (e) => {
    if (!panning) return;
    // Drag content with the cursor: mouse right → view shifts left, so panBy(-Δ).
    map.panBy([lastX - e.clientX, lastY - e.clientY], { animate: false });
    lastX = e.clientX;
    lastY = e.clientY;
  });

  window.addEventListener("mouseup", (e) => {
    if (e.button !== 1 || !panning) return;
    panning = false;
    container.style.cursor = "";
  });
}

// ---------------------------------------------------------------------------
// Game loop: advance the sim, tick farming, repaint what changed.
// ---------------------------------------------------------------------------
let lastFrame = performance.now();
let lastUiRefresh = 0;

function gameLoop(ts: number) {
  const realSeconds = Math.min(1, (ts - lastFrame) / 1000); // clamp tab-sleep jumps
  lastFrame = ts;

  const before = clock.time();
  clock.advance(realSeconds);
  tickWorld(before);

  requestAnimationFrame(gameLoop);
}

/** Advance farming from the clock's previous time to now; repaint changed fields. */
function tickWorld(prev: number) {
  const now = clock.time();
  const dt = now - prev;
  if (dt <= 0) return;
  const { changed } = tickFarming(save, now, dt);
  for (const f of changed) renderField(mapRef, overlay, f, now);
  repaintGrowthStages(now, changed);
  for (const f of changed) if (f.autoManage) toastAutoAction(f);
  // Refresh UI ~2×/s (or instantly when a status flipped). Rebuilding the field
  // panel every frame would recreate its buttons under the player's cursor.
  const rt = performance.now();
  if (changed.length || rt - lastUiRefresh > 500) {
    lastUiRefresh = rt;
    updateHud();
    if (selectedFieldId) refreshFieldPanel();
    refreshFieldsTab();
  }
}

/**
 * Growing fields change look WITHIN a status (young rows → closed canopy), so we
 * repaint whenever a field crosses a growth-stage bucket (12 per season), not
 * just on status flips. Per-field canvases make this cheap.
 */
const paintedStage = new Map<string, number>();
function repaintGrowthStages(now: number, alreadyPainted: { id: string }[]) {
  const done = new Set(alreadyPainted.map((f) => f.id));
  for (const f of save.fields) {
    if (f.status !== "growing" || done.has(f.id)) continue;
    const bucket = Math.floor(growthProgress(f, now) * 12);
    if (paintedStage.get(f.id) !== bucket) {
      paintedStage.set(f.id, bucket);
      renderField(mapRef, overlay, f, now);
    }
  }
}

/** Toast feedback when an auto-managed field advances on its own, so a player
 * who wanders back to the tab can see what happened while they were away. */
function toastAutoAction(field: Field): void {
  const name = prettyId(field.id);
  switch (field.status) {
    case "tilled":
      toast(`🤖 Auto-plowed ${name}`);
      break;
    case "planted":
      if (field.crop) {
        const cfg = gameConfig.crops[field.crop];
        toast(`🤖 Auto-planted ${cfg.emoji} ${cfg.name} on ${name}`);
      }
      break;
    case "ready":
      if (isHarvesting(field)) toast(`🤖 Auto-harvest started on ${name}`);
      break;
    case "harvested":
      toast(`🤖 Auto-harvested ${name}`);
      break;
  }
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------
function updateHud() {
  $("hud-date").textContent = formatDate(clock.time());
  $("hud-cash").textContent = "$" + Math.round(save.money).toLocaleString();
  $("hud-corn").textContent = save.grain.corn.toFixed(1) + " t";
  $("hud-soy").textContent = save.grain.soybeans.toFixed(1) + " t";

  // Year-position marker: fraction of the display year (Mar → Feb) elapsed.
  const f = yearFraction(clock.time());
  $("year-marker").style.left = `calc(${(f * 100).toFixed(2)}% - 1px)`;
  // The calendar grid has a 110px label column; the lanes take the rest.
  const calNow = document.getElementById("cal-now");
  if (calNow) calNow.style.left = `calc(${(110 * (1 - f)).toFixed(1)}px + ${(f * 100).toFixed(2)}%)`;

  // Day-position marker: fraction of the current 24h day elapsed (midnight = 0).
  const df = dayFraction(clock.time());
  $("day-marker").style.left = `calc(${(df * 100).toFixed(2)}% - 1px)`;
}

/** 0..1 through the campaign's display year, which runs Mar 1 → end of Feb. */
function yearFraction(t: number): number {
  const minutesPerYear = MONTHS_PER_YEAR * minutesPerMonth();
  return (t % minutesPerYear) / minutesPerYear;
}

/** 0..1 through the current game day, midnight (0:00) = 0. */
function dayFraction(t: number): number {
  return (t % MINUTES_PER_DAY) / MINUTES_PER_DAY;
}

function toast(text: string, ms = 2600) {
  const el = $("toast");
  el.textContent = text;
  el.style.display = "block";
  clearTimeout((toast as { t?: number }).t);
  (toast as { t?: number }).t = window.setTimeout(() => (el.style.display = "none"), ms);
}

// ---------------------------------------------------------------------------
// Inventory: grain storage + the v0 flat-price sale (real market comes later).
// ---------------------------------------------------------------------------
function wireInventory() {
  $("btn-inventory").addEventListener("click", () => {
    const el = $("inventory");
    const opening = el.style.display !== "block";
    el.style.display = opening ? "block" : "none";
    if (opening) refreshInventory();
  });
  $("inv-close").addEventListener("click", () => ($("inventory").style.display = "none"));
}

function refreshInventory() {
  const rows = $("inv-rows");
  rows.innerHTML = "";
  for (const cropId of Object.keys(gameConfig.crops) as CropId[]) {
    const cfg = gameConfig.crops[cropId];
    const tons = save.grain[cropId];
    const row = document.createElement("div");
    row.className = "inv-row";
    row.innerHTML = `
      <span class="icon">${cfg.emoji}</span>
      <span class="info">
        <div class="name">${cfg.name}</div>
        <div class="qty">${tons.toFixed(1)} t stored</div>
      </span>
      <span class="price">$${cfg.sellPricePerTon.toLocaleString()}/t</span>`;
    const btn = document.createElement("button");
    btn.className = "primary";
    const value = Math.round(tons * cfg.sellPricePerTon);
    btn.textContent = tons > 0 ? `Sell all · $${value.toLocaleString()}` : "Empty";
    btn.disabled = tons <= 0;
    btn.addEventListener("click", () => {
      const { tons: sold, revenue } = sellGrain(save, cropId, Infinity);
      if (sold <= 0) return;
      updateHud();
      refreshInventory();
      toast(`💰 Sold ${sold.toFixed(1)} t of ${cfg.name.toLowerCase()} for $${revenue.toLocaleString()}`);
    });
    row.appendChild(btn);
    rows.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Fields tab: every owned field at a glance — status, acres, expected yield.
// Click a row to open its detail panel (where Plow/Plant/Harvest/Sell live).
// ---------------------------------------------------------------------------
function wireFieldsTab() {
  $("btn-fields").addEventListener("click", () => {
    const el = $("fieldstab");
    const opening = el.style.display !== "block";
    el.style.display = opening ? "block" : "none";
    if (opening) refreshFieldsTab();
  });
  $("fields-close").addEventListener("click", () => ($("fieldstab").style.display = "none"));
}

/** Rebuild the fields list. Cheap no-op while the panel is hidden. */
function refreshFieldsTab() {
  const el = $("fieldstab");
  if (el.style.display !== "block") return;

  const rows = $("fields-rows");
  if (save.fields.length === 0) {
    rows.innerHTML = `<div id="fields-empty">No fields yet — 🚜 Buy Field to start your farm.</div>`;
    return;
  }

  const now = clock.time();
  rows.innerHTML = "";
  for (const field of save.fields) {
    const acres = areaAcres(field.boundary);
    const statusLabel = isHarvesting(field) ? "harvesting" : field.status;

    let icon = "🟫";
    let yieldText = "—";
    if (field.crop) {
      icon = gameConfig.crops[field.crop].emoji;
      const range = yieldRange(field, now);
      if (range) yieldText = `${(range.low * acres).toFixed(0)}–${(range.high * acres).toFixed(0)} t`;
    }

    const row = document.createElement("div");
    row.className = "field-row";
    row.innerHTML = `
      <span class="icon">${icon}</span>
      <span class="fr-info">
        <div class="fr-name">${prettyId(field.id)}</div>
        <div class="fr-sub">${acres.toFixed(1)} ac · ${statusLabel}${field.autoManage ? " · 🤖" : ""}</div>
      </span>
      <span class="fr-yield">${yieldText}</span>`;
    row.addEventListener("click", () => {
      el.style.display = "none";
      openFieldPanel(field.id);
    });
    rows.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Persistence: auto-save + the Reset button.
// ---------------------------------------------------------------------------
let resetting = false;

function doSave() {
  if (resetting) return; // a reset is wiping the save — don't write it back
  persistGame({ save, clockNow: clock.time(), harvestingIds: getHarvestingIds(), daysPerMonth: getDaysPerMonth() });
}

function wirePersistence() {
  // Auto-save every 5s and on tab close/hide. The state is a few KB — cheap.
  setInterval(doSave, 5000);
  window.addEventListener("beforeunload", doSave);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") doSave();
  });

  $("btn-reset").addEventListener("click", () => {
    if (!confirm("Start a new farm? This wipes the current save.")) return;
    resetting = true;
    clearSavedGame();
    location.reload();
  });
}

// ---------------------------------------------------------------------------
// Time controls: pause / 1× / 60× / 3600× + skip-to-month montage.
// ---------------------------------------------------------------------------
/** 1× = literal real time: 1 sim-minute per real minute. Multiples of this base
 * give the other speeds their exact "1 real second = N game time" meaning:
 *   60×   → 1 real second = 1 game minute
 *   3600× → 1 real second = 1 game hour
 */
const BASE_COMPRESSION = 1 / 60;

function wireTimeControls() {
  const speeds: Array<[string, number | null]> = [
    ["spd-pause", null],
    ["spd-1", 1],
    ["spd-60", 60],
    ["spd-3600", 3600],
  ];
  for (const [id, mult] of speeds) {
    $(id).addEventListener("click", () => {
      for (const [other] of speeds) $(other).classList.remove("active");
      $(id).classList.add("active");
      if (mult === null) {
        clock.pause();
      } else {
        clock.setCompression(BASE_COMPRESSION * mult);
        clock.play();
      }
    });
  }
  clock.setCompression(BASE_COMPRESSION);

  // Skip-to-month dropdown: always offers the next 12 month-starts.
  const sel = $("skip-month") as HTMLSelectElement;
  const rebuild = () => {
    const cur = dateOf(clock.time()).month;
    sel.options.length = 1;
    for (let i = 1; i <= 12; i++) {
      const mo = (cur + i) % 12;
      sel.add(new Option(`${MONTH_SHORT[mo]} 1`, String(mo)));
    }
  };
  rebuild();
  sel.addEventListener("focus", rebuild);
  sel.addEventListener("change", () => {
    if (sel.value === "") return;
    const target = nextMonthStart(clock.time(), Number(sel.value));
    sel.value = "";
    runMontage(target);
  });

  // Calendar pace knob: how many real days make up a game month. Everything the
  // player cares about (crop growth, harvest-band positions) is keyed to MONTHS,
  // so this cleanly rescales the whole farming loop — a shorter month = faster
  // seasons AND proportionally faster crops, staying in sync. Safe mid-campaign;
  // just refresh the HUD markers (year/day fractions depend on month length).
  const daysSel = $("days-per-month") as HTMLSelectElement;
  daysSel.value = String(getDaysPerMonth());
  daysSel.addEventListener("change", () => {
    setDaysPerMonth(Number(daysSel.value));
    updateHud();
    toast(`🗓️ Month length set to ${daysSel.value} days`);
  });
}

/**
 * The skip montage: fast-forward the sim to `target` over ~2.5 real seconds so the
 * player watches the field green up / ripen instead of teleporting. All skipped
 * time IS simulated (no shortcuts), just at very high compression.
 */
let montageActive = false;
function runMontage(target: number) {
  if (montageActive) return;
  montageActive = true;
  const wasPaused = clock.isPaused();
  const durationMs = 2500;
  const start = performance.now();
  const from = clock.time();
  $("montage").style.display = "flex";
  clock.pause(); // we drive time manually during the montage

  const step = (ts: number) => {
    const t = Math.min(1, (ts - start) / durationMs);
    const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2; // easeInOutQuad
    const now = from + (target - from) * eased;
    const prev = clock.time();
    // Drive the clock forward in montage steps (clock stays paused; we set time
    // by advancing at exact compression for one fake second).
    clock.play();
    clock.setCompression(now - prev);
    clock.advance(1);
    clock.pause();
    tickWorld(prev);
    $("montage-month").textContent = MONTH_NAMES[dateOf(clock.time()).month]!;
    if (t < 1) {
      requestAnimationFrame(step);
    } else {
      $("montage").style.display = "none";
      montageActive = false;
      restoreSpeed(wasPaused);
      toast(`📅 ${formatDate(clock.time())}`);
    }
  };
  requestAnimationFrame(step);
}

/** Put compression + play state back to whatever the speed buttons say. */
function restoreSpeed(paused: boolean) {
  const active = document.querySelector("#timebar button.active")?.id ?? "spd-1";
  const mult = active === "spd-3600" ? 3600 : active === "spd-60" ? 60 : 1;
  clock.setCompression(BASE_COMPRESSION * mult);
  if (active === "spd-pause" || paused) clock.pause();
  else clock.play();
}

// ---------------------------------------------------------------------------
// Crop calendar: planting/harvest bands per crop over the display year (Mar→Feb),
// derived from gameConfig (plant windows + grow time) — no hand-kept data.
// ---------------------------------------------------------------------------
function buildCropCalendar() {
  rebuildCropCalendarGrid();

  $("btn-cropcal").addEventListener("click", () => {
    const el = $("cropcal");
    el.style.display = el.style.display === "block" ? "none" : "block";
    updateHud();
  });
  $("cal-close").addEventListener("click", () => ($("cropcal").style.display = "none"));
}

/** Rebuild the grid from gameConfig. Bands are month-based (crop growMonths), so
 * they're independent of the days-per-month pace knob — calendar-accurate at any
 * pace, which is the whole point of keying growth to months. */
function rebuildCropCalendarGrid() {
  const grid = $("cal-grid");
  const disp = (mo: number) => (mo - START_MONTH + MONTHS_PER_YEAR) % MONTHS_PER_YEAR;

  // Season header (the display year aligns with seasons: Mar starts spring).
  let html = `<div></div>`;
  for (const s of ["🌱", "☀️", "🍂", "❄️"]) {
    html += `<div class="seasonhead" style="grid-column: span 3">${s}</div>`;
  }
  // Month header.
  html += `<div></div>`;
  for (let i = 0; i < MONTHS_PER_YEAR; i++) {
    html += `<div class="mo">${MONTH_SHORT[(START_MONTH + i) % MONTHS_PER_YEAR]}</div>`;
  }
  // One lane per crop with plant + harvest bands (percent of the display year).
  for (const cropId of Object.keys(gameConfig.crops) as CropId[]) {
    const cfg = gameConfig.crops[cropId];
    const growMonths = cfg.growMonths;
    const plantStart = disp(cfg.plantMonths[0]!);
    const plantLen = cfg.plantMonths.length;
    // Harvest opens a grow-time after the earliest planting and closes a
    // grow-time after the latest; crops here don't wrap past February.
    const harvStart = plantStart + growMonths;
    const harvLen = plantLen; // window is as wide as the planting window
    const pct = (months: number) => (months / MONTHS_PER_YEAR) * 100;
    html += `<div class="crop">${cfg.emoji} ${cfg.name}</div>
      <div class="lane">
        <div class="band plant" style="left:${pct(plantStart)}%;width:${pct(plantLen)}%"></div>
        <div class="band harv" style="left:${pct(harvStart)}%;width:${pct(harvLen)}%"></div>
      </div>`;
  }
  grid.innerHTML = html;

  // "You are here" line, positioned over the lanes (offset past the label column).
  const now = document.createElement("div");
  now.id = "cal-now";
  grid.appendChild(now);
}

// ---------------------------------------------------------------------------
// Field drawing (buy land) — click vertices, double-click to close.
// ---------------------------------------------------------------------------
function wireFieldDrawing(map: maplibregl.Map) {
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

  $("btn-field").addEventListener("click", () => {
    mode = "field";
    clearDraft();
    map.doubleClickZoom.disable();
    toast("🚜 Click to place corners — double-click to close the field");
  });

  map.on("click", (e) => {
    if (mode !== "field") return;
    verts.push(toMeters([e.lngLat.lng, e.lngLat.lat]));
    updateDraft();
  });

  map.on("dblclick", () => {
    if (mode !== "field") return;
    // The double-click's two single clicks each pushed the same vertex; drop one.
    verts.pop();
    mode = "none";
    map.doubleClickZoom.enable();
    const boundary = verts.slice();
    clearDraft();
    if (boundary.length < 3) {
      toast("Need at least 3 corners — try again");
      return;
    }
    try {
      const { field, acres, cost } = buyFieldFromBoundary(map, overlay, save, boundary);
      updateHud();
      toast(`🌾 Bought ${acres.toFixed(1)} ac for $${cost.toLocaleString()}`);
      openFieldPanel(field.id);
      refreshFieldsTab();
    } catch (err) {
      toast("❌ " + (err as Error).message, 3500);
    }
  });
}

// ---------------------------------------------------------------------------
// Field selection + the cozy side panel.
// ---------------------------------------------------------------------------
function wireFieldSelection(map: maplibregl.Map) {
  map.on("click", (e) => {
    if (mode !== "none") return;
    const p = toMeters([e.lngLat.lng, e.lngLat.lat]);
    const hit = save.fields.find((f) => pointInPolygon(p, f.boundary));
    if (hit) openFieldPanel(hit.id);
    else closeFieldPanel();
  });
  $("fp-close").addEventListener("click", closeFieldPanel);

  ($("fp-auto") as HTMLInputElement).addEventListener("change", (e) => {
    const field = save.fields.find((f) => f.id === selectedFieldId);
    if (!field) return;
    field.autoManage = (e.target as HTMLInputElement).checked;
    if (field.autoManage) {
      // Act immediately rather than waiting for the next tick, so flipping the
      // switch feels responsive.
      autoManageField(save, field, clock.time());
      renderField(mapRef, overlay, field, clock.time());
      updateHud();
      toast(`🤖 ${prettyId(field.id)} will manage itself — plow, plant, harvest`);
    } else {
      toast(`🖐️ ${prettyId(field.id)} is back to manual control`);
    }
    refreshFieldPanel(true);
  });

  $("fp-sell").addEventListener("click", () => {
    const field = save.fields.find((f) => f.id === selectedFieldId);
    if (!field) return;
    const refund = field.purchaseCost ?? Math.round(areaAcres(field.boundary) * gameConfig.landPricePerAcre);
    if (!confirm(`Sell ${prettyId(field.id)} for $${refund.toLocaleString()}?`)) return;
    try {
      const { refund: paid } = sellField(mapRef, overlay, save, field.id);
      updateHud();
      toast(`💰 Sold ${prettyId(field.id)} for $${paid.toLocaleString()}`);
      closeFieldPanel();
      refreshFieldsTab();
    } catch (err) {
      toast("❌ " + (err as Error).message, 3500);
    }
  });
}

function openFieldPanel(fieldId: string) {
  selectedFieldId = fieldId;
  $("fieldpanel").style.display = "block";
  refreshFieldPanel();
}

function closeFieldPanel() {
  selectedFieldId = null;
  $("fieldpanel").style.display = "none";
}

function fieldMsg(text: string) {
  $("fp-msg").textContent = text;
}

/** Rebuild the panel contents from the selected field's current state. */
let lastPanelKey = "";
function refreshFieldPanel(force = false) {
  const field = save.fields.find((f) => f.id === selectedFieldId);
  if (!field) return closeFieldPanel();
  const now = clock.time();
  const acres = areaAcres(field.boundary);

  // Skip the rebuild when nothing visible changed — replacing buttons under the
  // player's cursor twice a second makes them unclickable. Growth/harvest progress
  // is bucketed to 1% so live bars still animate.
  const auto = !!field.autoManage;
  const key = [
    field.id, field.status, isHarvesting(field), auto,
    Math.round(growthProgress(field, now) * 100),
    Math.round(((field.harvestedAcres ?? 0) / acres) * 100),
    dateOf(now).month, // planting windows open/close on month boundaries
    Math.round(save.money), // affordability of input costs
  ].join("|");
  if (!force && key === lastPanelKey) return;
  lastPanelKey = key;

  $("fp-title").textContent = "🌾 " + prettyId(field.id);
  $("fp-sub").textContent = `${acres.toFixed(1)} acres`;
  const badge = $("fp-status");
  badge.textContent = isHarvesting(field) ? "harvesting" : field.status;
  ($("fp-auto") as HTMLInputElement).checked = auto;

  const refund = field.purchaseCost ?? Math.round(acres * gameConfig.landPricePerAcre);
  const sellBtn = $("fp-sell") as HTMLButtonElement;
  sellBtn.textContent = `💰 Sell Field · $${refund.toLocaleString()}`;
  sellBtn.disabled = isHarvesting(field);
  sellBtn.title = isHarvesting(field) ? "Can't sell while it's mid-harvest" : "";

  const body = $("fp-body");
  const actions = $("fp-actions");
  body.innerHTML = "";
  actions.innerHTML = "";

  if (field.status === "stubble" || field.status === "harvested") {
    // --- Plow first (§10 lifecycle: stubble → tilled → planted) ---
    const cost = Math.round(acres * gameConfig.plowCostPerAcre);
    if (auto) {
      body.innerHTML = `<div class="auto-note">🤖 Waiting to plow (needs $${cost.toLocaleString()})…</div>`;
    } else {
      body.innerHTML = `<div class="small" style="margin-top:8px">Plow to prepare for planting.</div>`;
      const btn = document.createElement("button");
      btn.className = "primary";
      btn.innerHTML = `🚜 Plow <span class="small">$${cost.toLocaleString()}</span>`;
      btn.addEventListener("click", () => {
        try {
          plow(save, field);
          renderField(mapRef, overlay, field, clock.time());
          updateHud();
          fieldMsg("");
          toast("🚜 Field plowed!");
          refreshFieldPanel(true);
        } catch (err) {
          fieldMsg((err as Error).message);
        }
      });
      actions.appendChild(btn);
    }
  } else if (field.status === "tilled") {
    if (auto) {
      body.innerHTML = `<div class="auto-note">🤖 Waiting for a planting window…</div>`;
    } else {
      // --- Plant chooser ---
      body.innerHTML = `<div class="small" style="margin-top:8px">Plant a crop:</div>`;
      const row = document.createElement("div");
      row.className = "cropbtns";
      for (const cropId of Object.keys(gameConfig.crops) as CropId[]) {
        const cfg = gameConfig.crops[cropId];
        const cost = Math.round(acres * cfg.inputCostPerAcre);
        const btn = document.createElement("button");
        const open = inPlantingWindow(cropId, now);
        btn.innerHTML = `${cfg.emoji} ${cfg.name}<br><span class="small">$${cost.toLocaleString()}</span>`;
        if (!open) {
          btn.disabled = true;
          btn.title = `Plant in ${cfg.plantMonths.map((mo) => MONTH_SHORT[mo]).join("–")}`;
          btn.style.opacity = "0.45";
        }
        btn.addEventListener("click", () => {
          try {
            plant(save, field, cropId, now);
            renderField(mapRef, overlay, field, clock.time());
            updateHud();
            fieldMsg("");
            toast(`${cfg.emoji} ${cfg.name} planted!`);
            refreshFieldPanel();
          } catch (err) {
            fieldMsg((err as Error).message);
          }
        });
        row.appendChild(btn);
      }
      body.appendChild(row);
      const windows = (Object.keys(gameConfig.crops) as CropId[])
        .map((c) => `${gameConfig.crops[c].emoji} ${gameConfig.crops[c].plantMonths.map((mo) => MONTH_SHORT[mo]).join("–")}`)
        .join("   ");
      body.insertAdjacentHTML("beforeend", `<div class="small">${windows}</div>`);
    }
  } else if (field.crop) {
    // --- Growing / ready / harvesting ---
    const cfg = gameConfig.crops[field.crop];
    const progress = growthProgress(field, now);
    const range = yieldRange(field, now);

    let html = `<div style="margin-top:8px">${cfg.emoji} <b>${cfg.name}</b></div>`;
    if (!isHarvesting(field)) {
      html += `<div class="small">Growth</div>
        <div class="progress"><div class="fill" style="width:${(progress * 100).toFixed(0)}%"></div></div>`;
    }
    if (range) {
      const uMax = cfg.baseYieldTonsPerAcre * (1 + cfg.yieldUncertainty) * 1.05;
      const l = (range.low / uMax) * 100;
      const w = ((range.high - range.low) / uMax) * 100;
      html += `<div class="small">Est. yield (narrows over the season)</div>
        <div class="rangebar"><div class="band" style="left:${l}%;width:${Math.max(2, w)}%"></div></div>
        <div class="small">${(range.low * acres).toFixed(0)}–${(range.high * acres).toFixed(0)} t total</div>`;
    }
    if (isHarvesting(field)) {
      const done = ((field.harvestedAcres ?? 0) / acres) * 100;
      html += `<div class="small" style="margin-top:6px">Harvesting… 🚜</div>
        <div class="progress"><div class="fill" style="width:${done.toFixed(0)}%"></div></div>`;
    }
    body.innerHTML = html;

    if (field.status === "ready" && !isHarvesting(field)) {
      if (auto) {
        body.insertAdjacentHTML("beforeend", `<div class="auto-note">🤖 Harvesting will start automatically…</div>`);
      } else {
        const btn = document.createElement("button");
        btn.className = "primary";
        btn.textContent = "🚜 Harvest";
        btn.addEventListener("click", () => {
          try {
            startHarvest(field, clock.time());
            fieldMsg("");
            toast("🚜 Harvest started!");
            refreshFieldPanel();
          } catch (err) {
            fieldMsg((err as Error).message);
          }
        });
        actions.appendChild(btn);
      }
    }
  }
}

function prettyId(id: string): string {
  return id.replace("-", " ").replace(/^\w/, (c) => c.toUpperCase());
}

main().catch((err) => {
  devStatus("status-naip", "Failed to load county: " + (err as Error).message, "err");
  console.error(err);
});
