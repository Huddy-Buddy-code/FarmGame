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
import type { SaveState, Field, Building, BuildingKind } from "./state/saveState";
import { buyFieldFromBoundary, renderField, initIdCounters, sellField, hashSeed } from "./field/fields";
import { drawFieldTexture } from "./field/fieldRender";
import { updateBuildingMarkers, BUILDING_ICON } from "./field/buildingRender";
import {
  buyBuildingAt, sellBuilding, buildingPrice, buildingDisplayName, initBuildingIdCounters,
  BUILDING_NAME, siloCapacityForCrop, siloCapacityOf, assignSiloCrop,
  baleCapacity, barnSlotTotal, nearestFarmYard,
} from "./sim/buildings";
import { distanceAtWork } from "./sim/coverage";
import type { CoveragePath } from "./sim/coverage";
import {
  persistGame, loadGame, ensureActiveFarm, listFarms, createFarm,
  switchFarm, deleteFarm, getActiveFarmId, loadGameFor,
} from "./state/persistence";
import type { PersistedGame } from "./state/persistence";
import { sellGrain, sellBales, netWorth } from "./sim/economy";
import { SimClock } from "./sim/clock";
import {
  formatDate, dateOf, MONTH_NAMES, MONTH_SHORT,
  START_MONTH, MONTHS_PER_YEAR, MINUTES_PER_DAY,
  getDaysPerMonth, setDaysPerMonth, minutesPerMonth,
} from "./sim/calendar";
import {
  tickFarming, growthProgress, yieldRange, inPlantingWindow, canPlow,
  hasStandingCrop, inWeedingWindow, canFertilizeNow,
} from "./sim/farming";
import {
  ensureAgents, initTaskIds, enqueueTask, cancelTask, taskCost, tasksFor,
  isFieldHarvesting, effectiveStatus, tickTasks, autoManageAll, autoManageField,
  buyAgent, sellAgent, buyImplement, sellImplement, attachImplement, detachImplement,
  agentPrice, implementPrice, canPull, implementName, getCoveragePath,
  reorderTask, estimateTaskHours, forageDue, defaultPlan,
  harvesterCapacityTons, grainTrailerCapacityTons, setHarvesterCrop, setRoadNetwork, TASK_IMPLEMENT,
} from "./sim/tasks";
import { buildRoadNetwork } from "./sim/roadNet";
import type { RoadNetwork } from "./sim/roadNet";
import { defaultAccessPoints } from "./sim/access";
import {
  MACHINE_ICON, IMPLEMENT_ICON_SVG, tractorIconSvg, combineIconSvg, baleIconSvg,
  plowIconSvg, planterIconSvg, sprayerIconSvg, rakeIconSvg, balerIconSvg, grainTrailerIconSvg,
  grainHeaderIconSvg,
} from "./ui/icons";
import type { EquipmentKind, ImplementKind } from "./sim/tasks";
import {
  tickLoans, borrowOpen, paydownOpen, paydownLoan, refinanceLoan,
} from "./sim/finance";
import {
  CASHFLOW_CATEGORIES, CASHFLOW_LABEL, categoryTotal, netCashflow, ledgerYears,
} from "./sim/ledger";
import type { FarmTask, Agent, Implement, FieldStatus, TaskType } from "./state/saveState";
import { gameConfig } from "./config/gameConfig";
import type { CropId, EquipmentSize } from "./config/gameConfig";

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
    wireTimeControls();
    buildCropCalendar();
    wireInventory();
    wireFieldsTab();
    wireEquipTab();
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
    refreshFinanceTab();
    refreshQueuePanel();
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
  if (task.type === "weed") return "weeding";
  if (task.type === "fertilize") return "fertilizing";
  if (task.type === "rake") return "raking";
  if (task.type === "bale") return "baling";
  if (task.type === "unloadHarvester") return "hauling grain";
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

function makeBaleMarker(p: Meters): maplibregl.Marker {
  const el = document.createElement("div");
  el.className = "bale-dot";
  el.innerHTML = baleIconSvg(14);
  return new maplibregl.Marker({ element: el }).setLngLat(toLngLat(p)).addTo(mapRef!);
}

/** Markers for a field's bales — all of them, or an EVEN subsample if a field
 * somehow tops the ceiling (uniform coverage, never a bare last corner). */
function baleMarkersFor(locs: Meters[]): maplibregl.Marker[] {
  if (locs.length <= MAX_BALE_MARKERS) return locs.map(makeBaleMarker);
  const out: maplibregl.Marker[] = [];
  for (let i = 0; i < MAX_BALE_MARKERS; i++) out.push(makeBaleMarker(locs[Math.floor((i * locs.length) / MAX_BALE_MARKERS)]!));
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
    const existing = baleMarkers.get(field.id);
    if (existing && existing.count === locs.length) continue; // no change
    if (!existing) {
      baleMarkers.set(field.id, { count: locs.length, markers: baleMarkersFor(locs) });
    } else if (locs.length > existing.count && locs.length <= MAX_BALE_MARKERS) {
      // Common case while baling: just add markers for the NEW drops.
      for (let i = existing.count; i < locs.length; i++) existing.markers.push(makeBaleMarker(locs[i]!));
      existing.count = locs.length;
    } else {
      // Shrank (some sold), or crossed the subsample ceiling — rebuild.
      for (const m of existing.markers) m.remove();
      baleMarkers.set(field.id, { count: locs.length, markers: baleMarkersFor(locs) });
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
  if (task.type === "bale") return "mulched";
  if (task.type === "weed" || task.type === "fertilize") return field.status; // same status, different overlay
  return "harvested";
}

/** Task types whose completion actually changes the field's texture — the only
 * ones worth the reveal-stamping treatment. Weeding bakes the SAME status with
 * the weed overlay off (sprayer cleans strip-by-strip); fertilizing bakes it
 * ~20% darker (wet liquid spray, dries off next month). */
const REVEALS_TEXTURE: ReadonlySet<TaskType> = new Set(["plow", "plant", "harvest", "rake", "bale", "weed", "fertilize"]);

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
        // darkened); everything else reveals a fresh post-work surface where
        // progress starts at 0.
        progress: task.type === "weed" || task.type === "fertilize" ? growthProgress(field, clock.time()) : 0,
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
  bailer: "Baler", grainTrailer: "Grain Trailer",
};
function implementInfoLines(kind: ImplementKind, size: EquipmentSize): { name: string; detail: string } {
  const name = `${IMPLEMENT_KIND_NAME[kind]} - ${SIZE_LABEL[size]}`;
  if (kind === "grainTrailer") {
    return { name, detail: `${grainTrailerCapacityTons(size)} t Capacity` };
  }
  return { name, detail: `${gameConfig.equipment[kind][size].widthFt} ft Working Width` };
}

const IMPLEMENT_QUEUE_ICON_PX = 30;

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
  } else if (task.type === "bale") {
    const impl = save.implements.find((i) => i.attachedTo === agent.id && i.kind === "bailer");
    const size = impl?.size ?? "medium";
    iconSvg = balerIconSvg(IMPLEMENT_QUEUE_ICON_PX);
    info = implementInfoLines("bailer", size);
    // No persisted "current bale" fraction — bales are spaced evenly by work
    // distance, so acres-worked-so-far ÷ one-bale's-worth tracks the real
    // gather → tie → drop → reset cycle closely without exposing tasks.ts's
    // internal per-tick runtime maps. Whole bales dropped so far / total
    // bales stand in for "current"/"total" (a baler has no tonnage figure).
    const balesPerAcre = gameConfig.forage.balesPerAcre;
    const totalBales = Math.max(1, Math.round(task.totalAcres * balesPerAcre));
    const balesSoFar = task.doneAcres * balesPerAcre;
    const dropped = Math.min(totalBales, Math.floor(balesSoFar));
    fill = { pct: (balesSoFar % 1) * 100, current: `${dropped} bales`, total: `${totalBales} bales` };
  } else {
    const kind = TASK_IMPLEMENT[task.type];
    if (!kind) return "";
    const impl = save.implements.find((i) => i.attachedTo === agent.id && i.kind === kind);
    const size = impl?.size ?? "medium";
    iconSvg = (IMPLEMENT_ICON_SVG[kind] ?? plowIconSvg)(IMPLEMENT_QUEUE_ICON_PX);
    info = implementInfoLines(kind, size);
  }

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
        <div class="qr-sub">${sub}</div>
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
 * section (machines already committed) and a drag-reorderable Queued section
 * (queue order = pickup priority). */
let lastQueueKey = " init";
function refreshQueuePanel(): void {
  // Skip DOM churn when nothing visible changed (1% progress buckets animate).
  const key = save.tasks
    .map((t) => `${t.id}:${t.status}:${t.agentId ?? ""}:${Math.round((t.doneAcres / t.totalAcres) * 100)}:${t.unloadPhase ?? ""}:${t.waitingForSilo ?? ""}`)
    .join("|");
  if (key === lastQueueKey) return;
  lastQueueKey = key;

  const rows = $("queue-rows");
  rows.innerHTML = "";
  if (save.tasks.length === 0) {
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
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------
function updateHud() {
  $("hud-date").textContent = formatDate(clock.time());
  $("hud-cash").textContent = "$" + Math.round(save.money).toLocaleString();
  $("hud-networth").textContent = "$" + Math.round(netWorth(save).total).toLocaleString();
  const totalGrain = Object.values(save.grain).reduce((sum, t) => sum + t, 0);
  $("hud-grain").textContent = totalGrain.toFixed(1) + " t";

  // Year-position marker: fraction of the display year (Mar → Feb) elapsed.
  const f = yearFraction(clock.time());
  $("year-marker").style.left = `calc(${(f * 100).toFixed(2)}% - 1px)`;
  // The calendar grid has a 110px label column; the lanes take the rest.
  const calNow = document.getElementById("cal-now");
  if (calNow) calNow.style.left = `calc(${(110 * (1 - f)).toFixed(1)}px + ${(f * 100).toFixed(2)}%)`;

  // Day-position marker: a sun/moon token riding the day track (midnight = 0).
  const df = dayFraction(clock.time());
  const dayMarker = $("day-marker");
  dayMarker.style.left = `${(df * 100).toFixed(2)}%`;
  // Daytime ~6am–6pm (0.25–0.75); sun then, moon overnight.
  dayMarker.textContent = df >= 0.25 && df < 0.75 ? "☀️" : "🌙";
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
// The four bottom-toolbar panels are MUTUALLY EXCLUSIVE — opening one closes any
// other. Clicking the active panel's own button closes it (toggle).
// ---------------------------------------------------------------------------
const TOOLBAR_PANELS = ["fieldstab", "equiptab", "cropcal", "inventory", "financetab", "settingstab"];
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
  $("btn-inventory").addEventListener("click", () => toggleToolbarPanel("inventory", refreshInventory));
  $("inv-close").addEventListener("click", () => ($("inventory").style.display = "none"));
}

function refreshInventory() {
  const rows = $("inv-rows");
  rows.innerHTML = "";
  for (const cropId of Object.keys(gameConfig.crops) as CropId[]) {
    const cfg = gameConfig.crops[cropId];
    const tons = save.grain[cropId];
    const capacity = siloCapacityForCrop(save, cropId);
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
    rows.appendChild(siloCapacityBar(cfg, tons, capacity));
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

/** $-formatting for cashflow cells: rounded, parenthesized-red handled in CSS. */
function cfAmount(n: number): string {
  const r = Math.round(n);
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
      ? `$${pending.toLocaleString()} pending — locks in at ${gameConfig.loan.ratePercent}% / ${gameConfig.loan.termMonths / 12} yr on Jan 1`
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
      <span class="ll-sub">$${Math.round(loan.principal).toLocaleString()} owed · $${Math.round(loan.monthlyPayment).toLocaleString()}/mo · ${loan.ratePercent}%</span>`;
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

/**
 * The equipment shop, rebuilt (maintainer request, 2026-07-12): a dealer-lot
 * layout. Three sections — Machines, Implements, Buildings — each row a
 * product line with its icon + name on the left and ALIGNED size-tier cards
 * across fixed columns (Small/Medium/Large), so prices and specs compare at a
 * glance. Tiers a line doesn't come in show as an em-dash placeholder rather
 * than shifting the grid.
 */
function buildEquipShop(): void {
  const shop = $("equip-shop");
  shop.innerHTML = "";

  const section = (label: string) => {
    const h = document.createElement("div");
    h.className = "shop-section";
    h.textContent = label;
    shop.appendChild(h);
    const head = document.createElement("div");
    head.className = "shop-row shop-head";
    head.innerHTML = `<div></div><div>Small</div><div>Medium</div><div>Large</div>`;
    shop.appendChild(head);
  };

  /** One product line: label cell + one cell per size column. */
  const line = (
    label: string, iconSvg: string,
    cells: Partial<Record<EquipmentSize, { spec: string; price: number; onBuy: () => void }>>,
  ) => {
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
  };

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

  section("Buildings");
  const placeBuilding = (kind: BuildingKind, size?: EquipmentSize) => () => {
    mode = `building:${kind}`;
    if (kind === "silo") pendingSiloSize = size ?? "small";
    $("equiptab").style.display = "none";
    toast(`🏗️ Click the map to place your ${buildingDisplayName(kind, size)}`);
  };
  line("Silo", `<span class="shop-emoji">${BUILDING_ICON.silo}</span>`, Object.fromEntries(SIZES.map((s) => [s, {
    spec: `${siloCapacityOf(s).toLocaleString()} t grain`,
    price: buildingPrice("silo", s),
    onBuy: placeBuilding("silo", s),
  }])));
  const OTHER_BUILDINGS: Array<[Exclude<BuildingKind, "silo">, string]> = [
    ["baleBarn", `${gameConfig.buildings.baleBarn.capacityBales} bales · indoor`],
    ["baleArea", `${gameConfig.buildings.baleArea.capacityBales} bales · outdoor`],
    ["tractorBarn", `${gameConfig.buildings.tractorBarn.slots} machine slots`],
    ["implementBarn", `${gameConfig.buildings.implementBarn.slots} implement slots`],
    ["farmYard", "rally point — gear parks here"],
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
    const carried =
      agent.kind === "tractor"
        ? save.implements.find((i) => i.attachedTo === agent.id)
        : undefined;
    const sub = agent.kind === "tractor"
      ? `<div class="er-sub">🔧 ${carried ? implementName(save, carried) : "no implement"}</div>`
      : "";

    const row = document.createElement("div");
    row.className = "equip-row";
    row.innerHTML = `
      <span class="icon">${(AGENT_ICON[agent.kind] ?? tractorIconSvg)(20)}</span>
      <span class="er-info">
        <div class="er-name">${agent.name}</div>
        <div class="er-status">${text}</div>
        ${sub}
        ${pct !== null ? `<div class="progress"><div class="fill" style="width:${pct.toFixed(0)}%"></div></div>` : ""}
      </span>`;

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

    row.appendChild(locateButton(agent.name, agent.pos));

    const refund = agent.purchaseCost ?? (agent.size ? agentPrice(agent.kind as EquipmentKind, agent.size) : 0);
    row.appendChild(
      iconButton("💰", agent.state !== "idle" ? `${agent.name} is mid-job` : `Sell · $${refund.toLocaleString()}`, agent.state !== "idle", () => {
        if (!confirm(`Sell ${agent.name} for $${refund.toLocaleString()}?`)) return;
        const { refund: paid } = sellAgent(save, agent.id);
        afterFleetChange();
        toast(`💰 Sold ${agent.name} for $${paid.toLocaleString()}`);
      }),
    );
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

    const row = document.createElement("div");
    row.className = "equip-row implement";
    row.innerHTML = `
      <span class="icon">${(IMPLEMENT_ICON[impl.kind] ?? plowIconSvg)(22)}</span>
      <span class="er-info">
        <div class="er-name">${implementName(save, impl)}</div>
        <div class="er-status">${where} · ${sizeLine}</div>
      </span>`;

    row.appendChild(hitchSelector(impl));

    const busy = !!host && host.state !== "idle";
    row.appendChild(
      iconButton("💰", busy ? `${host!.name} is using this` : `Sell · $${refund.toLocaleString()}`, busy, () => {
        if (!confirm(`Sell ${implementName(save, impl)} for $${refund.toLocaleString()}?`)) return;
        const { refund: paid } = sellImplement(save, impl.id);
        afterFleetChange();
        toast(`💰 Sold for $${paid.toLocaleString()}`);
      }),
    );
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

  // Skip to the END of the current month (= the start of the next one), via the
  // same fully-simulated montage. Simpler than picking a month: one press moves
  // the season forward a step.
  $("skip-month").addEventListener("click", () => {
    const mpm = minutesPerMonth();
    const target = (Math.floor(clock.time() / mpm) + 1) * mpm; // start of next month
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
    $("fieldstab").style.display = "none"; // get the panel out of the way to draw
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
      // Gates go in with the fence: auto-placed at the road side + opposite.
      field.accessPoints = defaultAccessPoints(field.boundary, roadNetRef);
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
/** One-click placement for buildings (mode = `building:<kind>`, set from the
 * Equipment panel's Buildings group). Unlike field drawing there's no draft —
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
      return `Bale capacity: ${gameConfig.buildings.baleBarn.capacityBales.toLocaleString()} · farm total ${baleCapacity(save).toLocaleString()}`;
    case "baleArea":
      return `Bale capacity: ${gameConfig.buildings.baleArea.capacityBales.toLocaleString()} · farm total ${baleCapacity(save).toLocaleString()}`;
    case "tractorBarn":
      return `Tractor slots: ${gameConfig.buildings.tractorBarn.slots} · farm total ${barnSlotTotal(save, "tractorBarn")}`;
    case "implementBarn":
      return `Implement slots: ${gameConfig.buildings.implementBarn.slots} · farm total ${barnSlotTotal(save, "implementBarn")}`;
    case "farmYard":
      return "Rally point — new equipment parks here";
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
      toast(`🤖 ${prettyId(field.id)} will run its rotation plan`);
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
function queueFromPanel(field: Field, type: "plow" | "plant" | "harvest" | "weed" | "fertilize" | "rake" | "bale", crop?: CropId): void {
  try {
    const task = enqueueTask(save, field, type, clock.time(), crop);
    updateHud();
    fieldMsg("");
    toast(`📋 ${cap(taskVerb(task))} ${prettyId(field.id)} added to the queue`);
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
  const plans = field.plans;
  const activeIdx = (dateOf(now).year - 1) % plans.length;

  container.insertAdjacentHTML(
    "beforeend",
    `<div class="plan-hint">Rotation — one plan per year, loops after Yr ${plans.length}. Running Yr ${activeIdx + 1} now.</div>`,
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
      editPlans();
    });
    row.appendChild(sel);

    for (const o of ops) {
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

  const add = document.createElement("button");
  add.className = "plan-add";
  add.textContent = "＋ Add rotation year";
  add.disabled = plans.length >= 5;
  add.addEventListener("click", () => {
    if (plans.length >= 5) return;
    // Default the new year to a DIFFERENT crop for an easy rotation.
    const crops = Object.keys(gameConfig.crops) as CropId[];
    const nextCrop = crops.find((c) => c !== plans[plans.length - 1]!.crop) ?? crops[0]!;
    plans.push({ crop: nextCrop, bale: !!gameConfig.crops[nextCrop].producesForage });
    editPlans();
  });
  container.appendChild(add);
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
    field.weedy ? 1 : 0,
    accessEditFieldId === field.id ? "gates" : "",
  ].join("|");
  // The rotation planner has its OWN change-detection (below) so its dropdowns
  // don't get rebuilt under the cursor on every money/status tick.
  refreshPlanEditor(field, now, auto);
  if (!force && key === lastPanelKey) return;
  lastPanelKey = key;

  $("fp-title").textContent = "🌾 " + prettyId(field.id);
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
    const value = Math.round(bales * gameConfig.forage.balePricePerBale);
    const tons = (bales * gameConfig.forage.baleTons).toFixed(0);
    body.insertAdjacentHTML("beforeend", `<div class="small" style="margin-top:8px">📦 <b>${bales}</b> bales (${tons} t) · $${gameConfig.forage.balePricePerBale.toLocaleString()}/bale</div>`);
    const btn = document.createElement("button");
    btn.className = "primary";
    btn.innerHTML = `💰 Sell Bales <span class="small">$${value.toLocaleString()}</span>`;
    btn.addEventListener("click", () => {
      const { bales: sold, revenue } = sellBales(save, field);
      if (sold <= 0) return;
      updateHud();
      refreshFieldPanel(true);
      updateBaleMarkers();
      toast(`💰 Sold ${sold} bales for $${revenue.toLocaleString()}`);
    });
    actions.appendChild(btn);
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
      body.insertAdjacentHTML("beforeend", `<div class="small" style="margin-top:8px">Forage left on the field. Buy a 🧹 rake &amp; 📦 baler to bale it, or plow it under.</div>`);
    }
  }

  const plowable = canPlow(eff) && !(eff === "harvested" && forageDue(save, field));
  if (!auto && plowable) {
    // --- Plow first (§10 lifecycle: stubble → tilled → planted) ---
    const cost = taskCost(field, "plow");
    body.insertAdjacentHTML("beforeend", `<div class="small" style="margin-top:8px">Plow to prepare for planting.</div>`);
    const btn = document.createElement("button");
    btn.className = "primary";
    btn.innerHTML = `🚜 Queue Plow <span class="small">$${cost.toLocaleString()}</span>`;
    btn.addEventListener("click", () => queueFromPanel(field, "plow"));
    actions.appendChild(btn);
  }

  if (!auto && eff === "tilled") {
    // --- Plant chooser (queues a task for the tractor) ---
    body.insertAdjacentHTML("beforeend", `<div class="small" style="margin-top:8px">Plant a crop:</div>`);
    const row = document.createElement("div");
    row.className = "cropbtns";
    for (const cropId of Object.keys(gameConfig.crops) as CropId[]) {
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
    const windows = (Object.keys(gameConfig.crops) as CropId[])
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
    body.insertAdjacentHTML("beforeend", html);

    // --- Weed & fertilize: independent side-tasks, no chaining with the
    // plow/plant/harvest lifecycle. Only offered while the crop is standing. ---
    if (!auto && hasStandingCrop(field.status)) {
      const row = document.createElement("div");
      row.className = "cropbtns";
      if (tasksFor(save, field.id, "weed").length === 0) {
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

    if (!auto && field.status === "ready" && tasksFor(save, field.id, "harvest").length === 0) {
      const btn = document.createElement("button");
      btn.className = "primary";
      btn.textContent = "🌾 Queue Harvest";
      btn.addEventListener("click", () => queueFromPanel(field, "harvest"));
      actions.appendChild(btn);
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
        toast(`🚪 ${prettyId(field.id)}'s access points saved`);
        refreshFieldPanel(true);
      } else {
        startAccessEdit(field);
        toast("🚪 Drag the markers to move this field's gates");
      }
    });
    row.appendChild(btn);
    body.appendChild(row);
  }
}

function prettyId(id: string): string {
  return id.replace("-", " ").replace(/^\w/, (c) => c.toUpperCase());
}

// --- To-do list management ---
let todoCollapsed = false;

function renderTodos(): void {
  if (!save) return;
  const todos = save.todos ?? [];
  const container = $("todo-items");
  container.innerHTML = "";

  const active = todos.filter((t) => !t.done);
  const done = todos.filter((t) => t.done);

  // Active items first
  for (const todo of active) {
    const item = document.createElement("div");
    item.className = "todo-item";
    item.innerHTML = `
      <input type="checkbox" />
      <div class="text">${escapeHtml(todo.text)}</div>
      <div class="del">✕</div>
    `;
    const checkbox = item.querySelector("input[type='checkbox']") as HTMLInputElement;
    const text = item.querySelector(".text") as HTMLElement;
    const del = item.querySelector(".del") as HTMLElement;

    checkbox.addEventListener("change", () => toggleTodo(todo.id));
    text.addEventListener("click", () => toggleTodo(todo.id));
    del.addEventListener("click", () => deleteTodo(todo.id));

    container.appendChild(item);
  }

  // Done items at the bottom
  if (done.length > 0) {
    for (const todo of done) {
      const item = document.createElement("div");
      item.className = "todo-item done";
      item.innerHTML = `
        <input type="checkbox" checked />
        <div class="text done">${escapeHtml(todo.text)}</div>
        <div class="del">✕</div>
      `;
      const checkbox = item.querySelector("input[type='checkbox']") as HTMLInputElement;
      const text = item.querySelector(".text") as HTMLElement;
      const del = item.querySelector(".del") as HTMLElement;

      checkbox.addEventListener("change", () => toggleTodo(todo.id));
      text.addEventListener("click", () => toggleTodo(todo.id));
      del.addEventListener("click", () => deleteTodo(todo.id));

      container.appendChild(item);
    }
  }
}

function addTodo(text: string): void {
  if (!save || !text.trim()) return;
  if (!save.todos) save.todos = [];
  save.todos.push({
    id: `todo-${Date.now()}-${Math.random()}`,
    text: text.trim(),
    done: false,
  });
  ($("todo-input") as HTMLInputElement).value = "";
  renderTodos();
  persistGame({ save, clockNow: clock.time(), daysPerMonth: getDaysPerMonth() });
}

function deleteTodo(id: string): void {
  if (!save || !save.todos) return;
  save.todos = save.todos.filter((t) => t.id !== id);
  renderTodos();
  persistGame({ save, clockNow: clock.time(), daysPerMonth: getDaysPerMonth() });
}

function toggleTodo(id: string): void {
  if (!save || !save.todos) return;
  const todo = save.todos.find((t) => t.id === id);
  if (todo) {
    todo.done = !todo.done;
    renderTodos();
    persistGame({ save, clockNow: clock.time(), daysPerMonth: getDaysPerMonth() });
  }
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

// Hook up to-do list after main() so `save` is initialized
setTimeout(() => {
  const input = $("todo-input") as HTMLInputElement;
  const addBtn = $("todo-add") as HTMLButtonElement;
  const collapseBtn = $("todo-collapse") as HTMLButtonElement;
  const todoList = $("todolist") as HTMLElement;
  const todoItems = $("todo-items") as HTMLElement;

  addBtn.addEventListener("click", () => addTodo(input.value));
  input.addEventListener("keypress", (e) => {
    if (e.key === "Enter") addTodo(input.value);
  });

  collapseBtn.addEventListener("click", () => {
    todoCollapsed = !todoCollapsed;
    if (todoCollapsed) {
      todoItems.style.display = "none";
      collapseBtn.textContent = "+";
      todoList.style.height = "auto";
    } else {
      todoItems.style.display = "block";
      collapseBtn.textContent = "−";
      todoList.style.height = "auto";
    }
  });

  renderTodos();
}, 100);
