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
import { naipSource, naipTileUrlTemplate } from "./map/naip";
import { addRoadsLayer } from "./map/roadsLayer";
import { addCountyBoard, boundaryBbox, unionBbox } from "./map/countyBoard";
import { configureNaipCache, naipProtocolHandler, NAIP_PROVIDERS, DEFAULT_NAIP_PROVIDER } from "./map/tileCache";
import {
  countyPrefetchPlan, tilesNearPoints, runPrefetch, viewportPrefetchPlan, ASSET_ZOOMS, ASSET_RADIUS_M,
} from "./map/naipPrefetch";
import type { TileId } from "./map/tileCache";
import { OverlayEngine } from "./map/overlay";
import { newGame } from "./state/saveState";
import type { SaveState, Field, Building, BuildingKind } from "./state/saveState";
import { buyFieldFromBoundary, renderField, initIdCounters, sellField, hashSeed } from "./field/fields";
import { updateBaleLayer, baleIconFor } from "./field/baleLayer";
import { confirmDialog, promptDialog } from "./ui/modal";
import { drawFieldTexture } from "./field/fieldRender";
import { updateBuildingMarkers, BUILDING_ICON } from "./field/buildingRender";
import {
  buyBuildingAt, sellBuilding, buildingPrice, buildingDisplayName, initBuildingIdCounters,
  BUILDING_NAME, siloCapacityForCrop, siloCapacityOf, siloCapacityTonsOf, assignSiloCrop,
  barnSlotTotal, nearestFarmYard,
  baleStorageCapacityOf, storedBalesTotal, assignBaleStorageProduct,
  tickBaleSpoilage, baleSpoilRateOf, tickSilageAging, tickBaleAging,
  bunkerCapacityOf, silageCapacityTons, silageStoredTons, buildingIsSized,
  storedSilageTotal, assignSilageBunkerProduct, migrateLegacySilage, migrateLegacySilageProductNames,
} from "./sim/buildings";
import { distanceAtAcres } from "./sim/coverage";
import type { CoveragePath } from "./sim/coverage";
import {
  persistGame, loadGame, ensureActiveFarm, listFarms,
  switchFarm, deleteFarm, getActiveFarmId, loadGameFor,
} from "./state/persistence";
import { farmSummaryLine } from "./state/farmSummary";
import { runHomeScreen, AUTOBOOT_KEY, MENU_OPEN_NEW_KEY } from "./ui/homeScreen";
import { sellBales, netWorth, baleInventory, sellAllOfProduct, tickAutoSell } from "./sim/economy";
import {
  grainUnitPrice, baleUnitPrice, silageUnitPrice, seasonalBonus, monthOf, peakSaleMonth, effectiveSellPlan,
  SELLABLE_GRAINS, SELLABLE_BALES, AUTO_SELL_HOLDS_UNTIL_AGED,
} from "./sim/market";
import type { MarketProduct } from "./sim/market";
import { SimClock } from "./sim/clock";
import {
  formatDate, dateOf, MONTH_NAMES, MONTH_SHORT,
  START_MONTH, MONTHS_PER_YEAR, MINUTES_PER_DAY,
  getDaysPerMonth, setDaysPerMonth, minutesPerMonth, nextMonthStart,
} from "./sim/calendar";
import {
  tickFarming, growthProgress, yieldRange, productivityMultiplier, yieldModifierSteps, inPlantingWindow, canPlow,
  hasStandingCrop, inWeedingWindow, canFertilizeNow, isPerennial, canSeedPerennial,
  isPerennialDormant, harvestMonthsRemaining, harvestWindowMonthsFor, baleTonsOf, baleProductForField,
  canWrapBales, cropMakesSilage, isChopOnlyCrop, migrateLegacyBaleProducts,
} from "./sim/farming";
import {
  ensureAgents, initTaskIds, enqueueTask, cancelTask, resetQueuedTask, forceCancelActiveTask, restartActiveTask, taskCost, tasksFor,
  isFieldHarvesting, effectiveStatus, tickTasks, autoManageAll, autoManageField,
  buyAgent, sellAgent, buyImplement, sellImplement,
  agentPrice, implementPrice, implementName, getCoveragePath,
  reorderTask, estimateTaskHours, forageDue, canMulch, defaultPlan, forcePlow, removeRotationStep, blockedWork,
  chopHeadKind, isSilageRun, relayTrailerKind, chopHeadKindForTask, taskFieldSpeedKmh,
  harvesterCapacityTons, grainTrailerCapacityTons, harvesterCapacityBushels, grainTrailerCapacityBushels,
  tonsPerBushel, setHarvesterCrop, setRoadNetwork, TASK_IMPLEMENT,
  appendCompletedTask, haySpikesCapacityBales, baleTrailerCapacityBales, queueHaulBales, fieldHasLooseBales,
  queueSellRun, sellableStock,
} from "./sim/tasks";
import type { BlockedWork } from "./sim/tasks";
import { buildRoadNetwork } from "./sim/roadNet";
import type { RoadNetwork } from "./sim/roadNet";
import { defaultAccessPoints } from "./sim/access";
import {
  MACHINE_ICON, IMPLEMENT_ICON_SVG, tractorIconSvg, baleIconSvg,
  plowIconSvg, planterIconSvg, sprayerIconSvg, rakeIconSvg, grainTrailerIconSvg,
  mowerIconSvg, mulcherIconSvg, haySpikesIconSvg, baleTrailerIconSvg,
} from "./ui/icons";
import { machineImageUrl, machineImgTag, trailerFillImageUrl, machineVariantImageUrl } from "./ui/machineImages";
import type { EquipmentKind, ImplementKind } from "./sim/tasks";
import {
  tickLoans, borrowOpen, paydownOpen, paydownLoan, refinanceLoan,
} from "./sim/finance";
import {
  CASHFLOW_CATEGORIES, CASHFLOW_LABEL, categoryTotal, netCashflow, ledgerYears,
} from "./sim/ledger";
import {
  fieldCategoryTotal, fieldNetCashflow, fieldLedgerYears,
} from "./sim/fieldLedger";
import { setScheduleOverride } from "./sim/schedule";
import { projectRotation, splitAbs } from "./sim/rotationTimeline";
import type { AbsMonth, TimelineTaskKind } from "./sim/rotationTimeline";
import type { FarmTask, Agent, Implement, FieldStatus, TaskType, CompletedTask, FieldPlan } from "./state/saveState";
import { gameConfig, FEET_TO_METERS, KMH_TO_MPH, SILAGE_PRODUCTS } from "./config/gameConfig";
import type { CropId, EquipmentSize, BaleProduct, SilageProduct } from "./config/gameConfig";

// Multi-farm saves (maintainer request, 2026-07-13): exactly one farm is
// "active" at a time — everything below talks to THAT farm's save, same as
// the old single-slot behavior. The Settings tab creates/loads/deletes farms
// by switching which one is active and reloading the page (see wireSettingsTab).
// The farm carries WHICH COUNTY it plays in (2026-07-26) — boot loads that.
const activeFarm = ensureActiveFarm();

// Load the persisted game if there is one; otherwise start fresh. The game
// auto-saves (see wirePersistence), so refreshes drop you where you were.
const loaded = loadGame();
const save: SaveState = loaded?.save ?? newGame();
const clock = new SimClock();
if (loaded) {
  clock.setTime(loaded.clockNow);
  initIdCounters(save);
  if (loaded.daysPerMonth) setDaysPerMonth(loaded.daysPerMonth);
  // County integrity stamp (2026-07-26): the save says which county its UTM
  // geometry belongs to. FarmMeta is authoritative — a mismatch means the
  // index was hand-edited or half-written; warn and carry on (the stamp
  // self-heals on the next autosave).
  if (loaded.countyId && loaded.countyId !== activeFarm.countyId) {
    console.warn(
      `Save stamped for county "${loaded.countyId}" but farm "${activeFarm.id}" says "${activeFarm.countyId}" — trusting the farm.`,
    );
  }
  // Pre-task-queue saves: give them the new arrays, and turn any legacy
  // mid-harvest markers into queued harvest tasks so the combine resumes them.
  save.tasks ??= [];
  save.agents ??= [];
  save.implements ??= [];
  save.buildings ??= [];
  // Older saves: the grain bin must carry a key for EVERY config crop —
  // backfill whatever this save predates (perennials 2026-07-13, the six new
  // annuals 2026-07-22, and anything added after).
  for (const c of Object.keys(gameConfig.crops) as CropId[]) save.grain[c] ??= 0;
  save.completedTasks ??= [];
  save.fieldLedger ??= {};
  // A crop can be REMOVED from the config (Potatoes, 2026-07-23 — they'd need
  // specialty equipment the game doesn't model). Anything still referencing one
  // would hit `gameConfig.crops[undefined]` and throw, so scrub it here: a
  // standing crop is dropped back to bare stubble, and rotation steps fall back
  // to the default crop rather than leaving the plan un-runnable.
  {
    const known = (c: string | undefined): boolean => !!c && c in gameConfig.crops;
    for (const f of save.fields) {
      if (f.crop && !known(f.crop)) {
        f.crop = undefined;
        f.plantedAt = undefined;
        f.trueYieldTonsPerAcre = undefined;
        f.status = "stubble";
      }
      if (f.lastCrop && !known(f.lastCrop)) f.lastCrop = undefined;
      for (const p of f.plans ?? []) if (!known(p.crop)) p.crop = defaultPlan().crop;
    }
    for (const key of Object.keys(save.grain)) {
      if (!known(key)) delete (save.grain as Record<string, number>)[key];
    }
    for (const key of Object.keys(save.sellSchedule ?? {})) {
      if (!known(key) && !(key in gameConfig.baleProducts)) delete save.sellSchedule![key];
    }
  }
  // Rotation-sequence rework (2026-07-23): `plans` used to be indexed by
  // campaign year (`plans[(year-1) % len]`) and is now an explicit sequence
  // pointer. Seed the pointer at whatever the year-based rule would have
  // selected right now, so a mid-campaign save resumes on the same crop
  // instead of jumping back to the start of its rotation.
  {
    const campaignYear = dateOf(loaded.clockNow).year;
    for (const f of save.fields) {
      if (f.rotationIndex === undefined && f.plans && f.plans.length > 0) {
        f.rotationIndex = (campaignYear - 1) % f.plans.length;
      }
    }
  }
  initBuildingIdCounters(save);
  migrateLegacySilageProductNames(save); // pre-2026-08-15 saves: cornSilage/silage id swap -> cornForage/cornSilage
  migrateLegacySilage(save); // pre-2026-08-15 saves: pooled silage -> per-bunker
  migrateLegacyBaleProducts(save); // one-day-old "unwrapped" Silage-crop bale ids -> hay/alfalfaHay
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
// `relocate:<buildingId>` (2026-08-14) reuses the same click-to-place step
// as a fresh purchase — see `wireBuildingPlacement` — just mutating an
// existing building's `pos` instead of calling `buyBuildingAt`.
type Mode = "none" | "field" | `building:${BuildingKind}` | `relocate:${string}`;
let mode: Mode = "none";
/** Size armed for the NEXT silo placement (set by the Buildings shop button
 * just before `mode` becomes "building:silo"; ignored for every other kind). */
/** Size chosen in the shop for the SIZED building kinds (silo, silage
 * bunker), carried across the click-to-place step. */
let pendingSiloSize: EquipmentSize = "small";

let overlay: OverlayEngine;
let mapRef: maplibregl.Map;
let roadNetRef: RoadNetwork | null = null;
let selectedFieldId: string | null = null;
/** Which side-tab of the Field panel is showing (maintainer request,
 * 2026-07-21): View / Schedule / Finances / Settings. STICKY across field
 * selections since 2026-07-23 — clicking between fields keeps the tab you're
 * on, so you can compare the same view field to field. */
type FieldPanelTab = "view" | "schedule" | "finances" | "settings";
const FIELD_PANEL_TABS: FieldPanelTab[] = ["view", "schedule", "finances", "settings"];
let fieldPanelTab: FieldPanelTab = "view";
/** Where new machines park (county center / farmstead-to-be), in UTM meters. */
let homePos: Meters = [0, 0];

/** Which NAIP host serves imagery — a player-visible Settings toggle (added
 * 2026-08-12 after USDA APFO went unreachable mid-session with no code-side
 * cause). Persisted like autoSkipEnabled below so a switch survives reload. */
const NAIP_PROVIDER_KEY = "farm.naipProvider";
let activeNaipProvider: string =
  NAIP_PROVIDERS.find((p) => p.id === localStorage.getItem(NAIP_PROVIDER_KEY))?.id ?? DEFAULT_NAIP_PROVIDER;

const $ = (id: string) => document.getElementById(id)!;

function devStatus(id: string, text: string, cls?: "ok" | "err") {
  const el = $(id);
  el.textContent = text;
  el.className = "row" + (cls ? " " + cls : "");
}

async function main() {
  // For runtime-built counties (not bundled), surface build progress in the
  // dev corner; the home screen (Phase 4) adds the real progress UI.
  const county = await loadCounty(activeFarm.countyId, (stage, d) => {
    const mb = d?.bytes ? ` ${(d.bytes / 1e6).toFixed(1)} MB` : "";
    devStatus("status-osm", `Roads: ${stage}${mb}…`);
  });
  mainStarted = true; // past the county load — failures after this are mid-boot crashes

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

  // NAIP tiles go through the persistent IndexedDB cache (tileCache.ts) —
  // register the protocol before the map exists so the very first tile load
  // already writes through it.
  configureNaipCache();
  maplibregl.addProtocol("naip", naipProtocolHandler);

  // The board bbox: manifest bbox is hand-tuned for the VIEW and can be
  // smaller than the true polygon (Story's north edge pokes 10 km past it) —
  // pan limits must fit both, plus room for the county label off the north edge.
  const boardBbox = county.boundary ? unionBbox(m.bbox, boundaryBbox(county.boundary)) : m.bbox;

  const map = new maplibregl.Map({
    container: "map",
    center: m.center,
    zoom: m.defaultZoom,
    maxBounds: [
      [boardBbox[0] - 0.15, boardBbox[1] - 0.15],
      [boardBbox[2] + 0.15, boardBbox[3] + 0.15],
    ],
    // Keep more decoded tiles in memory than the default working set — panning
    // around the county re-evicts less (the IDB cache still backstops misses).
    maxTileCacheSize: 512,
    attributionControl: { compact: false },
    style: {
      version: 8,
      // Vendored SDF glyphs (public/fonts, via tools/fetch-glyphs.mjs). Without
      // this NO layer in the style can render text at all — that's why the
      // county label had to be an HTML marker before 2026-07-30. Only "Noto
      // Sans Bold" range 0-255 is on disk; naming any other stack silently
      // renders nothing.
      glyphs: `${import.meta.env.BASE_URL}fonts/{fontstack}/{range}.pbf`,
      sources: { naip: naipSource(m.imagery, activeNaipProvider) },
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
  map.on("moveend", scheduleViewportPrefetch);

  map.on("load", () => {
    addRoadsLayer(map, county.roads);
    // Game board: mask everything outside the county, border stroke, big
    // zoomed-out label. Added BEFORE field surfaces so player content stays
    // on top. No boundary (TIGERweb down at build time) → no board, still playable.
    if (county.boundary) {
      addCountyBoard(map, county.boundary, {
        name: m.name,
        state: m.state,
        labelMaxZoom: m.defaultZoom + 1,
      });
    }
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
    wireDevTools();
    wirePersistence();
    // Re-render every field from the loaded save (textures + outlines).
    for (const f of save.fields) renderField(map, overlay, f, clock.time());
    updateAgentMarkers();
    refreshBuildingMarkers();
    refreshQueuePanel();
    clock.play(); // the world breathes from the start (idle-game 1×)
    requestAnimationFrame(gameLoop);
    startBackgroundTick();
    // Warm the imagery cache once the initial view has had its turn at the
    // network: whole county at browse zooms + high-res around player assets.
    setTimeout(() => {
      const assets: LngLat[] = [
        toLngLat(homePos),
        ...save.fields.map((f) => toLngLat(centroidOf(f.boundary))),
        ...save.buildings.map((b) => toLngLat(b.pos)),
      ];
      queuePrefetch(countyPrefetchPlan(boardBbox, assets));
    }, 4000);
  });

  updateHud();
}

// ---------------------------------------------------------------------------
// NAIP prefetch queue — one prefetch runs at a time (a purchase mid-boot just
// appends its patch after the county-wide warmup). Progress and the final
// tally land on the dev corner's NAIP line; failures are silent by design
// (a missed tile stays a live fetch, exactly like before the cache).
// ---------------------------------------------------------------------------
let prefetchChain: Promise<unknown> = Promise.resolve();

function queuePrefetch(tiles: TileId[]): void {
  if (tiles.length === 0) return;
  prefetchChain = prefetchChain
    .then(() =>
      runPrefetch(tiles, {
        concurrency: 3,
        provider: activeNaipProvider,
        onProgress: (done, total) => {
          if (done % 25 === 0 || done === total) devStatus("status-naip", `NAIP: caching ${done}/${total}…`);
        },
      }),
    )
    .then((res) => {
      // Failures are non-fatal (a miss stays a live fetch) but must be VISIBLE —
      // the 2026-07-28 fetch-binding bug failed every tile and the old "cache ✓"
      // line would have looked healthy over a black map.
      if (res.failed > 0) {
        devStatus("status-naip", `NAIP: cache ${res.fetched} new, ${res.failed} failed ⚠`, "err");
      } else {
        devStatus("status-naip", `NAIP: cache ✓ (${res.fetched} new, ${res.cached} warm)`, "ok");
      }
    })
    .catch(() => {});
}

let lastViewportPrefetchKey = "";
let viewportPrefetchTimer: ReturnType<typeof setTimeout> | null = null;

/** Warms a ring of tiles around wherever the camera currently is (see
 * viewportPrefetchPlan's header — the boot-time plan only covers known
 * assets, so scouting elsewhere in the county always live-rendered with
 * nothing pre-cached). Debounced: a drag or zoom fires several `moveend`s in
 * quick succession, and only the settled position is worth a prefetch call. */
function scheduleViewportPrefetch(): void {
  if (viewportPrefetchTimer !== null) clearTimeout(viewportPrefetchTimer);
  viewportPrefetchTimer = setTimeout(() => {
    viewportPrefetchTimer = null;
    if (!mapRef) return;
    const z = mapRef.getZoom();
    const b = mapRef.getBounds();
    const bbox: [number, number, number, number] = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    const key = `${activeNaipProvider}:${Math.round(z)}:${bbox.map((v) => v.toFixed(3)).join(",")}`;
    if (key === lastViewportPrefetchKey) return;
    lastViewportPrefetchKey = key;
    queuePrefetch(viewportPrefetchPlan(bbox, z));
  }, 400);
}

/** High-res imagery around a newly bought field / placed building — the
 * county-wide browse zooms were already warmed at boot. */
function prefetchAroundAsset(pos: Meters): void {
  const ll = toLngLat(pos);
  const tiles: TileId[] = [];
  for (const z of ASSET_ZOOMS) tiles.push(...tilesNearPoints([ll], ASSET_RADIUS_M, z));
  queuePrefetch(tiles);
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
  const realSeconds = Math.min(1, (ts - lastFrame) / 1000); // clamp OS-sleep jumps
  lastFrame = ts;
  advanceSim(realSeconds);
  requestAnimationFrame(gameLoop);
}

/** One sim step of `realSeconds` wall-clock time. Shared by the rAF loop and
 * the background-tab fallback below. */
function advanceSim(realSeconds: number) {
  const before = clock.time();
  clock.advance(realSeconds);
  tickWorld(before);
  // No auto-skip while hidden: its montage animates on rAF, which is frozen in
  // background tabs — it would stall mid-skip with the clock paused.
  if (!document.hidden) maybeAutoSkipMonth();
}

/** Keep the sim running while the tab is hidden or minimized: rAF freezes in
 * background tabs, so a wall-clock interval takes over. Background timers get
 * throttled (~1/s, ~1/min after 5 min hidden), but the sim advances by real
 * elapsed time, so it just catches up in bigger steps — tickWorld already
 * handles month-sized deltas (the skip montage pushes far larger ones). */
function startBackgroundTick() {
  setInterval(() => {
    const now = performance.now();
    // Run when hidden, or when rAF has stalled >2s for any other reason.
    if (!document.hidden && now - lastFrame < 2000) return;
    if (montageActive) return; // montage drives the clock itself
    const realSeconds = (now - lastFrame) / 1000;
    lastFrame = now;
    advanceSim(realSeconds);
  }, 1000);
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
  tickAutoSell(save, now); // fire any scheduled auto-sells for months just crossed
  tickBaleSpoilage(save, dt); // stored bales rot — fast outdoors, slowly in a Barn
  tickSilageAging(save, now); // stored Corn Forage ages into Corn Silage after a while
  tickBaleAging(save, now); // stored wrapped bales age into their Aged Baleage twin after a while
  const allChanged = [...changed, ...work.changed];
  for (const f of allChanged) renderField(mapRef, overlay, f, now);
  repaintGrowthStages(now, allChanged);
  for (const ev of work.events) toastTaskEvent(ev.task, ev.agent, ev.kind);
  updateReveals();
  updateAgentMarkers();
  // Every tick, not just on the throttled refresh below (2026-08-13) — a
  // lightweight width/label patch, not a rebuild, so the harvester/cart/
  // baler fill bars read as a smooth fill instead of stepping in ~8% jumps.
  updateFillBars();
  // Same idea for the Equipment/Structures tabs' status text (2026-08-14) —
  // see `updateEquipStatusText`'s own doc comment for the flicker/missed-
  // click bug this fixes.
  updateEquipStatusText();
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
const AGENT_EMOJI: Record<string, string> = { tractor: "🚜", harvester: "🌾", windrower: "🌿", forageHarvester: "🌱" };

/** Implements that get NO badge beside their machine on the map — the machine's
 * own icon is the whole picture.
 *
 * Hay spikes (2026-07-21) bolt straight to the loader: no separate silhouette
 * worth drawing, and the Small/Medium tractors have composite art showing them
 * anyway. The two combine HEADERS joined them 2026-07-24 (maintainer request:
 * "hide the corn header and grain header from the field icons") — every combine
 * sprite is already drawn WITH a header on the front, so badging one alongside
 * would draw the same part twice. The chopper heads (rowCropHead/pickupHead)
 * joined 2026-08-13 for the same reason (maintainer request: "like the headers
 * on the Combines, it is included in the Harvester's icon") — the Forage
 * Harvester's sprite already reads as carrying one. Unlike the combine's two
 * headers, neither gets its own sprite VARIANT (`agentMachineIconHtml`) yet:
 * only `rowCropHead` is reachable in practice (the only crop that still chops
 * is Forage — see `cropMakesSilage`), so there's nothing to pick between. */
const MINOR_IMPLEMENT_KINDS = new Set<string>(["haySpikes", "cornHeader", "grainHeader", "rowCropHead", "pickupHead"]);

// Realistic side-profile machinery SVGs live in ui/icons.ts (maintainer
// request, 2026-07-12) — one shared set for map dots, panels, and the shop.
const AGENT_ICON = MACHINE_ICON;

/** Icon HTML for a machine: a photographic sprite from `src/assets/Equipment/`
 * if one exists for this kind+size (see machineImages.ts), otherwise the
 * hand-drawn SVG. Both obey the `.agent-glyph` heading transform. */
function machineIconHtml(kind: string, size: EquipmentSize | undefined, px: number): string {
  const url = machineImageUrl(kind, size);
  if (url) return machineImgTag(url, px);
  return (AGENT_ICON[kind] ?? tractorIconSvg)(px);
}

/** Map-icon size per machine kind. The base is 60px; the big self-propelled
 * machines run 30% larger, because at the shared size they read as tractors.
 * Combines got this 2026-07-21, the windrower 2026-07-24 (maintainer request) —
 * it's a full self-propelled machine, not a tractor with a mower on the back,
 * and it should look like one on the map. The Forage Harvester got a further
 * bump on top of that, 2026-08-13 (maintainer request: "increase the size...
 * by 50%", 78 → 117px) then dialed back 20% after seeing it in place
 * (117 × 0.8 = 93.6, rounded to 94px — a net ~+20% over the shared 78px). */
const BIG_MAP_ICON_KINDS = new Set<string>(["harvester", "windrower", "forageHarvester"]);
function agentIconPx(kind: string): number {
  if (kind === "forageHarvester") return 94;
  return BIG_MAP_ICON_KINDS.has(kind) ? 78 : 60;
}

/**
 * A machine's icon, drawn WITH the minor implement it's wearing when composite
 * art exists for that exact kind+size+variant — otherwise the plain sprite.
 *
 * Two cases, both about implements too small to earn their own trailing badge
 * but far too visible to leave off the machine:
 *   - a tractor's Hay Spikes, empty or carrying a bale (2026-07-21);
 *   - a combine's HEADER (2026-07-25). Corn head vs grain platform is the most
 *     recognisable thing about a combine, and since 2026-07-24 the game makes
 *     you own the right one per crop — so the art should show which is on.
 *
 * Falls back silently, so a size with no variant art just keeps its `_sideleft`
 * sprite and nothing breaks while art is still being drawn.
 */
/**
 * Every input `agentMachineIconHtml` looks at, flattened to a cache key.
 *
 * Map markers only touch `innerHTML` when this changes, so anything the sprite
 * depends on MUST appear here or the marker goes stale. It missed the combine's
 * header when header art landed (2026-07-25): a combine that swapped a grain
 * platform for a corn head kept the old sprite on the map indefinitely, while
 * the Work Queue — which re-renders wholesale — showed the right one. Lives
 * next to the function it mirrors so the two are edited together.
 */
function agentSpriteKey(agent: Agent): string {
  const hay = save.implements.find((i) => i.attachedTo === agent.id && i.kind === "haySpikes");
  const header = agent.kind === "harvester"
    ? save.implements.find((i) => i.attachedTo === agent.id && (i.kind === "cornHeader" || i.kind === "grainHeader"))
    : undefined;
  return [
    agent.kind,
    agent.size ?? "",
    hay ? ((hay.cargoBales ?? 0) > 0 ? "bale" : "empty") : "",
    header?.kind ?? "",
  ].join(":");
}

function agentMachineIconHtml(agent: Agent, px: number): string {
  const hay = save.implements.find((i) => i.attachedTo === agent.id && i.kind === "haySpikes");
  if (hay) {
    const variant = (hay.cargoBales ?? 0) > 0 ? "hayspikebale" : "hayspike";
    const url = machineVariantImageUrl(agent.kind, agent.size, variant);
    if (url) return machineImgTag(url, px);
  }
  if (agent.kind === "harvester") {
    const header = save.implements.find(
      (i) => i.attachedTo === agent.id && (i.kind === "cornHeader" || i.kind === "grainHeader"),
    );
    if (header) {
      const url = machineVariantImageUrl(agent.kind, agent.size, header.kind === "cornHeader" ? "cornheader" : "grainheader");
      if (url) return machineImgTag(url, px);
    }
  }
  return machineIconHtml(agent.kind, agent.size, px);
}

/** Same sprite-or-SVG fallback as machineIconHtml, but for a hitched implement
 * (falls back to the plow SVG shape family, not the tractor). */
function implementIconHtml(kind: string, size: EquipmentSize | undefined, px: number): string {
  const url = machineImageUrl(kind, size);
  if (url) return machineImgTag(url, px);
  return (IMPLEMENT_ICON_SVG[kind] ?? plowIconSvg)(px);
}

/** How full a cargo-hauling implement is (0-100), or `undefined` for kinds
 * that don't carry cargo — the input to `trailerFillImageUrl`. */
function implementFillPct(impl: Implement): number | undefined {
  if (impl.kind === "baleTrailer") {
    const cap = baleTrailerCapacityBales(impl.size);
    return cap > 0 ? Math.min(100, ((impl.cargoBales ?? 0) / cap) * 100) : 0;
  }
  if (impl.kind === "grainTrailer") {
    // Corn as the reference crop: this only picks which fill SPRITE to show,
    // and the real cargo crop isn't reachable from an implement alone.
    const cap = grainTrailerCapacityTons(impl.size);
    return cap > 0 ? Math.min(100, ((impl.cargoTons ?? 0) / cap) * 100) : 0;
  }
  return undefined;
}

/** Icon for an owned implement: prefers a fill-state sprite (how full it is
 * right now) over the plain size sprite, over the SVG — each a graceful
 * fallback for kinds without that art yet. */
function trailerIconHtml(impl: Implement, px: number): string {
  const fillPct = implementFillPct(impl);
  if (fillPct !== undefined) {
    const url = trailerFillImageUrl(impl.kind, fillPct);
    if (url) return machineImgTag(url, px);
  }
  return implementIconHtml(impl.kind, impl.size, px);
}

/** Human verb for a task, present participle ("plowing Field 1"). */
function taskVerb(task: FarmTask): string {
  if (task.type === "plow") return "plowing";
  if (task.type === "plant") {
    const c = task.crop ? gameConfig.crops[task.crop] : null;
    return c ? `planting ${c.name.toLowerCase()}` : "planting";
  }
  if (task.type === "mow") return "mowing";
  if (task.type === "mulch") return "mulching"; // fell through to "harvesting" before 2026-07-23
  if (task.type === "weed") return "weeding";
  if (task.type === "fertilize") return "fertilizing";
  if (task.type === "rake") return "raking";
  if (task.type === "bale") return "baling";
  if (task.type === "wrap") return "wrapping";
  if (task.type === "unloadHarvester") return "hauling grain";
  if (task.type === "haulBales") return "hauling bales";
  return "harvesting";
}

function toastTaskEvent(task: FarmTask, agent: Agent, kind: "started" | "finished"): void {
  const emoji = AGENT_EMOJI[agent.kind] ?? "🚜";
  const where = fieldLabelOf(task.fieldId);
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

/** A machine counts as "in storage" when it's idle AND parked at a Tractor
 * Barn or Farm Yard (maintainer request, 2026-07-21) — its map marker (and,
 * since the implement rides nested inside its glyph, any hitched implement) is
 * hidden while this holds, to declutter the farmstead. A machine idle out in a
 * field, or with no barn/yard built yet, still shows. */
function isAgentInStorage(agent: Agent): boolean {
  if (agent.state !== "idle") return false;
  return save.buildings.some(
    (b) => (b.kind === "tractorBarn" || b.kind === "farmYard") &&
      Math.hypot(b.pos[0] - agent.pos[0], b.pos[1] - agent.pos[1]) < 2,
  );
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
      // The implement nests INSIDE the glyph (not a sibling), so the pill
      // background (living on .agent-glyph, see CSS) rotates together with the
      // icons as one rigid piece — the pill always hugs its content exactly, at
      // any heading, instead of staying static while the content swings.
      // The mirror (scaleX, for driving east) is a SEPARATE inner wrapper: the
      // pill itself must only rotate, never flip, or its rounded corners/border
      // would visibly invert every time a machine turns around. Only the art
      // (which genuinely faces one way) needs to flip.
      const icons = document.createElement("span");
      icons.className = "agent-icons";
      // The machine's own icon is a dedicated dynamic span too (not baked into
      // innerHTML once here) — a Small Tractor with Hay Spikes attached swaps
      // to a composite sprite showing the loader, so it needs the same
      // attach/detach-driven resync as the implement badge below.
      icons.innerHTML = `<span class="agent-machine"></span><span class="agent-implement"></span>`;
      glyph.appendChild(icons);
      bob.appendChild(glyph);
      el.appendChild(bob);
      marker = new maplibregl.Marker({ element: el }).setLngLat(toLngLat(agent.pos)).addTo(mapRef);
      agentMarkers.set(agent.id, marker);
    } else {
      marker.setLngLat(toLngLat(agent.pos));
    }
    const el = marker.getElement();
    // Hide parked-in-storage machines (and their nested implement glyph).
    el.style.display = isAgentInStorage(agent) ? "none" : "";
    el.classList.toggle("working", agent.state === "working");
    el.classList.toggle("warn", isAgentWaitingForSilo(agent));
    // Sync the machine's own icon. Same cheap dataset-key pattern as the
    // implement badge below — a tractor swaps to its Hay-Spikes composite
    // (empty vs. carrying), and a combine to the head it's actually running.
    // The key comes from `agentSpriteKey` rather than being spelled out here,
    // so it can't fall behind what the sprite lookup reads: it did exactly that
    // when header art landed, leaving stale combines on the map (2026-07-25).
    const machineSpan = el.querySelector<HTMLElement>(".agent-machine");
    if (machineSpan) {
      const key = agentSpriteKey(agent);
      if (machineSpan.dataset.machine !== key) {
        machineSpan.dataset.machine = key;
        machineSpan.innerHTML = agentMachineIconHtml(agent, agentIconPx(agent.kind));
      }
    }
    // Sync the hitched-implement glyph. Cheap dataset-key check so we only touch
    // innerHTML on attach/detach/size-change, not every frame.
    const implSpan = el.querySelector<HTMLElement>(".agent-implement");
    if (implSpan) {
      const impl = save.implements.find((i) => i.attachedTo === agent.id && !MINOR_IMPLEMENT_KINDS.has(i.kind));
      // Fill % rounded into the key so the fill-state sprite (see
      // trailerIconHtml) redraws when its bucket changes, without a full
      // string-diff on every fractional-ton update.
      const key = impl ? `${impl.kind}:${impl.size ?? ""}:${Math.round(implementFillPct(impl) ?? -1)}` : "";
      if (implSpan.dataset.impl !== key) {
        implSpan.dataset.impl = key;
        implSpan.innerHTML = impl ? trailerIconHtml(impl, 55) : "";
      }
    }
    // Point the glyph along the driving heading. The SVGs are drawn facing WEST,
    // and screen-y points down while meters-north points up, so aligning to travel
    // is a rotation of (π − heading). But that rolls the icon 180° upside-down when
    // driving east — so instead of rotating past vertical, we MIRROR it horizontally
    // (scaleX) and keep it upright. Machines mostly run east↔west, so this reads as
    // "the tractor turned around," not "flipped over."
    const glyph = el.querySelector<HTMLElement>(".agent-glyph");
    const icons = el.querySelector<HTMLElement>(".agent-icons");
    if (glyph && icons && agent.heading !== undefined) {
      let a = Math.atan2(Math.sin(Math.PI - agent.heading), Math.cos(Math.PI - agent.heading)); // (−π, π]
      let sx = 1;
      if (Math.abs(a) > Math.PI / 2) {
        a -= Math.sign(a) * Math.PI; // bring rotation back within ±90°…
        sx = -1; // …and mirror instead, so the icon stays upright
      }
      // Rotation on the pill (glyph), mirror on the art only (icons) — see the
      // creation-time comment above for why these can't share one transform.
      glyph.style.transform = `rotate(${a}rad)`;
      icons.style.transform = `scaleX(${sx})`;
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
// Bale markers: physical bales, each drawn at the exact spot the baler dropped
// it (field.baleLocations). They accumulate live as the baler works and persist
// until sold.
//
// The rendering itself lives in field/baleLayer.ts — one GPU symbol layer, not
// the ~600-per-field DOM markers this used to be (see that module's header for
// why). This wrapper just keeps the call site and its `mapRef` guard.
// ---------------------------------------------------------------------------
function updateBaleMarkers(): void {
  if (!mapRef) return;
  // Fire-and-forget: the only await inside is the one-time icon rasterization,
  // and a failure there costs the bale icons, not the frame.
  void updateBaleLayer(mapRef, save.fields);
}

// ---------------------------------------------------------------------------
// The fieldwork REVEAL (brief §10): as a machine drives the coverage path, the
// NEW texture (tilled / seeded / cut stubble) appears strip-by-strip behind it.
// We bake the target texture once into an offscreen canvas, then blit only the
// swept strips onto the field's live surface — cheap, and pixel-identical to the
// final full repaint so there's no "pop" when the job finishes.
// ---------------------------------------------------------------------------
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
  /** Route-segment cursor: `lastDist` only ever advances, so stamping resumes
   * scanning the route here instead of from segment 0 every frame. */
  seg: number;
}

/** Min real-ms between GPU uploads of a revealing surface. Was 120 (~8/s) —
 * maintainer report (2026-08-14): reads as choppy, not continuous, since each
 * upload pops in a visibly larger chunk than the eye expects from a texture
 * that's supposedly sweeping smoothly. 40ms (~25/s) is well above the ~24fps
 * "looks continuous" threshold; the strips themselves are still stamped every
 * tick regardless of this value — only the GPU re-upload is throttled, and
 * only a handful of fields have an active reveal at once. */
const REVEAL_UPLOAD_MS = 40;
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
  if (task.type === "mulch") return "stubble"; // residue shredded back to bare stubble
  // harvest + mow + chop all cut to bare/cut ground. Chop used to be a
  // separate "stubble" branch here from back when `applyChopDone` skipped
  // straight past "harvested" — that mapping went stale when it changed to
  // settle at "harvested" (2026-08-14, texture parity with combine-harvested
  // Corn), so the WHOLE active sweep kept baking and blitting the wrong
  // texture strip-by-strip, then "popped" to the right one only once the
  // full field repainted on completion — exactly the visible seam this
  // bake-ahead system exists to prevent (maintainer report, 2026-08-15:
  // "It looks to be going straight to mulched status").
  return "harvested";
}

/** Task types whose completion actually changes the field's texture — the only
 * ones worth the reveal-stamping treatment. Weeding bakes the SAME status with
 * the weed overlay off (sprayer cleans strip-by-strip); fertilizing bakes it
 * ~20% darker (wet liquid spray, dries off next month); mowing cuts the sward. */
const REVEALS_TEXTURE: ReadonlySet<TaskType> = new Set(["plow", "plant", "harvest", "chop", "mow", "mulch", "rake", "bale", "weed", "fertilize"]);

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
        // Real implement width, so a mid-work field's headland frame + pass
        // texture match the machine actually driving it — BUT only for tasks
        // whose implement defines the baked status's geometry (plow furrows,
        // planter/crop rows, cut stubble, windrows). Weed/fertilize just overlay
        // on the existing crop; feeding them the (wide) sprayer swath would
        // redraw the crop's headland frame at sprayer width — a bogus perimeter
        // band. Omit it so they fall back to the crop's own default swath.
        swathM: task.type === "weed" || task.type === "fertilize" ? undefined : path.swath,
        seed: hashSeed(task.fieldId),
      });
      r = { taskId: task.id, fieldId: task.fieldId, baked, lastDist: 0, lastUpload: 0, seg: 0 };
      reveals.set(task.id, r);
    }

    // Reveal up to the swept in-field distance implied by how much is done.
    // Stamping is cheap (a few clipped drawImage calls); the GPU upload of the
    // whole canvas is what costs — throttle IT, not the stamping.
    const revealDist = distanceAtAcres(path, task.doneAcres, task.totalAcres);
    if (revealDist > r.lastDist + 1e-6) {
      r.seg = stampReveal(surface, r.baked, path, r.lastDist, revealDist, r.seg);
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
 * distances `from` and `to`, one swath-wide strip per in-field lane segment.
 * `startSeg` is the caller's cursor from the previous stamp (`from` is
 * monotonic per task, so earlier segments never need rescanning); returns the
 * cursor to pass next time. */
function stampReveal(
  surface: { ctx: CanvasRenderingContext2D; toPixel: (m: Meters) => [number, number] },
  baked: HTMLCanvasElement,
  path: CoveragePath,
  from: number,
  to: number,
  startSeg: number,
): number {
  const ctx = surface.ctx;
  const half = (path.swath / 2) * 1.08; // slight overlap avoids seams between lanes
  // The LONGITUDINAL counterpart to that lateral overlap. `ctx.clip()` antialiases
  // the quad edge, so where two consecutive stamps meet, the shared edge pixel takes
  // ~50% coverage from each and composites to ~75% — the old texture bleeds through
  // as a hairline seam. How MANY seams a lane collects is purely a function of sim
  // speed (this runs once per frame, so 1x stamps every few metres and bands visibly,
  // while 60x sweeps a whole lane in one stamp). Lapping each stamp back over its
  // predecessor's leading edge buries that edge under opaque texture, so the result
  // is identical at any speed. BACKWARD only — padding forward would reveal ground
  // ahead of the machine.
  const [ox, oy] = surface.toPixel([0, 0]);
  const [tx, ty] = surface.toPixel([100, 0]);
  const pxPerM = Math.hypot(tx - ox, ty - oy) / 100 || 1;
  const pad = 2 / pxPerM; // ~2 px of lap, whatever the surface's metres-per-pixel
  // Advance the cursor past segments that end before `from`; stop the loop at
  // the first segment that starts at/after `to` (cum is monotonic).
  let cursor = startSeg;
  while (cursor < path.pts.length - 1 && path.cum[cursor + 1]! <= from) cursor++;
  for (let i = cursor; i < path.pts.length - 1; i++) {
    if (path.cum[i]! >= to) break;
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
    // Trailing edge lapped back over the previous stamp (see `pad` above).
    const q0: Meters = [p0[0] - dx * pad, p0[1] - dy * pad];
    const quad: Meters[] = [
      [q0[0] + px, q0[1] + py],
      [p1[0] + px, p1[1] + py],
      [p1[0] - px, p1[1] - py],
      [q0[0] - px, q0[1] - py],
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
  return cursor;
}

function lerpAlong(a: Meters, b: Meters, distA: number, distB: number, d: number): Meters {
  const t = distB - distA > 1e-9 ? (d - distA) / (distB - distA) : 0;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** Task id currently being drag-reordered in the Jobs list, if any. */
let draggingTaskId: string | null = null;

/** Task id currently SELECTED (clicked) in the Work Queue, if any (2026-08-12).
 * Generic — not tied to any one feature — so a row can carry per-task actions
 * without cluttering every row all the time: today that's just active-task
 * Restart/Cancel (shown only on its own row once selected), but the same
 * selection state is meant to grow other task-specific panels/actions later. */
let selectedTaskId: string | null = null;

function sectionDivider(label: string): HTMLElement {
  const d = document.createElement("div");
  d.className = "qp-sub";
  d.textContent = label;
  return d;
}

/** Display name + working-width/capacity for an implement kind at a size, as
 * TWO separate lines (maintainer request, 2026-07-13): "Plow - Medium" then
 * "10 ft Working Width" — mirrors the equipment-name reorder, "<Kind> - <Size>". */
/**
 * Implement GROUPS for the Equipment tab (maintainer request, 2026-07-24:
 * "sort equipment by Types & Name"). Fourteen implement kinds is well past the
 * point where one flat list reads, so both the owned list and the shop are
 * split under these headings, alphabetical within each.
 *
 * "Misc" has no members today. It's kept so a new implement that fits nowhere
 * else has an obvious home instead of forcing a premature new category.
 */
const IMPLEMENT_GROUP_ORDER = [
  "Field Work", "Yield Modifiers", "Harvesting", "Hay & Silage Tools", "Trailers", "Misc",
] as const;
type ImplementGroup = (typeof IMPLEMENT_GROUP_ORDER)[number];

const IMPLEMENT_GROUP: Record<ImplementKind, ImplementGroup> = {
  plow: "Field Work",
  planter: "Field Work",
  // These two don't move soil or seed — they change what the crop YIELDS.
  sprayer: "Yield Modifiers",
  mulcher: "Yield Modifiers",
  cornHeader: "Harvesting",
  grainHeader: "Harvesting",
  rowCropHead: "Harvesting",
  pickupHead: "Harvesting",
  mower: "Hay & Silage Tools",
  rake: "Hay & Silage Tools",
  bailer: "Hay & Silage Tools",
  squareBaler: "Hay & Silage Tools",
  baleWrapper: "Hay & Silage Tools",
  combiBaler: "Hay & Silage Tools",
  haySpikes: "Hay & Silage Tools",
  grainTrailer: "Trailers",
  baleTrailer: "Trailers",
  forageWagon: "Trailers",
};

const IMPLEMENT_KIND_NAME: Record<ImplementKind, string> = {
  plow: "Plow", planter: "Planter", sprayer: "Sprayer", rake: "Rake",
  bailer: "Round Baler", squareBaler: "Square Baler", grainTrailer: "Grain Trailer", mower: "Mower",
  mulcher: "Mulcher", haySpikes: "Hay Spike", baleTrailer: "Bale Trailer",
  cornHeader: "Corn Header", grainHeader: "Grain Header",
  baleWrapper: "Bale Wrapper", combiBaler: "Round Baler with Wrapper",
  forageWagon: "Forage Wagon", rowCropHead: "Forage Row-Crop Header", pickupHead: "Forage Pickup Header",
};
function implementInfoLines(kind: ImplementKind, size: EquipmentSize): { name: string; detail: string } {
  const name = `${IMPLEMENT_KIND_NAME[kind]} - ${SIZE_LABEL[size]}`;
  if (kind === "grainTrailer") {
    // Volume is the real capacity; the tonnage quoted alongside is corn's, as a
    // familiar yardstick (a lighter crop gets fewer tons into the same wagon).
    return { name, detail: `${grainTrailerCapacityBushels(size).toLocaleString()} bu (~${grainTrailerCapacityTons(size).toFixed(0)} t corn)` };
  }
  if (kind === "forageWagon") {
    // No width of its own (towed, same reasoning as grainTrailer) — its
    // gameConfig widthFt is 0, so the generic fallback below would print
    // "0 ft Working Width".
    return { name, detail: `${gameConfig.equipment.forageWagon[size].capacityTons.toFixed(0)} t capacity` };
  }
  if (kind === "haySpikes") {
    return { name, detail: `${haySpikesCapacityBales(size)} bale capacity` };
  }
  if (kind === "baleTrailer") {
    return { name, detail: `${baleTrailerCapacityBales(size)} bale capacity` };
  }
  if (kind === "baleWrapper") {
    // No width of its own either (2026-08-14 redesign) — it seals bales in
    // place one at a time rather than driving a swath.
    return { name, detail: "seals bales one at a time" };
  }
  return { name, detail: `${gameConfig.equipment[kind][size].widthFt} ft Working Width` };
}

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
/**
 * The implement fill bar's {pct, primary, secondary} for a task/agent pair —
 * factored out (2026-08-13) so `implementRowHtml`'s full row rebuild and
 * `updateFillBars`'s per-frame lightweight patch (below) share one source of
 * truth and can never drift out of sync with each other.
 */
function computeImplFill(task: FarmTask, agent: Agent): { pct: number; primary: string; secondary?: string } | null {
  if (task.type === "harvest") {
    const size = agent.size ?? "medium";
    const crop = task.crop ?? save.fields.find((f) => f.id === task.fieldId)?.crop ?? "corn";
    const capBu = harvesterCapacityBushels(size);
    const capT = harvesterCapacityTons(size, crop);
    const onboard = agent.grainOnboard ?? 0;
    return {
      pct: capT > 0 ? Math.min(100, (onboard / capT) * 100) : 0,
      primary: `${(onboard / tonsPerBushel(crop)).toFixed(0)} / ${capBu.toLocaleString()} bu`,
      secondary: `${onboard.toFixed(1)} / ${capT.toFixed(1)} t ${gameConfig.crops[crop].name.toLowerCase()}`,
    };
  }
  if (task.type === "unloadHarvester") {
    // Grain cart or Forage Wagon, depending on what this relay is hauling
    // (2026-08-14 — the wagon used to fall through and show nothing at all,
    // since this only ever looked for a Grain Trailer).
    if (isSilageRun(task)) {
      const trailer = save.implements.find((i) => i.attachedTo === agent.id && i.kind === "forageWagon");
      if (!trailer) return null;
      const capT = gameConfig.equipment.forageWagon[trailer.size].capacityTons;
      const cargo = trailer.cargoTons ?? 0;
      return {
        pct: capT > 0 ? Math.min(100, (cargo / capT) * 100) : 0,
        // "Forage", not "Silage" (maintainer request, 2026-08-14) — it only
        // ages into generic Silage once it's sat in the bunker a while
        // (`tickSilageAging`); on the wagon it's still fresh-cut.
        primary: `${cargo.toFixed(1)} / ${capT.toFixed(1)} t forage`,
      };
    }
    const trailer = save.implements.find((i) => i.attachedTo === agent.id && i.kind === "grainTrailer");
    if (!trailer) return null;
    const haulCrop = task.crop ?? trailer.cargoCrop ?? "corn";
    const capBu = grainTrailerCapacityBushels(trailer.size);
    const capT = grainTrailerCapacityTons(trailer.size, haulCrop);
    const cargo = trailer.cargoTons ?? 0;
    return {
      pct: capT > 0 ? Math.min(100, (cargo / capT) * 100) : 0,
      primary: `${(cargo / tonsPerBushel(haulCrop)).toFixed(0)} / ${capBu.toLocaleString()} bu`,
      secondary: `${cargo.toFixed(1)} / ${capT.toFixed(1)} t ${gameConfig.crops[haulCrop].name.toLowerCase()}`,
    };
  }
  if (task.type === "chop") {
    // The chopper's own small onboard buffer (2026-08-14 — 5t flat, see
    // gameConfig.equipment.forageHarvester), same idea as a combine's tank.
    const size = agent.size ?? "medium";
    const capT = gameConfig.equipment.forageHarvester[size].capacityTons;
    const onboard = agent.grainOnboard ?? 0;
    return {
      pct: capT > 0 ? Math.min(100, (onboard / capT) * 100) : 0,
      primary: `${onboard.toFixed(1)} / ${capT.toFixed(1)} t forage`,
    };
  }
  if (task.type === "haulBales") {
    // Two different machines can carry this task's fill bar — the Bale
    // Trailer (`buildBaleTrailerRow`) if this agent is running it, else the
    // Hay-Spikes collector.
    if (agent.id === task.trailerAgentId) {
      const trailer = save.implements.find((i) => i.attachedTo === agent.id && i.kind === "baleTrailer");
      if (!trailer) return null;
      const cap = baleTrailerCapacityBales(trailer.size);
      const onboard = trailer.cargoBales ?? 0;
      return { pct: cap > 0 ? Math.min(100, (onboard / cap) * 100) : 0, primary: `${onboard} / ${cap} bales` };
    }
    const spikes = save.implements.find((i) => i.attachedTo === agent.id && i.kind === "haySpikes");
    if (!spikes) return null;
    const capB = haySpikesCapacityBales(spikes.size);
    const onboard = spikes.cargoBales ?? 0;
    return {
      pct: capB > 0 ? Math.min(100, (onboard / capB) * 100) : 0,
      primary: `${onboard} / ${capB} bale${capB === 1 ? "" : "s"}`,
    };
  }
  if (task.type === "bale") {
    const impl = save.implements.find(
      (i) => i.attachedTo === agent.id && (i.kind === "bailer" || i.kind === "squareBaler"),
    );
    if (!impl) return null;
    const field = save.fields.find((f) => f.id === task.fieldId);
    const square = impl.kind === "squareBaler";
    const baleTons = field ? baleTonsOf(baleProductForField(field, square)) : gameConfig.forage.baleTons;
    const cargo = impl.cargoTons ?? 0;
    return {
      pct: baleTons > 0 ? Math.min(100, (cargo / baleTons) * 100) : 0,
      primary: `${cargo.toFixed(2)} / ${baleTons} t`,
      secondary: "toward the next bale",
    };
  }
  return null;
}

function implementRowHtml(task: FarmTask, agent: Agent | undefined): string {
  if (!agent || task.status !== "active") return "";

  let info: { name: string; detail: string };
  // `primary` rides ON the bar (with the %), `secondary` goes on its own line
  // beneath it. Splitting them was forced by the bushel change (2026-07-24):
  // the total used to be "50 t" and now reads "250 bu / 7.0 t", and as a
  // non-shrinking flex item beside the bar it starved the bar down to a stub
  // (maintainer report + screenshot).
  let fill: { pct: number; primary: string; secondary?: string } | null = null;

  if (task.type === "harvest") {
    const size = agent.size ?? "medium";
    // The header actually fitted (2026-07-24) — which one, and how wide, is now
    // a real choice rather than an assumed part of the combine.
    const header = save.implements.find(
      (i) => i.attachedTo === agent.id && (i.kind === "cornHeader" || i.kind === "grainHeader"),
    );
    info = header
      ? implementInfoLines(header.kind, header.size)
      : { name: "No header fitted", detail: `${gameConfig.equipment.harvester[size].widthFt} ft nominal` };
    // Capacity is VOLUME, and how many tons that is depends on the crop
    // (2026-07-24) — so the bar shows both: bushels are what the tank actually
    // holds, tons are what the player sells.
    fill = computeImplFill(task, agent);
  } else if (task.type === "unloadHarvester") {
    // Grain cart or Forage Wagon, depending on what this relay is hauling
    // (2026-08-14 — the wagon used to fall through this branch entirely,
    // since it only ever looked for a Grain Trailer, and returned "" —
    // no row at all, unlike the grain cart's).
    const trailerKind = relayTrailerKind(task);
    const trailer = save.implements.find((i) => i.attachedTo === agent.id && i.kind === trailerKind);
    if (!trailer) return "";
    info = implementInfoLines(trailerKind, trailer.size);
    fill = computeImplFill(task, agent);
  } else if (task.type === "chop") {
    // The chopper's own head (2026-08-14) — text only, no picture: the head
    // is a small detail on a machine already the size of the card.
    const headKind = chopHeadKindForTask(save, task);
    const head = headKind ? save.implements.find((i) => i.attachedTo === agent.id && i.kind === headKind) : undefined;
    info = head
      ? implementInfoLines(head.kind, head.size)
      : { name: "No header fitted", detail: headKind ? `${IMPLEMENT_KIND_NAME[headKind]} needed` : "" };
    fill = computeImplFill(task, agent);
  } else if (task.type === "haulBales") {
    const spikes = save.implements.find((i) => i.attachedTo === agent.id && i.kind === "haySpikes");
    if (!spikes) return "";
    info = implementInfoLines("haySpikes", spikes.size);
    fill = computeImplFill(task, agent);
  } else if (task.type === "bale") {
    const impl = save.implements.find(
      (i) => i.attachedTo === agent.id && (i.kind === "bailer" || i.kind === "squareBaler"),
    );
    if (!impl) return "";
    // A baler has no width of its own (2026-07-24) — it clears whatever the
    // windrow is wide, so that's what's worth showing here.
    const field = save.fields.find((f) => f.id === task.fieldId);
    const swathFt = field?.windrowWidthM ? field.windrowWidthM / FEET_TO_METERS : undefined;
    info = {
      name: `${IMPLEMENT_KIND_NAME[impl.kind]} - ${SIZE_LABEL[impl.size]}`,
      detail: swathFt ? `${swathFt.toFixed(0)} ft windrow` : "picks up the windrow",
    };
    fill = computeImplFill(task, agent);
  } else if (agent.kind === "windrower") {
    // NO implement row at all (maintainer request, 2026-07-25). A windrower is
    // self-propelled — it IS the mower — so an implement row has nothing to
    // describe: it was repeating the machine's own name under a second, smaller
    // copy of the sprite already at the top of the card.
    //
    // This slot has now been wrong twice in the other direction: before
    // 2026-07-24 it invented a phantom "Mower - Medium" (an implement the farm
    // may not own, at a width that isn't the windrower's), and it was then
    // corrected to name the machine instead. Naming the machine twice is the
    // remaining redundancy; the honest answer is to draw nothing.
    return "";
  } else {
    const kind = TASK_IMPLEMENT[task.type];
    if (!kind) return "";
    const impl = save.implements.find((i) => i.attachedTo === agent.id && i.kind === kind);
    // No row rather than a fabricated one: `size ?? "medium"` used to invent an
    // implement (and a width) for any machine that wasn't actually carrying one.
    if (!impl) return "";
    info = implementInfoLines(kind, impl.size);
  }

  // The relay's Bale Trailer used to be squeezed in here as a second sub-row.
  // It gets its own full-width CARD now (`buildBaleTrailerRow`, 2026-07-25):
  // its name carries both the implement and its tractor, which wrapped onto
  // four lines inside a sub-row and left the fill bar clipped to "/ 20 bales".
  return implRow(info, fill, agent.id);
}

/** Wrap one implement into a Work-Queue sub-row (name/detail + optional fill
 * bar). Shared by the collector row and the Bale Trailer row. `agentId`
 * (2026-08-13) stamps the bar/label so `updateFillBars` can patch them every
 * frame without waiting for the panel's throttled full rebuild.
 *
 * No icon (2026-08-14, maintainer request) — the row used to lead with a
 * small implement icon; dropped to cut card height, since the machine's own
 * large sprite at the top of the card already carries the art. */
function implRow(
  info: { name: string; detail: string },
  fill: { pct: number; primary: string; secondary?: string } | null,
  agentId?: string,
): string {
  // The bar takes the WHOLE row (2026-07-24). It used to share the row with a
  // non-shrinking total off to the right, which was fine at "50 t" and hopeless
  // once capacities read "250 bu / 7.0 t" — the bar collapsed to a stub and its
  // own centred label overflowed it.
  const fillHtml = fill
    ? `<div class="impl-fillrow">
        <span class="impl-fill">
          <span class="impl-fill-bar" ${agentId ? `data-fill-agent="${agentId}"` : ""} style="width:${fill.pct.toFixed(0)}%"></span>
          <span class="impl-fill-label">${fill.primary} · ${fill.pct.toFixed(0)}%</span>
        </span>
      </div>${fill.secondary ? `<div class="impl-fillsub">${fill.secondary}</div>` : ""}`
    : "";
  return `<div class="qr-impl">
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
/**
 * How far through a bale haul the whole JOB is — bales cleared off the field
 * against the high-water total the sim keeps (`task.haulTotalBales`).
 *
 * Shared by both of the relay's cards on purpose (2026-07-25): they're two
 * machines working one task, so the progress bar at the top of each has to be
 * the same number. The trailer's own load is a separate thing entirely and
 * stays where it belongs, on its implement row's fill bar.
 */
function haulProgress(task: FarmTask): { total: number; remaining: number; cleared: number; pct: number } {
  const remaining = save.fields.find((f) => f.id === task.fieldId)?.baleLocations?.length ?? 0;
  const total = task.haulTotalBales ?? 0;
  const cleared = Math.max(0, total - remaining);
  return { total, remaining, cleared, pct: total > 0 ? Math.min(100, (cleared / total) * 100) : 0 };
}

/**
 * The relay's Bale Trailer half, as its own Work-Queue card (2026-07-25).
 *
 * It rode inside the Haul Bales card as a second implement sub-row until the
 * maintainer pointed out how badly it read once a trailer actually joined: the
 * row had to name both the implement AND its tractor to say which machine it
 * was, which wrapped to four lines in a sub-row's narrow column and squeezed
 * the fill bar down until its label clipped to "/ 20 bales · 0".
 *
 * It's laid out exactly like the Haul Bales card it accompanies — machine
 * sprite, name, machine, status, progress bar, implement row — because it IS
 * the same shape of job: one tractor, one implement, a load to move. Returns
 * null for anything that isn't a haul with a trailer attached.
 */
function buildBaleTrailerRow(task: FarmTask): HTMLElement | null {
  if (task.type !== "haulBales" || !task.trailerAgentId) return null;
  const tAgent = save.agents.find((a) => a.id === task.trailerAgentId);
  if (!tAgent) return null;
  const trailer = save.implements.find((i) => i.attachedTo === tAgent.id && i.kind === "baleTrailer");
  if (!trailer) return null;

  const load = computeImplFill(task, tAgent);
  const phase = task.waitingForStorage
    ? "⚠️ Waiting for storage room"
    : (TRAILER_PHASE_TEXT[task.trailerPhase ?? "toEntrance"] ?? "");
  // Top bar = the JOB's progress, the same figure the Haul Bales card shows —
  // these are two machines on one task. It used to repeat the trailer's own
  // load, so the card carried the identical bar twice (maintainer report).
  // The load keeps its own bar down on the implement row.
  const job = haulProgress(task);

  const row = document.createElement("div");
  row.className = "queue-row active" + (task.waitingForStorage ? " warn" : "");
  row.innerHTML = `
    <span class="icon">${machineIconHtml(tAgent.kind, tAgent.size, 96)}</span>
    <span class="qr-info">
      <div class="qr-name">Bale Trailer · ${escapeHtml(fieldLabelOf(task.fieldId))}</div>
      <div class="qr-machine">${escapeHtml(tAgent.name)}</div>
      <div class="qr-sub">${phase}</div>
      ${job.total > 0
        ? `<div class="progress-row">
            <div class="progress"><div class="fill" style="width:${job.pct.toFixed(0)}%"></div></div>
            <span class="progress-hrs">${job.remaining}/${job.total}</span>
          </div>`
        : ""}
      ${implRow(
        implementInfoLines("baleTrailer", trailer.size),
        load,
        tAgent.id,
      )}
    </span>`;
  return row; // system task — not draggable/cancelable, it follows its haul
}

/** One row in the Jobs list. Active jobs are locked in place (an agent is
 * already committed — reordering them would be meaningless/risky) and show
 * the working machine's icon; queued jobs carry no icon, are drag-reorderable,
 * and get a cancel button. */
/** Restart/Cancel for an ACTIVE task — the "it's stuck, get me out" escape
 * hatch (maintainer request, 2026-08-12: reloading doesn't clear a wedged
 * task since the save state IS what's broken). Restart wipes the task's
 * cached route/phase state and lets it re-derive everything fresh in place;
 * Cancel drops it outright (no refund) and frees the machine for other work.
 * Shown on every active row, including the system tasks (unload/haul/sell) —
 * those are exactly the phase-machine-heavy ones most likely to wedge.
 * Icon-only, tucked in the row's bottom-left corner (2026-08-12 follow-up —
 * the labeled buttons ate too much width for something used rarely): the
 * title attribute carries the label instead of visible text.
 *
 * Also carries a 📍 Locate button (2026-08-14, maintainer request) — same
 * fly-to-position button used on Field/Equipment/Structures cards
 * (`locateButton`), reused here rather than duplicated: jumps the map to
 * wherever the working agent actually is, which for a haul/unload/sell leg
 * may be well off the field itself. */
function buildActiveTaskControls(task: FarmTask, agent: Agent | undefined): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "qr-active-controls";

  const field = save.fields.find((f) => f.id === task.fieldId);
  const locatePos = agent?.pos ?? (field ? centroidOf(field.boundary) : undefined);
  if (locatePos) wrap.appendChild(locateButton(agent?.name ?? fieldLabelOf(task.fieldId), locatePos));

  const restartBtn = document.createElement("button");
  restartBtn.className = "qr-restart";
  restartBtn.textContent = "↻";
  restartBtn.title = "Stuck? Reset this job's route/phase — it picks back up in place";
  restartBtn.addEventListener("click", () => {
    try {
      restartActiveTask(save, task.id);
      lastQueueKey = " init";
      refreshQueuePanel();
      if (selectedFieldId) refreshFieldPanel(true);
      toast("↻ Restarted");
    } catch (err) {
      toast("❌ " + (err as Error).message, 3500);
    }
  });
  wrap.appendChild(restartBtn);

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "qr-force-cancel";
  cancelBtn.textContent = "⛔";
  cancelBtn.title = "Stuck? Drop this job entirely and free up the machine — no refund";
  cancelBtn.addEventListener("click", async () => {
    if (!(await confirmDialog({
      title: `Cancel this ${TASK_NOUN[task.type] ?? task.type} job?`,
      body: "The machine working it is freed up immediately, but there's no refund — this is meant for a job that's genuinely stuck, not a normal cancel.",
      okLabel: "Cancel job", danger: true,
    }))) return;
    try {
      forceCancelActiveTask(save, task.id);
      if (selectedTaskId === task.id) selectedTaskId = null; // the row it was on is gone
      updateHud();
      lastQueueKey = " init";
      refreshQueuePanel();
      if (selectedFieldId) refreshFieldPanel(true);
      toast("⛔ Canceled");
    } catch (err) {
      toast("❌ " + (err as Error).message, 3500);
    }
  });
  wrap.appendChild(cancelBtn);

  return wrap;
}

/** Click-to-select wiring shared by every branch below (2026-08-12) —
 * highlights the row and is what buildActiveTaskControls gates on, so the
 * Restart/Cancel icons only show up for the one task you've actually clicked
 * instead of cluttering every active row. Ignores clicks that land on a
 * button inside the row (cancel/restart) so those keep their own behavior
 * rather than also toggling selection. Not tied to the active-controls
 * feature specifically — selection is meant to carry other per-task
 * actions/panels later too. */
function wireRowSelection(row: HTMLElement, task: FarmTask): void {
  row.classList.toggle("selected", task.id === selectedTaskId);
  row.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("button")) return;
    selectedTaskId = selectedTaskId === task.id ? null : task.id;
    lastQueueKey = " init";
    refreshQueuePanel();
  });
}

/** A queued row's Cancel button (2026-08-13) — shared by every queued row
 * type now, including the system ones (Unload Harvester / Haul Bales /
 * Sell), which used to have no way to cancel while queued at all. */
function queuedCancelButton(task: FarmTask): HTMLButtonElement {
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
  return btn;
}

/** A queued row's Reset button (2026-08-13) — cancel it and immediately
 * re-queue an equivalent task at the back, freshly validated and re-paid
 * (see `resetQueuedTask`). Generic field tasks only: a system task
 * self-regenerates on its own every tick its trigger condition still holds,
 * so Cancel already covers "reset" for those — `queuedCancelButton` alone. */
function queuedResetButton(task: FarmTask): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "qr-reset";
  btn.textContent = "↻";
  btn.title = "Reset — cancel and re-queue at the back";
  btn.addEventListener("click", () => {
    try {
      resetQueuedTask(save, task.id, clock.time());
      updateHud();
      refreshQueuePanel();
      if (selectedFieldId) refreshFieldPanel(true);
      toast("↻ Reset");
    } catch (err) {
      toast("❌ " + (err as Error).message, 3500);
    }
  });
  return btn;
}

function buildQueueRow(task: FarmTask): HTMLElement {
  const isActive = task.status === "active";
  const agent = isActive && task.agentId ? save.agents.find((a) => a.id === task.agentId) : undefined;
  // Header-aware (2026-07-25): a combine on the Work Queue shows the head it's
  // actually running, not a generic one.
  const iconHtml = agent ? `<span class="icon">${agentMachineIconHtml(agent, 96)}</span>` : "";

  if (task.type === "unloadHarvester") {
    // Not acres-based — no %/hours estimate; show the phase instead.
    const sub = task.waitingForSilo ? "⚠️ Waiting for silo room" : (UNLOAD_PHASE_TEXT[task.unloadPhase ?? "toHarvester"] ?? "Hauling grain…");
    const row = document.createElement("div");
    row.className = "queue-row" + (isActive ? " active" : " queued") + (task.waitingForSilo ? " warn" : "");
    row.innerHTML = `
      ${iconHtml}
      <span class="qr-info">
        <div class="qr-name">Unload · ${escapeHtml(fieldLabelOf(task.fieldId))}</div>
        ${agent ? `<div class="qr-machine">${agent.name}</div>` : ""}
        <div class="qr-sub">${sub}</div>
        ${implementRowHtml(task, agent)}
      </span>`;
    wireRowSelection(row, task);
    if (isActive && task.id === selectedTaskId) row.appendChild(buildActiveTaskControls(task, agent));
    else if (!isActive) row.appendChild(queuedCancelButton(task));
    return row; // system task — not draggable/reorderable, it self-regenerates
  }

  if (task.type === "haulBales") {
    // Laid out like every other active job (maintainer request, 2026-07-25):
    // machine sprite, then name / machine / status / progress bar / implement
    // rows. It used to skip the sprite AND the bar — the sprite on the grounds
    // that one icon couldn't represent a two-tractor relay, and the bar because
    // a haul isn't acres-based and had no denominator. The relay is still
    // legible: the big sprite is the COLLECTOR (in its hay-spike livery, which
    // is unmistakable), and the Bale Trailer keeps its own row with its own
    // tractor paired to it below — this card only names ITS OWN tractor
    // (2026-08-14 follow-up: the paired trailer tractor used to tag along
    // in this card's machine line too, which read as one card driving two
    // tractors instead of two cards each driving one).
    // Bales CLEARED off the field, against the high-water total the sim keeps.
    // Shared with the trailer's card via `haulProgress` so the two halves of
    // one relay can never show different progress for the same job.
    const job = haulProgress(task);
    const row = document.createElement("div");
    row.className = "queue-row" + (isActive ? " active" : " queued") + (task.waitingForStorage ? " warn" : "");
    row.innerHTML = `
      ${agent ? `<span class="icon">${agentMachineIconHtml(agent, 96)}</span>` : ""}
      <span class="qr-info">
        <div class="qr-name">Haul Bales · ${escapeHtml(fieldLabelOf(task.fieldId))}</div>
        ${agent ? `<div class="qr-machine">${agent.name}</div>` : ""}
        <div class="qr-sub">${haulSubText(task)}</div>
        ${isActive && job.total > 0
          ? `<div class="progress-row">
              <div class="progress"><div class="fill" style="width:${job.pct.toFixed(0)}%"></div></div>
              <span class="progress-hrs">${job.remaining}/${job.total}</span>
            </div>`
          : ""}
        ${implementRowHtml(task, agent)}
      </span>`;
    wireRowSelection(row, task);
    if (isActive && task.id === selectedTaskId) row.appendChild(buildActiveTaskControls(task, agent));
    else if (!isActive) row.appendChild(queuedCancelButton(task));
    return row; // system task — not draggable/reorderable, it self-regenerates
  }

  if (task.type === "sell") {
    // Point-to-point, not acreage — and its fieldId is empty (a sale spans the
    // farm), so the generic row's field label would render blank.
    const product = task.sellProduct ?? "";
    const name = (gameConfig.crops as Record<string, { name: string } | undefined>)[product]?.name
      ?? (gameConfig.baleProducts as Record<string, { name: string } | undefined>)[product]?.name
      ?? (gameConfig.silageProducts as Record<string, { name: string } | undefined>)[product]?.name
      ?? product;
    const left = sellableStock(save, product);
    const phase: Record<string, string> = {
      toSource: "heading to storage", loading: "loading", toMarket: "hauling to market", dumping: "selling",
    };
    const row = document.createElement("div");
    row.className = "queue-row" + (isActive ? " active" : " queued");
    row.innerHTML = `
      ${iconHtml}
      <span class="qr-info">
        <div class="qr-name">💵 Sell ${escapeHtml(name)}</div>
        ${agent ? `<div class="qr-machine">${agent.name}</div>` : ""}
        <div class="qr-sub">${phase[task.sellPhase ?? "toSource"] ?? ""}${left > 0 ? ` · ${Math.round(left)} left in storage` : ""}</div>
        ${implementRowHtml(task, agent)}
      </span>`;
    wireRowSelection(row, task);
    if (isActive && task.id === selectedTaskId) row.appendChild(buildActiveTaskControls(task, agent));
    else if (!isActive) row.appendChild(queuedCancelButton(task));
    return row; // system task — self-regenerating, not draggable/reorderable
  }

  // Wrap is bale-count progress, not acreage (2026-08-14 redesign) — the
  // tractor visits each unwrapped bale in turn (see the `wrap` tick block,
  // sim/tasks.ts), so "done" is bales sealed, not distance driven. Both
  // piles live on the FIELD, not the task, so this reads them directly the
  // same way `implementRowHtml`'s haulBales branch reads `field.
  // baleLocations`. Still a REGULAR queued field task otherwise (unlike
  // haulBales/unloadHarvester/sell above, which self-regenerate) — it shares
  // this branch's drag-reorder + Reset/Cancel footer below, just with its
  // own name/sub/progress markup instead of the acres/mph one.
  const isWrap = task.type === "wrap";
  const wrapField = isWrap ? save.fields.find((f) => f.id === task.fieldId) : undefined;
  const wrapped = wrapField?.wrappedBaleLocations?.length ?? 0;
  const wrapRemaining = wrapField?.baleLocations?.length ?? 0;
  const wrapTotal = wrapped + wrapRemaining;

  const hours = estimateTaskHours(save, task);
  const pct = isWrap
    ? (wrapTotal > 0 ? (wrapped / wrapTotal) * 100 : 0)
    : (task.doneAcres / task.totalAcres) * 100;
  // Active row trades "hrs left" for the machine's working speed (2026-08-14,
  // maintainer request) — the hour figure moved out to sit beside the
  // progress bar instead (see `.progress-row` below), so it isn't lost.
  const speedMph = taskFieldSpeedKmh(task.type, agent) * KMH_TO_MPH;
  const sub = isWrap
    // No text at all while active (2026-08-14, maintainer request) — the
    // count now sits next to the bar instead (below), same place every
    // other active row's "Xh left" lives, so there's nothing left to say
    // here that isn't already on the bar.
    ? (isActive ? "" : `waiting${wrapTotal > 0 ? ` · ${wrapped}/${wrapTotal}` : ""}`)
    : isActive
      ? `${task.totalAcres.toFixed(0)} ac · ${speedMph.toFixed(1)} mph`
      : `${task.totalAcres.toFixed(0)} ac · waiting · ~${hours.toFixed(1)}h`;

  const row = document.createElement("div");
  row.className = "queue-row" + (isActive ? " active" : " queued");
  row.innerHTML = `
    ${iconHtml}
    <span class="qr-info">
      <div class="qr-name">${isWrap ? "Wrap Bales" : cap(taskVerb(task))} · ${escapeHtml(fieldLabelOf(task.fieldId))}</div>
      ${agent ? `<div class="qr-machine">${agent.name}</div>` : ""}
      ${sub ? `<div class="qr-sub">${sub}</div>` : ""}
      ${isActive
        ? (isWrap
          ? (wrapTotal > 0
            ? `<div class="progress-row">
                <div class="progress"><div class="fill" style="width:${pct.toFixed(0)}%"></div></div>
                <span class="progress-hrs">${wrapped}/${wrapTotal}</span>
              </div>`
            : "")
          : `<div class="progress-row">
              <div class="progress"><div class="fill" style="width:${pct.toFixed(0)}%"></div></div>
              <span class="progress-hrs">${hours.toFixed(1)}h left</span>
            </div>`)
        : ""}
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

    row.appendChild(queuedResetButton(task));
    row.appendChild(queuedCancelButton(task));
  }
  wireRowSelection(row, task);
  if (isActive && task.id === selectedTaskId) row.appendChild(buildActiveTaskControls(task, agent));

  return row;
}

/**
 * Patch every implement fill bar's width/label directly, without rebuilding
 * the row it lives in (2026-08-13). `refreshQueuePanel` only rebuilds the
 * Work Queue panel ~2x/sec (`tickWorld`'s `lastUiRefresh` gate) — rebuilding
 * every frame was ruled out because it recreates buttons under the player's
 * cursor. The underlying data (`agent.grainOnboard`, `Implement.cargoTons`,
 * …) is already updated every tick, so the bar visibly stepping in ~8%
 * jumps was purely a redraw-cadence problem, not a data one. Called
 * unconditionally every `tickWorld` — this only ever touches two `<span>`s
 * per bar, so it's cheap enough to run at full frame rate.
 */
function updateFillBars(): void {
  const bars = document.querySelectorAll<HTMLElement>(".impl-fill-bar[data-fill-agent]");
  for (const bar of bars) {
    const agentId = bar.dataset.fillAgent;
    const agent = agentId ? save.agents.find((a) => a.id === agentId) : undefined;
    const task = agent?.taskId ? save.tasks.find((t) => t.id === agent.taskId) : undefined;
    const fill = agent && task ? computeImplFill(task, agent) : null;
    if (!fill) continue;
    bar.style.width = `${fill.pct.toFixed(0)}%`;
    const label = bar.parentElement?.querySelector<HTMLElement>(".impl-fill-label");
    if (label) label.textContent = `${fill.primary} · ${fill.pct.toFixed(0)}%`;
  }
}

/**
 * Patch the Equipment tab's live status text/dot color directly, without
 * rebuilding a card's row (2026-08-14). `refreshEquipTab`'s rebuild-gating
 * key used to include every card's live progress %/onboard tonnage, which
 * — being genuinely continuous while a job runs — meant the key changed on
 * essentially every refresh and `buildEquipMachines`/`buildEquipImplements`
 * did a full `innerHTML = ""` + rebuild roughly 2x/sec any time equipment
 * was working (maintainer report: "flickers and sometimes you have to
 * attempt a few clicks... to execute the action" — a fresh button replacing
 * the one under the cursor mid-click eats the click). The key now only
 * tracks STRUCTURAL changes (attach/detach, discrete state, fleet size);
 * this patches the couple of text nodes that actually change continuously,
 * same split as `updateFillBars`/`computeImplFill`.
 */
function updateEquipStatusText(): void {
  if ($("equiptab").style.display === "block") {
    for (const el of document.querySelectorAll<HTMLElement>('[data-status-for^="agent:"]')) {
      const agent = save.agents.find((a) => `agent:${a.id}` === el.dataset.statusFor);
      if (!agent) continue;
      const { taskText, stateClass } = agentCardStatus(agent);
      el.className = el.className.replace(/^equip-card \S+/, `equip-card ${stateClass}`);
      const dot = el.querySelector<HTMLElement>(".ec-dot");
      if (dot) { dot.className = `ec-dot ${stateClass}`; dot.title = taskText; }
      const status = el.querySelector<HTMLElement>(".ec-status");
      if (status) { status.textContent = taskText; status.title = taskText; }
    }
  }
  if ($("structurestab").style.display !== "block") return;
  for (const el of document.querySelectorAll<HTMLElement>('[data-status-for^="impl:"]')) {
    const impl = save.implements.find((i) => `impl:${i.id}` === el.dataset.statusFor);
    if (!impl) continue;
    const { statusText, stateClass } = implCardStatus(impl);
    el.className = el.className.replace(/\S+$/, stateClass);
    const dot = el.querySelector<HTMLElement>(".ec-dot");
    if (dot) { dot.className = `ec-dot ${stateClass}`; dot.title = statusText; }
    const status = el.querySelector<HTMLElement>(".ec-status");
    if (status) { status.textContent = statusText; status.title = statusText; }
  }
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
      // The relay's TRAILER is a second machine on this same task, and since
      // 2026-07-25 it draws its own card with its own fill bar — its load has
      // to be in the key too, or that bar only repaints when the phase changes.
      const trailerImpl = t.trailerAgentId ? save.implements.find((i) => i.attachedTo === t.trailerAgentId) : undefined;
      const trailerBales = trailerImpl?.cargoBales ?? "";
      // Which sprite the card draws (a combine's header, a tractor's spikes).
      // Swapping a corn head for a grain platform changes nothing else in this
      // key — both headers carry no cargo — so without it the card keeps the
      // old machine art until some unrelated field happens to change.
      const agentForRow = t.agentId ? save.agents.find((a) => a.id === t.agentId) : undefined;
      const spriteKey = agentForRow ? agentSpriteKey(agentForRow) : "";
      return `${t.id}:${t.status}:${t.agentId ?? ""}:${Math.round((t.doneAcres / t.totalAcres) * 100)}:${t.unloadPhase ?? ""}:${t.waitingForSilo ?? ""}:${cargoBucket}:${t.haulPhase ?? ""}:${t.trailerPhase ?? ""}:${t.waitingForStorage ?? ""}:${bales}:${t.trailerAgentId ?? ""}:${trailerBales}:${t.haulTotalBales ?? ""}:${spriteKey}`;
    })
    .join("|") + `#${completed.length}:${nowDate.year}:${nowDate.month}`;
  // Blocked work is derived from state the task list alone doesn't capture
  // (cash, what machines are owned), so it needs its own slice of the key or
  // the ⚠️ rows would go stale — including never appearing when the ONLY
  // thing to report is a block and the task list itself hasn't changed.
  const blocked = blockedWork(save);
  const fullKey = key + "#B" + blocked.map((b) => `${b.fieldId}:${b.type}:${b.reason}`).join(",");
  if (fullKey === lastQueueKey) return;
  lastQueueKey = fullKey;

  const rows = $("queue-rows");
  rows.innerHTML = "";
  if (save.tasks.length === 0 && completed.length === 0 && blocked.length === 0) {
    rows.innerHTML = `<div class="queue-empty">No jobs queued — plow, plant, or harvest a field.</div>`;
    return;
  }

  const active = save.tasks.filter((t) => t.status === "active");
  const queued = save.tasks.filter((t) => t.status === "queued");

  if (active.length > 0) {
    rows.appendChild(sectionDivider("Active"));
    for (const task of active) {
      rows.appendChild(buildQueueRow(task));
      // A bale relay is two machines on one task — the trailer half gets its
      // own card straight after the collector's, rather than a cramped sub-row.
      const trailerRow = buildBaleTrailerRow(task);
      if (trailerRow) rows.appendChild(trailerRow);
    }
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
  // Work the farm wants to do but can't (2026-07-23). Shown after live jobs so
  // it never pushes them down the panel, but before Completed so it isn't
  // buried under a month of history.
  if (blocked.length > 0) {
    rows.appendChild(sectionDivider("Blocked"));
    for (const b of blocked) rows.appendChild(buildBlockedRow(b));
  }
  if (completed.length > 0) {
    rows.appendChild(sectionDivider(`Completed — ${MONTH_SHORT[nowDate.month]}`));
    for (const ct of completed) rows.appendChild(buildCompletedRow(ct));
  }
}

/** Present-tense task names, for work that hasn't happened yet — the Completed
 * feed's `TASK_PAST_VERB` ("Plowed") reads as a lie on a blocked row. */
const TASK_NOUN: Record<TaskType, string> = {
  plow: "Plow", plant: "Plant", harvest: "Harvest", mow: "Mow",
  mulch: "Mulch", weed: "Weed", fertilize: "Fertilize", rake: "Rake", bale: "Bale", wrap: "Wrap",
  chop: "Chop", unloadHarvester: "Haul grain", haulBales: "Haul bales", sell: "Sell run",
};

/** A ⚠️ row for work that can't proceed — task + field, then why. Deliberately
 * inert: there's no task to cancel or reorder, it's a diagnosis. Clicking it
 * jumps to the field so the fix is one step away. */
function buildBlockedRow(b: BlockedWork): HTMLElement {
  const row = document.createElement("div");
  row.className = "queue-row blocked";
  row.innerHTML = `
    <span class="qr-info">
      <div class="qr-name">⚠️ ${TASK_NOUN[b.type] ?? b.type} · ${escapeHtml(fieldLabelOf(b.fieldId))}</div>
      <div class="qr-sub">${escapeHtml(b.reason)}</div>
    </span>`;
  row.addEventListener("click", () => {
    const field = save.fields.find((f) => f.id === b.fieldId);
    if (field) {
      openFieldPanel(field.id);
      mapRef.flyTo({ center: toLngLat(centroidOf(field.boundary)), zoom: 15 });
    }
  });
  return row;
}

const TASK_PAST_VERB: Record<TaskType, string> = {
  plow: "Plowed", plant: "Planted", harvest: "Harvested", mow: "Mowed",
  mulch: "Mulched", weed: "Weeded", fertilize: "Fertilized", rake: "Raked", bale: "Baled", wrap: "Wrapped",
  chop: "Chopped", unloadHarvester: "Hauled", haulBales: "Hauled bales", sell: "Sold",
};

/** One compact, non-interactive row per finished job OR sale — sized like a
 * queued row but with no icon/progress bar, just what it produced. */
function buildCompletedRow(ct: CompletedTask): HTMLElement {
  let icon: string;
  let name: string;
  if (ct.type === "sellGrain" || ct.type === "sellBales") {
    icon = "💰";
    const label = ct.label ?? (ct.crop ? gameConfig.crops[ct.crop].name : "Product");
    name = `Sold ${label}` + (ct.fieldId ? ` · ${escapeHtml(fieldLabelOf(ct.fieldId))}` : "");
  } else {
    icon = "✅";
    const verb = TASK_PAST_VERB[ct.type] ?? cap(ct.type);
    const field = escapeHtml(fieldLabelOf(ct.fieldId));
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

/** A small "+N%" seasonal-premium badge for a product at the current month
 * (empty string at base price). */
function priceBadge(product: MarketProduct): string {
  const bonus = seasonalBonus(product, monthOf(clock.time()));
  if (bonus <= 0.001) return "";
  return `<span class="price-badge">+${Math.round(bonus * 100)}%</span>`;
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
  // Total acres owned replaced the grain-bin total here (maintainer request,
  // 2026-07-23) — inventory has its own tab; acreage is the farm's size at a
  // glance and doesn't live anywhere else in the header.
  const acres = save.fields.reduce((sum, f) => sum + areaAcres(f.boundary), 0);
  $("hud-acres").textContent = acres.toFixed(0) + " ac";

  // Year-position marker: fraction of the display year (Mar → Feb) elapsed.
  const f = yearFraction(clock.time());
  $("year-marker").style.left = `calc(${(f * 100).toFixed(2)}% - 1px)`;
  // The calendar grid's label column; the lanes take the rest.
  const calNow = document.getElementById("cal-now");
  if (calNow) calNow.style.left = `calc(${(CAL_LABEL_W * (1 - f)).toFixed(1)}px + ${(f * 100).toFixed(2)}%)`;
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

/** The Market section (2026-07-22 rework, maintainer: the tab was "very
 * busy"). ONE compact row per sellable product — holdings wherever they sit
 * (bin / storage / field), today's price, a Sell-all button, and the auto-sell
 * schedule (month dropdown + toggle). Replaces the per-product 12-month price
 * strips: the seasonal curve is IDENTICAL for every product (fixed Dec peak),
 * so it's explained once in the note line instead of drawn twelve times over.
 * Also absorbs the old "Unassigned Grain" and "In-Field Bales" sections —
 * holdings here are totals, so nothing can strand out of view. */
/**
 * How many cuttings a year a bale product comes off an acre (maintainer spec,
 * 2026-07-24: "assume 3 harvests for grass & alfalfa, 1 harvest for straw").
 * Straw is a by-product of a single annual grain harvest; a hay stand is mown
 * three times. Drives the per-acre figures in the Market rows — without it,
 * hay's $/acre would read a third of what a hay field actually earns.
 */
function cuttingsPerYearFor(product: BaleProduct): number {
  const crop = (Object.keys(gameConfig.crops) as CropId[]).find((c) => {
    const bp = gameConfig.crops[c].baleProduct;
    return bp !== undefined && (bp === product || `${bp}Square` === product);
  });
  return crop ? (gameConfig.crops[crop].harvestMonths?.length ?? 1) : 1;
}

/**
 * The one-line "when does this sell best" note above the Market rows, DERIVED
 * from the seasonal curve rather than spelled out (2026-07-25).
 *
 * It was hardcoded to December's old +25%/+15%/+10%, so the realism pass that
 * moved the peak to July left the panel telling players the opposite of what
 * the game does. Built from config now, so it can't drift again.
 */
function marketCurveNote(): string {
  const { peakMonth, seasonalBonusByDistance } = gameConfig.market;
  const name = (m: number) => MONTH_NAMES[((m % 12) + 12) % 12];
  const parts: string[] = [];
  for (const key of Object.keys(seasonalBonusByDistance).map(Number).sort((a, b) => a - b)) {
    const pct = Math.round((seasonalBonusByDistance[key] ?? 0) * 100);
    if (pct <= 0) continue;
    parts.push(key === 0
      ? `+${pct}% ${name(peakMonth)}`
      : `+${pct}% ${name(peakMonth - key)} &amp; ${name(peakMonth + key)}`);
  }
  return `Every product sells best in <b>${name(peakMonth)}</b>: ${parts.join(" · ")} · base otherwise.`;
}

function buildMarketSection(rows: HTMLElement): void {
  const now = clock.time();
  const month = monthOf(now);
  rows.insertAdjacentHTML(
    "beforeend",
    `<div class="inv-heading">🏷️ Market</div>
     <div class="mkt-note">${marketCurveNote()}</div>`,
  );

  // Farm-wide auto-sell (maintainer request, 2026-07-24). Sits above the
  // product rows because it's the DEFAULT they inherit — including crops not in
  // store yet, which is the reason it exists at all: the rows below only show
  // what the farm currently holds, so a per-product switch can't reach a crop
  // that hasn't been grown.
  const allPlan = save.sellAll ?? { month: peakSaleMonth(), auto: false };
  const allRow = document.createElement("div");
  allRow.className = "inv-row mkt-row mkt-all";
  allRow.innerHTML = `
    <span class="icon">🔁</span>
    <span class="info">
      <div class="name">Auto-sell everything</div>
      <div class="qty">${allPlan.auto
        ? "On — every product sells this month; individual settings are off while this is on"
        : "Every crop and bale, including ones you haven't grown yet"}</div>
    </span>`;

  const allSelect = document.createElement("select");
  allSelect.className = "mkt-month";
  allSelect.title = "The month everything sells in, unless a product below is set on its own";
  allSelect.innerHTML = SCHEDULE_MONTH_ORDER.map((m) => `<option value="${m}">${MONTH_SHORT[m]}</option>`).join("");
  allSelect.value = String(allPlan.month);
  allSelect.addEventListener("change", () => {
    save.sellAll = { month: Number(allSelect.value), auto: allPlan.auto };
    refreshInventory(true);
  });
  allRow.appendChild(allSelect);

  const allToggle = document.createElement("label");
  allToggle.className = "switch";
  allToggle.title = "Auto-sell every product when its month arrives. A product set individually below keeps its own setting.";
  const allCb = document.createElement("input");
  allCb.type = "checkbox";
  allCb.checked = allPlan.auto;
  allCb.addEventListener("change", () => {
    save.sellAll = { month: allPlan.month, auto: allCb.checked };
    // Switching it ON wipes the per-product rows rather than sitting on top of
    // them (maintainer decision, 2026-07-24) — "overrides all the individual
    // ones and moves them to on". Leaving stale overrides underneath would mean
    // turning the master back off silently restored settings the player can no
    // longer see, since the rows are hidden while it's on.
    if (allCb.checked) save.sellSchedule = {};
    refreshInventory(true);
  });
  allToggle.appendChild(allCb);
  allToggle.insertAdjacentHTML("beforeend", `<span class="slider"></span>`);
  allRow.appendChild(allToggle);
  rows.appendChild(allRow);

  const fieldBales = new Map(baleInventory(save, now).map((s) => [s.product, s.bales]));
  const claimed = new Set(save.buildings.filter((b) => b.kind === "silo").map((b) => b.assignedCrop).filter(Boolean));

  interface MarketRow {
    id: MarketProduct; name: string; iconHtml: string; unit: string; unitPrice: number;
    qty: number; qtyLabel: string;
    /** Per-acre economics — yield and gross, for comparing crops at a glance. */
    perAcre: string;
  }
  const products: MarketRow[] = [];
  for (const c of SELLABLE_GRAINS) {
    const cfg = gameConfig.crops[c];
    const tons = save.grain[c];
    // Only what's actually in store (maintainer request, 2026-07-24) — the full
    // catalogue of ten crops made this a wall to scroll past, most of it zeroes.
    if (tons <= 0) continue;
    const unitPrice = grainUnitPrice(c, month);
    const orphanNote = !claimed.has(c) ? " · ⚠️ no silo assigned" : "";
    products.push({
      id: c, name: cfg.name, iconHtml: cfg.emoji, unit: "/t",
      unitPrice,
      qty: tons,
      qtyLabel: `${tons.toFixed(1)} t stored${orphanNote}`,
      perAcre: `${cfg.baseYieldTonsPerAcre.toFixed(1)} t/ac · $${Math.round(unitPrice * cfg.baseYieldTonsPerAcre).toLocaleString()}/ac`,
    });
  }
  for (const p of SELLABLE_BALES) {
    const cfg = gameConfig.baleProducts[p];
    const stored = save.buildings.reduce((s, b) => s + (b.storedBales?.[p] ?? 0), 0);
    const inField = fieldBales.get(p) ?? 0;
    if (stored + inField <= 0) continue;
    const parts: string[] = [];
    if (stored > 0) parts.push(`${stored} stored`);
    if (inField > 0) parts.push(`${inField} in the field`);
    const cuttings = cuttingsPerYearFor(p);
    const balesPerAcre = cfg.balesPerAcre * cuttings;
    const unitPrice = baleUnitPrice(p, month);
    products.push({
      id: p, name: cfg.name, iconHtml: baleIconFor(p, 20), unit: "/bale",
      unitPrice,
      qty: stored + inField,
      qtyLabel: `${parts.join(" · ")} bales`,
      perAcre: `${balesPerAcre.toFixed(1)} bales/ac · $${Math.round(unitPrice * balesPerAcre).toLocaleString()}/ac${cuttings > 1 ? ` (${cuttings} cuts)` : ""}`,
    });
  }
  // Bunker silage (2026-08-15) — joins the same Auto/Manual/Haul row as
  // grain and bales, instead of the bespoke Sell-only rows it used to get
  // below (still there for the per-bunker CAPACITY/product cards —
  // infrastructure, not the sellable totals). No per-acre stat: a pooled
  // generic product doesn't map to one crop's yield the clean way
  // grain/bales do. Summed across every bunker (storage moved off one
  // farm-wide pool to per-building 2026-08-15, so a total needs adding up).
  for (const p of SILAGE_PRODUCTS) {
    const cfg = gameConfig.silageProducts[p];
    let tons = 0;
    for (const b of save.buildings) tons += b.storedSilage?.[p] ?? 0;
    if (tons <= 0) continue;
    const unitPrice = silageUnitPrice(p, month);
    products.push({
      id: p, name: cfg.name, iconHtml: cfg.emoji, unit: "/t",
      unitPrice,
      qty: tons,
      qtyLabel: `${tons.toFixed(1)} t stored`,
      perAcre: "",
    });
  }

  if (products.length === 0) {
    rows.insertAdjacentHTML(
      "beforeend",
      `<div class="silo-bar-empty">Nothing in store yet — harvest or bale a field and it shows up here to sell.</div>`,
    );
    return;
  }

  for (const prod of products) {
    // The EFFECTIVE plan — its own row if it has one, else the farm-wide
    // default. Showing the raw per-product entry here would leave a switch
    // reading "off" while the master quietly sold the crop.
    const sched = effectiveSellPlan(save, prod.id);
    const row = document.createElement("div");
    row.className = "inv-row mkt-row";
    row.innerHTML = `
      <span class="icon">${prod.iconHtml}</span>
      <span class="info">
        <div class="name">${escapeHtml(prod.name)}</div>
        <div class="qty">${prod.qtyLabel}</div>
        <div class="mkt-peracre">${prod.perAcre}</div>
      </span>
      <span class="price">$${Math.round(prod.unitPrice).toLocaleString()}${prod.unit} ${priceBadge(prod.id)}</span>`;

    // Sell EVERYTHING of this product, wherever it sits, RIGHT NOW — a buyer
    // collects, so it takes the instant price (base less the pickup fee, no
    // seasonal premium). The button label is the actual cash it pays. No
    // disabled state any more: a row only exists when there's stock to sell.
    const value = Math.round(prod.qty * prod.unitPrice);
    const sellBtn = document.createElement("button");
    sellBtn.className = "primary mkt-sellbtn";
    sellBtn.textContent = `Sell · $${value.toLocaleString()}`;
    sellBtn.title = `Instant sale — ${Math.round(gameConfig.market.instantSellPenaltyPct * 100)}% below base price, and no seasonal bonus. Haul it yourself for the full price.`;
    sellBtn.addEventListener("click", () => {
      const before = save.money;
      sellAllOfProduct(save, prod.id, clock.time());
      const revenue = save.money - before;
      if (revenue <= 0) return;
      updateHud();
      refreshInventory(true);
      updateBaleMarkers();
      if (selectedFieldId) refreshFieldPanel(true);
      toast(`💰 Sold all ${prod.name.toLowerCase()} for $${revenue.toLocaleString()}`);
    });
    row.appendChild(sellBtn);

    // ...or send a rig to haul it to a Sell Point for the FULL seasonal price.
    // Only offered when a run could actually be made, so the button never
    // silently does nothing.
    const stock = sellableStock(save, prod.id);
    const haulBtn = document.createElement("button");
    haulBtn.className = "mkt-haulbtn";
    haulBtn.textContent = "🚜 Haul";
    const hasSellPoint = save.buildings.some((b) => b.kind === "sellPoint");
    haulBtn.disabled = stock <= 0 || !hasSellPoint;
    haulBtn.title = !hasSellPoint
      ? "Build a Sell Point first (it's free) — then a tractor can haul this to market for the full seasonal price"
      : stock <= 0
        ? "Nothing in storage to haul (loose bales in fields are hauled from the field panel)"
        : `Haul to a Sell Point for the full seasonal price — $${Math.round(prod.qty * prod.unitPrice / (1 - gameConfig.market.instantSellPenaltyPct) * (1 + seasonalBonus(prod.id, dateOf(clock.time()).month))).toLocaleString()} at today's rate`;
    haulBtn.addEventListener("click", () => {
      if (!queueSellRun(save, prod.id)) {
        toast("❌ Nothing free to haul with right now", 3000);
        return;
      }
      refreshQueuePanel();
      refreshInventory(true);
      toast(`🚜 Hauling ${prod.name.toLowerCase()} to market`);
    });
    row.appendChild(haulBtn);

    // Freshly-wrapped baleage AND freshly-chopped crop-specific bunker
    // silage both hold until they age into the generic Silage product
    // (maintainer request, 2026-08-14 for baleage, 2026-08-15 for silage) —
    // never following the master toggle either, so (same pattern as the
    // master-follow case right below) the per-product controls are replaced
    // with a note instead of a toggle that would silently do nothing once
    // `tickAutoSell` skips these products.
    if (AUTO_SELL_HOLDS_UNTIL_AGED.has(prod.id as BaleProduct | SilageProduct)) {
      row.insertAdjacentHTML("beforeend", `<span class="mkt-following">held until Silage</span>`);
      rows.appendChild(row);
      continue;
    }

    // While the master is on it OWNS every product, so the per-product controls
    // are hidden rather than shown doing nothing (maintainer decision,
    // 2026-07-24: "then hides the individual toggles"). A short note takes
    // their place so the row doesn't look like it lost a feature.
    if (allPlan.auto) {
      row.insertAdjacentHTML("beforeend", `<span class="mkt-following">auto · ${MONTH_SHORT[allPlan.month]}</span>`);
      rows.appendChild(row);
      continue;
    }

    // Auto-sell: pick the month, flip the switch — tickAutoSell does the rest.
    const select = document.createElement("select");
    select.className = "mkt-month";
    select.title = "Auto-sell month — everything of this product sells when this month arrives (if the switch is on)";
    select.innerHTML = SCHEDULE_MONTH_ORDER.map((m) => {
      const bonus = seasonalBonus(prod.id, m);
      return `<option value="${m}">${MONTH_SHORT[m]}${bonus > 0 ? ` +${Math.round(bonus * 100)}%` : ""}</option>`;
    }).join("");
    select.value = String(sched.month);
    select.addEventListener("change", () => {
      // Touching a product's own control makes it an override from here on.
      const s = (save.sellSchedule ??= {});
      s[prod.id] = { month: Number(select.value), auto: sched.auto };
      refreshInventory(true);
    });
    row.appendChild(select);

    const toggle = document.createElement("label");
    toggle.className = "switch";
    toggle.title = sched.fromAll
      ? "Following \"Auto-sell everything\" above — change this to give this product its own setting"
      : "Auto-sell all of this product when the chosen month arrives";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = sched.auto;
    cb.addEventListener("change", () => {
      const s = (save.sellSchedule ??= {});
      s[prod.id] = { month: sched.month, auto: cb.checked };
      // Turning ANY product off drops the master too (maintainer decision,
      // 2026-07-24), so "sell everything" can never be showing as on while
      // something is deliberately held back. Unreachable through the UI as it
      // stands — the rows are hidden while the master is on — but it keeps the
      // two honest for a save that arrives in that state.
      if (!cb.checked && save.sellAll?.auto) save.sellAll = { ...save.sellAll, auto: false };
      refreshInventory(true);
    });
    toggle.appendChild(cb);
    toggle.insertAdjacentHTML("beforeend", `<span class="slider"></span>`);
    row.appendChild(toggle);

    rows.appendChild(row);
  }
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
    .map((b) => `${b.id}:${b.assignedCrop ?? ""}:${b.assignedProduct ?? ""}:${JSON.stringify(b.storedBales ?? {})}:${JSON.stringify(b.storedSilage ?? {})}`)
    .join("|");
  const fieldBaleKey = baleInventory(save, clock.time()).map((s) => `${s.product}:${s.bales}`).join(",");
  // Also keyed on the current month (seasonal prices shift the strip + badges)
  // and the sell schedule. Silage is folded into `bldgKey` now (per-bunker
  // storage, 2026-08-15) rather than its own key off the old farm-wide pool.
  const key = `${grainKey}#${bldgKey}#${fieldBaleKey}#m${monthOf(clock.time())}#${JSON.stringify(save.sellSchedule ?? {})}`;
  if (!force && key === lastInventoryKey) return;
  lastInventoryKey = key;

  const rows = $("inv-rows");
  rows.innerHTML = "";

  buildMarketSection(rows);

  // --- Grain Silos ---
  // Rectangular cards with the fill bar built in (maintainer request,
  // 2026-07-24), replacing the old row + separate bar beneath it. Locate/sell
  // appear on hover or selection, same rule as the Equipment tab's cards.
  const silos = save.buildings.filter((b) => b.kind === "silo");
  rows.insertAdjacentHTML("beforeend", `<div class="inv-heading">🛢️ Grain Silos</div>`);
  if (silos.length === 0) {
    rows.insertAdjacentHTML("beforeend", `<div class="silo-bar-empty">No silos built yet — buy one from the Structures tab.</div>`);
  }
  for (const silo of silos) {
    const bushels = siloCapacityOf(silo.size ?? "small");
    const crop = silo.assignedCrop;
    // A bin is a fixed VOLUME (2026-07-24), so what it holds in TONS depends on
    // the crop assigned to it — far less of oats than of corn.
    const capacity = crop ? siloCapacityTonsOf(silo.size ?? "small", crop) : 0;
    const cropCapacityTotal = crop ? siloCapacityForCrop(save, crop) : 0;
    // This silo's proportional share of the crop's pooled tons.
    const tons = crop && cropCapacityTotal > 0 ? (save.grain[crop] * capacity) / cropCapacityTotal : 0;
    const pct = capacity > 0 ? Math.min(100, (tons / capacity) * 100) : 0;
    const level = pct >= 95 ? "full" : pct >= 75 ? "high" : "ok";
    const name = `Silo ${buildingIndex(silo)}`;

    const card = document.createElement("div");
    card.className = "store-card";
    // The crop dropdown rides TOP-CENTRE of the head row (maintainer request,
    // 2026-07-24) rather than on its own full-width line below, which is what
    // shortens the card. The name line drops the crop with it — the dropdown
    // is now what says which crop this is, so repeating it was just height.
    card.innerHTML = `
      <div class="sc-head">
        <span class="sc-headleft">
          <span class="icon">${BUILDING_ICON.silo}</span>
          <span class="sc-title">
            <span class="sc-name">${name} · ${SIZE_LABEL[silo.size ?? "small"]}</span>
            <span class="sc-sub">${bushels.toLocaleString()} bu${crop ? ` · ${capacity.toFixed(0)} t of ${escapeHtml(gameConfig.crops[crop].name.toLowerCase())}` : ""}</span>
          </span>
        </span>
        <span class="sc-headright"></span>
      </div>
      <div class="sc-bar"><div class="sc-fill ${level}" style="width:${pct.toFixed(1)}%"></div>
        <span class="sc-bar-label">${crop ? `${tons.toFixed(1)} / ${capacity.toFixed(0)} t · ${pct.toFixed(0)}%` : "Pick a crop to start filling it"}</span>
      </div>`;

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
      refreshInventory(true);
    });
    card.querySelector(".sc-head")!.insertBefore(select, card.querySelector(".sc-headright"));

    const actions = document.createElement("div");
    actions.className = "sc-actions";
    actions.appendChild(locateButton(name, silo.pos));
    const refund = buildingPrice("silo", silo.size);
    actions.appendChild(
      iconButton("💰", `Sell · $${refund.toLocaleString()}`, false, async () => {
        if (!(await confirmDialog({
          title: `Sell ${name}?`,
          body: `You'll get back $${refund.toLocaleString()}.`,
          okLabel: "Sell", danger: true,
        }))) return;
        sellBuilding(save, silo.id);
        toast(`💰 Sold ${name} for $${refund.toLocaleString()}`);
        refreshInventory(true);
        refreshBuildingMarkers();
        updateHud();
      }),
    );
    card.appendChild(actions);
    wireStorageSelection(card, `silo:${silo.id}`);
    rows.appendChild(card);
  }

  // --- Silage bunkers: real per-building storage (2026-08-15, maintainer
  // request — "make it a real per-bunker restriction", styled to match Bale
  // Storage below: a `store-card` per bunker with a fill bar, a product
  // dropdown that actually gates what that bunker accepts, and the products
  // actually sitting in it. The sellable TOTALS (Sell/Haul/Auto) live in the
  // unified market list above; these cards are the storage-infrastructure
  // view, same division of labor as Bale Storage's cards vs. that list. ---
  const bunkers = save.buildings.filter((b) => b.kind === "silageBunker");
  if (bunkers.length > 0) {
    rows.insertAdjacentHTML("beforeend", `<div class="inv-heading">🧱 Silage Bunkers</div>`);
    for (const b of bunkers) {
      const name = `${buildingDisplayName(b.kind, b.size)} ${buildingIndex(b)}`;
      const cap = bunkerCapacityOf(b.size ?? "small");
      const stored = storedSilageTotal(b);
      const pct = cap > 0 ? Math.min(100, (stored / cap) * 100) : 0;
      const level = pct >= 95 ? "full" : pct >= 75 ? "high" : "ok";
      const held = SILAGE_PRODUCTS
        .map((p) => ({ p, n: b.storedSilage?.[p] ?? 0 }))
        .filter((x) => x.n > 1e-9);

      const card = document.createElement("div");
      card.className = "store-card";
      card.innerHTML = `
        <div class="sc-head">
          <span class="sc-headleft">
            <span class="icon">🧱</span>
            <span class="sc-title">
              <span class="sc-name">${name}</span>
              <span class="sc-sub">${cap.toLocaleString()} t capacity · sealed, doesn't spoil</span>
            </span>
          </span>
          <span class="sc-headright"></span>
        </div>
        <div class="sc-bar"><div class="sc-fill ${level}" style="width:${pct.toFixed(1)}%"></div>
          <span class="sc-bar-label">${stored.toFixed(0)} / ${cap.toLocaleString()} t · ${pct.toFixed(0)}%</span>
        </div>
        ${held.length > 0
          ? `<div class="sc-contents">${held.map((x) =>
              `<span class="sc-chip">${gameConfig.silageProducts[x.p].emoji} ${escapeHtml(gameConfig.silageProducts[x.p].name)} · ${x.n.toFixed(0)} t</span>`,
            ).join("")}</div>`
          : `<div class="sc-contents empty">Empty</div>`}
        <div class="sc-note">Bunker silage is sealed and packed — unlike a Bale Storage pad, it doesn't rot in place.</div>`;

      // Optional product assignment — mirrors the Bale Storage dropdown.
      // Unassigned (the default) accepts any product and may hold a mix;
      // assigning one dedicates the bunker's WHOLE capacity to it, same
      // restriction a Bale Storage building already enforces.
      const select = document.createElement("select");
      select.className = "inv-crop-select";
      select.innerHTML =
        `<option value="">— any product —</option>` +
        SILAGE_PRODUCTS.map((p) => `<option value="${p}">${gameConfig.silageProducts[p].name}</option>`).join("");
      select.value = b.assignedProduct ?? "";
      select.addEventListener("change", () => {
        assignSilageBunkerProduct(save, b.id, (select.value || undefined) as SilageProduct | undefined);
        refreshInventory(true);
      });
      card.querySelector(".sc-head")!.insertBefore(select, card.querySelector(".sc-headright"));

      const actions = document.createElement("div");
      actions.className = "sc-actions";
      actions.appendChild(locateButton(name, b.pos));
      const refund = buildingPrice(b.kind, b.size);
      actions.appendChild(
        iconButton("💰", `Sell · $${refund.toLocaleString()}`, false, async () => {
          if (!(await confirmDialog({
            title: `Sell ${name}?`,
            body: `You'll get back $${refund.toLocaleString()}.`,
            okLabel: "Sell", danger: true,
          }))) return;
          sellBuilding(save, b.id);
          toast(`💰 Sold ${name} for $${refund.toLocaleString()}`);
          refreshInventory(true);
          refreshBuildingMarkers();
          updateHud();
        }),
      );
      card.appendChild(actions);
      wireStorageSelection(card, `bunker:${b.id}`);
      rows.appendChild(card);
    }
  }

  // --- Bale storage structures (2026-07-17): now hold hauled bales (per
  // product), each with an optional product assignment (unassigned accepts
  // any). Both kinds cap since 2026-07-24. ---
  const baleBuildings = save.buildings.filter((b) => b.kind === "baleBarn" || b.kind === "baleArea");
  if (baleBuildings.length > 0) {
    rows.insertAdjacentHTML("beforeend", `<div class="inv-heading">📦 Bale Storage</div>`);
    for (const b of baleBuildings) {
      const name = `${buildingDisplayName(b.kind)} ${buildingIndex(b)}`;
      const cap = baleStorageCapacityOf(b.kind as "baleBarn" | "baleArea");
      const stored = storedBalesTotal(b);
      const pct = cap > 0 ? Math.min(100, (stored / cap) * 100) : 0;
      const level = pct >= 95 ? "full" : pct >= 75 ? "high" : "ok";
      // WHAT'S in there, per product (maintainer request, 2026-07-24) — round
      // and square of the same crop are different products and priced apart, so
      // "300 bales" alone doesn't tell you what you own.
      const held = SELLABLE_BALES
        .map((p) => ({ p, n: b.storedBales?.[p] ?? 0 }))
        .filter((x) => x.n > 0);

      const card = document.createElement("div");
      card.className = "store-card";
      card.innerHTML = `
        <div class="sc-head">
          <span class="sc-headleft">
            <span class="icon">${BUILDING_ICON[b.kind]}</span>
            <span class="sc-title">
              <span class="sc-name">${name}</span>
              <span class="sc-sub">${cap.toLocaleString()} bale capacity · ${spoilLabel(b.kind as "baleBarn" | "baleArea")}</span>
            </span>
          </span>
          <span class="sc-headright"></span>
        </div>
        <div class="sc-bar"><div class="sc-fill ${level}" style="width:${pct.toFixed(1)}%"></div>
          <span class="sc-bar-label">${stored.toLocaleString()} / ${cap.toLocaleString()} bales · ${pct.toFixed(0)}%</span>
        </div>
        ${held.length > 0
          ? `<div class="sc-contents">${held.map((x) =>
              `<span class="sc-chip">${baleIconFor(x.p, 11)} ${escapeHtml(gameConfig.baleProducts[x.p].name)} × ${x.n}</span>`,
            ).join("")}</div>`
          : `<div class="sc-contents empty">Empty</div>`}
        <div class="sc-note">${spoilBlurb(b.kind as "baleBarn" | "baleArea")}</div>`;

      // Optional product assignment — mirrors the silo crop dropdown.
      const select = document.createElement("select");
      select.className = "inv-crop-select";
      select.innerHTML =
        `<option value="">— any product —</option>` +
        SELLABLE_BALES.map((p) => `<option value="${p}">${gameConfig.baleProducts[p].name}</option>`).join("");
      select.value = b.assignedProduct ?? "";
      select.addEventListener("change", () => {
        assignBaleStorageProduct(save, b.id, (select.value || undefined) as BaleProduct | undefined);
        refreshInventory(true);
      });
      card.querySelector(".sc-head")!.insertBefore(select, card.querySelector(".sc-headright"));

      const actions = document.createElement("div");
      actions.className = "sc-actions";
      actions.appendChild(locateButton(name, b.pos));
      const refund = buildingPrice(b.kind);
      actions.appendChild(
        iconButton("💰", `Sell · $${refund.toLocaleString()}`, false, async () => {
          if (!(await confirmDialog({
            title: `Sell ${name}?`,
            body: `You'll get back $${refund.toLocaleString()}.`,
            okLabel: "Sell", danger: true,
          }))) return;
          sellBuilding(save, b.id);
          toast(`💰 Sold ${name} for $${refund.toLocaleString()}`);
          refreshInventory(true);
          refreshBuildingMarkers();
          updateHud();
        }),
      );
      card.appendChild(actions);
      wireStorageSelection(card, `bale:${b.id}`);
      rows.appendChild(card);
    }
  }
}

/** Which storage card is selected — same hover-or-select rule as the Equipment
 * tab's cards (see `wireCardSelection`), kept separate so selecting a silo
 * doesn't deselect a machine on another tab. */
let selectedStorageCardId: string | null = null;

function wireStorageSelection(card: HTMLElement, id: string): void {
  if (selectedStorageCardId === id) card.classList.add("selected");
  card.addEventListener("click", (e) => {
    // Don't steal clicks meant for the buttons or the crop dropdown.
    const el = e.target as HTMLElement;
    if (el.closest(".sc-actions") || el.closest("select")) return;
    selectedStorageCardId = selectedStorageCardId === id ? null : id;
    refreshInventory(true);
  });
}

/* REMOVED 2026-07-24: `siloCapacityBar`. The fill bar is drawn inside the
 * storage CARD now (`.sc-bar`, see refreshInventory) rather than as a separate
 * element hung underneath the row, so a silo's name, crop, capacity and fill
 * are one object instead of two stacked ones. */

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
    refi.addEventListener("click", async () => {
      const ok = await confirmDialog({
        title: `Refinance the Year ${loan.originYear} loan?`,
        body:
          `This resets it to a fresh ${gameConfig.loan.termMonths / 12}-year term at ${loan.ratePercent}% and ` +
          `recalculates the monthly payment from the current balance. A $${gameConfig.loan.refinanceFee.toLocaleString()} ` +
          `fee gets added to the loan's principal — it isn't charged in cash.`,
        okLabel: "Refinance",
      });
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
/** How much the dev cash button grants per click. */
const DEV_CASH_GRANT = 1_000_000;

/**
 * DEV-SERVER ONLY testing affordances (2026-07-31, maintainer request: "add
 * 1 MM to the Dev server cash so i can test").
 *
 * Gated on `import.meta.env.DEV`, which Vite compiles to a literal `false` in
 * a production build — so the whole block is dead code the bundler drops, and
 * a deployed game can never show a cash button.
 *
 * The grant is deliberately NOT recorded in the ledger. It isn't farm income,
 * and booking it would skew the very cashflow report you'd use to judge
 * whether a chopper or a bunker actually pays for itself.
 */
function wireDevTools(): void {
  if (!import.meta.env.DEV) return;
  const host = $("dev-tools");
  const btn = document.createElement("button");
  btn.textContent = `+$${(DEV_CASH_GRANT / 1_000_000).toFixed(0)}M`;
  btn.title = "Dev server only — grant cash for testing. Not booked to the ledger.";
  btn.addEventListener("click", () => {
    save.money += DEV_CASH_GRANT;
    updateHud();
    refreshEquipTab(true);
    refreshStructuresTab(true);
    refreshFinanceTab(true);
    toast(`🧪 Dev: +$${DEV_CASH_GRANT.toLocaleString()} — now $${Math.round(save.money).toLocaleString()}`);
  });
  host.appendChild(btn);
}

function wireSettingsTab() {
  $("btn-settings").addEventListener("click", () => toggleToolbarPanel("settingstab", refreshSettingsTab));
  $("settings-close").addEventListener("click", () => ($("settingstab").style.display = "none"));

  // Creating a farm needs the county picker, which lives on the home screen —
  // this button just flushes the current farm and reloads into the menu with
  // the New Farm section pre-expanded (no autoboot flag, so the menu shows).
  $("settings-new-menu").addEventListener("click", () => {
    saveBeforeSwitch();
    sessionStorage.setItem(MENU_OPEN_NEW_KEY, "1");
    location.reload();
  });
}

/** Flush the current farm's state before navigating away from it (switching
 * farms or the page will otherwise reload mid-autosave-interval and lose
 * whatever happened since the last 5s tick). */
function saveBeforeSwitch(): void {
  resetting = true; // reuse the same "don't let a stray timer write after us" guard as Reset
  persistGame({ save, clockNow: clock.time(), countyId: activeFarm.countyId, daysPerMonth: getDaysPerMonth() });
}

function refreshSettingsTab(): void {
  const el = $("settingstab");
  if (el.style.display !== "block") return;

  const rows = $("settings-farms");
  rows.innerHTML = "";
  const activeId = getActiveFarmId();
  for (const meta of listFarms()) {
    const isActive = meta.id === activeId;
    const pg = isActive
      ? { save, clockNow: clock.time(), countyId: activeFarm.countyId, daysPerMonth: getDaysPerMonth() }
      : loadGameFor(meta.id);
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
        // An explicit in-game choice — boot straight into it, skip the menu.
        sessionStorage.setItem(AUTOBOOT_KEY, meta.id);
        location.reload();
      });
      row.appendChild(loadBtn);
    }

    const delBtn = document.createElement("button");
    delBtn.className = "farm-del";
    delBtn.textContent = "🗑";
    delBtn.title = `Delete ${meta.name}`;
    delBtn.addEventListener("click", async () => {
      if (!(await confirmDialog({
        title: `Delete "${meta.name}"?`,
        body: "This farm and its save are gone for good — this can't be undone.",
        okLabel: "Delete", danger: true,
      }))) return;
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

  refreshNaipProviderRow();
}

/** Switch which NAIP host serves imagery — see activeNaipProvider's comment.
 * Persists the choice, then forces the live source to drop its tiles and
 * reload under the new provider: `setTiles()` with a URL that actually
 * changed (the provider segment) is what makes MapLibre treat every visible
 * tile as needing a fresh request instead of reusing what's already drawn. */
function switchNaipProvider(id: string): void {
  if (id === activeNaipProvider) return;
  activeNaipProvider = id;
  localStorage.setItem(NAIP_PROVIDER_KEY, id);
  const source = mapRef?.getSource("naip") as maplibregl.RasterTileSource | undefined;
  source?.setTiles([naipTileUrlTemplate(id)]);
  refreshNaipProviderRow();
}

function refreshNaipProviderRow(): void {
  const row = $("settings-naip-providers");
  row.innerHTML = "";
  for (const p of NAIP_PROVIDERS) {
    const pill = document.createElement("button");
    pill.className = "naip-provider-pill" + (p.id === activeNaipProvider ? " active" : "");
    pill.textContent = (p.id === activeNaipProvider ? "✓ " : "") + p.label;
    pill.title = p.imageServer;
    pill.addEventListener("click", () => switchNaipProvider(p.id));
    row.appendChild(pill);
  }
}

// ---------------------------------------------------------------------------
// Fields tab (reworked 2026-07-22): a sortable management table — crop/status,
// acres, expected yield, this year's net P&L, plus inline auto-manage and
// locate controls — topped by a whole-farm summary strip. Click a row to open
// its detail panel (where Plow/Plant/Harvest/Sell live).
// ---------------------------------------------------------------------------
function wireFieldsTab() {
  $("btn-fields").addEventListener("click", () => toggleToolbarPanel("fieldstab", () => refreshFieldsTab(true)));
  $("fields-close").addEventListener("click", () => ($("fieldstab").style.display = "none"));
}

type FieldsSortKey = "name" | "acres" | "status" | "yield" | "net";
let fieldsSortKey: FieldsSortKey = "name";
let fieldsSortDesc = false;

/** Rebuild the fields table. Cheap no-op while the panel is hidden. */
let lastFieldsKey = "";
function refreshFieldsTab(force = false) {
  const el = $("fieldstab");
  if (el.style.display !== "block") return;

  const rows = $("fields-rows");
  if (save.fields.length === 0) {
    if (!force && lastFieldsKey === "empty") return;
    lastFieldsKey = "empty";
    rows.innerHTML = `<div id="fields-empty">No fields yet — 🚜 Buy Field to start your farm.</div>`;
    return;
  }

  const now = clock.time();
  const year = save.finance.openYear;

  // Everything each row shows, computed once so sorting + summary reuse it.
  const entries = save.fields.map((field) => {
    const acres = areaAcres(field.boundary);
    const pending = tasksFor(save, field.id);
    const statusLabel = isFieldHarvesting(save, field.id)
      ? "harvesting"
      : pending.length > 0
        ? `${field.status} · ${pending.length} job${pending.length > 1 ? "s" : ""}`
        : field.status;
    const bales = field.baleLocations?.length ?? 0;
    // Yield column: bales sitting out rank first (they're money on the
    // ground), then a growing/ready annual's narrowing range, else —.
    let yieldText = "—";
    let yieldSort = 0;
    if (bales > 0) {
      yieldText = `${bales} bales down`;
      yieldSort = bales;
    } else if (field.crop && !isPerennial(field.crop)) {
      const range = yieldRange(field, now);
      if (range) {
        yieldText = `${(range.low * acres).toFixed(0)}–${(range.high * acres).toFixed(0)} t`;
        yieldSort = ((range.low + range.high) / 2) * acres;
      }
    }
    const net = fieldNetCashflow(save.fieldLedger?.[field.id]?.[year]);
    return { field, acres, statusLabel, yieldText, yieldSort, net };
  });

  // Live-refreshed from the game loop (~2×/s) — bail unless something shown
  // actually changed, same keyed pattern as the other tabs. Rebuilding every
  // pass would recreate the rows (and their toggles) under the cursor. Keyed
  // on everything a row or the summary renders, plus sort state and year.
  const key =
    `${fieldsSortKey}:${fieldsSortDesc}:${year}#` +
    entries
      .map(
        (e) =>
          `${e.field.id}:${fieldLabel(e.field)}:${e.field.crop ?? ""}:${e.statusLabel}:${e.acres.toFixed(1)}:` +
          `${e.yieldText}:${Math.round(e.net)}:${e.field.autoManage ? 1 : 0}`,
      )
      .join("|");
  if (!force && key === lastFieldsKey) return;
  lastFieldsKey = key;

  const dir = fieldsSortDesc ? -1 : 1;
  entries.sort((a, b) => {
    switch (fieldsSortKey) {
      case "acres": return (a.acres - b.acres) * dir;
      case "status": return a.statusLabel.localeCompare(b.statusLabel) * dir;
      case "yield": return (a.yieldSort - b.yieldSort) * dir;
      case "net": return (a.net - b.net) * dir;
      default: return fieldLabel(a.field).localeCompare(fieldLabel(b.field), undefined, { numeric: true }) * dir;
    }
  });

  rows.innerHTML = "";

  // Whole-farm summary strip.
  const totalAcres = entries.reduce((s, e) => s + e.acres, 0);
  const totalNet = entries.reduce((s, e) => s + e.net, 0);
  const totalBales = entries.reduce((s, e) => s + (e.field.baleLocations?.length ?? 0), 0);
  const growing = entries.filter((e) => e.field.status === "growing" || e.field.status === "ready").length;
  rows.insertAdjacentHTML(
    "beforeend",
    `<div class="ft-summary">
      <span><b>${entries.length}</b> field${entries.length === 1 ? "" : "s"} · <b>${totalAcres.toFixed(0)}</b> ac</span>
      <span><b>${growing}</b> growing</span>
      ${totalBales > 0 ? `<span><b>${totalBales}</b> bales down</span>` : ""}
      <span>Net Yr ${year}: <b class="${totalNet < 0 ? "neg" : "pos"}">${totalNet < 0 ? "−" : ""}$${Math.abs(totalNet).toLocaleString()}</b></span>
    </div>`,
  );

  // Sortable header row.
  const head = document.createElement("div");
  head.className = "ft-row ft-head";
  const cols: { key: FieldsSortKey | null; label: string }[] = [
    { key: "name", label: "Field" },
    { key: "acres", label: "Acres" },
    { key: "status", label: "Status" },
    { key: "yield", label: "Yield" },
    { key: "net", label: `Net Yr ${year}` },
    { key: null, label: "🤖" },
    { key: null, label: "" },
  ];
  for (const col of cols) {
    const cell = document.createElement("span");
    const active = col.key !== null && fieldsSortKey === col.key;
    cell.className = "ft-h" + (active ? " active" : "");
    cell.textContent = col.label + (active ? (fieldsSortDesc ? " ↓" : " ↑") : "");
    if (col.key !== null) {
      const key = col.key;
      cell.title = `Sort by ${col.label.toLowerCase()}`;
      cell.addEventListener("click", () => {
        if (fieldsSortKey === key) fieldsSortDesc = !fieldsSortDesc;
        else {
          fieldsSortKey = key;
          // Numbers read best big-first on the first click; names A→Z.
          fieldsSortDesc = key === "acres" || key === "yield" || key === "net";
        }
        refreshFieldsTab(true);
      });
    }
    head.appendChild(cell);
  }
  rows.appendChild(head);

  for (const e of entries) {
    const { field } = e;
    const icon = field.crop ? gameConfig.crops[field.crop].emoji : "🟫";
    const row = document.createElement("div");
    row.className = "ft-row field-row";
    row.innerHTML = `
      <span class="ft-name"><span class="icon">${icon}</span> ${escapeHtml(fieldLabel(field))}</span>
      <span class="ft-num">${e.acres.toFixed(1)}</span>
      <span class="ft-status">${e.statusLabel}</span>
      <span class="ft-num">${e.yieldText}</span>
      <span class="ft-num ${e.net < 0 ? "neg" : e.net > 0 ? "pos" : ""}">${e.net === 0 ? "—" : `${e.net < 0 ? "−" : ""}$${Math.abs(e.net).toLocaleString()}`}</span>`;

    // Inline auto-manage switch — same behavior as the field panel's toggle
    // (seeds a starter plan and acts immediately on first flip).
    const toggle = document.createElement("label");
    toggle.className = "switch ft-switch";
    toggle.title = field.autoManage ? "Auto-managed — click to take manual control" : "Hand this field to the rotation plan";
    toggle.addEventListener("click", (ev) => ev.stopPropagation());
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!field.autoManage;
    cb.addEventListener("change", () => {
      field.autoManage = cb.checked;
      if (field.autoManage) {
        if (!field.plans || field.plans.length === 0) field.plans = [defaultPlan()];
        autoManageField(save, field, clock.time());
        renderField(mapRef, overlay, field, clock.time());
        updateHud();
        toast(`🤖 ${fieldLabel(field)} will run its rotation plan`);
      } else {
        toast(`🖐️ ${fieldLabel(field)} is back to manual control`);
      }
      refreshFieldsTab();
      if (selectedFieldId === field.id) refreshFieldPanel(true);
    });
    toggle.appendChild(cb);
    toggle.insertAdjacentHTML("beforeend", `<span class="slider"></span>`);
    row.appendChild(toggle);

    const locate = locateButton(fieldLabel(field), centroidOf(field.boundary));
    locate.addEventListener("click", (ev) => ev.stopPropagation());
    row.appendChild(locate);

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
  // Rounded coarser (2026-08-14) — same reasoning as refreshEquipTab: the
  // shop's affordability styling doesn't need penny accuracy, and a coarser
  // key means fewer full rebuilds of the owned-structures list.
  const key = save.buildings.map((b) => `${b.id}:${b.assignedCrop ?? ""}`).join("|") + `|$${Math.round(save.money / 100) * 100}`;
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
      iconButton("💰", `Sell · $${refund.toLocaleString()}`, false, async () => {
        if (!(await confirmDialog({
          title: `Sell ${name}?`,
          body: `You'll get back $${refund.toLocaleString()}.`,
          okLabel: "Sell", danger: true,
        }))) return;
        sellBuilding(save, b.id);
        toast(`💰 Sold ${name} for $${refund.toLocaleString()}`);
        afterStructuresChange();
      }),
    );
    row.appendChild(actions);
    rows.appendChild(row);
  }
}

/**
 * "−2.5%/mo rot" — how fast a bale store loses its contents (2026-07-25).
 *
 * Shown wherever bale storage is described, because rot that happens silently
 * is indistinguishable from a bug: the player would just find fewer bales than
 * they hauled in. It's also the ONLY thing separating the $70k Barn from the
 * $25k Area, so it has to be legible at the point of purchase.
 */
function spoilLabel(kind: "baleBarn" | "baleArea"): string {
  return `−${spoilRateText(kind)}/mo rot`;
}

/** Just the monthly rate, "0.5%" / "2.5%" — trims the trailing zero so a whole
 * number doesn't read as "3.0%". Shared so prose and badge can't disagree. */
function spoilRateText(kind: "baleBarn" | "baleArea"): string {
  const pct = baleSpoilRateOf(kind) * 100;
  return `${pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(1)}%`;
}

/**
 * The long form: a sentence explaining WHY bales vanish and what the storage
 * choice is actually buying. Both figures are derived, so the copy can't drift
 * away from the config the way the "unlimited" line did.
 *
 * The six-month figure is the one that matters — it's the difference between
 * the two building kinds over a real storage season, and the whole reason the
 * Barn costs nearly 3x the Area.
 */
function spoilBlurb(kind: "baleBarn" | "baleArea"): string {
  const rate = baleSpoilRateOf(kind);
  const season = (1 - Math.pow(1 - rate, 6)) * 100;
  const other = kind === "baleBarn" ? "baleArea" : "baleBarn";
  const otherSeason = (1 - Math.pow(1 - baleSpoilRateOf(other), 6)) * 100;
  return kind === "baleBarn"
    ? `Under cover. Stored bales still rot, but slowly — ${spoilRateText(kind)} a month, so a load held `
      + `through a six-month winter loses about ${season.toFixed(0)}% of itself. The same bales stacked `
      + `outside would lose ${otherSeason.toFixed(0)}%. That gap is what you're paying for.`
    : `Out in the weather. Stored bales rot at ${spoilRateText(kind)} a month, so a load held through a `
      + `six-month winter loses about ${season.toFixed(0)}% of itself — sell early, or build a Bale Barn, `
      + `which cuts the same loss to roughly ${otherSeason.toFixed(0)}%.`;
}

/** One-line capacity/role summary for a building's status line. */
function structureSpecText(b: Building): string {
  switch (b.kind) {
    case "silo": {
      const cap = siloCapacityOf(b.size ?? "small");
      return b.assignedCrop
        ? `${cap.toLocaleString()} bu · ${siloCapacityTonsOf(b.size ?? "small", b.assignedCrop).toFixed(0)} t of ${gameConfig.crops[b.assignedCrop].name}`
        : `${cap.toLocaleString()} bu capacity · unassigned`;
    }
    case "baleBarn":
      return `${storedBalesTotal(b)} / ${baleStorageCapacityOf("baleBarn").toLocaleString()} bales · indoor · ${spoilLabel("baleBarn")}`;
    case "baleArea":
      // Said "unlimited" until 2026-07-25 — stale since the Area was capped at
      // 1000 on 2026-07-24, so the panel was claiming the opposite of the rule.
      return `${storedBalesTotal(b)} / ${baleStorageCapacityOf("baleArea").toLocaleString()} bales · outdoor · ${spoilLabel("baleArea")}`;
    case "tractorBarn":
      return `${gameConfig.buildings.tractorBarn.slots} machine slots`;
    case "implementBarn":
      return `${gameConfig.buildings.implementBarn.slots} implement slots`;
    case "farmYard":
      return "Rally point — gear parks here";
    case "sellPoint":
      return "Bale hauler fallback — sells on the spot when storage is full/missing";
    case "silageBunker":
      return `${bunkerCapacityOf(b.size ?? "small").toLocaleString()} t silage · farm total ${silageCapacityTons(save).toLocaleString()} t`;
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
  const crop = agent.lastCrop ?? "corn";
  const capV = harvesterCapacityTons(agent.size ?? "medium", crop);
  const onboard = agent.grainOnboard ?? 0;
  const blocked = onboard >= capV - 1e-9;
  if (onboard <= 1e-9 || !(agent.state === "idle" || blocked)) return null;
  const unload = save.tasks.find((t) => t.type === "unloadHarvester" && t.harvesterAgentId === agent.id);
  const warn = unload?.waitingForSilo ? "⚠️ " : "";
  return `${warn}Waiting for a Grain Trailer (${onboard.toFixed(1)}/${capV.toFixed(1)}t)`;
}

const UNLOAD_PHASE_TEXT: Record<string, string> = {
  staging: "Waiting at the gate for the combine…",
  toHarvester: "Driving to the combine…",
  onloading: "Loading grain…",
  toSilo: "Hauling to the silo…",
  dumping: "Unloading at the silo…",
};

/** One-line status for a Haul Bales job's queue row — a ⚠️ if a hauler is
 * stuck with nowhere to store, else a flat "Collecting bales…" regardless
 * of the collector's actual internal phase (2026-08-16, maintainer request —
 * the phase-by-phase text, e.g. "Carrying to the trailer…", read as noise
 * once the remaining/total count sits right next to the progress bar). */
function haulSubText(task: FarmTask): string {
  if (task.waitingForStorage) return "⚠️ Waiting for storage room";
  return "Collecting bales…";
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
  if (task && agent.state === "traveling") return { text: `Driving to ${escapeHtml(fieldLabelOf(task.fieldId))}…`, pct: null };
  if (task && task.type === "wrap" && agent.state === "working") {
    // Bale-count progress, not acreage (2026-08-14 redesign) — same reason
    // the Work Queue's wrap card reads `field.wrappedBaleLocations`/
    // `baleLocations` directly instead of the generic doneAcres/totalAcres
    // fallback below, which would otherwise sit frozen at 0% the whole run.
    const wrapField = save.fields.find((f) => f.id === task.fieldId);
    const wrapped = wrapField?.wrappedBaleLocations?.length ?? 0;
    const wrapTotal = wrapped + (wrapField?.baleLocations?.length ?? 0);
    return {
      text: `${cap(taskVerb(task))} ${escapeHtml(fieldLabelOf(task.fieldId))}`,
      pct: wrapTotal > 0 ? (wrapped / wrapTotal) * 100 : null,
    };
  }
  if (task && agent.state === "working") {
    let text = `${cap(taskVerb(task))} ${escapeHtml(fieldLabelOf(task.fieldId))}`;
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

  // STRUCTURAL only (2026-08-14) — deliberately excludes anything that
  // changes continuously while a job runs (doneAcres %, grainOnboard,
  // cargoTons): those used to be IN this key, which meant it changed on
  // almost every refresh and `buildEquipMachines`/`buildEquipImplements`
  // did a full teardown+rebuild ~2x/sec any time equipment was working —
  // the flicker, and the "have to click a few times" bug (a fresh button
  // replacing the one under the cursor mid-click). Those numbers are still
  // kept fresh, just via `updateEquipStatusText` patching text in place
  // instead of rebuilding. Money's rounded coarser than before for the same
  // reason — the shop's affordability styling doesn't need penny accuracy.
  const key =
    save.agents
      .map((a) => {
        const task = a.taskId ? save.tasks.find((t) => t.id === a.taskId) : undefined;
        return `${a.id}:${a.state}:${task?.unloadPhase ?? ""}:${task?.waitingForSilo ?? ""}:${a.lastCrop ?? ""}`;
      })
      .join("|") +
    "#" +
    save.implements.map((i) => `${i.id}:${i.attachedTo ?? ""}`).join("|") +
    `|$${Math.round(save.money / 100) * 100}`;
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
  line("Tractor", machineIconHtml("tractor", "medium", 78), Object.fromEntries(SIZES.map((s) => [s, {
    spec: `${SIZE_LABEL[s]} power unit`,
    price: agentPrice("tractor", s),
    onBuy: () => {
      const a = buyAgent(save, "tractor", s, spawnPos());
      afterFleetChange();
      toast(`Bought ${a.name} — parked at the yard`);
    },
  }])));
  line("Combine", machineIconHtml("harvester", "medium", 78), Object.fromEntries(SIZES.map((s) => [s, {
    spec: `${harvesterCapacityBushels(s).toLocaleString()} bu tank (~${harvesterCapacityTons(s).toFixed(0)} t corn) · needs a header`,
    price: agentPrice("harvester", s),
    onBuy: () => {
      const a = buyAgent(save, "harvester", s, spawnPos());
      afterFleetChange();
      toast(`Bought ${a.name} — parked at the yard`);
    },
  }])));

  // Self-Propelled Windrower: a machine, not an implement — it cuts hay with no
  // tractor tied up. One size, so it occupies the Large column alone rather
  // than pretending to a range it doesn't have.
  line("Windrower", machineIconHtml("windrower", "large", 78), {
    large: {
      spec: `${gameConfig.equipment.windrower.widthFt} ft · self-propelled, no tractor`,
      price: agentPrice("windrower", "large"),
      onBuy: () => {
        const a = buyAgent(save, "windrower", "large", spawnPos());
        afterFleetChange();
        toast(`Bought ${a.name} — parked at the yard`);
      },
    },
  });

  // Self-Propelled Forage Harvester (2026-07-31): the chopper. Priciest
  // machine in the game, and it cannot turn a wheel without a Forage Wagon —
  // which the spec line says outright, since buying one alone is a dead end.
  line("Forage Harvester", machineIconHtml("forageHarvester", "large", 78), Object.fromEntries(SIZES.map((s) => [s, {
    spec: `${gameConfig.equipment.forageHarvester[s].widthFt} ft · chops silage · needs a Forage Wagon`,
    price: agentPrice("forageHarvester", s),
    onBuy: () => {
      const a = buyAgent(save, "forageHarvester", s, spawnPos());
      afterFleetChange();
      toast(`Bought ${a.name} — parked at the yard`);
    },
  }])));

  // The shop is grouped exactly like the owned list (2026-07-24) — fourteen
  // implement kinds in one flat run was unreadable.
  const widthSpec = (kind: "plow" | "planter" | "sprayer", s: EquipmentSize) =>
    `${gameConfig.equipment[kind][s].widthFt} ft working width`;

  section("Field Work");
  line("Plow", plowIconSvg(26), Object.fromEntries(SIZES.map((s) => [s, {
    spec: widthSpec("plow", s), price: implementPrice("plow", s), onBuy: buyImpl("plow", s),
  }])));
  line("Planter", planterIconSvg(26), Object.fromEntries(SIZES.map((s) => [s, {
    spec: widthSpec("planter", s), price: implementPrice("planter", s), onBuy: buyImpl("planter", s),
  }])));

  section("Yield Modifiers");
  // Sprayers now come in all three sizes — the 30 ft Small joined the shop
  // 2026-07-24 (it existed in config but was never offered).
  line("Sprayer", sprayerIconSvg(26), Object.fromEntries(SIZES.map((s) => [s, {
    spec: `${widthSpec("sprayer", s)} boom`, price: implementPrice("sprayer", s), onBuy: buyImpl("sprayer", s),
  }])));
  // Mulcher: optional post-harvest residue pass on annuals — all three sizes.
  line("Mulcher", mulcherIconSvg(26), Object.fromEntries(SIZES.map((s) => [s, {
    spec: `${gameConfig.equipment.mulcher[s].widthFt} ft · shreds residue`, price: implementPrice("mulcher", s), onBuy: buyImpl("mulcher", s),
  }])));

  section("Harvesting");
  // A combine can't cut without the right header (2026-07-24) — corn head for
  // corn, grain head for everything else. These hitch to the COMBINE, and its
  // class caps which size it can carry, same rule as a tractor.
  line("Corn Header", implementIconHtml("cornHeader", "medium", 26), Object.fromEntries(SIZES.map((s) => [s, {
    spec: `${gameConfig.equipment.cornHeader[s].widthFt} ft · corn only`,
    price: implementPrice("cornHeader", s), onBuy: buyImpl("cornHeader", s),
  }])));
  line("Grain Header", implementIconHtml("grainHeader", "medium", 26), Object.fromEntries(SIZES.map((s) => [s, {
    spec: `${gameConfig.equipment.grainHeader[s].widthFt} ft · all but corn`,
    price: implementPrice("grainHeader", s), onBuy: buyImpl("grainHeader", s),
  }])));
  // The chopper's two heads (2026-07-31, moved into Harvesting 2026-08-14 to
  // match how the owned-implements list already grouped them — IMPLEMENT_
  // GROUP had both as "Harvesting" while the shop still had them under Hay &
  // Silage Tools) — which one a job needs depends on the crop, exactly like
  // the combine's.
  line("Forage Row-Crop Header", implementIconHtml("rowCropHead", "medium", 26), Object.fromEntries(SIZES.map((s) => [s, {
    spec: `${gameConfig.equipment.rowCropHead[s].widthFt} ft · chops standing corn, whole plant`,
    price: implementPrice("rowCropHead", s), onBuy: buyImpl("rowCropHead", s),
  }])));
  line("Forage Pickup Header", implementIconHtml("pickupHead", "medium", 26), {
    medium: {
      spec: "picks a mown windrow up · grass & alfalfa haylage",
      price: implementPrice("pickupHead", "medium"), onBuy: buyImpl("pickupHead", "medium"),
    },
  });

  section("Hay & Silage Tools");
  // Mower: cuts perennial forage (grass/alfalfa) — three sizes as of 2026-07-24.
  line("Mower", mowerIconSvg(26), Object.fromEntries(SIZES.map((s) => [s, {
    spec: `${gameConfig.equipment.mower[s].widthFt} ft · cuts hay`, price: implementPrice("mower", s), onBuy: buyImpl("mower", s),
  }])));
  // Rake: three sizes as of 2026-07-24 (15 / 30 / 50 ft).
  line("Rake", rakeIconSvg(26), Object.fromEntries(SIZES.map((s) => [s, {
    spec: `${gameConfig.equipment.rake[s].widthFt} ft · windrows forage`, price: implementPrice("rake", s), onBuy: buyImpl("rake", s),
  }])));
  // Balers: one of each SHAPE, both Medium (2026-07-24). Neither has a working
  // width — a baler clears whatever the windrow is wide, set by the rake (or by
  // the combine header on straw, which skips the rake) — so there was nothing
  // left for size tiers to express.
  line("Round Baler", implementIconHtml("bailer", "medium", 26), {
    medium: {
      spec: "round bales · picks up the windrow",
      price: implementPrice("bailer", "medium"), onBuy: buyImpl("bailer", "medium"),
    },
  });
  line("Square Baler", implementIconHtml("squareBaler", "medium", 26), {
    medium: {
      spec: "square bales · heavier, worth more per ton",
      price: implementPrice("squareBaler", "medium"), onBuy: buyImpl("squareBaler", "medium"),
    },
  });
  // Silage Phase 1 (2026-07-31). The cheap route into baleage and the
  // one-pass route — see `baleProducts`' balance note for the trade.
  line("Bale Wrapper", implementIconHtml("baleWrapper", "medium", 26), {
    medium: {
      spec: "wraps square and round bales to make silage",
      price: implementPrice("baleWrapper", "medium"), onBuy: buyImpl("baleWrapper", "medium"),
    },
  });
  line("Round Baler with Wrapper", implementIconHtml("combiBaler", "medium", 26), {
    medium: {
      spec: "bales AND wraps in one pass",
      price: implementPrice("combiBaler", "medium"), onBuy: buyImpl("combiBaler", "medium"),
    },
  });
  // Hay Spike: in-field bale collector. Single tier now (2026-08-14, was
  // Small 1-bale / Medium 2-bale) — pullable by Small OR Medium tractors,
  // but not Large (see `canPull`'s haySpikes special case, sim/tasks.ts).
  line("Hay Spike", haySpikesIconSvg(26), {
    medium: {
      spec: `${haySpikesCapacityBales("medium")} bales · collects`,
      price: implementPrice("haySpikes", "medium"), onBuy: buyImpl("haySpikes", "medium"),
    },
  });

  section("Trailers");
  // Forage Wagon: bigger than the grain line at every tier — chopped forage is
  // bulky, and the chopper stops dead whenever no wagon is taking material, so
  // capacity here is what keeps the whole silage harvest moving.
  line("Forage Wagon", implementIconHtml("forageWagon", "medium", 26), Object.fromEntries(SIZES.map((s) => [s, {
    spec: `${gameConfig.equipment.forageWagon[s].capacityTons} t silage`,
    price: implementPrice("forageWagon", s), onBuy: buyImpl("forageWagon", s),
  }])));
  line("Grain Trailer", grainTrailerIconSvg(26), Object.fromEntries(SIZES.map((s) => [s, {
    spec: `${grainTrailerCapacityBushels(s).toLocaleString()} bu (~${grainTrailerCapacityTons(s).toFixed(0)} t corn)`,
    price: implementPrice("grainTrailer", s), onBuy: buyImpl("grainTrailer", s),
  }])));
  // Bale Trailer: bulk bale hauler — Small (10) / Medium (20) / Large (30).
  // Catalog preview shows the empty (0%) fill sprite — a fresh purchase starts empty.
  const baleTrailerCatalogIcon = (() => {
    const url = trailerFillImageUrl("baleTrailer", 0);
    return url ? machineImgTag(url, 26) : baleTrailerIconSvg(26);
  })();
  line("Bale Trailer", baleTrailerCatalogIcon, Object.fromEntries(SIZES.map((s) => [s, {
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
    if (buildingIsSized(kind)) pendingSiloSize = size ?? "small";
    $("structurestab").style.display = "none";
    toast(`🏗️ Click the map to place your ${buildingDisplayName(kind, size)}`);
  };
  shopLine(shop, "Silo", `<span class="shop-emoji">${BUILDING_ICON.silo}</span>`, Object.fromEntries(SIZES.map((s) => [s, {
    spec: `${siloCapacityOf(s).toLocaleString()} bu (~${siloCapacityTonsOf(s, "corn").toFixed(0)} t corn)`,
    price: buildingPrice("silo", s),
    onBuy: placeBuilding("silo", s),
  }])));
  // Silage Bunker (2026-07-31) — sized like a silo, so it gets the same
  // three-column treatment rather than joining the flat list below.
  shopLine(shop, "Silage Bunker", `<span class="shop-emoji">${BUILDING_ICON.silageBunker}</span>`, Object.fromEntries(SIZES.map((s) => [s, {
    spec: `${bunkerCapacityOf(s).toLocaleString()} t silage · takes any product`,
    price: buildingPrice("silageBunker", s),
    onBuy: placeBuilding("silageBunker", s),
  }])));
  const OTHER_BUILDINGS: Array<[Exclude<BuildingKind, "silo" | "silageBunker">, string]> = [
    // The rot rate belongs HERE above all — it's the only thing separating
    // these two, and the point of purchase is where that has to be visible.
    // (`unlimited` was also a lie on the Area: it's been capped since
    // 2026-07-24, and the shop was the last place still saying otherwise.)
    ["baleBarn", `${gameConfig.buildings.baleBarn.capacityBales} bales · indoor · ${spoilLabel("baleBarn")}`],
    ["baleArea", `${gameConfig.buildings.baleArea.capacityBales.toLocaleString()} bales · outdoor · ${spoilLabel("baleArea")}`],
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
    // The full explanation on hover — the card itself is too small for a
    // sentence, but a buyer comparing the Barn against the Area needs one.
    if (kind === "baleBarn" || kind === "baleArea") btn.title = spoilBlurb(kind);
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
/** Status text + dot/card color for one agent's Equipment card — factored
 * out (2026-08-14) so `buildEquipMachines` (full rebuild) and
 * `updateEquipStatusText` (per-tick patch, no rebuild) can never drift out
 * of sync, same reasoning as `computeImplFill`/`updateFillBars`. */
function agentCardStatus(agent: Agent): { taskText: string; stateClass: string } {
  const { text, pct } = agentStatusText(agent);
  const taskText = pct !== null ? `${text} · ${pct.toFixed(0)}%` : text;
  // Corner dot + card tint carry "is it working" at a glance (maintainer
  // request, 2026-07-17, replacing the old progress bar): pulsing green
  // while actually working, gold while driving, red if a harvester is
  // blocked waiting on a Grain Trailer, gray otherwise.
  const waiting = agent.kind === "harvester" ? harvesterWaitingText(agent) : null;
  const stateClass = agent.state === "working" ? "working" : agent.state === "traveling" ? "traveling" : waiting ? "waiting" : "idle";
  return { taskText, stateClass };
}

function buildEquipMachines(): void {
  const rows = $("equip-machines");
  rows.innerHTML = "";
  for (const agent of save.agents) {
    const { taskText, stateClass } = agentCardStatus(agent);
    const carried =
      agent.kind === "tractor"
        ? save.implements.find((i) => i.attachedTo === agent.id)
        : undefined;
    const sub = agent.kind === "tractor"
      ? `<div class="ec-sub" title="${carried ? implementName(save, carried) : "no implement"}">🔧 ${carried ? implementName(save, carried) : "no implement"}</div>`
      : "";

    const row = document.createElement("div");
    row.className = `equip-card ${stateClass}`;
    row.dataset.statusFor = `agent:${agent.id}`;
    row.innerHTML = `
      <span class="ec-dot ${stateClass}" title="${taskText}"></span>
      <span class="icon">${agentMachineIconHtml(agent, 118)}</span>
      <div class="ec-name">${escapeHtml(agent.name)}</div>
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

    // Locate + sell live down the card's SIDE now (2026-07-24) and only appear
    // on hover or selection, so a resting card is just the machine and its
    // state.
    const actions = document.createElement("div");
    actions.className = "ec-actions side";
    actions.appendChild(locateButton(agent.name, agent.pos));

    const refund = agent.purchaseCost ?? (agent.size ? agentPrice(agent.kind as EquipmentKind, agent.size) : 0);
    actions.appendChild(
      iconButton("💰", agent.state !== "idle" ? `${agent.name} is mid-job` : `Sell · $${refund.toLocaleString()}`, agent.state !== "idle", async () => {
        if (!(await confirmDialog({
          title: `Sell ${agent.name}?`,
          body: `You'll get back $${refund.toLocaleString()}.`,
          okLabel: "Sell", danger: true,
        }))) return;
        const { refund: paid } = sellAgent(save, agent.id);
        afterFleetChange();
        toast(`💰 Sold ${agent.name} for $${paid.toLocaleString()}`);
      }),
    );
    row.appendChild(actions);
    wireCardSelection(row, `agent:${agent.id}`);
    rows.appendChild(row);
  }
}

/** Status text + dot color for one implement's Equipment strip — factored
 * out (2026-08-14), same reasoning as `agentCardStatus`. */
function implCardStatus(impl: Implement): { statusText: string; stateClass: string } {
  const host = impl.attachedTo ? save.agents.find((a) => a.id === impl.attachedTo) : undefined;
  const where = host ? `On ${host.name}` : "In the yard";
  const sizeLine = impl.kind === "grainTrailer"
    ? `${grainTrailerCapacityBushels(impl.size).toLocaleString()} bu${impl.cargoTons ? ` · ${impl.cargoTons.toFixed(1)}t onboard` : ""}`
    : `${gameConfig.equipment[impl.kind][impl.size].widthFt} ft wide`;
  // Same dot language as the Machines cards: green while its host tractor
  // is actively working, gold while driving, gray otherwise (in the yard
  // or hitched to an idle tractor).
  const stateClass = host?.state === "working" ? "working" : host?.state === "traveling" ? "traveling" : "idle";
  return { statusText: `${where} · ${sizeLine}`, stateClass };
}

/** IMPLEMENTS you attach, grouped by type (2026-07-24): short strips with a big
 * icon on the left, and a sell button that appears on hover or selection. */
function buildEquipImplements(): void {
  const rows = $("equip-implements");
  rows.innerHTML = "";
  const implements_ = save.implements;
  if (implements_.length === 0) {
    rows.innerHTML = `<div id="fields-empty">No implements — buy a plow and a planter so a tractor can till and seed.</div>`;
    return;
  }

  // Grouped by type, alphabetical within a group (maintainer request,
  // 2026-07-24). Only groups with something in them get a heading.
  for (const group of IMPLEMENT_GROUP_ORDER) {
    const inGroup = implements_
      .filter((i) => IMPLEMENT_GROUP[i.kind] === group)
      .sort((a, b) => implementName(save, a).localeCompare(implementName(save, b), undefined, { numeric: true }));
    if (inGroup.length === 0) continue;
    rows.insertAdjacentHTML("beforeend", `<div class="eq-group">${group}</div>`);

    for (const impl of inGroup) {
      const { statusText, stateClass } = implCardStatus(impl);
      const refund = impl.purchaseCost ?? implementPrice(impl.kind, impl.size);

      // SHORT card (2026-07-24): one row, big icon on the left, text to its
      // right. The hitch dropdown is gone — hitching is automatic when a task
      // is picked up, and the card still says where the implement is.
      const row = document.createElement("div");
      row.className = `eq-strip implement ${stateClass}`;
      row.dataset.statusFor = `impl:${impl.id}`;
      row.innerHTML = `
        <span class="ec-dot ${stateClass}" title="${escapeHtml(statusText)}"></span>
        <span class="icon">${trailerIconHtml(impl, 44)}</span>
        <span class="eq-strip-text">
          <span class="ec-name">${escapeHtml(implementName(save, impl))}</span>
          <span class="ec-status" title="${escapeHtml(statusText)}">${escapeHtml(statusText)}</span>
        </span>`;

      const host = impl.attachedTo ? save.agents.find((a) => a.id === impl.attachedTo) : undefined;
      const busy = !!host && host.state !== "idle";
      const actions = document.createElement("div");
      actions.className = "ec-actions";
      actions.appendChild(
        iconButton("💰", busy ? `${host!.name} is using this` : `Sell · $${refund.toLocaleString()}`, busy, async () => {
          if (!(await confirmDialog({
            title: `Sell ${implementName(save, impl)}?`,
            body: `You'll get back $${refund.toLocaleString()}.`,
            okLabel: "Sell", danger: true,
          }))) return;
          const { refund: paid } = sellImplement(save, impl.id);
          afterFleetChange();
          toast(`💰 Sold for $${paid.toLocaleString()}`);
        }),
      );
      row.appendChild(actions);
      wireCardSelection(row, `impl:${impl.id}`);
      rows.appendChild(row);
    }
  }
}

/**
 * Which equipment card is "selected" — the actions on a card are hidden until
 * it's hovered OR selected (maintainer request, 2026-07-24: "sell button only
 * visible when hovering over or selection"). Hover alone is no good on a touch
 * screen, and it also makes the buttons impossible to reach if the pointer has
 * to cross another card to get to them.
 *
 * A single id, not a set: selecting a card deselects whatever was selected
 * before, so at most one card ever shows its actions unprompted.
 */
let selectedEquipCardId: string | null = null;

function wireCardSelection(card: HTMLElement, id: string): void {
  if (selectedEquipCardId === id) card.classList.add("selected");
  card.addEventListener("click", (e) => {
    // Clicks on the actions themselves are the buttons doing their job — don't
    // let them toggle the selection out from under the press.
    if ((e.target as HTMLElement).closest(".ec-actions")) return;
    selectedEquipCardId = selectedEquipCardId === id ? null : id;
    refreshEquipTab(true);
  });
}

/* REMOVED 2026-07-24: `hitchSelector`, the per-implement "which tractor is this
 * on" dropdown. Maintainer request ("remove the dropdown with location") — the
 * implement cards are short strips now, and hitching has been automatic on task
 * pickup for a long time, so the control was a manual override for something
 * the game already gets right. The card still SAYS where the implement is; you
 * just can't drag it around by hand any more. `attachImplement`/
 * `detachImplement` (sim/tasks.ts) are still exported and still tested — bring
 * a control back here if hand-hitching is ever wanted again. */

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
  persistGame({ save, clockNow: clock.time(), countyId: activeFarm.countyId, daysPerMonth: getDaysPerMonth() });
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
 * The skip montage: fast-forward the sim to `target` so the player watches the
 * field green up / ripen instead of teleporting. All skipped time IS
 * simulated (no shortcuts), just at very high compression.
 *
 * Advances in bounded chunks, one per animation frame, rather than jumping
 * straight to an eased target within a single frame (maintainer request,
 * 2026-08-14, replacing the original fixed-2.5s eased version). That old
 * version could hand ONE frame hours of sim-time in the middle of its ease
 * curve, which (a) could silently drop in-progress relay/haul/wrap work —
 * `tickAgent` only processes a bounded number of discrete phase transitions
 * per `tickWorld` call (see the guard in sim/tasks.ts) — and (b) could force
 * enough field-repaint/agent work into one JS frame to visibly freeze the
 * browser before it could paint, then jump once it finally did. Capping the
 * chunk size fixes both: a typical Skip Month still finishes in about the
 * same ~2.5s it always has, but a skip too big to fit that comfortably (Skip
 * to Spring, or a long days-per-month setting) takes proportionally longer
 * instead of overflowing a single frame.
 */
/** Hard ceiling on sim-minutes advanced in any one montage frame. Chosen well
 * inside what the raised per-tick guard in `tickAgent` can drain (500
 * transitions at the shortest real phase, ~0.17 min, covers ~85 sim-minutes
 * even in a fully degenerate case with zero travel time between steps —
 * 60 leaves comfortable headroom under that). */
const MONTAGE_MAX_CHUNK_MINUTES = 60;
/** Frame budget a TYPICAL Skip Month aims for, so the common case keeps
 * animating at roughly its old ~2.5s pace (150 frames @ 60fps); only skips
 * whose natural chunk size would exceed `MONTAGE_MAX_CHUNK_MINUTES` take
 * more frames (and therefore longer) than this. */
const MONTAGE_TARGET_FRAMES = 150;
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
  const from = clock.time();
  const chunk = Math.min(MONTAGE_MAX_CHUNK_MINUTES, Math.max(1, (target - from) / MONTAGE_TARGET_FRAMES));
  $("montage").style.display = "flex";
  clock.pause(); // we drive time manually during the montage

  const step = () => {
    const prev = clock.time();
    if (prev >= target) {
      $("montage").style.display = "none";
      montageActive = false;
      restoreSpeed(wasPaused);
      toast(`📅 ${formatDate(clock.time())}`);
      return;
    }
    const dt = Math.min(chunk, target - prev);
    // Drive the clock forward by exactly `dt` minutes (clock stays paused
    // between frames; we set time by advancing at exact compression for one
    // fake second).
    clock.play();
    clock.setCompression(dt);
    clock.advance(1);
    clock.pause();
    tickWorld(prev);
    $("montage-month").textContent = MONTH_NAMES[dateOf(clock.time()).month]!;
    requestAnimationFrame(step);
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
/** Width of the Crop Calendar's crop-name column, in px. MUST match
 * `#cal-grid`'s first grid-template-column in index.html — the "you are here"
 * line is positioned over the lanes by offsetting past it. */
const CAL_LABEL_W = 150;

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
  // Bands can WRAP the display-year edge (winter wheat: planted Sep, ready
  // Jun — 2026-07-22) — split into two segments instead of overflowing.
  const pct = (months: number) => (months / MONTHS_PER_YEAR) * 100;
  const band = (cls: string, start: number, len: number): string => {
    if (start + len > MONTHS_PER_YEAR) {
      return (
        `<div class="band ${cls}" style="left:${pct(start)}%;width:${pct(MONTHS_PER_YEAR - start)}%"></div>` +
        `<div class="band ${cls}" style="left:0%;width:${pct(start + len - MONTHS_PER_YEAR)}%"></div>`
      );
    }
    return `<div class="band ${cls}" style="left:${pct(start)}%;width:${pct(len)}%"></div>`;
  };
  for (const cropId of Object.keys(gameConfig.crops) as CropId[]) {
    const cfg = gameConfig.crops[cropId];
    const plantStart = disp(cfg.plantMonths[0]!);
    const plantLen = cfg.plantMonths.length;
    let bands = band("plant", plantStart, plantLen);
    if (cfg.perennial) {
      // Perennials are cut on separate monthly windows — draw a plain harvest
      // bar per cutting month, same style as the annual crops below
      // (maintainer request: drop the special detached/inset "cut" look).
      for (const mo of cfg.harvestMonths ?? []) {
        bands += band("harv", disp(mo), 1);
      }
    } else {
      // Annual: harvest opens a grow-time after planting and runs for the real
      // HARVEST WINDOW (2026-07-23) — modulo a full year so an overwintering
      // crop lands back inside the display year instead of off the right edge.
      // This band is now load-bearing rather than decorative: past its right
      // edge the crop withers, so it has to match the crop's real window
      // (per-crop since 2026-07-24 — oats and barley get a third month).
      const harvStart = disp((cfg.plantMonths[0]! + cfg.growMonths) % MONTHS_PER_YEAR);
      bands += band("harv", harvStart, harvestWindowMonthsFor(cropId));
    }
    // A bale marker after the name for crops whose residue can be baled
    // (maintainer request, 2026-07-23), tinted by the product it makes.
    const baleMark = cfg.producesForage
      ? baleIconSvg(12, gameConfig.baleProducts[cfg.baleProduct ?? "straw"].color)
      : "";
    html += `<div class="crop" title="${cfg.name}">` +
      `<span class="cal-emoji">${cfg.emoji}</span><span class="cal-name">${cfg.name}</span>` +
      (baleMark ? `<span class="cal-bale" title="Leaves balable residue">${baleMark}</span>` : "") +
      `</div><div class="lane">${bands}</div>`;
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
  async function finishField(boundary: Meters[]) {
    if (boundary.length < 3) {
      toast("Need at least 3 corners — try again");
      updateDraft();
      return;
    }
    const acres = areaAcres(boundary);
    const cost = Math.round(acres * gameConfig.landPricePerAcre);
    endDrawing();
    if (!(await confirmDialog({
      title: `Buy this ${acres.toFixed(1)} ac field?`,
      body: `It'll cost $${cost.toLocaleString()} at $${gameConfig.landPricePerAcre.toLocaleString()}/acre.`,
      okLabel: "Buy field",
    }))) return;
    try {
      const { field, acres: boughtAcres, cost: paid } = buyFieldFromBoundary(map, overlay, save, boundary);
      const defaultName = `Field ${save.fields.length}`; // buyFieldFromBoundary already pushed it
      const chosen = await promptDialog({ title: "Name this field", value: defaultName });
      field.name = (chosen ?? "").trim() || defaultName;
      renderField(map, overlay, field, clock.time()); // buy-time render predates the name
      // Seed gates at the road side + opposite, then hand the player the
      // same drag-to-place editor so they can designate the real entry points.
      field.accessPoints = defaultAccessPoints(field.boundary, roadNetRef);
      prefetchAroundAsset(centroidOf(field.boundary)); // warm high-res imagery here
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
  $("df-finish").addEventListener("click", () => void finishField(verts.slice()));

  map.on("click", (e) => {
    if (mode !== "field") return;
    verts.push(toMeters([e.lngLat.lng, e.lngLat.lat]));
    updateDraft();
  });

  map.on("dblclick", () => {
    if (mode !== "field") return;
    // The double-click's two single clicks each pushed the same vertex; drop one.
    verts.pop();
    void finishField(verts.slice());
  });
}

// ---------------------------------------------------------------------------
// Field selection + the cozy side panel.
/** One-click placement for buildings (mode = `building:<kind>`, set from the
 * Structures tab's shop). Unlike field drawing there's no draft —
 * the first click buys and drops it, then resets to "none" whether or not
 * the purchase succeeded (so a misclick/insufficient funds doesn't strand
 * the player in placement mode).
 *
 * Relocating an already-placed building (mode = `relocate:<id>`, maintainer
 * request 2026-08-14) reuses this exact same click-to-place step — the only
 * difference is the click mutates an existing building's `pos` instead of
 * calling `buyBuildingAt`, so it's free and there's nothing to refund if the
 * player backs out (there's no "place" to undo). */
function wireBuildingPlacement(map: maplibregl.Map) {
  map.on("click", (e) => {
    if (mode.startsWith("relocate:")) {
      const id = mode.slice("relocate:".length);
      mode = "none";
      const building = save.buildings.find((b) => b.id === id);
      if (!building) return;
      building.pos = toMeters([e.lngLat.lng, e.lngLat.lat]);
      prefetchAroundAsset(building.pos);
      refreshBuildingMarkers();
      toast(`🏗️ Moved ${buildingDisplayName(building.kind, building.size)}`);
      return;
    }
    if (!mode.startsWith("building:")) return;
    const kind = mode.slice("building:".length) as BuildingKind;
    mode = "none";
    const pos = toMeters([e.lngLat.lng, e.lngLat.lat]);
    const size = buildingIsSized(kind) ? pendingSiloSize : undefined;
    try {
      buyBuildingAt(save, kind, pos, size);
      prefetchAroundAsset(pos); // warm high-res imagery here
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
      if (!building.assignedCrop) return `Holds ${per} bu once assigned a crop below.`;
      const cfg = gameConfig.crops[building.assignedCrop];
      const perTons = siloCapacityTonsOf(building.size ?? "small", building.assignedCrop).toFixed(0);
      return `Holds ${per} bu = ${perTons} t of ${cfg.name.toLowerCase()} · farm total ${siloCapacityForCrop(save, building.assignedCrop).toFixed(0)} t`;
    }
    case "baleBarn":
      return `Bale storage: ${storedBalesTotal(building)} / ${baleStorageCapacityOf("baleBarn").toLocaleString()} bales · under cover, ${spoilLabel("baleBarn")}`;
    case "baleArea":
      return `Bale storage: ${storedBalesTotal(building)} / ${baleStorageCapacityOf("baleArea").toLocaleString()} bales · out in the weather, ${spoilLabel("baleArea")}`;
    case "tractorBarn":
      return `Tractor slots: ${gameConfig.buildings.tractorBarn.slots} · farm total ${barnSlotTotal(save, "tractorBarn")}`;
    case "implementBarn":
      return `Implement slots: ${gameConfig.buildings.implementBarn.slots} · farm total ${barnSlotTotal(save, "implementBarn")}`;
    case "farmYard":
      return "Rally point — new equipment parks here";
    case "sellPoint":
      return "No capacity — a bale hauler sells here on the spot when Bale Storage is missing or full";
    case "silageBunker": {
      const assigned = building.assignedProduct as SilageProduct | undefined;
      const what = assigned ? gameConfig.silageProducts[assigned].name.toLowerCase() : "any silage";
      return `Silage: ${storedSilageTotal(building).toFixed(0)} / ${bunkerCapacityOf(building.size ?? "small").toLocaleString()} t · takes ${what} · farm total ${silageStoredTons(save).toFixed(0)} / ${silageCapacityTons(save).toLocaleString()} t`;
    }
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

  const moveBtn = document.createElement("button");
  moveBtn.className = "shop-buy secondary";
  moveBtn.textContent = "📍 Move";
  moveBtn.addEventListener("click", () => {
    popup.remove();
    mode = `relocate:${building.id}`;
    toast(`📍 Click the map to relocate your ${name}`);
  });
  el.appendChild(moveBtn);

  const sellBtn = document.createElement("button");
  sellBtn.className = "shop-buy";
  sellBtn.textContent = `Sell · $${refund.toLocaleString()}`;
  sellBtn.addEventListener("click", async () => {
    if (!(await confirmDialog({
      title: `Sell ${name}?`,
      body: `You'll get back $${refund.toLocaleString()}.`,
      okLabel: "Sell", danger: true,
    }))) return;
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

  for (const t of FIELD_PANEL_TABS) {
    $(`fp-tab-${t}`).addEventListener("click", () => switchFieldPanelTab(t));
  }

  $("fp-rename").addEventListener("click", async () => {
    const field = save.fields.find((f) => f.id === selectedFieldId);
    if (!field) return;
    const chosen = await promptDialog({ title: "Rename this field", value: fieldLabel(field) });
    if (chosen === null) return; // cancelled — keep the existing name
    field.name = chosen.trim() || field.name;
    renderField(mapRef, overlay, field, clock.time()); // the map label reads the name
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

  $("fp-sell").addEventListener("click", async () => {
    const field = save.fields.find((f) => f.id === selectedFieldId);
    if (!field) return;
    const refund = field.purchaseCost ?? Math.round(areaAcres(field.boundary) * gameConfig.landPricePerAcre);
    if (!(await confirmDialog({
      title: `Sell ${fieldLabel(field)}?`,
      body: `You'll get back $${refund.toLocaleString()}. Any standing crop and queued work goes with it.`,
      okLabel: "Sell field", danger: true,
    }))) return;
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
      // Acres beside the name, rotation name on its own line (maintainer
      // request, 2026-07-23). The rotation line is omitted entirely when
      // unnamed rather than shown empty — most fields won't have one.
      const rot = hit.rotationName?.trim();
      badge.innerHTML = `
        <div class="fb-icon">${cropIcon}</div>
        <div class="fb-text">
          <div class="fb-name">${escapeHtml(fieldLabel(hit))}<span class="fb-acres">${areaAcres(hit.boundary).toFixed(1)} ac</span></div>
          <div class="fb-crop">${cropName}</div>
          ${rot ? `<div class="fb-rot">🔁 ${escapeHtml(rot)}</div>` : ""}
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
  $("fieldpanel").style.display = "flex";
  // Stay on whichever tab is already open (maintainer request, 2026-07-23) —
  // clicking between fields to compare their schedules or finances used to
  // throw you back to View on every single click.
  switchFieldPanelTab(fieldPanelTab);
}

function closeFieldPanel() {
  stopAccessEdit();
  selectedFieldId = null;
  $("fieldpanel").style.display = "none";
}

/** Switch the Field panel's active side-tab, updating the tab-strip's
 * highlighted button and which tab-content div is visible, then force-
 * refreshing so the newly-shown tab repaints immediately. All four tabs share
 * one uniform width (see `.fp-main`). */
function switchFieldPanelTab(tab: FieldPanelTab): void {
  fieldPanelTab = tab;
  for (const t of FIELD_PANEL_TABS) {
    $(`fp-${t}-tab`).style.display = t === tab ? "block" : "none";
    $(`fp-tab-${t}`).classList.toggle("active", t === tab);
  }
  refreshFieldPanel(true);
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
function queueFromPanel(field: Field, type: "plow" | "plant" | "harvest" | "chop" | "mow" | "mulch" | "weed" | "fertilize" | "rake" | "bale", crop?: CropId): void {
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

/** Which rotation STEP a field is on, normalized for display. Mirrors the
 * sim's own `rotationStep` (sim/tasks.ts) — the rotation stopped being keyed to
 * the campaign year on 2026-07-23, so the UI reads the pointer, not the clock. */
function activeRotationIdx(field: Field): number {
  const len = field.plans?.length ?? 1;
  return ((field.rotationIndex ?? 0) % len + len) % len;
}

/** Render the field's rotation sequence into #fp-plans — one row per step, each
 * with a crop. Own change-detection so its dropdowns aren't rebuilt under the
 * cursor on every tick. */
/** Does this crop leave residue a player can bale (straw or hay)? Drives the
 * bale marker on a rotation chip (maintainer request, 2026-07-23). */
function cropMakesBales(crop: CropId): boolean {
  return !!gameConfig.crops[crop].producesForage;
}

/** Clipboard for the Schedule tab's rotation Copy/Paste. Deliberately a plain
 * module variable, not save state: it's a transient editing convenience, and
 * persisting it would mean a rotation copied three sessions ago silently
 * survives into a farm it was never meant for. */
let rotationClipboard: { name?: string; plans: FieldPlan[] } | null = null;

function refreshPlanEditor(field: Field, auto: boolean): void {
  const head = $("fp-rotation-head");
  const container = $("fp-plans");
  // Keyed on the rotation POINTER, not the campaign year — the year no longer
  // selects the active step, so a year turn is not a reason to rebuild. The
  // viewed step and clipboard state are in the key too: both change what's drawn.
  const key = [
    field.id, auto ? 1 : 0, activeRotationIdx(field), scheduleViewStepIdx,
    field.rotationName ?? "", rotationClipboard ? 1 : 0, JSON.stringify(field.plans ?? []),
  ].join("|");
  if (key === lastPlansKey) return;
  lastPlansKey = key;
  head.innerHTML = "";
  container.innerHTML = "";
  if (!auto) return;

  if (!field.plans || field.plans.length === 0) field.plans = [defaultPlan()];
  // A perennial stand (grass/alfalfa) is planted once and never rotated — its
  // "plan" is a single step. Collapse to plans[0].
  const perennialField = isPerennial(field.plans[0]!.crop);
  if (perennialField && field.plans.length > 1) field.plans.length = 1;
  const plans = field.plans;
  // Self-heal a stale bale toggle: the Rake/Bale column is hidden for crops
  // with no bale product, so a flag left over from an earlier crop choice (or
  // from before corn stopped making stover) would otherwise be stuck on with
  // no way to clear it. Harmless in the sim — `forageDue` gates on the field
  // actually having residue — but it would misreport the plan.
  for (const p of plans) if (p.bale && !cropMakesBales(p.crop)) p.bale = false;

  // --- Rotation name + Copy / Paste -----------------------------------------
  const nameInput = document.createElement("input");
  nameInput.className = "rot-name";
  nameInput.type = "text";
  nameInput.maxLength = 40;
  nameInput.placeholder = "Name this rotation…";
  nameInput.value = field.rotationName ?? "";
  // Commit on blur/Enter rather than per keystroke: `editPlans` re-renders, and
  // rebuilding the input mid-word would drop the cursor.
  const commitName = () => {
    const v = nameInput.value.trim();
    const next = v === "" ? undefined : v;
    if (next !== field.rotationName) {
      field.rotationName = next;
      editPlans();
    }
  };
  nameInput.addEventListener("blur", commitName);
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") nameInput.blur();
  });
  head.appendChild(nameInput);

  const copyBtn = document.createElement("button");
  copyBtn.className = "rot-btn";
  copyBtn.textContent = "⧉";
  copyBtn.title = "Copy this rotation";
  copyBtn.addEventListener("click", () => {
    // Deep copy so later edits to this field don't mutate what's on the clipboard.
    rotationClipboard = { name: field.rotationName, plans: JSON.parse(JSON.stringify(plans)) as FieldPlan[] };
    toast(`⧉ Copied rotation${field.rotationName ? ` "${field.rotationName}"` : ""}`);
    lastPlansKey = "";
    refreshFieldPanel(true);
  });
  head.appendChild(copyBtn);

  const pasteBtn = document.createElement("button");
  pasteBtn.className = "rot-btn";
  pasteBtn.textContent = "⎘";
  pasteBtn.disabled = !rotationClipboard;
  pasteBtn.title = rotationClipboard
    ? `Paste rotation${rotationClipboard.name ? ` "${rotationClipboard.name}"` : ""} onto this field`
    : "Copy a rotation from another field first";
  pasteBtn.addEventListener("click", () => {
    if (!rotationClipboard) return;
    // Deep copy on the way OUT too, so one clipboard can be pasted onto many
    // fields without them sharing plan objects.
    field.plans = JSON.parse(JSON.stringify(rotationClipboard.plans)) as FieldPlan[];
    field.rotationName = rotationClipboard.name;
    // The pasted sequence is a different length/shape — restart it rather than
    // leaving the pointer indexing into a step that no longer means the same thing.
    field.rotationIndex = 0;
    toast(`⎘ Pasted rotation onto ${fieldLabel(field)}`);
    editPlans();
  });
  head.appendChild(pasteBtn);

  // The crop LIST that used to live here is gone (maintainer, 2026-07-31:
  // "the crop selection at the top is redundant"). Choosing a crop, adding a
  // step and removing one all happen on the calendar's own block headers now —
  // this editor keeps only the rotation's name and its copy/paste.
}

/** Rebuild just the field panel's shared header (title + acreage) — shown
 * above the tab content regardless of which side-tab is active. Cheap enough
 * to run unconditionally on every refresh, no change-detection needed.
 *
 * The status pill went in the 2026-07-31 space-clearing pass (maintainer
 * request): the Work Queue already reports what a field is doing, and the
 * calendar shows where it is in its cycle. */
function refreshFieldPanelHeader(field: Field): void {
  $("fp-title").textContent = "🌾 " + fieldLabel(field);
  $("fp-sub").textContent = `${areaAcres(field.boundary).toFixed(1)} acres`;
}

/** Rebuild the panel contents from the selected field's current state —
 * dispatches to whichever side-tab (View/Schedule/Finances/Settings) is
 * currently active. Each tab keeps its OWN change-detection cache (mirroring
 * refreshPlanEditor's existing lastPlansKey pattern) rather than one shared
 * key, so switching/editing one tab doesn't force-rebuild the others. */
function refreshFieldPanel(force = false) {
  const field = save.fields.find((f) => f.id === selectedFieldId);
  if (!field) return closeFieldPanel();
  const now = clock.time();
  const auto = !!field.autoManage;
  refreshFieldPanelHeader(field);
  switch (fieldPanelTab) {
    case "view": refreshFieldViewTab(field, now, auto, force); break;
    case "schedule": refreshFieldScheduleTab(field, now, force); break;
    case "finances": refreshFieldFinancesTab(field, force); break;
    case "settings": refreshFieldSettingsTab(field, force); break;
  }
}

/** Icon per yield-modifier label (see `yieldModifierSteps`) for the waterfall
 * graphic below — distinct per factor even where the game reuses an emoji
 * elsewhere (e.g. the Fertilize button also uses 🌿). */
const YIELD_STEP_ICON: Record<string, string> = { Weeds: "🐛", Fertilizer: "🌿", Mulch: "♻️", Rotation: "🔄" };

/** "What's going into this yield" waterfall: a Base bar, one small delta bar
 * per active modifier (weeds/fertilizer/mulch/rotation), and a final Estimate
 * bar — each delta bar's height is its own ± ton/acre contribution off Base,
 * exactly matching `productivityMultiplier`'s linear sum (no compounding),
 * so the bars' math always agrees with the number in the range display above
 * them. Only annuals get this (perennials show cut-count progress instead). */
function yieldWaterfallHtml(field: Field, now: number): string {
  const crop = field.crop;
  if (!crop) return "";
  const cfg = gameConfig.crops[crop];
  const base = cfg.baseYieldTonsPerAcre;
  const steps = yieldModifierSteps(field, now);
  if (steps.length === 0) return ""; // nothing modifying yield yet — the plain range bar says enough

  let running = base;
  const deltas = steps.map((s) => {
    const delta = base * s.pct;
    running += delta;
    return { ...s, delta };
  });
  const maxVal = Math.max(base, running, 0.01);
  const trackPx = 64;
  const barPx = (v: number) => Math.max(4, Math.min(trackPx, (v / maxVal) * trackPx));

  const step = (label: string, valueLabel: string, heightPx: number, cls: string, icon: string, bold = false) => `
    <div class="yw-step">
      <div class="yw-val">${valueLabel}</div>
      <div class="yw-bar ${cls}" style="height:${heightPx.toFixed(0)}px"></div>
      <div class="yw-name${bold ? " bold" : ""}">${icon} ${label}</div>
    </div>`;

  let html = `<div class="small" style="margin-top:8px">What's going into this yield (t/acre)</div><div class="yield-waterfall">`;
  html += step("Base", base.toFixed(1), barPx(base), "base", cfg.emoji);
  for (const d of deltas) {
    const pctLabel = `${d.pct >= 0 ? "+" : ""}${Math.round(d.pct * 100)}%`;
    html += step(d.label, pctLabel, barPx(Math.abs(d.delta)), d.delta >= 0 ? "bonus" : "penalty", YIELD_STEP_ICON[d.label] ?? "");
  }
  html += step("Estimate", running.toFixed(1), barPx(running), "final", "🎯", true);
  html += `</div>`;
  return html;
}

/** Field View tab: task progress, bales, plow/plant/weed/fertilize/harvest
 * controls — everything the field needs RIGHT NOW under manual control. */
let lastViewKey = "";
function refreshFieldViewTab(field: Field, now: number, auto: boolean, force: boolean): void {
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
  const key = [
    field.id, field.status, eff, auto,
    pending.map((t) => `${t.type}${t.status}${Math.round((t.doneAcres / t.totalAcres) * 100)}`).join(","),
    Math.round(growthProgress(field, now) * 100),
    dateOf(now).month, // planting windows open/close on month boundaries
    Math.round(save.money), // affordability of input costs
    field.forageReady ? 1 : 0, field.windrowed ? 1 : 0, field.baleLocations?.length ?? 0, // forage/bale state
    field.weedy ? 1 : 0, field.baleProduct ?? "", field.cutsThisYear ?? 0, field.cutYear ?? 0, // perennial/bale
  ].join("|");
  if (!force && key === lastViewKey) return;
  lastViewKey = key;

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
    const productId = field.baleProduct ?? "cornStover";
    const product = gameConfig.baleProducts[productId];
    const unitPrice = baleUnitPrice(productId, monthOf(now));
    const value = Math.round(bales * unitPrice);
    const tons = (bales * baleTonsOf(productId)).toFixed(0);
    // The real bale icon, not a generic box — round vs rectangular is the whole
    // point once both balers exist (2026-07-24).
    body.insertAdjacentHTML(
      "beforeend",
      `<div class="small fp-bales" style="margin-top:8px">${baleIconFor(productId, 16)} <b>${bales}</b> ${product.name} bales (${tons} t) · $${Math.round(unitPrice).toLocaleString()}/bale ${priceBadge(productId)}</div>`,
    );
    const btn = document.createElement("button");
    btn.className = "primary";
    btn.innerHTML = `💰 Sell Bales <span class="small">$${value.toLocaleString()}</span>`;
    btn.addEventListener("click", () => {
      const { bales: sold, revenue } = sellBales(save, field, clock.time());
      if (sold <= 0) return;
      logSale("sellBales", { fieldId: field.id, label: product.name, bales: sold, tons: sold * baleTonsOf(productId), revenue });
      updateHud();
      refreshFieldPanel(true);
      updateBaleMarkers();
      toast(`💰 Sold ${sold} bales for $${revenue.toLocaleString()}`);
    });
    actions.appendChild(btn);

    // WRAP into baleage (2026-07-31). Only offered while the same-month window
    // is open, and the button says how long that is — miss it and these bales
    // are hay for good, which is the one bit of timing pressure in the feature.
    if (canWrapBales(field, clock.time()) && tasksFor(save, field.id, "wrap").length === 0) {
      const wrapCost = taskCost(field, "wrap");
      const wrapBtn = document.createElement("button");
      wrapBtn.innerHTML = `🎁 Wrap into Baleage<br><span class="small">$${wrapCost.toLocaleString()}</span>`;
      wrapBtn.title = save.implements.some((i) => i.kind === "baleWrapper")
        ? "Seal these bales in plastic — baleage barely spoils in storage. Has to happen this month."
        : "Needs a Bale Wrapper (Equipment → Hay & Silage Tools)";
      wrapBtn.addEventListener("click", () => {
        try {
          enqueueTask(save, field, "wrap", clock.time());
          updateHud();
          refreshQueuePanel();
          refreshFieldPanel(true);
          toast("🎁 Wrap queued — these bales become baleage");
        } catch (err) {
          toast("❌ " + (err as Error).message, 3500);
        }
      });
      actions.appendChild(wrapBtn);
    }

    // Haul these bales to Bale Storage (a Hay-Spikes tractor collects them,
    // pulling in a Bale Trailer if one's idle). Hidden once a haul's already
    // covering the field — baling auto-queues one (maintainer request,
    // 2026-07-17).
    if (fieldHasLooseBales(save, field.id)) {
      const haulBtn = document.createElement("button");
      haulBtn.innerHTML = `🚜 Haul to Storage`;
      haulBtn.title = "Send a Hay-Spikes tractor to move these bales into Bale Storage";
      haulBtn.addEventListener("click", () => {
        if (!queueHaulBales(save, field.id, clock.time())) {
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

  /* MOVED 2026-07-24 to the Field Schedule tab (`renderQueuePlow`) at the
   * maintainer's request — plowing is configured there, so the manual
   * "plow now" override belongs beside it rather than buried in Field View. */

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

  // --- Withered: the crop was lost to a missed harvest window (2026-07-23).
  // A total loss needs an explicit explanation, or a field that quietly went
  // grey and empty just reads as a bug.
  if (field.status === "withered") {
    const lost = field.lastCrop ? gameConfig.crops[field.lastCrop] : undefined;
    body.insertAdjacentHTML(
      "beforeend",
      `<div class="withered-note">
         <b>💀 ${lost ? `${lost.emoji} ${lost.name}` : "The crop"} withered</b>
         <div class="small">It stood past its ${field.lastCrop ? harvestWindowMonthsFor(field.lastCrop) : gameConfig.harvestWindowMonths}-month harvest window and was lost — no grain, no bales.
         Mulch it back in (worth ${Math.round(gameConfig.mulchBonusPct * 100)}% on the next crop) or plow it under to clear the field.</div>
       </div>`,
    );
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
    // Countdown on a ripe crop — the last chance to act before a total loss.
    const monthsLeft = harvestMonthsRemaining(field, now);
    if (monthsLeft !== null && !harvestingNow) {
      html += `<div class="small harvest-window${monthsLeft === 0 ? " urgent" : ""}">${
        monthsLeft === 0
          ? "⚠️ Last month to harvest — the crop withers at the month's end"
          : `⏳ ${monthsLeft} more month${monthsLeft === 1 ? "" : "s"} to harvest before it withers`
      }</div>`;
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
        html += yieldWaterfallHtml(field, now);
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
      // Perennial forage is CUT with a mower (→ rake → bale); a chop-only
      // annual (Forage) only ever chops; everything else is combined. Exactly
      // one button per crop — the route was decided at planting, not here
      // (2026-08-12: silage used to be an in-season fork on Corn itself; see
      // `isChopOnlyCrop`).
      if (isPerennial(field.crop)) {
        if (tasksFor(save, field.id, "mow").length === 0) {
          const cost = taskCost(field, "mow");
          const btn = document.createElement("button");
          btn.className = "primary";
          btn.innerHTML = `🌾 Queue Cut (Mow) <span class="small">$${cost.toLocaleString()}</span>`;
          btn.addEventListener("click", () => queueFromPanel(field, "mow"));
          actions.appendChild(btn);
        }
      } else if (isChopOnlyCrop(field.crop)) {
        if (tasksFor(save, field.id, "chop").length === 0) {
          const chopCost = taskCost(field, "chop");
          const chopBtn = document.createElement("button");
          chopBtn.className = "primary";
          chopBtn.innerHTML = `🌱 Queue Chop (Silage) <span class="small">$${chopCost.toLocaleString()}</span>`;
          // Named per missing piece (2026-08-13) — queuing used to succeed
          // regardless (enqueueTask never checked the harvester or head), so
          // a field with everything but a Row-Crop Head just sat "ready"
          // forever with no explanation. Same three checks `enqueueTask`
          // now enforces (sim/tasks.ts), in the same order, so the tooltip
          // and the click can never disagree.
          if (!save.agents.some((a) => a.kind === "forageHarvester")) {
            chopBtn.title = "Needs a Forage Harvester (Equipment)";
          } else if (!save.implements.some((i) => i.kind === "forageWagon")) {
            chopBtn.title = "Needs a Forage Wagon (Equipment) — a chopper has no tank of its own";
          } else if (!save.implements.some((i) => i.kind === chopHeadKind(field.crop!))) {
            chopBtn.title = `Needs a ${IMPLEMENT_KIND_NAME[chopHeadKind(field.crop!)]} (Equipment) — the chopper can't cut standing ${cfg.name.toLowerCase()} without one`;
          } else {
            chopBtn.title = "Chop the whole plant for silage — no grain, no residue";
          }
          chopBtn.addEventListener("click", () => queueFromPanel(field, "chop"));
          actions.appendChild(chopBtn);
        }
      } else if (tasksFor(save, field.id, "harvest").length === 0) {
        const btn = document.createElement("button");
        btn.className = "primary";
        btn.textContent = "🌾 Queue Harvest";
        btn.addEventListener("click", () => queueFromPanel(field, "harvest"));
        actions.appendChild(btn);
      }
    }

    // Haylage (Phase 2): a cut perennial can be chopped off the windrow
    // instead of raked and baled. Sits beside the Rake/Bale buttons below.
    if (!auto && isPerennial(field.crop) && field.status === "harvested" && field.forageReady
        && cropMakesSilage(field.crop) && tasksFor(save, field.id, "chop").length === 0) {
      const chopCost = taskCost(field, "chop");
      const chopBtn = document.createElement("button");
      chopBtn.innerHTML = `🌱 Chop for Haylage <span class="small">$${chopCost.toLocaleString()}</span>`;
      chopBtn.title = "Chop the windrow into a bunker instead of baling it — needs a rake pass first";
      chopBtn.addEventListener("click", () => queueFromPanel(field, "chop"));
      actions.appendChild(chopBtn);
    }

    // Optional post-harvest residue pass (annuals we aren't baling): available
    // once the field is harvested, until it's plowed or baled. Boosts the next
    // crop by `mulchBonusPct` — read from config, since the figure was cut to a
    // realistic +3% in 2026-07-25 and a hardcoded tooltip would have lied.
    if (!auto && canMulch(save, field) && tasksFor(save, field.id, "mulch").length === 0) {
      const cost = taskCost(field, "mulch");
      const btn = document.createElement("button");
      btn.innerHTML = `🍂 Queue Mulch <span class="small">$${cost.toLocaleString()}</span>`;
      btn.title = `Shred crop residue back in — +${Math.round(gameConfig.mulchBonusPct * 100)}% to the next crop's yield`;
      btn.addEventListener("click", () => queueFromPanel(field, "mulch"));
      actions.appendChild(btn);
    }
  }
}

/** Field Schedule tab: the Auto-manage switch + the rotation-sequence editor +
 * a monthly drag-drop calendar of the viewed step's task months. `_now` is unused
 * since the rotation stopped being keyed to the campaign year (2026-07-23), but
 * stays for signature parity with the other per-tab refreshers. */
function refreshFieldScheduleTab(field: Field, _now: number, _force: boolean): void {
  const auto = !!field.autoManage;
  ($("fp-auto") as HTMLInputElement).checked = auto;
  // refreshPlanEditor has its own change-detection (lastPlansKey) so its
  // dropdowns aren't rebuilt under the cursor on every tick.
  refreshPlanEditor(field, auto);
  refreshScheduleCalendar(field, auto);
  renderQueuePlow(field);
  renderQueueHaulBales(field);
}

/**
 * The manual "plow now" control, moved here from Field View (maintainer
 * request, 2026-07-24) — plowing is scheduled on this tab, so the override that
 * ignores the schedule belongs next to it.
 *
 * Offered ALWAYS: any month, whether or not something is standing on the field,
 * and — unlike its old home — whether or not the field is auto-managed. On an
 * auto field it's the "don't wait for the scheduled month" escape hatch; the
 * automatic plow still runs to the calendar (see `plowDue`, sim/tasks.ts).
 *
 * On bare/harvested/mulched ground it just queues a plow. Anywhere else it's a
 * destructive restart that forfeits the standing crop and any residue — which
 * is the ONLY way to clear a perennial stand, since the automatic lifecycle
 * never plows one under. That branch confirms first.
 */
function renderQueuePlow(field: Field): void {
  const host = $("fp-schedule-plow");
  host.innerHTML = "";
  const eff = effectiveStatus(save, field);
  const activeTask = save.tasks.find((t) => t.fieldId === field.id && t.status === "active");
  if (activeTask) return; // something's already working this field

  const plowableNow = canPlow(eff) && !isPerennial(field.crop) && !(eff === "harvested" && forageDue(save, field));
  const cost = taskCost(field, "plow");
  // Compact, and the explanation moved into the tooltip: this button shares a
  // row with Reset now (maintainer, 2026-07-31), and a sentence above it was
  // costing the calendar vertical space.
  const btn = document.createElement("button");
  btn.className = "primary";
  btn.innerHTML = `🚜 Plow <span class="small">$${cost.toLocaleString()}</span>`;
  btn.title = plowableNow
    ? "Plow to prepare for planting"
    : "Plow now to clear this field and start over — forfeits the standing crop and any residue";
  if (plowableNow) {
    btn.addEventListener("click", () => queueFromPanel(field, "plow"));
  } else {
    btn.addEventListener("click", async () => {
      if (!(await confirmDialog({
        title: `Plow ${fieldLabel(field)} now?`,
        body: "This clears the field's current crop and any residue.",
        okLabel: "Plow it under", danger: true,
      }))) return;
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
  host.appendChild(btn);
}

/**
 * Manual "Haul Bales" control (maintainer request, 2026-08-13) — a one-click
 * sweep for stranded bales, next to Plow so a player working the Schedule
 * tab doesn't have to switch to Field View to notice loose bales and go find
 * the (also-existing) button there. Reuses `queueHaulBales`/
 * `fieldHasLooseBales` directly rather than `queueFromPanel`, whose `type`
 * union doesn't include "haulBales" — same pattern the Field View button
 * already follows. Visible only while there's actually something to sweep.
 */
function renderQueueHaulBales(field: Field): void {
  const host = $("fp-schedule-haul");
  host.innerHTML = "";
  if (!fieldHasLooseBales(save, field.id)) return;
  const btn = document.createElement("button");
  btn.innerHTML = `🚜 Haul Bales`;
  btn.title = "Send a Hay-Spikes tractor to pick up bales stranded on this field";
  btn.addEventListener("click", () => {
    if (!queueHaulBales(save, field.id, clock.time())) {
      toast("Nothing to haul, or a haul's already running");
      return;
    }
    refreshQueuePanel();
    refreshFieldPanel(true);
    toast("🚜 Haul Bales queued — a Hay-Spikes tractor is on it");
  });
  host.appendChild(btn);
}

// --- Field Schedule calendar (maintainer request, 2026-07-21; rotated to a
//     VERTICAL layout 2026-07-21 to save horizontal space) -------------------
/** Which rotation STEP (plans[] index) the calendar is currently showing —
 * independent of which step is actually running right now, so the player can
 * view/edit any step's schedule. Driven by the crop chips (2026-07-23, which
 * replaced the old ‹ Yr N › stepper). */
let scheduleViewStepIdx = 0;

/** Month ROWS top-to-bottom, in the game's season order (Mar→Feb, starting at
 * START_MONTH) so the year reads Spring→Winter down the calendar, matching the
 * year bar. `SCHEDULE_MONTH_ORDER[row]` = the real 0-11 month number. */
const SCHEDULE_MONTH_ORDER: number[] = Array.from({ length: 12 }, (_, i) => (START_MONTH + i) % MONTHS_PER_YEAR);

type ScheduleSeason = "spring" | "summer" | "fall" | "winter";
function seasonOfMonth(m: number): ScheduleSeason {
  if (m >= 2 && m <= 4) return "spring";
  if (m >= 5 && m <= 7) return "summer";
  if (m >= 8 && m <= 10) return "fall";
  return "winter";
}
/** The Schedule timeline's own drag state — separate from the Work Queue's
 * `draggingTaskId` (different domain/shape). */
let draggingScheduleCell: { planIdx: number; kind: string } | null = null;

const TL_TASK_ICON: Record<string, string> = {
  plow: "🚜", plant: "🌱", fertilize: "🌿", weed: "💦", harvest: "🌾",
  mulch: "🍂", mow: "🌾", bale: "📦", wrap: "🎁", silage: "🌱",
};
const TL_TASK_LABEL: Record<string, string> = {
  plow: "Plow", plant: "Plant", fertilize: "Fertilize", weed: "Weed", harvest: "Harvest",
  mulch: "Mulch", mow: "Mow (cut)", bale: "Rake / Bale", wrap: "Wrap (Baleage)", silage: "Chop (Silage)",
};

let lastScheduleCalKey = "";

/** Task COLUMNS, left to right, in the order a crop actually experiences them.
 * The header is the union across every step in the rotation, so a column means
 * the same thing in every block. */
const TL_COLUMN_ORDER: TimelineTaskKind[] = [
  "plow", "plant", "fertilize", "weed", "mow", "harvest", "bale", "wrap", "silage", "mulch",
];

/** Field whose schedule was last auto-scrolled to today. Scrolling is a
 * ONE-TIME courtesy when the panel opens — re-running it on every re-render
 * yanked the view out from under the player every time they clicked a task
 * (maintainer report, 2026-07-31). */
let tlScrolledFieldId: string | null = null;

/**
 * The rotation TIMELINE (maintainer rework, 2026-07-31).
 *
 * LAYOUT: tasks run across the TOP axis, shared by every crop in the rotation.
 * The vertical axis is the rotation itself — each step is a BLOCK of its own
 * months, stacked in the order they happen. Today is a line across the grid.
 *
 * Why this shape: the field panel is narrow and tall. A month axis across the
 * top meant permanent side-scrolling; a crop-per-column grid gave each crop one
 * narrow column to hold every task, so two tasks in the same month collided.
 * Tasks are a fixed, small column set that fits the width, and stacking crops
 * downward is the one direction the panel has room to grow.
 *
 * THE CALENDAR IS THE WHOLE EDITOR (maintainer, 2026-07-31). Crop choice, adding
 * and removing steps, turning optional operations on and off, and moving a task
 * to another month all happen HERE — there is no separate crop list or toggle
 * strip any more, because both were saying things the calendar already showed.
 *
 * Every task's AVAILABLE months are drawn all the time as dotted cells, not
 * revealed on click. That's what let the click-to-select step disappear: you
 * just click the month you want.
 *
 * All the arithmetic lives in `sim/rotationTimeline.ts` and is unit-tested;
 * this only draws it. Moving a task still goes through `setScheduleOverride`
 * with that month-of-year, so the override model is untouched.
 */
function refreshScheduleCalendar(field: Field, auto: boolean): void {
  const host = $("fp-schedule-grid");
  const msg = $("fp-schedule-msg");
  const resetHost = $("fp-schedule-reset");
  if (!auto) {
    host.innerHTML = `<div class="fp-sched-hint">Turn on <b>Auto-manage</b> above to lay out this field's task schedule. The schedule tells the auto-manager which month to run each step — it has no effect while you drive the field manually from the View tab.</div>`;
    msg.textContent = "";
    resetHost.innerHTML = "";
    lastScheduleCalKey = "";
    return;
  }
  if (!field.plans || field.plans.length === 0) field.plans = [defaultPlan()];
  const plans = field.plans;
  const perennialField = isPerennial(plans[0]!.crop);
  // One block per rotation step — see `ProjectOptions.maxBands`.
  const timeline = projectRotation(field, clock.time());

  const key = [field.id, activeRotationIdx(field), JSON.stringify(plans), timeline.todayAbs].join("|");
  if (key === lastScheduleCalKey) return;
  lastScheduleCalKey = key;

  host.innerHTML = "";
  if (timeline.bands.length === 0) {
    host.insertAdjacentHTML("beforeend", `<div class="fp-sched-hint">No rotation steps yet — add a crop below.</div>`);
    return;
  }

  host.insertAdjacentHTML("beforeend",
    `<div class="fp-cal-legend">
      <span><i class="lg-sched"></i>Scheduled</span>
      <span><i class="lg-legal"></i>Available — click to move</span>
      <span><i class="lg-today"></i>Today</span>
    </div>`);

  // Columns: every task kind any step in this rotation uses, canonically
  // ordered so a column means the same thing in every block.
  const used = new Set<TimelineTaskKind>();
  for (const band of timeline.bands) for (const t of band.tasks) used.add(t.kind);
  const columns = TL_COLUMN_ORDER.filter((k) => used.has(k));
  const colOf = (kind: TimelineTaskKind): number => 2 + columns.indexOf(kind);

  const scroller = document.createElement("div");
  scroller.className = "fp-tl-scroll";
  const grid = document.createElement("div");
  grid.className = "fp-tl-grid";
  grid.style.gridTemplateColumns = `40px repeat(${columns.length}, minmax(28px, 1fr))`;
  scroller.appendChild(grid);
  host.appendChild(scroller);

  let row = 1;

  // --- Sticky task header ---
  const corner = document.createElement("div");
  corner.className = "fp-tl-corner";
  corner.style.gridRow = String(row);
  corner.style.gridColumn = "1";
  grid.appendChild(corner);
  for (const kind of columns) {
    const head = document.createElement("div");
    head.className = "fp-tl-thead";
    head.style.gridRow = String(row);
    head.style.gridColumn = String(colOf(kind));
    head.textContent = TL_TASK_ICON[kind] ?? "•";
    head.title = TL_TASK_LABEL[kind] ?? kind;
    grid.appendChild(head);
  }
  row++;

  /** Rows carrying a real month, for placing the today line afterwards. */
  const monthRows: { abs: AbsMonth; row: number }[] = [];

  for (const band of timeline.bands) {
    const plan = plans[band.planIdx]!;
    const cfg = gameConfig.crops[band.crop];

    // --- Block header: the crop itself is edited here ---
    const bhead = document.createElement("div");
    bhead.className = "fp-tl-bhead" + (band.current ? " current" : "");
    bhead.style.gridRow = String(row);
    bhead.style.gridColumn = "1 / -1";
    if (band.planted) {
      bhead.insertAdjacentHTML("beforeend", `<span class="fp-tl-planted" title="Already in the ground">●</span>`);
    }

    // Crop picker — replaces the separate crop list that used to sit above the
    // calendar saying the same thing twice.
    const sel = document.createElement("select");
    sel.className = "fp-tl-crop-sel";
    for (const cropId of Object.keys(gameConfig.crops) as CropId[]) {
      const opt = document.createElement("option");
      opt.value = cropId;
      opt.textContent = `${gameConfig.crops[cropId].emoji} ${gameConfig.crops[cropId].name}`;
      if (cropId === plan.crop) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.title = `${cfg.name} — change this step's crop`;
    sel.addEventListener("change", () => {
      plan.crop = sel.value as CropId;
      if (!cropMakesBales(plan.crop)) plan.bale = false; // baling is forage-only
      // Switching TO a perennial collapses the rotation to this single step;
      // perennials also default to baling (hay) and never weed.
      if (isPerennial(plan.crop)) {
        field.plans = [plan];
        field.rotationIndex = 0;
        plan.weed = false;
        plan.bale = true;
      }
      // The new crop's legal months differ — an override carried over from the
      // old crop would be re-validated away silently, so clear it and let the
      // calendar show real defaults.
      plan.schedule = undefined;
      editPlans();
    });
    bhead.appendChild(sel);

    const del = document.createElement("button");
    del.className = "fp-tl-crop-del";
    del.textContent = "✕";
    del.disabled = plans.length <= 1;
    del.title = plans.length <= 1 ? "A rotation needs at least one crop" : `Remove ${cfg.name} from the rotation`;
    del.addEventListener("click", () => {
      // Pointer arithmetic lives in the sim (removeRotationStep) — getting it
      // wrong silently changes which crop the field is growing.
      removeRotationStep(field, band.planIdx);
      editPlans();
    });
    bhead.appendChild(del);
    grid.appendChild(bhead);
    row++;

    // --- The months this step actually needs: first task (usually the plow,
    //     which sits ahead of the crop) through the last. ---
    const marks = band.tasks.flatMap((t) => t.at);
    const from = Math.min(band.plantAbs, ...marks);
    const to = Math.max(band.harvestAbs, ...marks);
    const taskFor = new Map(band.tasks.map((t) => [t.kind, t]));

    for (let abs = from; abs <= to; abs++) {
      const { year, month } = splitAbs(abs);
      const inGround = abs >= band.plantAbs && abs <= band.harvestAbs;

      const gutter = document.createElement("div");
      gutter.className = `fp-tl-month ${seasonOfMonth(month)}${month === 0 ? " year-start" : ""}`;
      gutter.style.gridRow = String(row);
      gutter.style.gridColumn = "1";
      gutter.title = `${MONTH_SHORT[month]} Year ${year}`;
      gutter.innerHTML = month === 0
        ? `<span class="fp-tl-year">Y${year}</span><span class="fp-tl-mname">${MONTH_SHORT[month]}</span>`
        : `<span class="fp-tl-mname">${MONTH_SHORT[month]}</span>`;
      grid.appendChild(gutter);

      for (const kind of columns) {
        const task = taskFor.get(kind);
        const here = !!task && task.at.includes(abs);
        const cell = document.createElement("div");
        cell.className = "fp-tl-cell" + (inGround ? " in-ground" : "");
        cell.style.gridRow = String(row);
        cell.style.gridColumn = String(colOf(kind));

        // AVAILABLE months are drawn always, not on click (maintainer request)
        // — so moving a task is one click on the month you want, and the whole
        // select-then-place step disappears.
        if (task && !here && task.on && task.scheduleType && task.legal.includes(abs)) {
          const scheduleType = task.scheduleType;
          const plantMonth = task.plantMonth;
          cell.classList.add("legal");
          cell.title = `Move ${TL_TASK_LABEL[kind]} to ${MONTH_SHORT[month]} Y${year}`;
          const apply = (): void => {
            try {
              setScheduleOverride(plan, scheduleType, month, plantMonth);
              msg.textContent = "";
              editPlans();
            } catch (err) {
              msg.textContent = (err as Error).message;
            }
          };
          cell.addEventListener("click", apply);
          cell.addEventListener("dragover", (e) => {
            if (draggingScheduleCell?.kind !== kind) return;
            e.preventDefault();
            cell.classList.add("drag-over");
          });
          cell.addEventListener("dragleave", () => cell.classList.remove("drag-over"));
          cell.addEventListener("drop", (e) => {
            e.preventDefault();
            cell.classList.remove("drag-over");
            if (draggingScheduleCell?.kind !== kind) return;
            apply();
          });
        }
        grid.appendChild(cell);
      }

      // Chips: this month's tasks, each in its own column.
      for (const task of band.tasks) {
        if (!task.at.includes(abs)) continue;
        const chip = document.createElement("div");
        const movable = task.legal.length > 0 && task.on && !!task.scheduleType;
        chip.className = "fp-tl-chip" + (task.on ? "" : " off") + (movable ? " movable" : "");
        chip.style.gridRow = String(row);
        chip.style.gridColumn = String(colOf(task.kind));
        chip.textContent = TL_TASK_ICON[task.kind] ?? "•";
        const name = TL_TASK_LABEL[task.kind] ?? task.kind;
        // OPTIONAL operations are switched on and off from their own chip
        // (maintainer request) — the toggle strip that used to live on the
        // crop header is gone.
        if (task.toggle) {
          const toggle = task.toggle;
          chip.title = task.on
            ? `${name} — ${MONTH_SHORT[month]} Y${year} · click to turn OFF${movable ? ", drag to move" : ""}`
            : `${name} is off — click to turn it on`;
          chip.addEventListener("click", () => {
            plan[toggle] = !plan[toggle];
            editPlans();
          });
        } else {
          chip.title = `${name} — ${MONTH_SHORT[month]} Y${year}`
            + (movable ? " · drag, or click an available month" : " · fixed timing");
        }
        if (movable) {
          chip.draggable = true;
          chip.addEventListener("dragstart", () => {
            draggingScheduleCell = { planIdx: band.planIdx, kind: task.kind };
            chip.classList.add("dragging");
          });
          chip.addEventListener("dragend", () => {
            draggingScheduleCell = null;
            chip.classList.remove("dragging");
          });
        }
        grid.appendChild(chip);
      }

      monthRows.push({ abs, row });
      row++;
    }
  }

  // --- Today: a line across the whole grid. Lands ON its month where the
  //     rotation covers it, and at the top edge of the next month drawn where
  //     today falls in a fallow gap between blocks. ---
  const exact = monthRows.find((r) => r.abs === timeline.todayAbs);
  const marker = exact ?? monthRows.find((r) => r.abs > timeline.todayAbs);
  if (marker) {
    const line = document.createElement("div");
    line.className = "fp-tl-today" + (exact ? "" : " gap");
    line.style.gridRow = String(marker.row);
    line.style.gridColumn = "1 / -1";
    line.title = exact ? "Today" : "Today — the field is between crops";
    grid.appendChild(line);
    // ONE-TIME scroll to today when the panel opens on a field. Re-running it
    // on every re-render yanked the view away whenever a task was clicked.
    if (tlScrolledFieldId !== field.id) {
      tlScrolledFieldId = field.id;
      const target = line;
      requestAnimationFrame(() => {
        scroller.scrollTop = Math.max(0, target.offsetTop - scroller.clientHeight / 2);
      });
    }
  }

  // --- Add a crop (perennial stands don't rotate) ---
  if (!perennialField) {
    const add = document.createElement("button");
    add.className = "fp-tl-add";
    add.textContent = "＋ Add a crop";
    add.disabled = plans.length >= 5;
    add.title = plans.length >= 5 ? "A rotation holds at most 5 crops" : "Add another crop to the rotation";
    add.addEventListener("click", () => {
      if (plans.length >= 5) return;
      // Default the new step to a DIFFERENT, non-perennial crop for an easy rotation.
      const crops = (Object.keys(gameConfig.crops) as CropId[]).filter((c) => !gameConfig.crops[c].perennial);
      const nextCrop = crops.find((c) => c !== plans[plans.length - 1]!.crop) ?? crops[0]!;
      plans.push({ crop: nextCrop, bale: cropMakesBales(nextCrop) });
      editPlans();
    });
    host.appendChild(add);
  }

  // --- Reset overrides across every step (shares a row with Queue Plow) ---
  resetHost.innerHTML = "";
  const def = document.createElement("button");
  def.className = "fp-sched-defaults";
  def.textContent = "↺ Auto timing";
  def.title = "Clear every month override on this rotation — each task goes back to its earliest natural time";
  def.disabled = !plans.some((p) => p.schedule && Object.keys(p.schedule).length > 0);
  def.addEventListener("click", () => {
    for (const p of plans) p.schedule = {};
    msg.textContent = "";
    editPlans();
  });
  resetHost.appendChild(def);
}

/** Field Finances tab: per-field multi-year profit & loss, mirroring the
 * global Finance tab's cashflow table but scoped to one field and only 2
 * categories (Expenses/Revenue — this field ledger has no Land & Equipment/
 * Loan Expenses analog, those are whole-farm concepts). Revenue is modeled at
 * production time (see sim/fieldLedger.ts's doc comment for why that's exact,
 * not an approximation, under this game's flat-price economy). */
let lastFieldFinKey = "";
/** The body-portaled tooltip for the field-panel Finances table. Lives in
 * <body> (not inside the cell) so it clears the panel's overflow clip and the
 * #fieldpanel transform that would trap a position:fixed descendant. Reused
 * across hovers; shows visually as a `.cf-tip`. */
function fieldFinTipEl(): HTMLElement {
  let el = document.getElementById("fp-cf-tip-float");
  if (!el) {
    el = document.createElement("div");
    el.id = "fp-cf-tip-float";
    el.className = "cf-tip";
    el.style.position = "fixed";
    document.body.appendChild(el);
  }
  return el;
}
function showFieldFinTip(cell: HTMLElement, html: string): void {
  const el = fieldFinTipEl();
  el.innerHTML = html;
  const r = cell.getBoundingClientRect();
  // Anchor the tip's bottom-left to the cell's top-left → opens up and right.
  el.style.right = "auto";
  el.style.left = `${r.left}px`;
  el.style.bottom = `${window.innerHeight - r.top + 4}px`;
  el.style.display = "block";
}
function hideFieldFinTip(): void {
  const el = document.getElementById("fp-cf-tip-float");
  if (el) el.style.display = "none";
}

function refreshFieldFinancesTab(field: Field, force: boolean): void {
  const key = `${field.id}|${save.finance.openYear}|${JSON.stringify(save.fieldLedger?.[field.id] ?? {})}`;
  if (!force && key === lastFieldFinKey) return;
  lastFieldFinKey = key;
  hideFieldFinTip(); // the table's about to be rebuilt — drop any stale hover tip

  const body = $("fp-finances-body");
  body.innerHTML = `<div class="small">Revenue is booked at harvest, at the base price of what came off the field.</div>`;

  const table = document.createElement("div");
  table.className = "cf-table";
  table.insertAdjacentHTML(
    "beforeend",
    `<div class="cf-row fp-cf-row cf-head"><div>Year</div><div>Expenses</div><div>Revenue</div><div>Net</div></div>`,
  );
  for (const year of fieldLedgerYears(save, field.id)) {
    const y = save.fieldLedger?.[field.id]?.[year];
    const row = document.createElement("div");
    row.className = "cf-row fp-cf-row" + (year === save.finance.openYear ? " current" : "");
    const crop = y?.crop;
    const cropHtml = crop ? `<div class="cf-crop">${gameConfig.crops[crop].emoji} ${gameConfig.crops[crop].name}</div>` : "";
    row.insertAdjacentHTML("beforeend", `<div class="cf-year">Yr ${year}${year === save.finance.openYear ? " ·" : ""}${cropHtml}</div>`);
    for (const cat of ["expenses", "revenue"] as const) {
      const total = fieldCategoryTotal(y, cat);
      const cell = document.createElement("div");
      cell.className = "cf-cell" + (total < 0 ? " neg" : total > 0 ? " pos" : "");
      cell.textContent = cfAmount(total);
      const items = Object.entries(y?.[cat] ?? {}).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
      if (items.length > 0) {
        // Portaled to <body> (not appended to the cell) so it escapes .fp-main's
        // overflow clip AND #fieldpanel's transform, which would otherwise trap
        // a position:fixed child. Opens up and to the LEFT of the cell.
        const tipHtml =
          `<div class="cf-tip-title">${cat === "expenses" ? "Expenses" : "Revenue"} · Yr ${year}</div>` +
          items.map(([n, v]) => `<div class="cf-tip-row"><span>${n}</span><span class="${v < 0 ? "neg" : "pos"}">${cfAmount(v)}</span></div>`).join("");
        cell.addEventListener("mouseenter", () => showFieldFinTip(cell, tipHtml));
        cell.addEventListener("mouseleave", hideFieldFinTip);
      }
      row.appendChild(cell);
    }
    const net = fieldNetCashflow(y);
    row.insertAdjacentHTML("beforeend", `<div class="cf-cell cf-net ${net < 0 ? "neg" : net > 0 ? "pos" : ""}">${cfAmount(net)}</div>`);
    table.appendChild(row);
  }
  body.appendChild(table);
}

/** Field Settings tab: misc field-level settings — for now, just the
 * access-point editor (moved verbatim from the old refreshFieldPanel tail;
 * startAccessEdit/stopAccessEdit need no changes, they're driven by
 * accessEditFieldId module state, not by where this button's markup lives). */
let lastSettingsKey = "";
function refreshFieldSettingsTab(field: Field, force: boolean): void {
  const editing = accessEditFieldId === field.id;
  const key = [field.id, editing ? 1 : 0].join("|");
  if (!force && key === lastSettingsKey) return;
  lastSettingsKey = key;

  const body = $("fp-settings-body");
  body.innerHTML = "";
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
  body.appendChild(row);
}

function prettyId(id: string): string {
  return id.replace("-", " ").replace(/^\w/, (c) => c.toUpperCase());
}

function fieldLabel(field: Field): string {
  return field.name || prettyId(field.id);
}

/**
 * A field's display name from its ID alone.
 *
 * The Work Queue, the blocked-work rows, the Completed feed and the machine
 * status lines all only have a `fieldId` to hand, and each of them used to
 * render `prettyId(fieldId)` directly — the RAW id, ignoring `field.name`. So
 * the moment a field was renamed, the badge and panel said one thing and the
 * queue said "Field 3" (maintainer bug report, 2026-07-24: "Field Numbers are
 * getting out of sync in Field Badge/Panel and Work Queue"). Everything goes
 * through here now, so there's one answer to what a field is called.
 *
 * Falls back to the prettified id for a field that's since been sold — a
 * completed-task row outlives the field it happened on.
 */
function fieldLabelOf(fieldId: string | undefined): string {
  const field = fieldId ? save.fields.find((f) => f.id === fieldId) : undefined;
  return field ? fieldLabel(field) : prettyId(fieldId ?? "");
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

// ---------------------------------------------------------------------------
// Boot (2026-07-26): the home screen (main menu) shows every launch, BEFORE
// the map/county load. Picking the already-active farm resolves the menu and
// falls through to main(); any other choice reloads the page with the
// AUTOBOOT flag set, and the reloaded boot skips the menu.
// ---------------------------------------------------------------------------
/** Set once main() gets past the county load — a failure AFTER this point is
 * a mid-boot crash (map, wiring), where re-showing the menu and running
 * main() a second time would double-initialize everything. */
let mainStarted = false;

async function boot(): Promise<void> {
  // Consume the flag BEFORE any await — a crash later can never leave a stale
  // flag that would skip the menu on the next real launch (sessionStorage is
  // per-tab, so other tabs are unaffected either way).
  const target = sessionStorage.getItem(AUTOBOOT_KEY);
  sessionStorage.removeItem(AUTOBOOT_KEY);
  // Show the menu unless this reload explicitly targeted the farm that is in
  // fact active now (a flag for a DIFFERENT id means the farm was deleted or
  // switched in another tab between reloads — the menu sorts that out).
  if (target !== activeFarm.id) {
    await runHomeScreen({ activeFarmId: activeFarm.id });
  }
  try {
    await main();
  } catch (err) {
    console.error(err);
    if (mainStarted) {
      // Mid-boot crash after the county loaded — don't re-run main().
      devStatus("status-naip", "Boot failed: " + (err as Error).message, "err");
      return;
    }
    // County load/build failed (bad network, Overpass down). Re-offer the
    // menu with the error shown; picking this farm again retries main().
    await runHomeScreen({
      activeFarmId: activeFarm.id,
      error: (err as Error).message,
    });
    await main();
  }
}

boot().catch((err) => {
  devStatus("status-naip", "Failed to start: " + (err as Error).message, "err");
  console.error(err);
});
