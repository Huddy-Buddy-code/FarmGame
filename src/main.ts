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
import { areaAcres, pointInPolygon, nearestPointOnPolygon, centroidOf } from "./geo/geometry";
import { naipSource } from "./map/naip";
import { addRoadsLayer } from "./map/roadsLayer";
import { OverlayEngine } from "./map/overlay";
import { newGame } from "./state/saveState";
import type { SaveState, Field, Building, BuildingKind } from "./state/saveState";
import { buyFieldFromBoundary, renderField, initIdCounters, sellField, hashSeed } from "./field/fields";
import { drawFieldTexture } from "./field/fieldRender";
import { updateBuildingMarkers, BUILDING_ICON } from "./field/buildingRender";
import {
  buyBuildingAt, sellBuilding, buildingPrice, buildingDisplayName, initBuildingIdCounters,
  BUILDING_NAME, siloCapacityForCrop, siloCapacityOf, assignSiloCrop,
  barnSlotTotal, nearestFarmYard,
  baleStorageCapacityOf, storedBalesTotal, assignBaleStorageProduct,
} from "./sim/buildings";
import { distanceAtWork } from "./sim/coverage";
import type { CoveragePath } from "./sim/coverage";
import {
  persistGame, loadGame, ensureActiveFarm, listFarms, createFarm,
  switchFarm, deleteFarm, getActiveFarmId, loadGameFor,
} from "./state/persistence";
import type { PersistedGame } from "./state/persistence";
import { sellGrain, sellBales, netWorth, baleInventory, sellBalesOfProduct, sellStoredBalesFrom } from "./sim/economy";
import { SimClock } from "./sim/clock";
import {
  formatDate, dateOf, MONTH_NAMES, MONTH_SHORT,
  START_MONTH, MONTHS_PER_YEAR, MINUTES_PER_DAY,
  getDaysPerMonth, setDaysPerMonth, minutesPerMonth, nextMonthStart,
} from "./sim/calendar";
import {
  tickFarming, growthProgress, yieldRange, productivityMultiplier, inPlantingWindow, canPlow,
  hasStandingCrop, inWeedingWindow, canFertilizeNow, isPerennial, canSeedPerennial,
  isPerennialDormant,
} from "./sim/farming";
import {
  ensureAgents, initTaskIds, enqueueTask, cancelTask, taskCost, tasksFor,
  isFieldHarvesting, effectiveStatus, tickTasks, autoManageAll, autoManageField,
  buyAgent, sellAgent, buyImplement, sellImplement, attachImplement, detachImplement,
  agentPrice, implementPrice, canPull, implementName, getCoveragePath,
  reorderTask, estimateTaskHours, forageDue, defaultPlan, forcePlow,
  harvesterCapacityTons, grainTrailerCapacityTons, setHarvesterCrop, setRoadNetwork, TASK_IMPLEMENT,
  appendCompletedTask, haySpikesCapacityBales, baleTrailerCapacityBales, queueHaulBales, fieldHasLooseBales,
} from "./sim/tasks";
import { buildRoadNetwork } from "./sim/roadNet";
import type { RoadNetwork } from "./sim/roadNet";
import { defaultAccessPoints } from "./sim/access";
import {
  MACHINE_ICON, IMPLEMENT_ICON_SVG, tractorIconSvg, combineIconSvg, baleIconSvg,
  plowIconSvg, planterIconSvg, sprayerIconSvg, rakeIconSvg, balerIconSvg, grainTrailerIconSvg,
  grainHeaderIconSvg, mowerIconSvg, haySpikesIconSvg, baleTrailerIconSvg,
} from "./ui/icons";
import type { EquipmentKind, ImplementKind } from "./sim/tasks";
import {
  tickLoans, borrowOpen, paydownOpen, paydownLoan, refinanceLoan,
} from "./sim/finance";
import {
  CASHFLOW_CATEGORIES, CASHFLOW_LABEL, categoryTotal, netCashflow, ledgerYears,
} from "./sim/ledger";
import type { FarmTask, Agent, Implement, FieldStatus, TaskType, CompletedTask } from "./state/saveState";
import { gameConfig } from "./config/gameConfig";
import type { CropId, EquipmentSize, BaleProduct } from "./config/gameConfig";

// Which county to play. Later this comes from a save / county picker.
const COUNTY_ID = "story-ia";

// Multi-farm saves (maintainer request, 2026-07-13): exactly one farm is
// "active" at a time — everything below talks to THAT farm's save, same as
// the old single-slot behavior. The Settings tab creates/loads/deletes farms
// by switching which one is active and reloading the page (see wireSettingsTab).
ensureActiveFarm();

// Load the persisted game if there is one; otherwise start fresh. The game
// auto-saves (see wirePersistence), so refreshes drop you where you were.
const loaded = loadGame();
const save: SaveState = loaded?.save ?? newGame();
const clock = new SimClock();
if (loaded) {
  clock.setTime(loaded.clockNow);
  initIdCounters(save);
  if (loaded.daysPerMonth) setDaysPerMonth(loaded.daysPerMonth);
  // Pre-task-queue saves: give them the new arrays, and turn any legacy
  // mid-harvest markers into queued harvest tasks so the combine resumes them.
  save.tasks ??= [];
  save.agents ??= [];
  save.implements ??= [];
  save.buildings ??= [];
  // Pre-perennial saves: the grain bin gained grass/alfalfa keys (0 tons — they
  // never bank grain anyway, but the record must have every crop key).
  save.grain.grass ??= 0;
  save.grain.alfalfa ??= 0;
  save.completedTasks ??= [];
  initBuildingIdCounters(save);
  // Pre-finance saves: start the open borrowing year at whatever campaign
  // year the save was loaded at (tickLoans self-corrects instantly either
  // way, since a year with $0 pending never creates a loan).
  save.finance ??= { openYear: dateOf(loaded.clockNow).year, pendingPrincipal: 0, loans: [] };
  initTaskIds(save);
  for (const id of loaded.harvestingIds ?? []) {
    const f = save.fields.find((x) => x.id === id);
    if (f && !tasksFor(save, id, "harvest").length) {
      save.tasks.push({
        id: `task-legacy-${id}`, type: "harvest", fieldId: id,
        totalAcres: areaAcres(f.boundary), doneAcres: f.harvestedAcres ?? 0,
        status: "queued", costPaid: 0,
      });
    }
  }
}

// Only one map interaction is active at a time.
type Mode = "none" | "field" | `building:${BuildingKind}`;
let mode: Mode = "none";
/** Size armed for the NEXT silo placement (set by the Buildings shop button
 * just before `mode` becomes "building:silo"; ignored for every other kind). */
let pendingSiloSize: EquipmentSize = "small";

let overlay: OverlayEngine;
let mapRef: maplibregl.Map;
let roadNetRef: RoadNetwork | null = null;
let selectedFieldId: string | null = null;
/** Where new machines park (county center / farmstead-to-be), in UTM meters. */
let homePos: Meters = [0, 0];

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
  // Seed the starting fleet (tractor + combine) parked at the county center —
  // the farmstead-to-be. Also upgrades pre-agent saves. New purchases park here too.
  homePos = toMeters(m.center as LngLat);
  ensureAgents(save, homePos);
  // Machines navigate the county's real road graph between jobs (brief §9).
  roadNetRef = buildRoadNetwork(county.roads, (p) => toMeters(p));
  setRoadNetwork(roadNetRef);
  // Backfill gates for fields from saves that predate access points.
  for (const f of save.fields) {
    if (!f.accessPoints || f.accessPoints.length < 2) f.accessPoints = defaultAccessPoints(f.boundary, roadNetRef);
  }
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
    wireBuildingPlacement(map);
    wireFieldSelection(map);
    wireFieldHover(map);
    wireTimeControls();
    buildCropCalendar();
    wireInventory();
    wireFieldsTab();
    wireEquipTab();
    wireStructuresTab();
    wireFinanceTab();
    wireSettingsTab();
    wirePersistence();
    // Re-render every field from the loaded save (textures + outlines).
    for (const f of save.fields) renderField(map, overlay, f, clock.time());
    updateAgentMarkers();
    refreshBuildingMarkers();
    refreshQueuePanel();
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
  maybeAutoSkipMonth();

  requestAnimationFrame(gameLoop);
}

/** Advance farming + fieldwork from the clock's previous time to now; repaint
 * changed fields, move the machines, and toast what the agents did. */
function tickWorld(prev: number) {
  const now = clock.time();
  const dt = now - prev;
  if (dt <= 0) return;
  const { changed } = tickFarming(save, now);
  // Auto-managed fields queue their next job BEFORE agents tick, so freshly
  // queued work can start the same tick.
  autoManageAll(save, now);
  const work = tickTasks(save, now, dt);
  tickLoans(save, now); // lock in a turned-over year, charge due monthly payments
  const allChanged = [...changed, ...work.changed];
  for (const f of allChanged) renderField(mapRef, overlay, f, now);
  repaintGrowthStages(now, allChanged);
  for (const ev of work.events) toastTaskEvent(ev.task, ev.agent, ev.kind);
  updateReveals();
  updateAgentMarkers();
  // Refresh UI ~2×/s (or instantly when a status flipped). Rebuilding the field
  // panel every frame would recreate its buttons under the player's cursor.
  const rt = performance.now();
  if (allChanged.length || work.events.length || rt - lastUiRefresh > 500) {
    lastUiRefresh = rt;
    updateHud();
    if (selectedFieldId) refreshFieldPanel();
    refreshFieldsTab();
    refreshEquipTab();
    refreshStructuresTab();
    refreshFinanceTab();
    refreshInventory();
    refreshQueuePanel();
  }
}

/**
 * Growing fields change look WITHIN a status (young rows → closed canopy), so we
 * repaint whenever a field crosses a growth-stage bucket (12 per season), not
 * just on status flips. Per-field canvases make this cheap.
 */
const paintedStage = new Map<string, number>();
// Last-painted winter-dormancy state per perennial field, so we repaint the
// brown/green flip at the Dec 1 / Mar 1 season boundaries (the status stays
// "growing" across those, so the stage-bucket check alone wouldn't catch it).
const paintedDormant = new Map<string, boolean>();
function repaintGrowthStages(now: number, alreadyPainted: { id: string }[]) {
  const done = new Set(alreadyPainted.map((f) => f.id));
  for (const f of save.fields) {
    if (done.has(f.id)) continue;
    // Perennial dormancy flip (any status) → repaint the browned/green texture.
    if (isPerennial(f.crop)) {
      const dormant = isPerennialDormant(f, now);
      if (paintedDormant.get(f.id) !== dormant) {
        paintedDormant.set(f.id, dormant);
        renderField(mapRef, overlay, f, now);
        continue;
      }
    }
    if (f.status !== "growing") continue;
    const bucket = Math.floor(growthProgress(f, now) * 12);
    if (paintedStage.get(f.id) !== bucket) {
      paintedStage.set(f.id, bucket);
      renderField(mapRef, overlay, f, now);
    }
  }
}

// ---------------------------------------------------------------------------
// Agents on the map + the work-queue panel (right side).
// ---------------------------------------------------------------------------
// Toasts are plain text (toast() sets textContent), so they keep a small emoji
// fallback; every rendered UI icon (map dots, queue rows, equipment panel) uses
// the SVGs below instead — a classic big-tractor/combine silhouette in the
// game's own cozy palette, not a real manufacturer's colors/logo.
const AGENT_EMOJI: Record<string, string> = { tractor: "🚜", harvester: "🌾" };

// Realistic side-profile machinery SVGs live in ui/icons.ts (maintainer
// request, 2026-07-12) — one shared set for map dots, panels, and the shop.
const AGENT_ICON = MACHINE_ICON;

/** Human verb for a task, present participle ("plowing Field 1"). */
function taskVerb(task: FarmTask): string {
  if (task.type === "plow") return "plowing";
  if (task.type === "plant") {
    const c = task.crop ? gameConfig.crops[task.crop] : null;
    return c ? `planting ${c.name.toLowerCase()}` : "planting";
  }
  if (task.type === "mow") return "mowing";
  if (task.type === "weed") return "weeding";
  if (task.type === "fertilize") return "fertilizing";
  if (task.type === "rake") return "raking";
  if (task.type === "bale") return "baling";
  if (task.type === "unloadHarvester") return "hauling grain";
  if (task.type === "haulBales") return "hauling bales";
  return "harvesting";
}

function toastTaskEvent(task: FarmTask, agent: Agent, kind: "started" | "finished"): void {
  const emoji = AGENT_EMOJI[agent.kind] ?? "🚜";
  const where = prettyId(task.fieldId);
  if (kind === "started") toast(`${emoji} ${agent.name} is heading out — ${taskVerb(task)} ${where}`);
  else toast(`✅ ${agent.name} finished ${taskVerb(task)} ${where}`);
}

/** One marker per agent, moved (not recreated) every frame. */
const agentMarkers = new Map<string, maplibregl.Marker>();

/** ⚠️ badge condition (maintainer request, 2026-07-12): the tractor whose
 * active job is a stuck unload, or the harvester that unload is servicing. */
function isAgentWaitingForSilo(agent: Agent): boolean {
  if (agent.kind === "tractor") {
    const task = agent.taskId ? save.tasks.find((t) => t.id === agent.taskId) : undefined;
    return !!task && task.type === "unloadHarvester" && !!task.waitingForSilo;
  }
  if (agent.kind === "harvester") {
    return !!save.tasks.find((t) => t.type === "unloadHarvester" && t.harvesterAgentId === agent.id && t.waitingForSilo);
  }
  return false;
}

function updateAgentMarkers(): void {
  if (!mapRef) return;
  for (const agent of save.agents) {
    let marker = agentMarkers.get(agent.id);
    if (!marker) {
      // IMPORTANT: MapLibre positions the marker by writing `transform` on the
      // ROOT element, so none of our CSS may touch the root's transform. The
      // bounce and the heading rotation therefore live on nested children:
      //   .agent-dot (root, MapLibre's transform) > .agent-bob (bounce) > .agent-glyph (heading)
      const el = document.createElement("div");
      el.className = "agent-dot";
      el.title = agent.name;
      const bob = document.createElement("span");
      bob.className = "agent-bob";
      const glyph = document.createElement("span");
      glyph.className = "agent-glyph";
      glyph.innerHTML = (AGENT_ICON[agent.kind] ?? tractorIconSvg)(20);
      bob.appendChild(glyph);
      el.appendChild(bob);
      marker = new maplibregl.Marker({ element: el }).setLngLat(toLngLat(agent.pos)).addTo(mapRef);
      agentMarkers.set(agent.id, marker);
    } else {
      marker.setLngLat(toLngLat(agent.pos));
    }
    const el = marker.getElement();
    el.classList.toggle("working", agent.state === "working");
    el.classList.toggle("warn", isAgentWaitingForSilo(agent));
    // Point the glyph along the driving heading. The SVGs are drawn facing WEST,
    // and screen-y points down while meters-north points up, so aligning to travel
    // is a rotation of (π − heading). But that rolls the icon 180° upside-down when
    // driving east — so instead of rotating past vertical, we MIRROR it horizontally
    // (scaleX) and keep it upright. Machines mostly run east↔west, so this reads as
    // "the tractor turned around," not "flipped over."
    const glyph = el.querySelector<HTMLElement>(".agent-glyph");
    if (glyph && agent.heading !== undefined) {
      let a = Math.atan2(Math.sin(Math.PI - agent.heading), Math.cos(Math.PI - agent.heading)); // (−π, π]
      let sx = 1;
      if (Math.abs(a) > Math.PI / 2) {
        a -= Math.sign(a) * Math.PI; // bring rotation back within ±90°…
        sx = -1; // …and mirror instead, so the icon stays upright
      }
      glyph.style.transform = `rotate(${a}rad) scaleX(${sx})`;
    }
  }
  // Tear down markers for machines that were sold.
  for (const [id, marker] of agentMarkers) {
    if (!save.agents.some((a) => a.id === id)) {
      marker.remove();
      agentMarkers.delete(id);
    }
  }
  updateBaleMarkers();
}

// ---------------------------------------------------------------------------
// Bale markers: physical bales, each drawn at the exact spot the baler dropped it
// (field.baleLocations). They accumulate live as the baler works and persist
// until sold. Markers are appended incrementally as bales drop (no rebuild churn);
// only a truly enormous field is subsampled, and then EVENLY so coverage stays
// uniform rather than dropping the last-worked corner.
// ---------------------------------------------------------------------------
const MAX_BALE_MARKERS = 600; // per-field perf ceiling; real fields sit well under this

function makeBaleMarker(p: Meters, color: "hay" | "alfalfa"): maplibregl.Marker {
  const el = document.createElement("div");
  el.className = "bale-dot";
  el.innerHTML = baleIconSvg(14, color);
  return new maplibregl.Marker({ element: el }).setLngLat(toLngLat(p)).addTo(mapRef!);
}

/** The bale marker tint for a field, from its product (hay/corn = light brown,
 * alfalfa = green). */
function baleColorOf(field: Field): "hay" | "alfalfa" {
  return gameConfig.baleProducts[field.baleProduct ?? "cornStover"].color;
}

/** Markers for a field's bales — all of them, or an EVEN subsample if a field
 * somehow tops the ceiling (uniform coverage, never a bare last corner). */
function baleMarkersFor(locs: Meters[], color: "hay" | "alfalfa"): maplibregl.Marker[] {
  if (locs.length <= MAX_BALE_MARKERS) return locs.map((p) => makeBaleMarker(p, color));
  const out: maplibregl.Marker[] = [];
  for (let i = 0; i < MAX_BALE_MARKERS; i++) out.push(makeBaleMarker(locs[Math.floor((i * locs.length) / MAX_BALE_MARKERS)]!, color));
  return out;
}

// `count` = how many baleLocations the markers currently represent.
const baleMarkers = new Map<string, { count: number; markers: maplibregl.Marker[] }>();

function updateBaleMarkers(): void {
  if (!mapRef) return;
  const wanted = new Set<string>();
  for (const field of save.fields) {
    const locs = field.baleLocations ?? [];
    if (locs.length === 0) continue;
    wanted.add(field.id);
    const color = baleColorOf(field);
    const existing = baleMarkers.get(field.id);
    if (existing && existing.count === locs.length) continue; // no change
    if (!existing) {
      baleMarkers.set(field.id, { count: locs.length, markers: baleMarkersFor(locs, color) });
    } else if (locs.length > existing.count && locs.length <= MAX_BALE_MARKERS) {
      // Common case while baling: just add markers for the NEW drops.
      for (let i = existing.count; i < locs.length; i++) existing.markers.push(makeBaleMarker(locs[i]!, color));
      existing.count = locs.length;
    } else {
      // Shrank (some sold), or crossed the subsample ceiling — rebuild.
      for (const m of existing.markers) m.remove();
      baleMarkers.set(field.id, { count: locs.length, markers: baleMarkersFor(locs, color) });
    }
  }
  // Drop markers for fields that were sold or had their bales sold.
  for (const [id, entry] of baleMarkers) {
    if (!wanted.has(id)) {
      for (const m of entry.markers) m.remove();
      baleMarkers.delete(id);
    }
  }
}

// ---------------------------------------------------------------------------
// The fieldwork REVEAL (brief §10): as a machine drives the coverage path, the
// NEW texture (tilled / seeded / cut stubble) appears strip-by-strip behind it.
// We bake the target texture once into an offscreen canvas, then blit only the
// swept strips onto the field's live surface — cheap, and pixel-identical to the
// final full repaint so there's no "pop" when the job finishes.
// ---------------------------------------------------------------------------
const ACRE_M2 = 4046.8564224;

interface Reveal {
  taskId: string;
  fieldId: string;
  baked: HTMLCanvasElement;
  /** How far along the route (full-route meters) we've stamped so far. */
  lastDist: number;
  /** performance.now() of the last GPU upload — uploads are throttled (a
   * 0.5 m/px field canvas is megabytes; re-uploading it every frame while a
   * machine worked was the main source of sustained stutter). */
  lastUpload: number;
}

/** Min real-ms between GPU uploads of a revealing surface (~8/s reads as
 * continuous; the strips themselves are still stamped every tick). */
const REVEAL_UPLOAD_MS = 120;
// Keyed by TASK id — a single field can carry TWO concurrent reveals at once:
// the rake laying windrows and the baler laying mulch behind it.
const reveals = new Map<string, Reveal>();

function revealTargetStatus(task: FarmTask, field: Field): FieldStatus {
  if (task.type === "plow") return "tilled";
  if (task.type === "plant") return "planted";
  // Baling a perennial leaves it regrowing (green), not mulched like corn —
  // reveal that so there's no pop when the field repaints on completion.
  if (task.type === "bale") return isPerennial(field.crop) ? "growing" : "mulched";
  if (task.type === "weed" || task.type === "fertilize") return field.status; // same status, different overlay
  return "harvested"; // harvest + mow both cut to bare/cut ground
}

/** Task types whose completion actually changes the field's texture — the only
 * ones worth the reveal-stamping treatment. Weeding bakes the SAME status with
 * the weed overlay off (sprayer cleans strip-by-strip); fertilizing bakes it
 * ~20% darker (wet liquid spray, dries off next month); mowing cuts the sward. */
const REVEALS_TEXTURE: ReadonlySet<TaskType> = new Set(["plow", "plant", "harvest", "mow", "rake", "bale", "weed", "fertilize"]);

function updateReveals(): void {
  if (!overlay) return;
  const activeTasks = save.tasks.filter((t) => t.status === "active" && REVEALS_TEXTURE.has(t.type));
  const activeIds = new Set(activeTasks.map((t) => t.id));

  // Drop reveals whose task ended — with one final upload so the last stamped
  // strips aren't lost (a finished rake gets no completion repaint).
  for (const [tid, r] of reveals) {
    if (!activeIds.has(tid)) {
      reveals.delete(tid);
      overlay.get(r.fieldId)?.markDirty();
    }
  }

  // Iterate in task order (rake enqueued before baler) so, where the baler has
  // caught up to ground the rake already windrowed, its mulch stamp lands AFTER
  // — and on top of — the windrows on the shared surface.
  for (const task of activeTasks) {
    const agent = save.agents.find((a) => a.id === task.agentId);
    if (!agent || agent.state !== "working") continue; // reveal only while working
    const path = getCoveragePath(save, task);
    const field = save.fields.find((f) => f.id === task.fieldId);
    const surface = overlay.get(task.fieldId);
    if (!path || !field || !surface) continue;

    let r = reveals.get(task.id);
    if (!r) {
      const baked = document.createElement("canvas");
      baked.width = surface.canvas.width;
      baked.height = surface.canvas.height;
      const bctx = baked.getContext("2d");
      if (!bctx) continue;
      drawFieldTexture(bctx, baked.width, baked.height, (mtr) => surface.toPixel(mtr), field.boundary, {
        status: revealTargetStatus(task, field),
        crop: field.crop,
        // Weeding/fertilizing repaint the crop AS IT IS (weeds off / spray
        // darkened); a perennial being baled reveals its regrowth green;
        // everything else reveals a fresh post-work surface (progress 0).
        progress:
          task.type === "weed" || task.type === "fertilize"
            ? growthProgress(field, clock.time())
            : task.type === "bale" && isPerennial(field.crop)
              ? growthProgress(field, clock.time())
              : 0,
        // Fertilizing doesn't clear weeds — keep them under the wet sheen.
        weedy: task.type === "fertilize" ? !!field.weedy : false,
        fertilized: task.type === "fertilize",
        // Raking reveals windrows over the harvested surface strip-by-strip; the
        // baler then reveals clean/mulched over those windrows as it collects.
        windrowed: task.type === "rake",
        seed: hashSeed(task.fieldId),
      });
      r = { taskId: task.id, fieldId: task.fieldId, baked, lastDist: 0, lastUpload: 0 };
      reveals.set(task.id, r);
    }

    // Reveal up to the swept in-field distance implied by how much is done.
    // Stamping is cheap (a few clipped drawImage calls); the GPU upload of the
    // whole canvas is what costs — throttle IT, not the stamping.
    const revealWork = Math.min(path.totalWork, (task.doneAcres * ACRE_M2) / path.swath);
    const revealDist = distanceAtWork(path, revealWork);
    if (revealDist > r.lastDist + 1e-6) {
      stampReveal(surface, r.baked, path, r.lastDist, revealDist);
      r.lastDist = revealDist;
      const rt = performance.now();
      if (rt - r.lastUpload > REVEAL_UPLOAD_MS) {
        r.lastUpload = rt;
        surface.markDirty();
      }
    }
  }
}

/** Blit the baked NEW texture onto `surface` along the route between full-route
 * distances `from` and `to`, one swath-wide strip per in-field lane segment. */
function stampReveal(
  surface: { ctx: CanvasRenderingContext2D; toPixel: (m: Meters) => [number, number] },
  baked: HTMLCanvasElement,
  path: CoveragePath,
  from: number,
  to: number,
): void {
  const ctx = surface.ctx;
  const half = (path.swath / 2) * 1.08; // slight overlap avoids seams between lanes
  for (let i = 0; i < path.pts.length - 1; i++) {
    if (!path.inField[i]) continue;
    const segA = path.cum[i]!;
    const segB = path.cum[i + 1]!;
    const lo = Math.max(from, segA);
    const hi = Math.min(to, segB);
    if (hi <= lo) continue;
    const a = path.pts[i]!;
    const b = path.pts[i + 1]!;
    const p0 = lerpAlong(a, b, segA, segB, lo);
    const p1 = lerpAlong(a, b, segA, segB, hi);
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const px = -dy * half;
    const py = dx * half;
    const quad: Meters[] = [
      [p0[0] + px, p0[1] + py],
      [p1[0] + px, p1[1] + py],
      [p1[0] - px, p1[1] - py],
      [p0[0] - px, p0[1] - py],
    ];
    ctx.save();
    ctx.beginPath();
    quad.forEach((m, k) => {
      const [x, y] = surface.toPixel(m);
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(baked, 0, 0); // baked is transparent outside the field, so safe
    ctx.restore();
  }
}

function lerpAlong(a: Meters, b: Meters, distA: number, distB: number, d: number): Meters {
  const t = distB - distA > 1e-9 ? (d - distA) / (distB - distA) : 0;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** Task id currently being drag-reordered in the Jobs list, if any. */
let draggingTaskId: string | null = null;

function sectionDivider(label: string): HTMLElement {
  const d = document.createElement("div");
  d.className = "qp-sub";
  d.textContent = label;
  return d;
}

/** Display name + working-width/capacity for an implement kind at a size, as
 * TWO separate lines (maintainer request, 2026-07-13): "Plow - Medium" then
 * "10 ft Working Width" — mirrors the equipment-name reorder, "<Kind> - <Size>". */
const IMPLEMENT_KIND_NAME: Record<ImplementKind, string> = {
  plow: "Plow", planter: "Planter", sprayer: "Sprayer", rake: "Rake",
  bailer: "Baler", grainTrailer: "Grain Trailer", mower: "Mower",
  haySpikes: "Hay Spikes", baleTrailer: "Bale Trailer",
};
function implementInfoLines(kind: ImplementKind, size: EquipmentSize): { name: string; detail: string } {
  const name = `${IMPLEMENT_KIND_NAME[kind]} - ${SIZE_LABEL[size]}`;
  if (kind === "grainTrailer") {
    return { name, detail: `${grainTrailerCapacityTons(size)} t Capacity` };
  }
  if (kind === "haySpikes") {
    return { name, detail: `${haySpikesCapacityBales(size)} bale capacity` };
  }
  if (kind === "baleTrailer") {
    return { name, detail: `${baleTrailerCapacityBales(size)} bale capacity` };
  }
  return { name, detail: `${gameConfig.equipment[kind][size].widthFt} ft Working Width` };
}

const IMPLEMENT_QUEUE_ICON_PX = 36;

/**
 * The IMPLEMENT row for an active task's Work Queue box (maintainer request,
 * 2026-07-13) — a second line under the existing name/sub/progress, still
 * inside the same bordered box, showing the tool actually doing the work
 * (as opposed to the tractor/combine icon already shown at the row's left),
 * a plain-English info line ("Plow - Medium, 10 ft Working Width"), and —
 * for Combine/Baler/Grain Wagon, the three that fill up with something as
 * the job runs — a fill bar labeled with the current amount + percent, plus
 * the total off to the right. Empty string for queued tasks (no agent/
 * implement committed yet) or a task type with no implement of its own.
 */
function implementRowHtml(task: FarmTask, agent: Agent | undefined): string {
  if (!agent || task.status !== "active") return "";

  let iconSvg: string;
  let info: { name: string; detail: string };
  let fill: { pct: number; current: string; total: string } | null = null;

  if (task.type === "harvest") {
    const size = agent.size ?? "medium";
    iconSvg = grainHeaderIconSvg(IMPLEMENT_QUEUE_ICON_PX);
    info = { name: `Grain Header - ${SIZE_LABEL[size]}`, detail: `${gameConfig.equipment.harvester[size].widthFt} ft Working Width` };
    const capT = harvesterCapacityTons(size);
    const onboard = agent.grainOnboard ?? 0;
    fill = {
      pct: capT > 0 ? Math.min(100, (onboard / capT) * 100) : 0,
      current: `${onboard.toFixed(1)} t`,
      total: `${capT} t`,
    };
  } else if (task.type === "unloadHarvester") {
    const trailer = save.implements.find((i) => i.attachedTo === agent.id && i.kind === "grainTrailer");
    if (!trailer) return "";
    iconSvg = grainTrailerIconSvg(IMPLEMENT_QUEUE_ICON_PX);
    info = implementInfoLines("grainTrailer", trailer.size);
    const capT = grainTrailerCapacityTons(trailer.size);
    const cargo = trailer.cargoTons ?? 0;
    fill = {
      pct: capT > 0 ? Math.min(100, (cargo / capT) * 100) : 0,
      current: `${cargo.toFixed(1)} t`,
      total: `${capT} t`,
    };
  } else if (task.type === "haulBales") {
    const spikes = save.implements.find((i) => i.attachedTo === agent.id && i.kind === "haySpikes");
    if (!spikes) return "";
    iconSvg = (IMPLEMENT_ICON_SVG.haySpikes ?? plowIconSvg)(IMPLEMENT_QUEUE_ICON_PX);
    info = implementInfoLines("haySpikes", spikes.size);
    const capB = haySpikesCapacityBales(spikes.size);
    const onboard = spikes.cargoBales ?? 0;
    fill = {
      pct: capB > 0 ? Math.min(100, (onboard / capB) * 100) : 0,
      current: `${onboard} bale${onboard === 1 ? "" : "s"}`,
      total: `${capB}`,
    };
  } else if (task.type === "bale") {
    const impl = save.implements.find((i) => i.attachedTo === agent.id && i.kind === "bailer");
    const size = impl?.size ?? "medium";
    iconSvg = balerIconSvg(IMPLEMENT_QUEUE_ICON_PX);
    info = implementInfoLines("bailer", size);
    // The baler's real hopper (like the combine): tons gathered toward the next
    // bale, resetting to 0 each time one ejects. Total = one bale's worth.
    const baleTons = gameConfig.forage.baleTons;
    const cargo = impl?.cargoTons ?? 0;
    fill = {
      pct: baleTons > 0 ? Math.min(100, (cargo / baleTons) * 100) : 0,
      current: `${cargo.toFixed(2)} t`,
      total: `${baleTons} t`,
    };
  } else {
    const kind = TASK_IMPLEMENT[task.type];
    if (!kind) return "";
    const impl = save.implements.find((i) => i.attachedTo === agent.id && i.kind === kind);
    const size = impl?.size ?? "medium";
    iconSvg = (IMPLEMENT_ICON_SVG[kind] ?? plowIconSvg)(IMPLEMENT_QUEUE_ICON_PX);
    info = implementInfoLines(kind, size);
  }

  // The relay's Bale Trailer gets its own row (its fill + what it's doing) so
  // the whole two-machine job is visible, not just the collector's half.
  const trailerExtra =
    task.type === "haulBales" && task.trailerAgentId
      ? implRowForBaleTrailer(task)
      : "";
  return implRow(iconSvg, info, fill) + trailerExtra;
}

/** Wrap one implement into a Work-Queue sub-row (icon + name/detail + optional
 * fill bar). Shared by the collector row and the Bale Trailer row. */
function implRow(iconSvg: string, info: { name: string; detail: string }, fill: { pct: number; current: string; total: string } | null): string {
  const fillHtml = fill
    ? `<div class="impl-fillrow">
        <span class="impl-fill">
          <span class="impl-fill-bar" style="width:${fill.pct.toFixed(0)}%"></span>
          <span class="impl-fill-label">${fill.current} · ${fill.pct.toFixed(0)}%</span>
        </span>
        <span class="impl-total">${fill.total}</span>
      </div>`
    : "";
  return `<div class="qr-impl">
      <span class="impl-icon">${iconSvg}</span>
      <div class="impl-body">
        <div class="impl-name">${info.name}</div>
        <div class="impl-detail">${info.detail}</div>
        ${fillHtml}
      </div>
    </div>`;
}

const TRAILER_PHASE_TEXT: Record<string, string> = {
  toEntrance: "Heading to the field",
  waiting: "Waiting to load",
  toStorage: "Hauling to storage",
  dumping: "Unloading at storage",
};

/** The Bale Trailer's own Work-Queue sub-row for a Haul Bales relay: its bale
 * fill and current phase. */
function implRowForBaleTrailer(task: FarmTask): string {
  const tAgent = save.agents.find((a) => a.id === task.trailerAgentId);
  if (!tAgent) return "";
  const trailer = save.implements.find((i) => i.attachedTo === tAgent.id && i.kind === "baleTrailer");
  if (!trailer) return "";
  const cap = baleTrailerCapacityBales(trailer.size);
  const onboard = trailer.cargoBales ?? 0;
  const base = implementInfoLines("baleTrailer", trailer.size);
  const phase = task.waitingForStorage ? "⚠️ Waiting for storage room" : (TRAILER_PHASE_TEXT[task.trailerPhase ?? "toEntrance"] ?? "");
  const info = { name: `${base.name} · ${tAgent.name}`, detail: phase ? `${base.detail} · ${phase}` : base.detail };
  const fill = {
    pct: cap > 0 ? Math.min(100, (onboard / cap) * 100) : 0,
    current: `${onboard} bale${onboard === 1 ? "" : "s"}`,
    total: `${cap}`,
  };
  return implRow(baleTrailerIconSvg(IMPLEMENT_QUEUE_ICON_PX), info, fill);
}

/** One row in the Jobs list. Active jobs are locked in place (an agent is
 * already committed — reordering them would be meaningless/risky) and show
 * the working machine's icon; queued jobs carry no icon, are drag-reorderable,
 * and get a cancel button. */
function buildQueueRow(task: FarmTask): HTMLElement {
  const isActive = task.status === "active";
  const agent = isActive && task.agentId ? save.agents.find((a) => a.id === task.agentId) : undefined;
  const iconHtml = agent ? `<span class="icon">${(AGENT_ICON[agent.kind] ?? tractorIconSvg)(32)}</span>` : "";

  if (task.type === "unloadHarvester") {
    // Not acres-based — no %/hours estimate; show the phase instead.
    const sub = task.waitingForSilo ? "⚠️ Waiting for silo room" : (UNLOAD_PHASE_TEXT[task.unloadPhase ?? "toHarvester"] ?? "Hauling grain…");
    const row = document.createElement("div");
    row.className = "queue-row" + (isActive ? " active" : " queued") + (task.waitingForSilo ? " warn" : "");
    row.innerHTML = `
      ${iconHtml}
      <span class="qr-info">
        <div class="qr-name">Unload Harvester · ${prettyId(task.fieldId)}</div>
        ${agent ? `<div class="qr-machine">${agent.name}</div>` : ""}
        <div class="qr-sub">${sub}</div>
        ${implementRowHtml(task, agent)}
      </span>`;
    return row; // system task — not draggable/cancelable, it self-regenerates
  }

  if (task.type === "haulBales") {
    // Two-tractor relay, not acres-based — show the collector's leg + how many
    // bales remain in the field. The trailer half (if any) shows its own name.
    const trailerAgent = task.trailerAgentId ? save.agents.find((a) => a.id === task.trailerAgentId) : undefined;
    const remaining = save.fields.find((f) => f.id === task.fieldId)?.baleLocations?.length ?? 0;
    const row = document.createElement("div");
    row.className = "queue-row" + (isActive ? " active" : " queued") + (task.waitingForStorage ? " warn" : "");
    row.innerHTML = `
      ${iconHtml}
      <span class="qr-info">
        <div class="qr-name">Haul Bales · ${prettyId(task.fieldId)}</div>
        ${agent ? `<div class="qr-machine">${agent.name}${trailerAgent ? ` + ${trailerAgent.name}` : ""}</div>` : ""}
        <div class="qr-sub">${haulSubText(task)}${remaining > 0 ? ` · ${remaining} left in field` : ""}</div>
        ${implementRowHtml(task, agent)}
      </span>`;
    return row; // system task — not draggable/cancelable, it self-regenerates
  }

  const hours = estimateTaskHours(save, task);
  const pct = (task.doneAcres / task.totalAcres) * 100;
  const sub = isActive
    ? `${task.totalAcres.toFixed(0)} ac · ${pct.toFixed(0)}% done · ${hours.toFixed(1)}h left`
    : `${task.totalAcres.toFixed(0)} ac · waiting · ~${hours.toFixed(1)}h`;

  const row = document.createElement("div");
  row.className = "queue-row" + (isActive ? " active" : " queued");
  row.innerHTML = `
    ${iconHtml}
    <span class="qr-info">
      <div class="qr-name">${cap(taskVerb(task))} · ${prettyId(task.fieldId)}</div>
      ${agent ? `<div class="qr-machine">${agent.name}</div>` : ""}
      <div class="qr-sub">${sub}</div>
      ${isActive ? `<div class="progress"><div class="fill" style="width:${pct.toFixed(0)}%"></div></div>` : ""}
      ${implementRowHtml(task, agent)}
    </span>`;

  if (!isActive) {
    row.draggable = true;
    row.addEventListener("dragstart", (e) => {
      draggingTaskId = task.id;
      row.classList.add("dragging");
      e.dataTransfer?.setData("text/plain", task.id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    row.addEventListener("dragend", () => {
      draggingTaskId = null;
      row.classList.remove("dragging");
    });
    row.addEventListener("dragover", (e) => {
      if (!draggingTaskId || draggingTaskId === task.id) return;
      e.preventDefault();
      row.classList.add("drag-over");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      row.classList.remove("drag-over");
      if (!draggingTaskId || draggingTaskId === task.id) return;
      try {
        reorderTask(save, draggingTaskId, task.id);
        lastQueueKey = " init";
        refreshQueuePanel();
      } catch (err) {
        toast("❌ " + (err as Error).message, 3500);
      }
    });

    const btn = document.createElement("button");
    btn.className = "qr-cancel";
    btn.textContent = "✕";
    btn.title = task.costPaid > 0 ? `Cancel and refund $${task.costPaid.toLocaleString()}` : "Cancel";
    btn.addEventListener("click", () => {
      try {
        cancelTask(save, task.id);
        updateHud();
        refreshQueuePanel();
        if (selectedFieldId) refreshFieldPanel(true);
        toast(task.costPaid > 0 ? `↩️ Canceled — $${task.costPaid.toLocaleString()} refunded` : "↩️ Canceled");
      } catch (err) {
        toast("❌ " + (err as Error).message, 3500);
      }
    });
    row.appendChild(btn);
  }

  return row;
}

/** Rebuild the right-hand queue panel: Jobs only, split into a locked Active
 * section (machines already committed), a drag-reorderable Queued section
 * (queue order = pickup priority), and a read-only Completed section (this
 * calendar month's finished jobs — maintainer request, 2026-07-14). */
let lastQueueKey = " init";
function refreshQueuePanel(): void {
  const nowDate = dateOf(clock.time());
  // Newest first; scoped to the current calendar month (the log itself is
  // bounded/pruned in tasks.ts, this just narrows what's shown).
  const completed = (save.completedTasks ?? [])
    .filter((ct) => {
      const d = dateOf(ct.completedAt);
      return d.year === nowDate.year && d.month === nowDate.month;
    })
    .slice()
    .reverse();

  // Skip DOM churn when nothing visible changed (1% progress buckets animate).
  // Hopper-style fills (baler/harvester/grain trailer) cycle much faster than
  // a 1% acreage bucket — especially at high sim speed — so their cargoTons
  // must be its own, finer-grained bucket or the fill bar reads stale/desynced.
  const key = save.tasks
    .map((t) => {
      const impl = t.agentId ? save.implements.find((i) => i.attachedTo === t.agentId) : undefined;
      const cargoBucket = impl?.cargoTons !== undefined ? Math.round(impl.cargoTons * 50) : "";
      const bales = (impl?.cargoBales ?? "") + ":" + (save.fields.find((f) => f.id === t.fieldId)?.baleLocations?.length ?? "");
      return `${t.id}:${t.status}:${t.agentId ?? ""}:${Math.round((t.doneAcres / t.totalAcres) * 100)}:${t.unloadPhase ?? ""}:${t.waitingForSilo ?? ""}:${cargoBucket}:${t.haulPhase ?? ""}:${t.trailerPhase ?? ""}:${t.waitingForStorage ?? ""}:${bales}`;
    })
    .join("|") + `#${completed.length}:${nowDate.year}:${nowDate.month}`;
  if (key === lastQueueKey) return;
  lastQueueKey = key;

  const rows = $("queue-rows");
  rows.innerHTML = "";
  if (save.tasks.length === 0 && completed.length === 0) {
    rows.innerHTML = `<div class="queue-empty">No jobs queued — plow, plant, or harvest a field.</div>`;
    return;
  }

  const active = save.tasks.filter((t) => t.status === "active");
  const queued = save.tasks.filter((t) => t.status === "queued");

  if (active.length > 0) {
    rows.appendChild(sectionDivider("Active"));
    for (const task of active) rows.appendChild(buildQueueRow(task));
  }
  if (queued.length > 0) {
    rows.appendChild(sectionDivider("Queued"));
    for (const task of queued) rows.appendChild(buildQueueRow(task));
    // A trailing drop target so a job can be dragged to the back of the queue.
    const tail = document.createElement("div");
    tail.className = "queue-tail";
    tail.addEventListener("dragover", (e) => {
      if (!draggingTaskId) return;
      e.preventDefault();
      tail.classList.add("drag-over");
    });
    tail.addEventListener("dragleave", () => tail.classList.remove("drag-over"));
    tail.addEventListener("drop", (e) => {
      e.preventDefault();
      tail.classList.remove("drag-over");
      if (!draggingTaskId) return;
      try {
        reorderTask(save, draggingTaskId, undefined);
        lastQueueKey = " init";
        refreshQueuePanel();
      } catch (err) {
        toast("❌ " + (err as Error).message, 3500);
      }
    });
    rows.appendChild(tail);
  }
  if (completed.length > 0) {
    rows.appendChild(sectionDivider(`Completed — ${MONTH_SHORT[nowDate.month]}`));
    for (const ct of completed) rows.appendChild(buildCompletedRow(ct));
  }
}

const TASK_PAST_VERB: Record<TaskType, string> = {
  plow: "Plowed", plant: "Planted", harvest: "Harvested", mow: "Mowed",
  weed: "Weeded", fertilize: "Fertilized", rake: "Raked", bale: "Baled",
  unloadHarvester: "Hauled", haulBales: "Hauled bales",
};

/** One compact, non-interactive row per finished job OR sale — sized like a
 * queued row but with no icon/progress bar, just what it produced. */
function buildCompletedRow(ct: CompletedTask): HTMLElement {
  let icon: string;
  let name: string;
  if (ct.type === "sellGrain" || ct.type === "sellBales") {
    icon = "💰";
    const label = ct.label ?? (ct.crop ? gameConfig.crops[ct.crop].name : "Product");
    name = `Sold ${label}` + (ct.fieldId ? ` · ${prettyId(ct.fieldId)}` : "");
  } else {
    icon = "✅";
    const verb = TASK_PAST_VERB[ct.type] ?? cap(ct.type);
    const field = prettyId(ct.fieldId ?? "");
    name = ct.type === "plant" && ct.crop ? `${verb} ${gameConfig.crops[ct.crop].name} · ${field}` : `${verb} · ${field}`;
  }

  const stats: string[] = [];
  if (ct.acres !== undefined) stats.push(`${ct.acres.toFixed(0)} ac`);
  if (ct.bales !== undefined) stats.push(`${ct.bales} bale${ct.bales === 1 ? "" : "s"}`);
  if (ct.tons !== undefined) stats.push(`${ct.tons.toFixed(1)} t`);
  if (ct.costPaid !== undefined && ct.costPaid > 0) stats.push(`<span class="amt-neg">-$${round100(ct.costPaid).toLocaleString()}</span>`);
  if (ct.revenue !== undefined && ct.revenue > 0) stats.push(`<span class="amt-pos">+$${round100(ct.revenue).toLocaleString()}</span>`);

  const row = document.createElement("div");
  row.className = "queue-row completed";
  row.innerHTML = `
    <span class="icon">${icon}</span>
    <span class="qr-info">
      <div class="qr-name">${name}</div>
      ${ct.agentName ? `<div class="qr-machine">${ct.agentName}</div>` : ""}
      <div class="qr-sub">${stats.join(" · ")}</div>
    </span>`;
  return row;
}

/** Log a grain/bale sale into the same Completed log as finished field-work
 * tasks (maintainer request, 2026-07-14) — a sale isn't a `FarmTask`, so it's
 * recorded directly here rather than via `sim/tasks.ts`'s completion path. */
let saleLogSeq = 0;
function logSale(type: "sellGrain" | "sellBales", entry: Omit<CompletedTask, "id" | "type" | "completedAt">): void {
  appendCompletedTask(save, { id: `sale-${++saleLogSeq}`, type, completedAt: clock.time(), ...entry });
  lastQueueKey = " init";
  refreshQueuePanel();
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Round to the nearest $100 for DISPLAY only (maintainer request, 2026-07-14
 * — the Work Queue, Finance, and header panels all read noisy to the dollar;
 * the underlying save-state numbers stay exact, only the on-screen text
 * coarsens). */
function round100(n: number): number {
  return Math.round(n / 100) * 100;
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------
function updateHud() {
  $("hud-date").textContent = formatDate(clock.time());
  $("hud-cash").textContent = "$" + round100(save.money).toLocaleString();
  $("hud-networth").textContent = "$" + round100(netWorth(save).total).toLocaleString();
  const totalGrain = Object.values(save.grain).reduce((sum, t) => sum + t, 0);
  $("hud-grain").textContent = totalGrain.toFixed(1) + " t";

  // Year-position marker: fraction of the display year (Mar → Feb) elapsed.
  const f = yearFraction(clock.time());
  $("year-marker").style.left = `calc(${(f * 100).toFixed(2)}% - 1px)`;
  // The calendar grid has a 110px label column; the lanes take the rest.
  const calNow = document.getElementById("cal-now");
  if (calNow) calNow.style.left = `calc(${(110 * (1 - f)).toFixed(1)}px + ${(f * 100).toFixed(2)}%)`;
  // Live current-month chip riding the same position (maintainer request,
  // 2026-07-14) — "Jun.", "Oct.", etc.
  placeChip($("month-marker"), `${MONTH_SHORT[dateOf(clock.time()).month]}.`, f);

  // Day-position marker: a live clock-time chip riding the workday track
  // (6am = 0, 6pm = 1). No night is modeled (maintainer request, 2026-07-14)
  // — replaced the old always-on sun emoji with the actual rounded hour.
  const df = dayFraction(clock.time());
  placeChip($("day-marker"), hourLabel(df), df);
}

/**
 * Put a marker chip's text in and centre it on `frac` (0..1) across its track,
 * CLAMPED so the pill never overhangs either end of that track.
 *
 * The chips are centred on their position (translateX(-50%) in CSS), so an
 * unclamped chip hangs half its own width past the track's end — and the HUD
 * panel's edge is only ~12px beyond it. That's not an edge case: the day chip
 * hits it every morning at 6am (frac 0) and every evening at 6pm (frac 1), and
 * the month chip hits it every March and February. Clamping in JS (not CSS)
 * because it needs the chip's rendered width, which depends on its text.
 *
 * Measures layout, so only call it from `updateHud` (~2×/s), never per-frame.
 */
function placeChip(chip: HTMLElement, text: string, frac: number): void {
  chip.textContent = text; // set first — the clamp needs the final width
  const track = chip.offsetParent as HTMLElement | null;
  if (!track) return; // hidden (display:none) — nothing to place
  const width = track.clientWidth;
  const half = chip.offsetWidth / 2;
  // A chip wider than its own track can't be clamped into it — centre it.
  const centre = half * 2 > width
    ? width / 2
    : Math.min(Math.max(frac * width, half), width - half);
  chip.style.left = `${centre.toFixed(1)}px`;
}

/** Rounded-to-the-hour 12-hour clock label for a workday fraction (0 = 6am,
 * 1 = 6pm) — "6am", "10am", "12pm", "5pm", etc. */
function hourLabel(df: number): string {
  const hour = Math.round(6 + df * 12); // 6..18
  const period = hour < 12 ? "am" : "pm";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}${period}`;
}

/** 0..1 through the campaign's display year, which runs Mar 1 → end of Feb. */
function yearFraction(t: number): number {
  const minutesPerYear = MONTHS_PER_YEAR * minutesPerMonth();
  return (t % minutesPerYear) / minutesPerYear;
}

/** 0..1 through the current workday, 6am = 0, 6pm = 1 (the whole game "day"
 * is this 12-hour window — no night is modeled). */
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
// The four bottom-toolbar panels are MUTUALLY EXCLUSIVE — opening one closes any
// other. Clicking the active panel's own button closes it (toggle).
// ---------------------------------------------------------------------------
const TOOLBAR_PANELS = ["fieldstab", "equiptab", "structurestab", "cropcal", "inventory", "financetab", "settingstab"];
function toggleToolbarPanel(id: string, onOpen?: () => void): void {
  const opening = $(id).style.display !== "block";
  for (const p of TOOLBAR_PANELS) $(p).style.display = "none";
  if (opening) {
    $(id).style.display = "block";
    onOpen?.();
  }
}

// ---------------------------------------------------------------------------
// Inventory: grain storage + the v0 flat-price sale (real market comes later).
// ---------------------------------------------------------------------------
function wireInventory() {
  $("btn-inventory").addEventListener("click", () => toggleToolbarPanel("inventory", () => refreshInventory(true)));
  $("inv-close").addEventListener("click", () => ($("inventory").style.display = "none"));
}

/** Building index within its own kind, 1-based, in purchase order — "Silo 1",
 * "Silo 2", … (buildings have no persistent name, so this is display-only). */
function buildingIndex(building: Building): number {
  return save.buildings.filter((b) => b.kind === building.kind).indexOf(building) + 1;
}

/** Inventory is organized around STORAGE STRUCTURES, not crops (maintainer
 * request, 2026-07-16): each silo is its own row with its own capacity and a
 * crop dropdown; grain is still one pooled bin per crop under the hood
 * (brief's "unlimited in this slice" note), so a silo's "stored" reading is
 * its share of that pool, proportional to its capacity among every silo
 * sharing the same crop — the shares always sum back to the true total. */
let lastInventoryKey = "";
function refreshInventory(force = false) {
  const el = $("inventory");
  if (el.style.display !== "block") return;

  // Live-refreshed from the game loop (~2×/s), so bail unless the shown data
  // actually changed — otherwise every frame would rebuild the DOM and reset a
  // half-open crop/product dropdown or the sell buttons under the cursor. Keyed
  // on everything rendered below: pooled grain, each building's assignment +
  // stored bales, and the in-field bale tallies.
  const grainKey = (Object.keys(save.grain) as CropId[]).map((c) => `${c}:${save.grain[c].toFixed(1)}`).join(",");
  const bldgKey = save.buildings
    .map((b) => `${b.id}:${b.assignedCrop ?? ""}:${b.assignedProduct ?? ""}:${JSON.stringify(b.storedBales ?? {})}`)
    .join("|");
  const fieldBaleKey = baleInventory(save).map((s) => `${s.product}:${s.bales}`).join(",");
  const key = `${grainKey}#${bldgKey}#${fieldBaleKey}`;
  if (!force && key === lastInventoryKey) return;
  lastInventoryKey = key;

  const rows = $("inv-rows");
  rows.innerHTML = "";

  // --- Grain Silos ---
  const silos = save.buildings.filter((b) => b.kind === "silo");
  rows.insertAdjacentHTML("beforeend", `<div class="inv-heading">🛢️ Grain Silos</div>`);
  if (silos.length === 0) {
    rows.insertAdjacentHTML("beforeend", `<div class="silo-bar-empty">No silos built yet — buy one from the Structures tab.</div>`);
  }
  for (const silo of silos) {
    const capacity = siloCapacityOf(silo.size ?? "small");
    const crop = silo.assignedCrop;
    const cropCapacityTotal = crop ? siloCapacityForCrop(save, crop) : 0;
    // This silo's proportional share of the crop's pooled tons.
    const tons = crop && cropCapacityTotal > 0 ? (save.grain[crop] * capacity) / cropCapacityTotal : 0;

    const row = document.createElement("div");
    row.className = "inv-row inv-building";
    row.innerHTML = `
      <span class="icon">${BUILDING_ICON.silo}</span>
      <span class="info">
        <div class="name">Silo ${buildingIndex(silo)} · ${SIZE_LABEL[silo.size ?? "small"]}</div>
        <div class="qty">${capacity.toLocaleString()} t capacity</div>
      </span>`;

    const select = document.createElement("select");
    select.className = "inv-crop-select";
    select.innerHTML =
      `<option value="">— assign a crop —</option>` +
      (Object.keys(gameConfig.crops) as CropId[])
        .filter((c) => gameConfig.crops[c].producesGrain !== false)
        .map((c) => `<option value="${c}">${gameConfig.crops[c].emoji} ${gameConfig.crops[c].name}</option>`)
        .join("");
    select.value = crop ?? "";
    select.addEventListener("change", () => {
      assignSiloCrop(save, silo.id, (select.value || undefined) as CropId | undefined);
      refreshInventory();
    });
    row.appendChild(select);
    row.appendChild(locateButton(`Silo ${buildingIndex(silo)}`, silo.pos));
    const refund = buildingPrice("silo", silo.size);
    row.appendChild(
      iconButton("💰", `Sell · $${refund.toLocaleString()}`, false, () => {
        if (!confirm(`Sell Silo ${buildingIndex(silo)} for $${refund.toLocaleString()}?`)) return;
        sellBuilding(save, silo.id);
        toast(`💰 Sold Silo ${buildingIndex(silo)} for $${refund.toLocaleString()}`);
        refreshInventory();
        refreshBuildingMarkers();
        updateHud();
      }),
    );
    rows.appendChild(row);

    if (!crop) {
      rows.insertAdjacentHTML("beforeend", `<div class="silo-bar-empty">Not assigned — pick a crop above to start filling it.</div>`);
      continue;
    }
    const cfg = gameConfig.crops[crop];
    const bar = siloCapacityBar(cfg, tons, capacity);
    rows.appendChild(bar);
    const sellRow = document.createElement("div");
    sellRow.className = "inv-row inv-sell-row";
    sellRow.innerHTML = `<span class="price">${cfg.emoji} ${cfg.name} · $${cfg.sellPricePerTon.toLocaleString()}/t</span>`;
    const sellBtn = document.createElement("button");
    sellBtn.className = "primary";
    const value = Math.round(tons * cfg.sellPricePerTon);
    sellBtn.textContent = tons > 0 ? `Sell all · $${value.toLocaleString()}` : "Empty";
    sellBtn.disabled = tons <= 0;
    sellBtn.addEventListener("click", () => {
      const { tons: sold, revenue } = sellGrain(save, crop, tons);
      if (sold <= 0) return;
      logSale("sellGrain", { crop, label: cfg.name, tons: sold, revenue });
      updateHud();
      refreshInventory();
      toast(`💰 Sold ${sold.toFixed(1)} t of ${cfg.name.toLowerCase()} for $${revenue.toLocaleString()}`);
    });
    sellRow.appendChild(sellBtn);
    rows.appendChild(sellRow);
  }

  // --- Unassigned grain safety net: a crop can end up with pooled tons but no
  // silo currently claiming it (e.g. the assigned silo got sold) — still show
  // it somewhere sellable rather than silently stranding it. ---
  const claimed = new Set(silos.map((s) => s.assignedCrop).filter((c): c is CropId => !!c));
  const orphaned = (Object.keys(gameConfig.crops) as CropId[]).filter(
    (c) => gameConfig.crops[c].producesGrain !== false && !claimed.has(c) && save.grain[c] > 0,
  );
  if (orphaned.length > 0) {
    rows.insertAdjacentHTML("beforeend", `<div class="inv-heading">⚠️ Unassigned Grain</div>`);
    for (const cropId of orphaned) {
      const cfg = gameConfig.crops[cropId];
      const tons = save.grain[cropId];
      const row = document.createElement("div");
      row.className = "inv-row";
      row.innerHTML = `
        <span class="icon">${cfg.emoji}</span>
        <span class="info">
          <div class="name">${cfg.name}</div>
          <div class="qty">${tons.toFixed(1)} t · no silo claims it</div>
        </span>
        <span class="price">$${cfg.sellPricePerTon.toLocaleString()}/t</span>`;
      const btn = document.createElement("button");
      btn.className = "primary";
      const value = Math.round(tons * cfg.sellPricePerTon);
      btn.textContent = `Sell all · $${value.toLocaleString()}`;
      btn.addEventListener("click", () => {
        const { tons: sold, revenue } = sellGrain(save, cropId, Infinity);
        if (sold <= 0) return;
        logSale("sellGrain", { crop: cropId, label: cfg.name, tons: sold, revenue });
        updateHud();
        refreshInventory();
        toast(`💰 Sold ${sold.toFixed(1)} t of ${cfg.name.toLowerCase()} for $${revenue.toLocaleString()}`);
      });
      row.appendChild(btn);
      rows.appendChild(row);
    }
  }

  // --- Bale storage structures (2026-07-17): now hold hauled bales (per
  // product), each with an optional product assignment (unassigned accepts
  // any). A Barn caps; an Area is unlimited. ---
  const baleBuildings = save.buildings.filter((b) => b.kind === "baleBarn" || b.kind === "baleArea");
  if (baleBuildings.length > 0) {
    rows.insertAdjacentHTML("beforeend", `<div class="inv-heading">📦 Bale Storage</div>`);
    for (const b of baleBuildings) {
      const name = `${buildingDisplayName(b.kind)} ${buildingIndex(b)}`;
      const cap = baleStorageCapacityOf(b.kind as "baleBarn" | "baleArea");
      const stored = storedBalesTotal(b);
      const capText = cap === Infinity ? "unlimited" : `${stored} / ${cap.toLocaleString()}`;
      const row = document.createElement("div");
      row.className = "inv-row inv-building";
      row.innerHTML = `
        <span class="icon">${BUILDING_ICON[b.kind]}</span>
        <span class="info">
          <div class="name">${name}</div>
          <div class="qty">${capText} bales${cap === Infinity ? ` · ${stored} stored` : ""}</div>
        </span>`;

      // Optional product assignment — mirrors the silo crop dropdown.
      const select = document.createElement("select");
      select.className = "inv-crop-select";
      const products: BaleProduct[] = ["cornStover", "hay", "alfalfaHay"];
      select.innerHTML =
        `<option value="">— any product —</option>` +
        products.map((p) => `<option value="${p}">${gameConfig.baleProducts[p].name}</option>`).join("");
      select.value = b.assignedProduct ?? "";
      select.addEventListener("change", () => {
        assignBaleStorageProduct(save, b.id, (select.value || undefined) as BaleProduct | undefined);
        refreshInventory();
      });
      row.appendChild(select);
      row.appendChild(locateButton(name, b.pos));
      const refund = buildingPrice(b.kind);
      row.appendChild(
        iconButton("💰", `Sell · $${refund.toLocaleString()}`, false, () => {
          if (!confirm(`Sell ${name} for $${refund.toLocaleString()}?`)) return;
          sellBuilding(save, b.id);
          toast(`💰 Sold ${name} for $${refund.toLocaleString()}`);
          refreshInventory();
          refreshBuildingMarkers();
          updateHud();
        }),
      );
      rows.appendChild(row);

      // Per-product stored tally, each sellable at the flat price.
      for (const p of products) {
        const n = b.storedBales?.[p] ?? 0;
        if (n <= 0) continue;
        const cfg = gameConfig.baleProducts[p];
        const value = Math.round(n * cfg.pricePerBale);
        const sellRow = document.createElement("div");
        sellRow.className = "inv-row inv-sell-row";
        sellRow.innerHTML = `<span class="price">${cfg.name} · ${n} bale${n === 1 ? "" : "s"} · $${cfg.pricePerBale.toLocaleString()}/bale</span>`;
        const sellBtn = document.createElement("button");
        sellBtn.className = "primary";
        sellBtn.textContent = `Sell all · $${value.toLocaleString()}`;
        sellBtn.addEventListener("click", () => {
          const { bales: sold, revenue } = sellStoredBalesFrom(save, b, p);
          if (sold <= 0) return;
          logSale("sellBales", { label: cfg.name, bales: sold, tons: sold * gameConfig.forage.baleTons, revenue });
          updateHud();
          refreshInventory();
          toast(`💰 Sold ${sold} stored ${cfg.name.toLowerCase()} bales for $${revenue.toLocaleString()}`);
        });
        sellRow.appendChild(sellBtn);
        rows.appendChild(sellRow);
      }
    }
  }

  // --- In-field bales (2026-07-14): every field's bales summed per product —
  // this IS where every bale lives today (baling drops them on the field and
  // nothing moves them since there's no hauling mechanic), sellable in one
  // click here as well as from a field's own panel. ---
  const stocks = baleInventory(save);
  rows.insertAdjacentHTML("beforeend", `<div class="inv-heading">🌾 In-Field Bales (not yet hauled)</div>`);
  if (stocks.length === 0) {
    rows.insertAdjacentHTML("beforeend", `<div class="silo-bar-empty">No bales sitting in any field right now.</div>`);
  }
  for (const stock of stocks) {
    const tons = (stock.bales * gameConfig.forage.baleTons).toFixed(0);
    const row = document.createElement("div");
    row.className = "inv-row";
    row.innerHTML = `
      <span class="icon">${baleIconSvg(22, stock.color)}</span>
      <span class="info">
        <div class="name">${stock.name}</div>
        <div class="qty">${stock.bales} bales · ${tons} t</div>
      </span>
      <span class="price">$${stock.pricePerBale.toLocaleString()}/bale</span>`;
    const btn = document.createElement("button");
    btn.className = "primary";
    btn.textContent = `Sell all · $${stock.value.toLocaleString()}`;
    btn.addEventListener("click", () => {
      const { bales: sold, revenue } = sellBalesOfProduct(save, stock.product);
      if (sold <= 0) return;
      logSale("sellBales", { label: stock.name, bales: sold, tons: sold * gameConfig.forage.baleTons, revenue });
      updateHud();
      refreshInventory();
      updateBaleMarkers();
      if (selectedFieldId) refreshFieldPanel(true);
      toast(`💰 Sold ${sold} ${stock.name.toLowerCase()} bales for $${revenue.toLocaleString()}`);
    });
    row.appendChild(btn);
    rows.appendChild(row);
  }
}

/** A silo-capacity status bar for one crop: fills left→right, "X.X / Y t".
 * Color shifts gold → amber → red as it nears full; reads "No silo assigned"
 * (no fill) when the farm hasn't dedicated a silo to this crop yet. */
function siloCapacityBar(cfg: (typeof gameConfig.crops)[CropId], tons: number, capacity: number): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "silo-bar";
  if (capacity <= 0) {
    wrap.innerHTML = `<div class="silo-bar-empty">🛢️ No silo assigned to ${cfg.name.toLowerCase()} — build or assign one to track capacity</div>`;
    return wrap;
  }
  const pct = Math.min(100, (tons / capacity) * 100);
  const level = pct >= 95 ? "full" : pct >= 75 ? "high" : "ok";
  wrap.innerHTML = `
    <div class="silo-bar-track">
      <div class="silo-bar-fill ${level}" style="width:${pct.toFixed(1)}%"></div>
      <div class="silo-bar-label">${tons.toFixed(1)} / ${capacity.toLocaleString()} t</div>
    </div>`;
  return wrap;
}

// ---------------------------------------------------------------------------
// Finance tab: loans (brief §8). One OPEN balance for the current campaign
// year, grown/shrunk with +/-$50k clicks (cash moves immediately); it locks
// in as its own 5%/15-year loan the moment the year turns. Locked loans list
// below, newest first — each pays down independently and can be refinanced.
// ---------------------------------------------------------------------------
function wireFinanceTab() {
  $("btn-finance").addEventListener("click", () => toggleToolbarPanel("financetab", () => refreshFinanceTab(true)));
  $("finance-close").addEventListener("click", () => ($("financetab").style.display = "none"));
}

function loanAmtLabel(n: number): string {
  return n % 1000 === 0 ? `$${(n / 1000).toFixed(0)}k` : `$${n.toLocaleString()}`;
}

/** $-formatting for cashflow cells: rounded to the nearest $100, parenthesized-
 * red handled in CSS. */
function cfAmount(n: number): string {
  const r = round100(n);
  if (r === 0) return "—";
  return (r < 0 ? "−$" : "$") + Math.abs(r).toLocaleString();
}

let lastFinanceKey = "";
function refreshFinanceTab(force = false) {
  const el = $("financetab");
  if (el.style.display !== "block") return;

  const key =
    `${save.finance.openYear}:${Math.round(save.finance.pendingPrincipal)}` +
    "#" +
    save.finance.loans.map((l) => `${l.id}:${Math.round(l.principal)}:${Math.round(l.monthlyPayment)}`).join(",") +
    `|$${Math.round(save.money)}` +
    `|L${JSON.stringify(save.ledger ?? {})}`;
  if (!force && key === lastFinanceKey) return;
  lastFinanceKey = key;

  const rows = $("finance-rows");
  rows.innerHTML = "";
  const inc = gameConfig.loan.incrementAmount;

  // --- Loans, CONDENSED (maintainer request, 2026-07-12): one compact line
  // each — open borrowing first, then locked loans newest-first, actions inline.
  rows.insertAdjacentHTML("beforeend", `<div class="fin-heading">Loans</div>`);
  const pending = save.finance.pendingPrincipal;
  const openLine = document.createElement("div");
  openLine.className = "loan-line open";
  openLine.innerHTML = `
    <span class="ll-name">Yr ${save.finance.openYear} · open</span>
    <span class="ll-sub">${pending > 0
      ? `$${round100(pending).toLocaleString()} pending — locks in at ${gameConfig.loan.ratePercent}% / ${gameConfig.loan.termMonths / 12} yr on Jan 1`
      : "Nothing borrowed this year"}</span>`;
  const borrowBtn = document.createElement("button");
  borrowBtn.className = "ll-btn borrow";
  borrowBtn.textContent = `+${loanAmtLabel(inc)}`;
  borrowBtn.title = `Borrow ${loanAmtLabel(inc)} now`;
  borrowBtn.addEventListener("click", () => {
    borrowOpen(save, inc);
    updateHud();
    refreshFinanceTab(true);
  });
  openLine.appendChild(borrowBtn);
  const openPayAmount = Math.min(inc, pending);
  const openPayBtn = document.createElement("button");
  openPayBtn.className = "ll-btn";
  openPayBtn.textContent = `−${loanAmtLabel(inc)}`;
  openPayBtn.disabled = openPayAmount <= 0 || openPayAmount > save.money;
  openPayBtn.title = openPayAmount <= 0 ? "Nothing pending to pay down" : `Pay down ${loanAmtLabel(openPayAmount)}`;
  openPayBtn.addEventListener("click", () => {
    try {
      paydownOpen(save, inc);
      updateHud();
      refreshFinanceTab(true);
    } catch (err) {
      toast("❌ " + (err as Error).message, 3500);
    }
  });
  openLine.appendChild(openPayBtn);
  rows.appendChild(openLine);

  const loans = [...save.finance.loans].sort((a, b) => b.originYear - a.originYear);
  for (const loan of loans) {
    const line = document.createElement("div");
    line.className = "loan-line";
    line.innerHTML = `
      <span class="ll-name">Yr ${loan.originYear} loan</span>
      <span class="ll-sub">$${round100(loan.principal).toLocaleString()} owed · $${round100(loan.monthlyPayment).toLocaleString()}/mo · ${loan.ratePercent}%</span>`;
    const payAmount = Math.min(inc, loan.principal);
    const payBtn = document.createElement("button");
    payBtn.className = "ll-btn";
    payBtn.textContent = payAmount < inc ? `Pay off $${Math.round(payAmount).toLocaleString()}` : `−${loanAmtLabel(inc)}`;
    payBtn.disabled = payAmount > save.money;
    payBtn.title = "Extra principal — retires the loan sooner (payment unchanged)";
    payBtn.addEventListener("click", () => {
      try {
        const payingOff = payAmount >= loan.principal - 0.01;
        paydownLoan(save, loan.id, inc);
        updateHud();
        refreshFinanceTab(true);
        toast(payingOff ? `💰 Paid off the Year ${loan.originYear} loan` : `💰 Paid down the Year ${loan.originYear} loan`);
      } catch (err) {
        toast("❌ " + (err as Error).message, 3500);
      }
    });
    line.appendChild(payBtn);
    // Refinance: the one action that warns + confirms (maintainer request).
    const refi = document.createElement("button");
    refi.className = "ll-btn refi";
    refi.textContent = "🔄";
    refi.title = `Refinance — fresh ${gameConfig.loan.termMonths / 12}-yr term, $${gameConfig.loan.refinanceFee.toLocaleString()} fee added to principal`;
    refi.addEventListener("click", () => {
      const ok = confirm(
        `Refinance the Year ${loan.originYear} loan?\n\n` +
          `This resets it to a fresh ${gameConfig.loan.termMonths / 12}-year term at ${loan.ratePercent}% and ` +
          `recalculates the monthly payment from the current balance. A $${gameConfig.loan.refinanceFee.toLocaleString()} ` +
          `fee gets added to the loan's principal — it isn't charged in cash.`,
      );
      if (!ok) return;
      refinanceLoan(save, loan.id);
      updateHud();
      refreshFinanceTab(true);
      toast(`🔄 Refinanced the Year ${loan.originYear} loan`);
    });
    line.appendChild(refi);
    rows.appendChild(line);
  }

  // --- Cashflow table (maintainer request, 2026-07-12): last 5 campaign
  // years, current on top. Hover any figure for the item-level breakdown.
  rows.insertAdjacentHTML("beforeend", `<div class="fin-heading">Cashflow · last 5 years</div>`);
  const table = document.createElement("div");
  table.className = "cf-table";
  table.insertAdjacentHTML(
    "beforeend",
    `<div class="cf-row cf-head"><div>Year</div>` +
      CASHFLOW_CATEGORIES.map((c) => `<div>${CASHFLOW_LABEL[c]}</div>`).join("") +
      `<div>Net Cashflow</div></div>`,
  );
  for (const year of ledgerYears(save)) {
    const y = save.ledger?.[year];
    const row = document.createElement("div");
    row.className = "cf-row" + (year === save.finance.openYear ? " current" : "");
    row.insertAdjacentHTML("beforeend", `<div class="cf-year">Yr ${year}${year === save.finance.openYear ? " ·" : ""}</div>`);
    for (const cat of CASHFLOW_CATEGORIES) {
      const total = categoryTotal(y, cat);
      const cell = document.createElement("div");
      cell.className = "cf-cell" + (total < 0 ? " neg" : total > 0 ? " pos" : "");
      cell.textContent = cfAmount(total);
      const items = Object.entries(y?.[cat] ?? {}).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
      if (items.length > 0) {
        const tip = document.createElement("div");
        tip.className = "cf-tip";
        tip.innerHTML =
          `<div class="cf-tip-title">${CASHFLOW_LABEL[cat]} · Yr ${year}</div>` +
          items.map(([name, v]) => `<div class="cf-tip-row"><span>${name}</span><span class="${v < 0 ? "neg" : "pos"}">${cfAmount(v)}</span></div>`).join("");
        cell.appendChild(tip);
      }
      row.appendChild(cell);
    }
    const net = netCashflow(y);
    row.insertAdjacentHTML("beforeend", `<div class="cf-cell cf-net ${net < 0 ? "neg" : net > 0 ? "pos" : ""}">${cfAmount(net)}</div>`);
    table.appendChild(row);
  }
  rows.appendChild(table);
}

// ---------------------------------------------------------------------------
// Settings tab (maintainer request, 2026-07-13): create/load/delete separate
// farms. Exactly one farm is "active" — switching farms reloads the page
// (same pattern the Reset button already used) so every module-level bit of
// state elsewhere (clock, calendar pace, id counters, ...) boots up correct
// for whichever save is now active, rather than needing a live teardown path.
// ---------------------------------------------------------------------------
function wireSettingsTab() {
  $("btn-settings").addEventListener("click", () => toggleToolbarPanel("settingstab", refreshSettingsTab));
  $("settings-close").addEventListener("click", () => ($("settingstab").style.display = "none"));

  const nameInput = $("settings-new-name") as HTMLInputElement;
  const createBtn = $("settings-new-create") as HTMLButtonElement;
  const doCreate = () => {
    // Flush the OUTGOING farm's state before switching — persistGame() always
    // writes to whichever farm is active AT CALL TIME, so this must run
    // before createFarm() flips activeId to the new (blank) farm.
    saveBeforeSwitch();
    createFarm(nameInput.value);
    location.reload();
  };
  createBtn.addEventListener("click", doCreate);
  nameInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") doCreate();
  });
}

/** Flush the current farm's state before navigating away from it (switching
 * farms or the page will otherwise reload mid-autosave-interval and lose
 * whatever happened since the last 5s tick). */
function saveBeforeSwitch(): void {
  resetting = true; // reuse the same "don't let a stray timer write after us" guard as Reset
  persistGame({ save, clockNow: clock.time(), daysPerMonth: getDaysPerMonth() });
}

/** One line of "what's in this save" without touching the shared calendar
 * module's daysPerMonth (that's a live global for the ACTIVE farm's pace —
 * reading a different farm's saved pace through it would corrupt the
 * currently-playing farm's calendar math). Computed directly from the
 * PersistedGame's own daysPerMonth instead. */
function farmSummaryLine(pg: PersistedGame | null): string {
  if (!pg) return "Not started yet";
  const mpm = (pg.daysPerMonth ?? 30) * MINUTES_PER_DAY;
  const totalMonths = START_MONTH + Math.floor(pg.clockNow / mpm);
  const year = 1 + Math.floor(totalMonths / MONTHS_PER_YEAR);
  const acres = pg.save.fields.reduce((sum, f) => sum + areaAcres(f.boundary), 0);
  return `Year ${year} · $${Math.round(pg.save.money).toLocaleString()} · ${acres.toFixed(0)} ac`;
}

function refreshSettingsTab(): void {
  const el = $("settingstab");
  if (el.style.display !== "block") return;

  const rows = $("settings-farms");
  rows.innerHTML = "";
  const activeId = getActiveFarmId();
  for (const meta of listFarms()) {
    const isActive = meta.id === activeId;
    const pg = isActive ? { save, clockNow: clock.time(), daysPerMonth: getDaysPerMonth() } : loadGameFor(meta.id);
    const row = document.createElement("div");
    row.className = "farm-row" + (isActive ? " active" : "");
    row.innerHTML = `
      <span class="icon">🚜</span>
      <span class="farm-info">
        <div class="farm-name">${escapeHtml(meta.name)}${isActive ? " · Playing" : ""}</div>
        <div class="farm-sub">${farmSummaryLine(pg)}</div>
      </span>`;

    if (!isActive) {
      const loadBtn = document.createElement("button");
      loadBtn.className = "primary";
      loadBtn.textContent = "▶ Load";
      loadBtn.addEventListener("click", () => {
        saveBeforeSwitch();
        switchFarm(meta.id);
        location.reload();
      });
      row.appendChild(loadBtn);
    }

    const delBtn = document.createElement("button");
    delBtn.className = "farm-del";
    delBtn.textContent = "🗑";
    delBtn.title = `Delete ${meta.name}`;
    delBtn.addEventListener("click", () => {
      if (!confirm(`Delete "${meta.name}"? This can't be undone.`)) return;
      const wasActive = isActive;
      deleteFarm(meta.id); // picks (or creates) the next active farm internally
      if (wasActive) {
        resetting = true; // this farm's gone — don't let the autosave timer resurrect it
        location.reload();
      } else {
        refreshSettingsTab();
      }
    });
    row.appendChild(delBtn);
    rows.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Fields tab: every owned field at a glance — status, acres, expected yield.
// Click a row to open its detail panel (where Plow/Plant/Harvest/Sell live).
// ---------------------------------------------------------------------------
function wireFieldsTab() {
  $("btn-fields").addEventListener("click", () => toggleToolbarPanel("fieldstab", refreshFieldsTab));
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
    const pending = tasksFor(save, field.id);
    const statusLabel = isFieldHarvesting(save, field.id)
      ? "harvesting"
      : pending.length > 0
        ? `${field.status} · ${pending.length} job${pending.length > 1 ? "s" : ""} queued`
        : field.status;

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
        <div class="fr-name">${fieldLabel(field)}</div>
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
// Equipment tab: the machine fleet. Tractors are power units that attach
// implements (a plow now); the combine is self-contained. Buy any size, hitch a
// plow to a tractor (its class or smaller), and sell idle gear back for its
// purchase price (same rule as land).
// ---------------------------------------------------------------------------
const SIZES: EquipmentSize[] = ["small", "medium", "large"];
const SIZE_LABEL: Record<EquipmentSize, string> = { small: "Small", medium: "Medium", large: "Large" };

function wireEquipTab() {
  $("btn-equip").addEventListener("click", () => toggleToolbarPanel("equiptab", () => refreshEquipTab(true)));
  $("equip-close").addEventListener("click", () => ($("equiptab").style.display = "none"));

  // The shop is tucked behind a toggle so the panel defaults to the fleet.
  $("equip-buy-toggle").addEventListener("click", () => {
    const shop = $("equip-shop");
    const open = shop.style.display !== "block";
    shop.style.display = open ? "block" : "none";
    $("equip-buy-toggle").textContent = open ? "✕ Close shop" : "＋ Buy equipment";
    if (open) buildEquipShop();
  });
}

/** Structures tab: buildings' shop, split out of Equipment (maintainer
 * request, 2026-07-17), styled to match it — a fleet list of owned
 * buildings with the shop tucked behind a "＋ Buy structures" toggle. Silo
 * crop assignment/sale still happens from the Inventory tab; this tab's
 * sell button here is the same "sell back for full refund" as everywhere
 * else (land/equipment). */
function wireStructuresTab() {
  $("btn-structures").addEventListener("click", () => toggleToolbarPanel("structurestab", () => refreshStructuresTab(true)));
  $("structures-close").addEventListener("click", () => ($("structurestab").style.display = "none"));

  $("structures-buy-toggle").addEventListener("click", () => {
    const shop = $("structures-shop");
    const open = shop.style.display !== "block";
    shop.style.display = open ? "block" : "none";
    $("structures-buy-toggle").textContent = open ? "✕ Close shop" : "＋ Buy structures";
    if (open) buildStructuresShop();
  });
}

/** Refresh after any building purchase/sale: HUD cash, map markers, panel. */
function afterStructuresChange(): void {
  updateHud();
  refreshBuildingMarkers();
  refreshStructuresTab(true);
}

/** Rebuild the Structures tab — cheap no-op while hidden. Mirrors
 * refreshEquipTab: only re-renders the shop while it's open (affordability
 * may have changed), always re-renders the owned list. */
let lastStructuresKey = "";
function refreshStructuresTab(force = false) {
  const el = $("structurestab");
  if (el.style.display !== "block") return;
  const key = save.buildings.map((b) => `${b.id}:${b.assignedCrop ?? ""}`).join("|") + `|$${Math.round(save.money)}`;
  if (!force && key === lastStructuresKey) return;
  lastStructuresKey = key;

  if ($("structures-shop").style.display === "block") buildStructuresShop();
  buildStructuresList();
}

/** Owned buildings, one row per structure — same `.equip-row` layout as the
 * Equipment tab's Machines/Implements lists. */
function buildStructuresList(): void {
  const rows = $("structures-list");
  rows.innerHTML = "";
  if (save.buildings.length === 0) {
    rows.innerHTML = `<div id="fields-empty">No structures yet — buy a silo so harvested grain has somewhere to go.</div>`;
    return;
  }
  for (const b of save.buildings) {
    const name = `${buildingDisplayName(b.kind, b.size)} ${buildingIndex(b)}`;
    const refund = buildingPrice(b.kind, b.size);
    const specText = structureSpecText(b);

    // Same dot language as Equipment: a silo actually assigned to a crop
    // reads as "active" (solid green, no pulse — there's no in-progress
    // state to animate); everything else is passive infrastructure (gray).
    const stateClass = b.kind === "silo" && b.assignedCrop ? "assigned" : "idle";

    const row = document.createElement("div");
    row.className = `equip-card ${stateClass}`;
    row.innerHTML = `
      <span class="ec-dot ${stateClass}" title="${specText}"></span>
      <span class="icon">${BUILDING_ICON[b.kind]}</span>
      <div class="ec-name">${name}</div>
      <div class="ec-status" title="${specText}">${specText}</div>`;

    const actions = document.createElement("div");
    actions.className = "ec-actions";
    actions.appendChild(locateButton(name, b.pos));
    actions.appendChild(
      iconButton("💰", `Sell · $${refund.toLocaleString()}`, false, () => {
        if (!confirm(`Sell ${name} for $${refund.toLocaleString()}?`)) return;
        sellBuilding(save, b.id);
        toast(`💰 Sold ${name} for $${refund.toLocaleString()}`);
        afterStructuresChange();
      }),
    );
    row.appendChild(actions);
    rows.appendChild(row);
  }
}

/** One-line capacity/role summary for a building's status line. */
function structureSpecText(b: Building): string {
  switch (b.kind) {
    case "silo": {
      const cap = siloCapacityOf(b.size ?? "small");
      return b.assignedCrop
        ? `${cap.toLocaleString()} t capacity · assigned to ${gameConfig.crops[b.assignedCrop].name}`
        : `${cap.toLocaleString()} t capacity · unassigned`;
    }
    case "baleBarn":
      return `${storedBalesTotal(b)} / ${baleStorageCapacityOf("baleBarn").toLocaleString()} bales · indoor`;
    case "baleArea":
      return `${storedBalesTotal(b)} bales · outdoor · unlimited`;
    case "tractorBarn":
      return `${gameConfig.buildings.tractorBarn.slots} machine slots`;
    case "implementBarn":
      return `${gameConfig.buildings.implementBarn.slots} implement slots`;
    case "farmYard":
      return "Rally point — gear parks here";
    case "sellPoint":
      return "Bale hauler fallback — sells on the spot when storage is full/missing";
  }
}

/** Refresh after any fleet change: HUD cash, map dots, panels. */
function afterFleetChange(): void {
  updateHud();
  updateAgentMarkers();
  refreshEquipTab(true);
  refreshQueuePanel();
}

/** Text for a harvester waiting on a Grain Trailer — full mid-job, or idle
 * with a leftover partial hopper after finishing its field. ⚠️ if the
 * servicing unload trip is stuck with nowhere to dump. */
function harvesterWaitingText(agent: Agent): string | null {
  const capV = harvesterCapacityTons(agent.size ?? "medium");
  const onboard = agent.grainOnboard ?? 0;
  const blocked = onboard >= capV - 1e-9;
  if (onboard <= 1e-9 || !(agent.state === "idle" || blocked)) return null;
  const unload = save.tasks.find((t) => t.type === "unloadHarvester" && t.harvesterAgentId === agent.id);
  const warn = unload?.waitingForSilo ? "⚠️ " : "";
  return `${warn}Waiting for a Grain Trailer (${onboard.toFixed(1)}/${capV}t)`;
}

const UNLOAD_PHASE_TEXT: Record<string, string> = {
  staging: "Waiting at the gate for the combine…",
  toHarvester: "Driving to the combine…",
  onloading: "Loading grain…",
  toSilo: "Hauling to the silo…",
  dumping: "Unloading at the silo…",
};

const HAUL_PHASE_TEXT: Record<string, string> = {
  toBale: "Collecting bales…",
  loading: "Spearing a bale…",
  toTrailer: "Carrying to the trailer…",
  unloadToTrailer: "Loading the trailer…",
  toStorage: "Hauling to storage…",
  dumping: "Unloading at storage…",
  waiting: "Waiting…",
};

/** One-line status for a Haul Bales job's queue row — the spikes tractor's leg,
 * or a ⚠️ if a hauler is stuck with nowhere to store. */
function haulSubText(task: FarmTask): string {
  if (task.waitingForStorage) return "⚠️ Waiting for storage room";
  return HAUL_PHASE_TEXT[task.haulPhase ?? "toBale"] ?? "Hauling bales…";
}

function agentStatusText(agent: Agent): { text: string; pct: number | null } {
  const task = agent.taskId ? save.tasks.find((t) => t.id === agent.taskId) : undefined;

  if (agent.kind === "harvester") {
    const waiting = harvesterWaitingText(agent);
    if (waiting) return { text: waiting, pct: null };
  }

  if (task && task.type === "unloadHarvester") {
    const text = task.waitingForSilo ? "⚠️ Waiting for silo room" : (UNLOAD_PHASE_TEXT[task.unloadPhase ?? "toHarvester"] ?? "Hauling grain…");
    return { text, pct: null };
  }
  if (task && agent.state === "traveling") return { text: `Driving to ${prettyId(task.fieldId)}…`, pct: null };
  if (task && agent.state === "working") {
    let text = `${cap(taskVerb(task))} ${prettyId(task.fieldId)}`;
    if (task.type === "harvest" && (agent.grainOnboard ?? 0) > 0) {
      text += ` · ${(agent.grainOnboard ?? 0).toFixed(1)}t onboard`;
    }
    return { text, pct: (task.doneAcres / task.totalAcres) * 100 };
  }
  // No task but still "traveling" — driving home to a Tractor Barn/Farm Yard
  // after finishing a job (see homeTargetFor in tasks.ts).
  if (!task && agent.state === "traveling") return { text: "Heading home…", pct: null };
  return { text: "Idle — waiting for work", pct: null };
}

/** Rebuild the equipment tab. Cheap no-op while hidden. */
let lastEquipKey = "";
function refreshEquipTab(force = false) {
  const el = $("equiptab");
  if (el.style.display !== "block") return;

  const key =
    save.agents
      .map((a) => {
        const task = a.taskId ? save.tasks.find((t) => t.id === a.taskId) : undefined;
        const pct = task ? Math.round((task.doneAcres / task.totalAcres) * 100) : "";
        return `${a.id}:${a.state}:${pct}:${Math.round(a.grainOnboard ?? 0)}:${task?.unloadPhase ?? ""}:${task?.waitingForSilo ?? ""}:${a.lastCrop ?? ""}`;
      })
      .join("|") +
    "#" +
    save.implements.map((i) => `${i.id}:${i.attachedTo ?? ""}:${Math.round(i.cargoTons ?? 0)}`).join("|") +
    `|$${Math.round(save.money)}`;
  if (!force && key === lastEquipKey) return;
  lastEquipKey = key;

  // Only rebuild the shop if it's currently open (affordability may have changed).
  if ($("equip-shop").style.display === "block") buildEquipShop();
  buildEquipMachines();
  buildEquipImplements();
}

/** Shared dealer-lot builders: a section header row + one product-line row
 * per shop, size tiers in ALIGNED columns (Small/Medium/Large) so prices and
 * specs compare straight down. Tiers a line doesn't come in show as an
 * em-dash placeholder rather than shifting the grid. Used by both the
 * Equipment shop (Machines/Implements) and the Structures shop (Buildings —
 * split into its own tab, maintainer request, 2026-07-17). */
function shopSection(shop: HTMLElement, label: string): void {
  const h = document.createElement("div");
  h.className = "shop-section";
  h.textContent = label;
  shop.appendChild(h);
  const head = document.createElement("div");
  head.className = "shop-row shop-head";
  head.innerHTML = `<div></div><div>Small</div><div>Medium</div><div>Large</div>`;
  shop.appendChild(head);
}

/** One product line: label cell + one cell per size column. */
function shopLine(
  shop: HTMLElement, label: string, iconSvg: string,
  cells: Partial<Record<EquipmentSize, { spec: string; price: number; onBuy: () => void }>>,
): void {
  const row = document.createElement("div");
  row.className = "shop-row";
  row.innerHTML = `<div class="shop-line-label"><span class="icon">${iconSvg}</span><span>${label}</span></div>`;
  for (const size of SIZES) {
    const c = cells[size];
    if (!c) {
      row.insertAdjacentHTML("beforeend", `<div class="shop-na">—</div>`);
      continue;
    }
    const btn = document.createElement("button");
    btn.className = "shop-card";
    btn.innerHTML = `<span class="spec">${c.spec}</span><span class="price">$${c.price.toLocaleString()}</span>`;
    btn.disabled = c.price > save.money;
    btn.title = btn.disabled ? `Costs $${c.price.toLocaleString()} — not enough cash` : `Buy ${label} - ${SIZE_LABEL[size]}`;
    btn.addEventListener("click", () => {
      try {
        c.onBuy();
      } catch (err) {
        toast("❌ " + (err as Error).message, 3500);
      }
    });
    row.appendChild(btn);
  }
  shop.appendChild(row);
}

/** The Equipment shop: Machines + Implements (Buildings live in the
 * Structures tab, see `buildStructuresShop`). */
function buildEquipShop(): void {
  const shop = $("equip-shop");
  shop.innerHTML = "";
  const section = (label: string) => shopSection(shop, label);
  const line = (
    label: string, iconSvg: string,
    cells: Partial<Record<EquipmentSize, { spec: string; price: number; onBuy: () => void }>>,
  ) => shopLine(shop, label, iconSvg, cells);

  const buyImpl = (kind: Parameters<typeof buyImplement>[1], size: EquipmentSize) => () => {
    const i = buyImplement(save, kind, size);
    afterFleetChange();
    toast(`Bought ${implementName(save, i)} — parked in the yard`);
  };

  section("Machines");
  line("Tractor", tractorIconSvg(26), Object.fromEntries(SIZES.map((s) => [s, {
    spec: `${SIZE_LABEL[s]} power unit`,
    price: agentPrice("tractor", s),
    onBuy: () => {
      const a = buyAgent(save, "tractor", s, spawnPos());
      afterFleetChange();
      toast(`Bought ${a.name} — parked at the yard`);
    },
  }])));
  line("Combine", combineIconSvg(26), Object.fromEntries(SIZES.map((s) => [s, {
    spec: `${gameConfig.equipment.harvester[s].widthFt} ft header · ${harvesterCapacityTons(s)} t hopper`,
    price: agentPrice("harvester", s),
    onBuy: () => {
      const a = buyAgent(save, "harvester", s, spawnPos());
      afterFleetChange();
      toast(`Bought ${a.name} — parked at the yard`);
    },
  }])));

  section("Implements");
  const widthSpec = (kind: "plow" | "planter" | "sprayer", s: EquipmentSize) =>
    `${gameConfig.equipment[kind][s].widthFt} ft working width`;
  line("Plow", plowIconSvg(26), Object.fromEntries(SIZES.map((s) => [s, {
    spec: widthSpec("plow", s), price: implementPrice("plow", s), onBuy: buyImpl("plow", s),
  }])));
  line("Planter", planterIconSvg(26), Object.fromEntries(SIZES.map((s) => [s, {
    spec: widthSpec("planter", s), price: implementPrice("planter", s), onBuy: buyImpl("planter", s),
  }])));
  // Sprayers only come in Medium/Large (a big-acreage tool).
  line("Sprayer", sprayerIconSvg(26), Object.fromEntries((["medium", "large"] as EquipmentSize[]).map((s) => [s, {
    spec: `${widthSpec("sprayer", s)} boom`, price: implementPrice("sprayer", s), onBuy: buyImpl("sprayer", s),
  }])));
  // Mower: cuts perennial forage (grass/alfalfa) — Small (10 ft) & Medium (20 ft).
  line("Mower", mowerIconSvg(26), Object.fromEntries((["small", "medium"] as EquipmentSize[]).map((s) => [s, {
    spec: `${gameConfig.equipment.mower[s].widthFt} ft · cuts hay`, price: implementPrice("mower", s), onBuy: buyImpl("mower", s),
  }])));
  // Rake & baler: single-size forage tools.
  line("Rake", rakeIconSvg(26), {
    small: { spec: `${gameConfig.equipment.rake.small.widthFt} ft · windrows forage`, price: implementPrice("rake", "small"), onBuy: buyImpl("rake", "small") },
  });
  line("Baler", balerIconSvg(26), {
    medium: { spec: `${gameConfig.equipment.bailer.medium.widthFt} ft pickup · drops bales`, price: implementPrice("bailer", "medium"), onBuy: buyImpl("bailer", "medium") },
  });
  line("Grain Trailer", grainTrailerIconSvg(26), Object.fromEntries(SIZES.map((s) => [s, {
    spec: `${grainTrailerCapacityTons(s)} t cargo`, price: implementPrice("grainTrailer", s), onBuy: buyImpl("grainTrailer", s),
  }])));
  // Hay Spikes: in-field bale collector — Small (1 bale) & Medium (2).
  line("Hay Spikes", haySpikesIconSvg(26), Object.fromEntries((["small", "medium"] as EquipmentSize[]).map((s) => [s, {
    spec: `${haySpikesCapacityBales(s)} bale${haySpikesCapacityBales(s) === 1 ? "" : "s"} · collects`, price: implementPrice("haySpikes", s), onBuy: buyImpl("haySpikes", s),
  }])));
  // Bale Trailer: bulk bale hauler — Small (10) & Medium (20).
  line("Bale Trailer", baleTrailerIconSvg(26), Object.fromEntries((["small", "medium"] as EquipmentSize[]).map((s) => [s, {
    spec: `${baleTrailerCapacityBales(s)} bale cargo`, price: implementPrice("baleTrailer", s), onBuy: buyImpl("baleTrailer", s),
  }])));
}

/** The Structures shop (split out of Equipment, maintainer request,
 * 2026-07-17): every buildable — Silo (size-tiered) plus the single-size
 * barns/yards in a grid below it. */
function buildStructuresShop(): void {
  const shop = $("structures-shop");
  shop.innerHTML = "";

  const placeBuilding = (kind: BuildingKind, size?: EquipmentSize) => () => {
    mode = `building:${kind}`;
    if (kind === "silo") pendingSiloSize = size ?? "small";
    $("structurestab").style.display = "none";
    toast(`🏗️ Click the map to place your ${buildingDisplayName(kind, size)}`);
  };
  shopLine(shop, "Silo", `<span class="shop-emoji">${BUILDING_ICON.silo}</span>`, Object.fromEntries(SIZES.map((s) => [s, {
    spec: `${siloCapacityOf(s).toLocaleString()} t grain`,
    price: buildingPrice("silo", s),
    onBuy: placeBuilding("silo", s),
  }])));
  const OTHER_BUILDINGS: Array<[Exclude<BuildingKind, "silo">, string]> = [
    ["baleBarn", `${gameConfig.buildings.baleBarn.capacityBales} bales · indoor`],
    ["baleArea", `unlimited · outdoor`],
    ["tractorBarn", `${gameConfig.buildings.tractorBarn.slots} machine slots`],
    ["implementBarn", `${gameConfig.buildings.implementBarn.slots} implement slots`],
    ["farmYard", "rally point — gear parks here"],
    ["sellPoint", "bale hauler fallback — sells on the spot"],
  ];
  const grid = document.createElement("div");
  grid.className = "shop-bgrid";
  for (const [kind, spec] of OTHER_BUILDINGS) {
    const price = buildingPrice(kind);
    const btn = document.createElement("button");
    btn.className = "shop-card";
    btn.innerHTML = `<span class="spec">${BUILDING_ICON[kind]} ${BUILDING_NAME[kind]}</span><span class="sub">${spec}</span><span class="price">$${price.toLocaleString()}</span>`;
    btn.disabled = price > save.money;
    btn.addEventListener("click", placeBuilding(kind));
    grid.appendChild(btn);
  }
  shop.appendChild(grid);
}

/** Where a newly bought machine parks: the nearest Farm Yard if the farm has
 * built one, else the county-center fallback used before buildings existed. */
function spawnPos(): Meters {
  return nearestFarmYard(save, homePos)?.pos ?? homePos;
}

/** MACHINES you drive: tractors + the combine. A tractor shows the plow it's
 * carrying as a subtitle; attaching is done from the Implements area below. */
function buildEquipMachines(): void {
  const rows = $("equip-machines");
  rows.innerHTML = "";
  for (const agent of save.agents) {
    const { text, pct } = agentStatusText(agent);
    const taskText = pct !== null ? `${text} · ${pct.toFixed(0)}%` : text;
    const carried =
      agent.kind === "tractor"
        ? save.implements.find((i) => i.attachedTo === agent.id)
        : undefined;
    const sub = agent.kind === "tractor"
      ? `<div class="ec-sub" title="${carried ? implementName(save, carried) : "no implement"}">🔧 ${carried ? implementName(save, carried) : "no implement"}</div>`
      : "";

    // Corner dot + card tint carry "is it working" at a glance (maintainer
    // request, 2026-07-17, replacing the old progress bar): pulsing green
    // while actually working, gold while driving, red if a harvester is
    // blocked waiting on a Grain Trailer, gray otherwise.
    const waiting = agent.kind === "harvester" ? harvesterWaitingText(agent) : null;
    const stateClass = agent.state === "working" ? "working" : agent.state === "traveling" ? "traveling" : waiting ? "waiting" : "idle";

    const row = document.createElement("div");
    row.className = `equip-card ${stateClass}`;
    row.innerHTML = `
      <span class="ec-dot ${stateClass}" title="${taskText}"></span>
      <span class="icon">${(AGENT_ICON[agent.kind] ?? tractorIconSvg)(30)}</span>
      <div class="ec-name">${agent.name}</div>
      <div class="ec-status" title="${taskText}">${taskText}</div>
      ${sub}`;

    // Manual escape hatch: a harvester holding grain with no `lastCrop` on
    // record (a leftover from before that tracking existed, ambiguous
    // because 2+ crops have silos so the automatic guess can't pick one) has
    // no other way to ever get a trailer routed to it — let the player say
    // what's in the hopper (maintainer request, 2026-07-13).
    if (agent.kind === "harvester" && (agent.grainOnboard ?? 0) > 0 && !agent.lastCrop) {
      const select = document.createElement("select");
      select.className = "er-crop-select";
      select.innerHTML =
        `<option value="">Which crop is onboard?</option>` +
        (Object.keys(gameConfig.crops) as CropId[])
          .map((c) => `<option value="${c}">${gameConfig.crops[c].emoji} ${gameConfig.crops[c].name}</option>`)
          .join("");
      select.addEventListener("change", () => {
        if (!select.value) return;
        try {
          setHarvesterCrop(save, agent.id, select.value as CropId);
          afterFleetChange();
          toast(`Marked ${agent.name}'s load as ${gameConfig.crops[select.value as CropId].name.toLowerCase()} — a Grain Trailer is on its way`);
        } catch (err) {
          toast("❌ " + (err as Error).message, 3500);
        }
      });
      row.appendChild(select);
    }

    const actions = document.createElement("div");
    actions.className = "ec-actions";
    actions.appendChild(locateButton(agent.name, agent.pos));

    const refund = agent.purchaseCost ?? (agent.size ? agentPrice(agent.kind as EquipmentKind, agent.size) : 0);
    actions.appendChild(
      iconButton("💰", agent.state !== "idle" ? `${agent.name} is mid-job` : `Sell · $${refund.toLocaleString()}`, agent.state !== "idle", () => {
        if (!confirm(`Sell ${agent.name} for $${refund.toLocaleString()}?`)) return;
        const { refund: paid } = sellAgent(save, agent.id);
        afterFleetChange();
        toast(`💰 Sold ${agent.name} for $${paid.toLocaleString()}`);
      }),
    );
    row.appendChild(actions);
    rows.appendChild(row);
  }
}

const IMPLEMENT_ICON = IMPLEMENT_ICON_SVG;

/** IMPLEMENTS you attach: every plow/planter, with a selector to hitch it to a
 * tractor (or park it in the yard) and a sell button. */
function buildEquipImplements(): void {
  const rows = $("equip-implements");
  rows.innerHTML = "";
  const implements_ = save.implements;
  if (implements_.length === 0) {
    rows.innerHTML = `<div id="fields-empty">No implements — buy a plow and a planter so a tractor can till and seed.</div>`;
    return;
  }
  for (const impl of implements_) {
    const host = impl.attachedTo ? save.agents.find((a) => a.id === impl.attachedTo) : undefined;
    const where = host ? `On ${host.name}` : "In the yard";
    const refund = impl.purchaseCost ?? implementPrice(impl.kind, impl.size);
    const sizeLine = impl.kind === "grainTrailer"
      ? `${grainTrailerCapacityTons(impl.size)}t capacity${impl.cargoTons ? ` · ${impl.cargoTons.toFixed(1)}t onboard` : ""}`
      : `${gameConfig.equipment[impl.kind][impl.size].widthFt} ft wide`;

    // Same dot language as the Machines cards: green while its host tractor
    // is actively working, gold while driving, gray otherwise (in the yard
    // or hitched to an idle tractor).
    const stateClass = host?.state === "working" ? "working" : host?.state === "traveling" ? "traveling" : "idle";
    const statusText = `${where} · ${sizeLine}`;

    const row = document.createElement("div");
    row.className = `equip-card implement ${stateClass}`;
    row.innerHTML = `
      <span class="ec-dot ${stateClass}" title="${statusText}"></span>
      <span class="icon">${(IMPLEMENT_ICON[impl.kind] ?? plowIconSvg)(30)}</span>
      <div class="ec-name">${implementName(save, impl)}</div>
      <div class="ec-status" title="${statusText}">${statusText}</div>`;

    row.appendChild(hitchSelector(impl));

    const busy = !!host && host.state !== "idle";
    const actions = document.createElement("div");
    actions.className = "ec-actions";
    actions.appendChild(
      iconButton("💰", busy ? `${host!.name} is using this` : `Sell · $${refund.toLocaleString()}`, busy, () => {
        if (!confirm(`Sell ${implementName(save, impl)} for $${refund.toLocaleString()}?`)) return;
        const { refund: paid } = sellImplement(save, impl.id);
        afterFleetChange();
        toast(`💰 Sold for $${paid.toLocaleString()}`);
      }),
    );
    row.appendChild(actions);
    rows.appendChild(row);
  }
}

/** A <select> on the implement side to hitch it to a compatible idle tractor, or
 * unhitch it to the yard. Tractors must be able to pull this size and be idle. */
function hitchSelector(impl: Implement): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "er-hitch";
  const host = impl.attachedTo ? save.agents.find((a) => a.id === impl.attachedTo) : undefined;
  const sel = document.createElement("select");
  sel.className = "hitch-select";
  // Can't re-hitch while the current host is mid-job.
  sel.disabled = !!host && host.state !== "idle";
  sel.title = sel.disabled ? "That tractor is mid-job" : "Attach to a tractor";

  const yard = new Option("— in the yard —", "");
  yard.selected = !host;
  sel.add(yard);
  for (const t of save.agents) {
    if (t.kind !== "tractor" || !t.size || !canPull(t.size, impl.size)) continue;
    if (t.state !== "idle" && t.id !== host?.id) continue; // only idle tractors (or the current host)
    const o = new Option(t.name, t.id);
    if (t.id === host?.id) o.selected = true;
    sel.add(o);
  }
  sel.addEventListener("change", () => {
    try {
      if (sel.value === "") detachImplement(save, impl.id);
      else attachImplement(save, sel.value, impl.id);
      afterFleetChange();
    } catch (err) {
      toast("❌ " + (err as Error).message, 3500);
      refreshEquipTab(true);
    }
  });
  wrap.appendChild(sel);
  return wrap;
}

function locateButton(name: string, pos: Meters): HTMLButtonElement {
  return iconButton("📍", `Fly to ${name}`, false, () => {
    mapRef.flyTo({ center: toLngLat(pos), zoom: Math.max(mapRef.getZoom(), 14) });
  });
}

function iconButton(label: string, title: string, disabled: boolean, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "er-btn";
  btn.textContent = label;
  btn.title = title;
  btn.disabled = disabled;
  btn.addEventListener("click", () => {
    try {
      onClick();
    } catch (err) {
      toast("❌ " + (err as Error).message, 3500);
    }
  });
  return btn;
}

// ---------------------------------------------------------------------------
// Persistence: auto-save. (The old top-left Reset button is gone — the
// Settings tab's per-farm Delete does the same "wipe and start over" job,
// scoped to a specific farm instead of a blanket single-slot reset.)
// ---------------------------------------------------------------------------
let resetting = false;

function doSave() {
  if (resetting) return; // switching/deleting a farm is wiping this save — don't write it back
  persistGame({ save, clockNow: clock.time(), daysPerMonth: getDaysPerMonth() });
}

function wirePersistence() {
  // Auto-save every 5s and on tab close/hide. The state is a few KB — cheap.
  setInterval(doSave, 5000);
  window.addEventListener("beforeunload", doSave);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") doSave();
  });
}

// ---------------------------------------------------------------------------
// Time controls: Real-Time / 1 hr=1 day / 1 hr=1 month / 1 hr=1 year, plus a
// skip-to-month montage. Pause (spd-pause) and the old 3600× tier (spd-3600)
// are kept wired but hidden (maintainer request, 2026-07-14) — not deleted,
// in case they're wanted back.
// ---------------------------------------------------------------------------
/** 1× = literal real time: 1 sim-minute per real minute. Multiples of this base
 * give the other speeds their exact "1 real hour = N game time" meaning —
 * verified 2026-07-14 against the current calendar (12h day, 3 days/month):
 *   12×  → 1 real hour = 1 game day EXACTLY (day length is a fixed 12h, not a
 *          knob, so this one holds regardless of the days-per-month setting)
 *   36×  → 1 real hour = 1 game month, AT THE 3-DAYS/MONTH DEFAULT (branded
 *          "1 hr = 1 month"; a save carrying an old, pre-2026-07-14
 *          days-per-month value will drift off this)
 *   432× → 1 real hour = 1 game year, same 3-days/month caveat as above
 *          (branded "1 hr = 1 year")
 *   3600× → 1 real second = 1 game hour (hidden)
 * (60× and 720× were the previous month/year picks, calibrated for the old
 * 24h-day/30-day-month calendar — both overshot by 5/3× once the day
 * shrank to 12h and the default month to 3 days; replaced with 36×/432×.)
 */
const BASE_COMPRESSION = 1 / 60;

function wireTimeControls() {
  const speeds: Array<[string, number | null]> = [
    ["spd-pause", null],
    ["spd-1", 1],
    ["spd-12", 12],
    ["spd-36", 36],
    ["spd-432", 432],
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
  clock.setCompression(BASE_COMPRESSION * 36); // default pace: 1 hr = 1 month

  // Skip to the END of the current month (= the start of the next one), via the
  // same fully-simulated montage. Simpler than picking a month: one press moves
  // the season forward a step.
  $("skip-month").addEventListener("click", () => {
    const mpm = minutesPerMonth();
    const target = (Math.floor(clock.time() / mpm) + 1) * mpm; // start of next month
    runMontage(target);
  });

  // Jump straight to the start of Spring (March 1) — always the NEXT one,
  // even if the sim is already mid-March (mirrors nextMonthStart's semantics).
  $("skip-spring").addEventListener("click", () => {
    runMontage(nextMonthStart(clock.time(), 2)); // 2 = March, 0-based
  });

  // Auto-skip toggle: highlight (.active) reflects on/off; state persists.
  const autoBtn = $("auto-skip");
  autoBtn.classList.toggle("active", autoSkipEnabled);
  autoBtn.addEventListener("click", () => {
    autoSkipEnabled = !autoSkipEnabled;
    autoBtn.classList.toggle("active", autoSkipEnabled);
    localStorage.setItem("farm.autoSkip", autoSkipEnabled ? "on" : "off");
    idleSinceReal = null; // restart the idle clock either way
    toast(autoSkipEnabled ? "⏩ Auto-skip idle months: ON" : "⏸ Auto-skip idle months: OFF");
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
/** Auto-advance the season through dead stretches: if the farm's had no work
 * (no queued OR active tasks) for this long of REAL time, fire the same
 * Skip-Month montage on its own — so idle downtime doesn't need repeated
 * clicks (maintainer request, 2026-07-20). Re-arms after each auto-skip. */
const AUTO_SKIP_IDLE_MS = 60_000;
let idleSinceReal: number | null = null;
// Toggle (⏩ Auto button); persisted across reloads. Default ON.
let autoSkipEnabled = localStorage.getItem("farm.autoSkip") !== "off";
function maybeAutoSkipMonth(): void {
  // Off, mid-montage, paused, or any pending work (incl. system hauls) → reset
  // the idle clock and do nothing.
  if (!autoSkipEnabled || montageActive || clock.isPaused() || save.tasks.length > 0) {
    idleSinceReal = null;
    return;
  }
  const nowReal = performance.now();
  if (idleSinceReal === null) {
    idleSinceReal = nowReal;
    return;
  }
  if (nowReal - idleSinceReal < AUTO_SKIP_IDLE_MS) return;
  idleSinceReal = null; // re-arm; the next idle minute triggers the next skip
  const mpm = minutesPerMonth();
  const target = (Math.floor(clock.time() / mpm) + 1) * mpm; // start of next month
  runMontage(target);
}

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

const SPEED_MULT: Record<string, number> = { "spd-1": 1, "spd-12": 12, "spd-36": 36, "spd-432": 432, "spd-3600": 3600 };

/** Put compression + play state back to whatever the speed buttons say. */
function restoreSpeed(paused: boolean) {
  const active = document.querySelector("#timebar button.active")?.id ?? "spd-1";
  const mult = SPEED_MULT[active] ?? 1;
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

  $("btn-cropcal").addEventListener("click", () => toggleToolbarPanel("cropcal", updateHud));
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
  const pct = (months: number) => (months / MONTHS_PER_YEAR) * 100;
  for (const cropId of Object.keys(gameConfig.crops) as CropId[]) {
    const cfg = gameConfig.crops[cropId];
    const plantStart = disp(cfg.plantMonths[0]!);
    const plantLen = cfg.plantMonths.length;
    let bands = `<div class="band plant" style="left:${pct(plantStart)}%;width:${pct(plantLen)}%"></div>`;
    if (cfg.perennial) {
      // Perennials are cut on separate monthly windows — draw a plain harvest
      // bar per cutting month, same style as the annual crops below
      // (maintainer request: drop the special detached/inset "cut" look).
      for (const mo of cfg.harvestMonths ?? []) {
        bands += `<div class="band harv" style="left:${pct(disp(mo))}%;width:${pct(1)}%"></div>`;
      }
    } else {
      // Annual: harvest opens a grow-time after planting, as wide as the window.
      const harvStart = plantStart + cfg.growMonths;
      bands += `<div class="band harv" style="left:${pct(harvStart)}%;width:${pct(plantLen)}%"></div>`;
    }
    html += `<div class="crop">${cfg.emoji} ${cfg.name}</div>
      <div class="lane">${bands}</div>`;
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
  const lineId = "field-draft";
  const fillId = "field-draft-fill";

  function updateDraft() {
    const ring = verts.length >= 3 ? [...verts, verts[0]!] : verts;
    const line: LngLat[] = ring.map((m) => toLngLat(m));
    const lineData: Feature = {
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: line },
    };
    const lineSrc = map.getSource(lineId) as maplibregl.GeoJSONSource | undefined;
    if (lineSrc) {
      lineSrc.setData(lineData);
    } else {
      map.addSource(lineId, { type: "geojson", data: lineData });
      map.addLayer({
        id: lineId,
        type: "line",
        source: lineId,
        paint: { "line-color": "#ffe36e", "line-width": 2, "line-dasharray": [2, 1] },
      });
    }

    // Fill preview once there's an actual polygon to shade (3+ corners).
    const fillData: Feature = {
      type: "Feature",
      properties: {},
      geometry: { type: "Polygon", coordinates: verts.length >= 3 ? [line] : [] },
    };
    const fillSrc = map.getSource(fillId) as maplibregl.GeoJSONSource | undefined;
    if (fillSrc) {
      fillSrc.setData(fillData);
    } else {
      map.addSource(fillId, { type: "geojson", data: fillData });
      map.addLayer(
        { id: fillId, type: "fill", source: fillId, paint: { "fill-color": "#ffe36e", "fill-opacity": 0.25 } },
        lineId, // keep the outline drawn on top of the fill
      );
    }

    updateDrawPanel();
  }

  function clearDraft() {
    verts.length = 0;
    if (map.getLayer(fillId)) map.removeLayer(fillId);
    if (map.getLayer(lineId)) map.removeLayer(lineId);
    if (map.getSource(fillId)) map.removeSource(fillId);
    if (map.getSource(lineId)) map.removeSource(lineId);
  }

  function updateDrawPanel() {
    const acres = verts.length >= 3 ? areaAcres(verts) : 0;
    const cost = Math.round(acres * gameConfig.landPricePerAcre);
    $("df-corners").textContent = String(verts.length);
    $("df-cost").textContent = verts.length >= 3 ? `$${cost.toLocaleString()}` : "—";
    ($("df-finish") as HTMLButtonElement).disabled = verts.length < 3;
  }

  function endDrawing() {
    mode = "none";
    map.doubleClickZoom.enable();
    map.getCanvas().style.cursor = "";
    $("drawfieldpanel").style.display = "none";
    clearDraft();
  }

  /** Shared by the double-click-to-close gesture and the "Purchase Field"
   * button — confirm the price, then buy + name + hand off to gate placement. */
  function finishField(boundary: Meters[]) {
    if (boundary.length < 3) {
      toast("Need at least 3 corners — try again");
      updateDraft();
      return;
    }
    const acres = areaAcres(boundary);
    const cost = Math.round(acres * gameConfig.landPricePerAcre);
    endDrawing();
    if (!confirm(`Buy this ${acres.toFixed(1)} ac field for $${cost.toLocaleString()}?`)) return;
    try {
      const { field, acres: boughtAcres, cost: paid } = buyFieldFromBoundary(map, overlay, save, boundary);
      const defaultName = `Field ${save.fields.length}`; // buyFieldFromBoundary already pushed it
      const chosen = prompt("Name this field:", defaultName);
      field.name = (chosen ?? "").trim() || defaultName;
      // Seed gates at the road side + opposite, then hand the player the
      // same drag-to-place editor so they can designate the real entry points.
      field.accessPoints = defaultAccessPoints(field.boundary, roadNetRef);
      updateHud();
      toast(`🌾 Bought ${boughtAcres.toFixed(1)} ac for $${paid.toLocaleString()}`);
      openFieldPanel(field.id);
      refreshFieldsTab();
      startAccessEdit(field);
      toast("🚪 Drag the two gate markers to set this field's entry points");
    } catch (err) {
      toast("❌ " + (err as Error).message, 3500);
    }
  }

  $("btn-field").addEventListener("click", () => {
    mode = "field";
    clearDraft();
    closeFieldPanel();
    $("fieldstab").style.display = "none"; // get the panel out of the way to draw
    map.doubleClickZoom.disable();
    map.getCanvas().style.cursor = "crosshair";
    $("drawfieldpanel").style.display = "block";
    updateDrawPanel();
    toast("🚜 Click to place corners — double-click to close the field");
  });

  $("df-cancel").addEventListener("click", endDrawing);
  $("df-finish").addEventListener("click", () => finishField(verts.slice()));

  map.on("click", (e) => {
    if (mode !== "field") return;
    verts.push(toMeters([e.lngLat.lng, e.lngLat.lat]));
    updateDraft();
  });

  map.on("dblclick", () => {
    if (mode !== "field") return;
    // The double-click's two single clicks each pushed the same vertex; drop one.
    verts.pop();
    finishField(verts.slice());
  });
}

// ---------------------------------------------------------------------------
// Field selection + the cozy side panel.
/** One-click placement for buildings (mode = `building:<kind>`, set from the
 * Structures tab's shop). Unlike field drawing there's no draft —
 * the first click buys and drops it, then resets to "none" whether or not
 * the purchase succeeded (so a misclick/insufficient funds doesn't strand
 * the player in placement mode). */
function wireBuildingPlacement(map: maplibregl.Map) {
  map.on("click", (e) => {
    if (!mode.startsWith("building:")) return;
    const kind = mode.slice("building:".length) as BuildingKind;
    mode = "none";
    const pos = toMeters([e.lngLat.lng, e.lngLat.lat]);
    const size = kind === "silo" ? pendingSiloSize : undefined;
    try {
      buyBuildingAt(save, kind, pos, size);
      updateHud();
      refreshBuildingMarkers();
      toast(`🏗️ Built ${buildingDisplayName(kind, size)} for $${buildingPrice(kind, size).toLocaleString()}`);
    } catch (err) {
      toast("❌ " + (err as Error).message, 3500);
    }
  });
}

function refreshBuildingMarkers(): void {
  if (!mapRef) return;
  updateBuildingMarkers(mapRef, save.buildings, onBuildingClick);
}

/** What a building's popup shows below its name — capacity numbers from
 * config, plus the farm-wide total across every building of that kind. */
function buildingCapacityText(building: Building): string {
  switch (building.kind) {
    case "silo": {
      const per = siloCapacityOf(building.size ?? "small").toLocaleString();
      if (!building.assignedCrop) return `Holds ${per} t once assigned a crop below.`;
      const cfg = gameConfig.crops[building.assignedCrop];
      return `Holds ${per} t of ${cfg.name.toLowerCase()} · farm total ${siloCapacityForCrop(save, building.assignedCrop).toLocaleString()} t`;
    }
    case "baleBarn":
      return `Bale storage: ${storedBalesTotal(building)} / ${baleStorageCapacityOf("baleBarn").toLocaleString()} bales`;
    case "baleArea":
      return `Bale storage: ${storedBalesTotal(building)} bales · unlimited (outdoor)`;
    case "tractorBarn":
      return `Tractor slots: ${gameConfig.buildings.tractorBarn.slots} · farm total ${barnSlotTotal(save, "tractorBarn")}`;
    case "implementBarn":
      return `Implement slots: ${gameConfig.buildings.implementBarn.slots} · farm total ${barnSlotTotal(save, "implementBarn")}`;
    case "farmYard":
      return "Rally point — new equipment parks here";
    case "sellPoint":
      return "No capacity — a bale hauler sells here on the spot when Bale Storage is missing or full";
  }
}

function onBuildingClick(building: Building): void {
  const refund = buildingPrice(building.kind, building.size);
  const name = buildingDisplayName(building.kind, building.size);
  const el = document.createElement("div");
  el.className = "building-popup";
  el.innerHTML = `
    <div class="bp-title">${BUILDING_ICON[building.kind]} ${name}</div>
    <div class="bp-cap">${buildingCapacityText(building)}</div>`;

  if (building.kind === "silo") {
    const select = document.createElement("select");
    select.className = "bp-crop-select";
    select.innerHTML =
      `<option value="">— assign a crop —</option>` +
      (Object.keys(gameConfig.crops) as CropId[])
        .map((c) => `<option value="${c}">${gameConfig.crops[c].emoji} ${gameConfig.crops[c].name}</option>`)
        .join("");
    select.value = building.assignedCrop ?? "";
    select.addEventListener("change", () => {
      assignSiloCrop(save, building.id, (select.value || undefined) as CropId | undefined);
      refreshInventory();
      popup.remove();
      onBuildingClick(building); // re-open with updated capacity text
    });
    el.appendChild(select);
  }

  const sellBtn = document.createElement("button");
  sellBtn.className = "shop-buy";
  sellBtn.textContent = `Sell · $${refund.toLocaleString()}`;
  sellBtn.addEventListener("click", () => {
    if (!confirm(`Sell ${name} for $${refund.toLocaleString()}?`)) return;
    sellBuilding(save, building.id);
    updateHud();
    refreshBuildingMarkers();
    toast(`💰 Sold ${name} for $${refund.toLocaleString()}`);
    popup.remove();
  });
  el.appendChild(sellBtn);
  const popup = new maplibregl.Popup({ closeButton: true, offset: 16 })
    .setLngLat(toLngLat(building.pos))
    .setDOMContent(el)
    .addTo(mapRef);
}

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

  $("fp-rename").addEventListener("click", () => {
    const field = save.fields.find((f) => f.id === selectedFieldId);
    if (!field) return;
    const chosen = prompt("Rename this field:", fieldLabel(field));
    if (chosen === null) return; // cancelled — keep the existing name
    field.name = chosen.trim() || field.name;
    refreshFieldPanel(true);
    refreshFieldsTab();
  });

  ($("fp-auto") as HTMLInputElement).addEventListener("change", (e) => {
    const field = save.fields.find((f) => f.id === selectedFieldId);
    if (!field) return;
    field.autoManage = (e.target as HTMLInputElement).checked;
    if (field.autoManage) {
      // Seed a starter rotation plan the first time it's switched on.
      if (!field.plans || field.plans.length === 0) field.plans = [defaultPlan()];
      // Act immediately rather than waiting for the next tick, so flipping the
      // switch feels responsive.
      autoManageField(save, field, clock.time());
      renderField(mapRef, overlay, field, clock.time());
      updateHud();
      toast(`🤖 ${fieldLabel(field)} will run its rotation plan`);
    } else {
      toast(`🖐️ ${fieldLabel(field)} is back to manual control`);
    }
    refreshFieldPanel(true);
  });

  $("fp-sell").addEventListener("click", () => {
    const field = save.fields.find((f) => f.id === selectedFieldId);
    if (!field) return;
    const refund = field.purchaseCost ?? Math.round(areaAcres(field.boundary) * gameConfig.landPricePerAcre);
    if (!confirm(`Sell ${fieldLabel(field)} for $${refund.toLocaleString()}?`)) return;
    try {
      const { refund: paid } = sellField(mapRef, overlay, save, field.id);
      updateHud();
      toast(`💰 Sold ${fieldLabel(field)} for $${paid.toLocaleString()}`);
      closeFieldPanel();
      refreshFieldsTab();
    } catch (err) {
      toast("❌ " + (err as Error).message, 3500);
    }
  });
}

/** Small floating badge that follows the cursor over an owned field — crop +
 * a productivity readout (maintainer request, 2026-07-16). No penalty/boost
 * mechanic exists yet, so productivity is a flat 100% placeholder for every
 * field until that system lands. */
function wireFieldHover(map: maplibregl.Map) {
  const badge = $("field-badge");
  let hoveredId: string | null = null;

  function positionBadge(field: Field) {
    const centroid = toLngLat(centroidOf(field.boundary));
    const pt = map.project(centroid);
    const rect = map.getContainer().getBoundingClientRect();
    badge.style.left = `${rect.left + pt.x}px`;
    badge.style.top = `${rect.top + pt.y}px`;
  }

  map.on("mousemove", (e) => {
    if (mode !== "none") {
      hoveredId = null;
      badge.style.display = "none";
      return;
    }
    const p = toMeters([e.lngLat.lng, e.lngLat.lat]);
    const hit = save.fields.find((f) => pointInPolygon(p, f.boundary));
    if (!hit) {
      hoveredId = null;
      badge.style.display = "none";
      return;
    }
    if (hit.id !== hoveredId) {
      hoveredId = hit.id;
      const cropIcon = hit.crop ? gameConfig.crops[hit.crop].emoji : "🟫";
      const cropName = hit.crop ? gameConfig.crops[hit.crop].name : "No crop planted";
      const boost = Math.round(productivityMultiplier(hit, clock.time()) * 100);
      badge.innerHTML = `
        <div class="fb-icon">${cropIcon}</div>
        <div class="fb-text">
          <div class="fb-name">${fieldLabel(hit)}</div>
          <div class="fb-crop">${cropName}</div>
          <div class="fb-boost">⚡ ${boost}%</div>
        </div>`;
      badge.style.display = "flex";
    }
    positionBadge(hit);
  });
  map.on("mouseleave", () => {
    hoveredId = null;
    badge.style.display = "none";
  });
  // Stay pinned to the field's centroid while panning/zooming, not the cursor.
  map.on("move", () => {
    if (!hoveredId) return;
    const field = save.fields.find((f) => f.id === hoveredId);
    if (field) positionBadge(field);
  });
}

function openFieldPanel(fieldId: string) {
  if (accessEditFieldId && accessEditFieldId !== fieldId) stopAccessEdit();
  selectedFieldId = fieldId;
  $("fieldpanel").style.display = "block";
  refreshFieldPanel();
}

function closeFieldPanel() {
  stopAccessEdit();
  selectedFieldId = null;
  $("fieldpanel").style.display = "none";
}

// --- Access-point editing (maintainer request, 2026-07-12) -------------------
// Gates are INVISIBLE on the map except while this edit mode is on: two
// draggable 🚪 markers appear, dragging updates the field's accessPoints
// live, and Done/close hides them again.
let accessEditFieldId: string | null = null;
const accessMarkers: maplibregl.Marker[] = [];

function startAccessEdit(field: Field): void {
  stopAccessEdit();
  accessEditFieldId = field.id;
  field.accessPoints ??= defaultAccessPoints(field.boundary, roadNetRef);
  field.accessPoints.forEach((pt, i) => {
    const el = document.createElement("div");
    el.className = "access-dot";
    el.innerHTML = `🚪<span class="n">${i + 1}</span>`;
    el.title = `Access point ${i + 1} — drag to move`;
    const marker = new maplibregl.Marker({ element: el, draggable: true })
      .setLngLat(toLngLat(pt))
      .addTo(mapRef);
    // Snap continuously to the boundary as it's dragged — a gate can only
    // slide along the fence line, never float into the middle of the field.
    marker.on("drag", () => {
      const ll = marker.getLngLat();
      const snapped = nearestPointOnPolygon(toMeters([ll.lng, ll.lat]), field.boundary);
      marker.setLngLat(toLngLat(snapped));
    });
    marker.on("dragend", () => {
      const ll = marker.getLngLat();
      field.accessPoints![i] = toMeters([ll.lng, ll.lat]);
    });
    accessMarkers.push(marker);
  });
  refreshFieldPanel(true);
}

function stopAccessEdit(): void {
  if (!accessEditFieldId) return;
  for (const m of accessMarkers) m.remove();
  accessMarkers.length = 0;
  accessEditFieldId = null;
}

function fieldMsg(text: string) {
  $("fp-msg").textContent = text;
}

/** Queue a task from a panel button, with shared feedback plumbing. */
function queueFromPanel(field: Field, type: "plow" | "plant" | "harvest" | "mow" | "weed" | "fertilize" | "rake" | "bale", crop?: CropId): void {
  try {
    const task = enqueueTask(save, field, type, clock.time(), crop);
    updateHud();
    fieldMsg("");
    toast(`📋 ${cap(taskVerb(task))} ${fieldLabel(field)} added to the queue`);
    refreshQueuePanel();
    refreshFieldPanel(true);
  } catch (err) {
    fieldMsg((err as Error).message);
  }
}

// --- Rotation planner (the auto-manage designer) ---------------------------
let lastPlansKey = "";

/** Force the planner (and panel) to rebuild after an edit. */
function editPlans(): void {
  lastPlansKey = "";
  refreshFieldPanel(true);
}

/** Render the field's rotation plans into #fp-plans — one row per campaign year,
 * each with a crop and the optional-operation toggles. Own change-detection so
 * its dropdowns aren't rebuilt under the cursor on every tick. */
function refreshPlanEditor(field: Field, now: number, auto: boolean): void {
  const container = $("fp-plans");
  const key = [field.id, auto ? 1 : 0, dateOf(now).year, JSON.stringify(field.plans ?? [])].join("|");
  if (key === lastPlansKey) return;
  lastPlansKey = key;
  container.innerHTML = "";
  if (!auto) return;

  if (!field.plans || field.plans.length === 0) field.plans = [defaultPlan()];
  // A perennial stand (grass/alfalfa) is planted once and never rotated — its
  // "plan" is a single row (no per-year rotation). Collapse to plans[0].
  const perennialField = isPerennial(field.plans[0]!.crop);
  if (perennialField && field.plans.length > 1) field.plans.length = 1;
  const plans = field.plans;
  const activeIdx = (dateOf(now).year - 1) % plans.length;

  container.insertAdjacentHTML(
    "beforeend",
    perennialField
      ? `<div class="plan-hint">Perennial stand — one plan, cut every year (no rotation).</div>`
      : `<div class="plan-hint">Rotation — one plan per year, loops after Yr ${plans.length}. Running Yr ${activeIdx + 1} now.</div>`,
  );

  const ops: Array<{ prop: "weed" | "fertilize" | "bale"; icon: string; title: string }> = [
    { prop: "weed", icon: "💦", title: "Weed once, when the window opens" },
    { prop: "fertilize", icon: "🌿", title: "Fertilize once, the month after planting" },
    { prop: "bale", icon: "📦", title: "Rake + bale the residue after harvest (forage crops)" },
  ];

  plans.forEach((plan, i) => {
    const row = document.createElement("div");
    row.className = "plan-row" + (i === activeIdx ? " active" : "");

    const yr = document.createElement("span");
    yr.className = "plan-yr";
    yr.textContent = "Yr" + (i + 1);
    row.appendChild(yr);

    const sel = document.createElement("select");
    sel.className = "plan-crop";
    for (const cropId of Object.keys(gameConfig.crops) as CropId[]) {
      const opt = document.createElement("option");
      opt.value = cropId;
      opt.textContent = `${gameConfig.crops[cropId].emoji} ${gameConfig.crops[cropId].name}`;
      if (cropId === plan.crop) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener("change", () => {
      plan.crop = sel.value as CropId;
      if (!gameConfig.crops[plan.crop].producesForage) plan.bale = false; // baling is forage-only
      // Switching TO a perennial collapses any rotation to this single plan;
      // perennials also default to baling (hay) and never weed.
      if (isPerennial(plan.crop)) {
        field.plans = [plan];
        plan.weed = false;
        plan.bale = true;
      }
      editPlans();
    });
    row.appendChild(sel);

    for (const o of ops) {
      // Perennials only expose Fertilize & Bale (no weeding) — hide the weed op.
      if (o.prop === "weed" && isPerennial(plan.crop)) continue;
      const b = document.createElement("button");
      const forageOnly = o.prop === "bale" && !gameConfig.crops[plan.crop].producesForage;
      b.className = "plan-op" + (plan[o.prop] ? " on" : "");
      b.textContent = o.icon;
      b.title = forageOnly ? "Only forage crops (e.g. corn) can be baled" : o.title;
      b.disabled = forageOnly;
      b.addEventListener("click", () => {
        plan[o.prop] = !plan[o.prop];
        editPlans();
      });
      row.appendChild(b);
    }

    if (plans.length > 1) {
      const del = document.createElement("button");
      del.className = "plan-del";
      del.textContent = "✕";
      del.title = "Remove this rotation year";
      del.addEventListener("click", () => {
        plans.splice(i, 1);
        editPlans();
      });
      row.appendChild(del);
    }
    container.appendChild(row);
  });

  // Perennial stands don't rotate — no "add year" button (maintainer request).
  if (!perennialField) {
    const add = document.createElement("button");
    add.className = "plan-add";
    add.textContent = "＋ Add rotation year";
    add.disabled = plans.length >= 5;
    add.addEventListener("click", () => {
      if (plans.length >= 5) return;
      // Default the new year to a DIFFERENT, non-perennial crop for an easy rotation.
      const crops = (Object.keys(gameConfig.crops) as CropId[]).filter((c) => !gameConfig.crops[c].perennial);
      const nextCrop = crops.find((c) => c !== plans[plans.length - 1]!.crop) ?? crops[0]!;
      plans.push({ crop: nextCrop, bale: !!gameConfig.crops[nextCrop].producesForage });
      editPlans();
    });
    container.appendChild(add);
  }
}

/** Rebuild the panel contents from the selected field's current state. */
let lastPanelKey = "";
function refreshFieldPanel(force = false) {
  const field = save.fields.find((f) => f.id === selectedFieldId);
  if (!field) return closeFieldPanel();
  const now = clock.time();
  const acres = areaAcres(field.boundary);
  const pending = tasksFor(save, field.id);
  const activeTask = pending.find((t) => t.status === "active");
  const harvestingNow = isFieldHarvesting(save, field.id);
  // What the field WILL be once queued work finishes — buttons offer the NEXT
  // step, so plow + plant can be queued back-to-back.
  const eff = effectiveStatus(save, field);

  // Skip the rebuild when nothing visible changed — replacing buttons under the
  // player's cursor twice a second makes them unclickable. Growth/task progress
  // is bucketed to 1% so live bars still animate.
  const auto = !!field.autoManage;
  const key = [
    field.id, field.status, eff, auto,
    pending.map((t) => `${t.type}${t.status}${Math.round((t.doneAcres / t.totalAcres) * 100)}`).join(","),
    Math.round(growthProgress(field, now) * 100),
    dateOf(now).month, // planting windows open/close on month boundaries
    Math.round(save.money), // affordability of input costs
    field.forageReady ? 1 : 0, field.windrowed ? 1 : 0, field.baleLocations?.length ?? 0, // forage/bale state
    field.weedy ? 1 : 0, field.baleProduct ?? "", field.cutsThisYear ?? 0, field.cutYear ?? 0, // perennial/bale
    accessEditFieldId === field.id ? "gates" : "",
  ].join("|");
  // The rotation planner has its OWN change-detection (below) so its dropdowns
  // don't get rebuilt under the cursor on every money/status tick.
  refreshPlanEditor(field, now, auto);
  if (!force && key === lastPanelKey) return;
  lastPanelKey = key;

  $("fp-title").textContent = "🌾 " + fieldLabel(field);
  $("fp-sub").textContent = `${acres.toFixed(1)} acres`;
  const badge = $("fp-status");
  badge.textContent = activeTask ? taskVerb(activeTask) : field.status;
  ($("fp-auto") as HTMLInputElement).checked = auto;

  const refund = field.purchaseCost ?? Math.round(acres * gameConfig.landPricePerAcre);
  const sellBtn = $("fp-sell") as HTMLButtonElement;
  sellBtn.textContent = `💰 Sell Field · $${refund.toLocaleString()}`;
  sellBtn.disabled = !!activeTask;
  sellBtn.title = activeTask ? "Can't sell while a machine is working it" : "";

  const body = $("fp-body");
  const actions = $("fp-actions");
  body.innerHTML = "";
  actions.innerHTML = "";

  // --- Queued/active work on this field ---
  for (const t of pending) {
    const pct = Math.round((t.doneAcres / t.totalAcres) * 100);
    body.insertAdjacentHTML(
      "beforeend",
      `<div class="small" style="margin-top:6px">📋 ${cap(taskVerb(t))} — ${
        t.status === "active" ? `${pct}% done` : "waiting in queue"
      }</div>` + (t.status === "active" ? `<div class="progress"><div class="fill" style="width:${pct}%"></div></div>` : ""),
    );
  }

  // --- Bales sitting in the field (persist until sold) — the field's market ---
  const bales = field.baleLocations?.length ?? 0;
  if (bales > 0) {
    const product = gameConfig.baleProducts[field.baleProduct ?? "cornStover"];
    const value = Math.round(bales * product.pricePerBale);
    const tons = (bales * gameConfig.forage.baleTons).toFixed(0);
    body.insertAdjacentHTML("beforeend", `<div class="small" style="margin-top:8px">📦 <b>${bales}</b> ${product.name} bales (${tons} t) · $${product.pricePerBale.toLocaleString()}/bale</div>`);
    const btn = document.createElement("button");
    btn.className = "primary";
    btn.innerHTML = `💰 Sell Bales <span class="small">$${value.toLocaleString()}</span>`;
    btn.addEventListener("click", () => {
      const { bales: sold, revenue } = sellBales(save, field);
      if (sold <= 0) return;
      logSale("sellBales", { fieldId: field.id, label: product.name, bales: sold, tons: sold * gameConfig.forage.baleTons, revenue });
      updateHud();
      refreshFieldPanel(true);
      updateBaleMarkers();
      toast(`💰 Sold ${sold} bales for $${revenue.toLocaleString()}`);
    });
    actions.appendChild(btn);

    // Haul these bales to Bale Storage (a Hay-Spikes tractor collects them,
    // pulling in a Bale Trailer if one's idle). Hidden once a haul's already
    // covering the field — baling auto-queues one (maintainer request,
    // 2026-07-17).
    if (fieldHasLooseBales(save, field.id)) {
      const haulBtn = document.createElement("button");
      haulBtn.innerHTML = `🚜 Haul to Storage`;
      haulBtn.title = "Send a Hay-Spikes tractor to move these bales into Bale Storage";
      haulBtn.addEventListener("click", () => {
        if (!queueHaulBales(save, field.id)) {
          toast("Nothing to haul, or a haul's already running");
          return;
        }
        refreshQueuePanel();
        refreshFieldPanel(true);
        toast("🚜 Haul Bales queued — a Hay-Spikes tractor is on it");
      });
      actions.appendChild(haulBtn);
    }
  }

  // --- Manual controls (only when NOT auto-managed; the planner drives the rest). ---
  // --- Forage loop: a harvested forage field gets raked + baled before it can
  // re-plow (only when the farm owns the gear; otherwise it just plows under). ---
  if (!auto && field.status === "harvested" && field.forageReady) {
    if (forageDue(save, field)) {
      const rakeCost = taskCost(field, "rake");
      const baleCost = taskCost(field, "bale");
      body.insertAdjacentHTML("beforeend", `<div class="small" style="margin-top:8px">Rake, then bale the forage (the baler follows the rake). Baling drops bales you can sell.</div>`);
      const row = document.createElement("div");
      row.className = "cropbtns";
      const hasRake = tasksFor(save, field.id, "rake").length > 0;
      const hasBale = tasksFor(save, field.id, "bale").length > 0;
      if (!hasRake) {
        const btn = document.createElement("button");
        btn.innerHTML = `🧹 Rake<br><span class="small">$${rakeCost.toLocaleString()}</span>`;
        btn.addEventListener("click", () => queueFromPanel(field, "rake"));
        row.appendChild(btn);
      }
      if (!hasBale) {
        const btn = document.createElement("button");
        btn.innerHTML = `📦 Bale<br><span class="small">$${baleCost.toLocaleString()}</span>`;
        const canBale = field.windrowed || hasRake;
        if (!canBale) {
          btn.disabled = true;
          btn.title = "Rake the field first — the baler follows the rake";
          btn.style.opacity = "0.45";
        }
        btn.addEventListener("click", () => queueFromPanel(field, "bale"));
        row.appendChild(btn);
      }
      if (row.children.length > 0) body.appendChild(row);
    } else {
      const under = isPerennial(field.crop) ? "; without the gear it's left to regrow" : ", or plow it under";
      body.insertAdjacentHTML("beforeend", `<div class="small" style="margin-top:8px">Forage left on the field. Buy a 🧹 rake &amp; 📦 baler to bale it${under}.</div>`);
    }
  }

  // Queue Plow is ALWAYS offered, any time of year, whether or not the field
  // has a (even perennial) crop standing on it (maintainer request,
  // 2026-07-16): the normal case (bare/harvested/mulched ground) just queues
  // it; anywhere else — including an established grass/alfalfa stand — it's
  // a manual "start over" that forfeits the standing crop/residue. This is
  // the ONLY way to clear a perennial; the automatic lifecycle never plows
  // one under. Auto-manage's own plowing still waits for winter — see the
  // season check in autoManageField.
  const plowableNow = canPlow(eff) && !isPerennial(field.crop) && !(eff === "harvested" && forageDue(save, field));
  if (!auto && !activeTask) {
    const cost = taskCost(field, "plow");
    body.insertAdjacentHTML(
      "beforeend",
      `<div class="small" style="margin-top:8px">${
        plowableNow ? "Plow to prepare for planting." : "Plow now to clear this field and start over."
      }</div>`,
    );
    const btn = document.createElement("button");
    btn.className = "primary";
    btn.innerHTML = `🚜 Queue Plow <span class="small">$${cost.toLocaleString()}</span>`;
    if (plowableNow) {
      btn.addEventListener("click", () => queueFromPanel(field, "plow"));
    } else {
      btn.addEventListener("click", () => {
        if (!confirm(`Plowing ${fieldLabel(field)} now clears its current crop and any residue. Continue?`)) return;
        try {
          forcePlow(save, field, clock.time());
          updateHud();
          fieldMsg("");
          toast(`🚜 ${fieldLabel(field)} plowed under and restarted`);
          refreshQueuePanel();
          refreshFieldPanel(true);
          updateBaleMarkers();
        } catch (err) {
          fieldMsg((err as Error).message);
        }
      });
    }
    actions.appendChild(btn);
  }

  // Plant chooser: both annuals and perennials (grass/alfalfa) need tilled
  // ground (maintainer request, 2026-07-16 — perennials used to seed
  // straight onto stubble with no plow).
  const canPlantAnnual = eff === "tilled";
  const canSeedPeren = canSeedPerennial(eff) && !field.crop;
  if (!auto && (canPlantAnnual || canSeedPeren)) {
    const plantable = (Object.keys(gameConfig.crops) as CropId[]).filter((c) =>
      gameConfig.crops[c].perennial ? canSeedPeren : canPlantAnnual,
    );
    body.insertAdjacentHTML("beforeend", `<div class="small" style="margin-top:8px">Plant a crop:</div>`);
    const row = document.createElement("div");
    row.className = "cropbtns";
    for (const cropId of plantable) {
      const cfg = gameConfig.crops[cropId];
      const cost = taskCost(field, "plant", cropId);
      const btn = document.createElement("button");
      const open = inPlantingWindow(cropId, now);
      btn.innerHTML = `${cfg.emoji} ${cfg.name}<br><span class="small">$${cost.toLocaleString()}</span>`;
      if (!open) {
        btn.disabled = true;
        btn.title = `Plant in ${cfg.plantMonths.map((mo) => MONTH_SHORT[mo]).join("–")}`;
        btn.style.opacity = "0.45";
      }
      btn.addEventListener("click", () => queueFromPanel(field, "plant", cropId));
      row.appendChild(btn);
    }
    body.appendChild(row);
    const windows = plantable
      .map((c) => `${gameConfig.crops[c].emoji} ${gameConfig.crops[c].plantMonths.map((mo) => MONTH_SHORT[mo]).join("–")}`)
      .join("   ");
    body.insertAdjacentHTML("beforeend", `<div class="small">${windows}</div>`);
  }

  if (field.crop) {
    // --- Growing / ready / harvesting ---
    const cfg = gameConfig.crops[field.crop];
    const progress = growthProgress(field, now);
    const range = yieldRange(field, now);

    let html = `<div style="margin-top:8px">${cfg.emoji} <b>${cfg.name}</b></div>`;
    if (field.weedy) {
      html += `<div class="small" style="color:var(--red)">🌿 Weeds are spreading — a weeding pass clears them</div>`;
    }
    if (isPerennial(field.crop)) {
      // Perennial: no grain yield / single-ripen growth — show the 3-cut
      // window progress (X of 3 cuttings this year) instead.
      const windows = cfg.harvestMonths ?? [];
      const done = field.cutYear === dateOf(now).year ? field.cutsThisYear ?? 0 : 0;
      const monthLabels = windows.map((m) => MONTH_SHORT[m]).join(" · ");
      html += `<div class="small">Perennial stand — cut ${done}/${windows.length} times this year (${monthLabels})</div>`;
    } else {
      if (!harvestingNow) {
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
    }
    body.insertAdjacentHTML("beforeend", html);

    // --- Weed & fertilize: independent side-tasks, no chaining with the
    // plow/plant/harvest lifecycle. Only offered while the crop is standing. ---
    if (!auto && hasStandingCrop(field.status)) {
      const row = document.createElement("div");
      row.className = "cropbtns";
      // Perennial forage crops don't get weeded — only fertilized.
      if (!isPerennial(field.crop) && tasksFor(save, field.id, "weed").length === 0) {
        const cost = taskCost(field, "weed");
        const open = inWeedingWindow(field, now);
        const btn = document.createElement("button");
        btn.innerHTML = `💦 Weed<br><span class="small">$${cost.toLocaleString()}</span>`;
        if (!open) {
          btn.disabled = true;
          btn.title = "Opens once the crop is growing, 2 months after planting";
          btn.style.opacity = "0.45";
        }
        btn.addEventListener("click", () => queueFromPanel(field, "weed"));
        row.appendChild(btn);
      }
      if (tasksFor(save, field.id, "fertilize").length === 0) {
        const cost = taskCost(field, "fertilize");
        const open = canFertilizeNow(field, now);
        const btn = document.createElement("button");
        btn.innerHTML = `🌿 Fertilize<br><span class="small">$${cost.toLocaleString()}</span>`;
        if (!open) {
          btn.disabled = true;
          btn.title = "Opens once the crop is growing, the month after planting";
          btn.style.opacity = "0.45";
        }
        btn.addEventListener("click", () => queueFromPanel(field, "fertilize"));
        row.appendChild(btn);
      }
      if (row.children.length > 0) body.appendChild(row);
    }

    if (!auto && field.status === "ready") {
      // Perennial forage is CUT with a mower (→ rake → bale); annuals are
      // combined. Whichever applies, offer the one button.
      if (isPerennial(field.crop)) {
        if (tasksFor(save, field.id, "mow").length === 0) {
          const cost = taskCost(field, "mow");
          const btn = document.createElement("button");
          btn.className = "primary";
          btn.innerHTML = `🌾 Queue Cut (Mow) <span class="small">$${cost.toLocaleString()}</span>`;
          btn.addEventListener("click", () => queueFromPanel(field, "mow"));
          actions.appendChild(btn);
        }
      } else if (tasksFor(save, field.id, "harvest").length === 0) {
        const btn = document.createElement("button");
        btn.className = "primary";
        btn.textContent = "🌾 Queue Harvest";
        btn.addEventListener("click", () => queueFromPanel(field, "harvest"));
        actions.appendChild(btn);
      }
    }
  }

  // --- Access points: two gates machines enter/leave through. Invisible on
  // the map until this edit mode shows their draggable markers. ---
  {
    const editing = accessEditFieldId === field.id;
    const row = document.createElement("div");
    row.className = "access-row";
    if (editing) {
      row.insertAdjacentHTML("beforeend", `<div class="small">Drag the two 🚪 markers on the map, then press Done.</div>`);
    }
    const btn = document.createElement("button");
    btn.className = editing ? "primary" : "";
    btn.style.width = "100%";
    btn.textContent = editing ? "✅ Done — save access points" : "🚪 Edit access points";
    btn.title = "The two gates machines use to enter and leave this field";
    btn.addEventListener("click", () => {
      if (accessEditFieldId === field.id) {
        stopAccessEdit();
        toast(`🚪 ${fieldLabel(field)}'s access points saved`);
        refreshFieldPanel(true);
      } else {
        startAccessEdit(field);
        toast("🚪 Drag the markers to move this field's gates");
      }
    });
    row.appendChild(btn);
    actions.appendChild(row);
  }
}

function prettyId(id: string): string {
  return id.replace("-", " ").replace(/^\w/, (c) => c.toUpperCase());
}

function fieldLabel(field: Field): string {
  return field.name || prettyId(field.id);
}

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return text.replace(/[&<>"']/g, (c) => map[c]!);
}

main().catch((err) => {
  devStatus("status-naip", "Failed to load county: " + (err as Error).message, "err");
  console.error(err);
});
