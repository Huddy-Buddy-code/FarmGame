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
import { buyFieldFromBoundary, renderField, initIdCounters, sellField, hashSeed } from "./field/fields";
import { drawFieldTexture } from "./field/fieldRender";
import { distanceAtWork } from "./sim/coverage";
import type { CoveragePath } from "./sim/coverage";
import { persistGame, loadGame, clearSavedGame } from "./state/persistence";
import { sellGrain } from "./sim/economy";
import { SimClock } from "./sim/clock";
import {
  formatDate, dateOf, MONTH_NAMES, MONTH_SHORT,
  START_MONTH, MONTHS_PER_YEAR, MINUTES_PER_DAY,
  getDaysPerMonth, setDaysPerMonth, minutesPerMonth,
} from "./sim/calendar";
import {
  tickFarming, growthProgress, yieldRange, inPlantingWindow, canPlow,
} from "./sim/farming";
import {
  ensureAgents, initTaskIds, enqueueTask, cancelTask, taskCost, tasksFor,
  isFieldHarvesting, effectiveStatus, tickTasks, autoManageAll, autoManageField,
  buyAgent, sellAgent, buyImplement, sellImplement, attachImplement, detachImplement,
  agentPrice, implementPrice, canPull, implementName, getCoveragePath,
} from "./sim/tasks";
import type { EquipmentKind } from "./sim/tasks";
import type { FarmTask, Agent, FieldStatus } from "./state/saveState";
import { gameConfig } from "./config/gameConfig";
import type { CropId, EquipmentSize } from "./config/gameConfig";

// Which county to play. Later this comes from a save / county picker.
const COUNTY_ID = "story-ia";

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
type Mode = "none" | "field";
let mode: Mode = "none";

let overlay: OverlayEngine;
let mapRef: maplibregl.Map;
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
    wireEquipTab();
    wirePersistence();
    // Re-render every field from the loaded save (textures + outlines).
    for (const f of save.fields) renderField(map, overlay, f, clock.time());
    updateAgentMarkers();
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

/** A big row-crop tractor: large rear drive wheel, small front wheel, cab. */
function tractorIconSvg(size = 22): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <path d="M2 19a3 3 0 1 0 6 0 3 3 0 0 0-6 0Z" fill="#e0a63c" stroke="#6b4426" stroke-width="1"/>
    <path d="M2 19a3 3 0 1 0 6 0 3 3 0 0 0-6 0Z" fill="none" stroke="#4a3520" stroke-width="0.6" opacity="0.5"/>
    <circle cx="5" cy="19" r="1.1" fill="#4a3520"/>
    <circle cx="17" cy="19" r="1.6" fill="#4a3520"/>
    <path d="M14 19.6a3.6 3.6 0 1 0 7.2 0 3.6 3.6 0 0 0-7.2 0Z" fill="#e0a63c" stroke="#6b4426" stroke-width="1"/>
    <path d="M9 8h4.5l1.5 4h3.8a2 2 0 0 1 2 2v2.2h-3.2a3.6 3.6 0 0 0-7.1 0H10a3 3 0 0 0-5.8-1.1L3 15v-2.3L9 10Z" fill="#6da144" stroke="#55832f" stroke-width="1"/>
    <rect x="9.6" y="4" width="4.4" height="4.4" rx="0.6" fill="#6da144" stroke="#55832f" stroke-width="1"/>
    <rect x="10.4" y="4.7" width="2.8" height="2.4" rx="0.3" fill="#dff2ff" opacity="0.9"/>
    <rect x="16" y="6.5" width="1" height="4" fill="#4a3520"/>
  </svg>`;
}

/** A combine harvester: boxy cab/body with a wide grain header out front. */
function combineIconSvg(size = 22): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <path d="M1 15.5h4.5l1-2.2h4.8l0.6 2.2H15v3.3H1Z" fill="#e0a63c" stroke="#6b4426" stroke-width="1"/>
    <line x1="2.5" y1="13.6" x2="2.5" y2="18.4" stroke="#6b4426" stroke-width="0.8"/>
    <line x1="4.3" y1="13.6" x2="4.3" y2="18.4" stroke="#6b4426" stroke-width="0.8"/>
    <line x1="6.1" y1="13.6" x2="6.1" y2="18.4" stroke="#6b4426" stroke-width="0.8"/>
    <line x1="7.9" y1="13.6" x2="7.9" y2="18.4" stroke="#6b4426" stroke-width="0.8"/>
    <rect x="13.5" y="6.5" width="8" height="9.5" rx="1.2" fill="#6da144" stroke="#55832f" stroke-width="1"/>
    <rect x="14.6" y="8" width="3" height="3" rx="0.3" fill="#dff2ff" opacity="0.9"/>
    <circle cx="17.5" cy="19" r="3" fill="#4a3520"/>
    <circle cx="17.5" cy="19" r="1.9" fill="#e0a63c" stroke="#6b4426" stroke-width="0.8"/>
    <circle cx="21.2" cy="18.2" r="1.6" fill="#4a3520"/>
    <circle cx="21.2" cy="18.2" r="0.9" fill="#e0a63c"/>
  </svg>`;
}

const AGENT_ICON: Record<string, (size?: number) => string> = {
  tractor: tractorIconSvg,
  harvester: combineIconSvg,
};

/** Human verb for a task, present participle ("plowing Field 1"). */
function taskVerb(task: FarmTask): string {
  if (task.type === "plow") return "plowing";
  if (task.type === "plant") {
    const c = task.crop ? gameConfig.crops[task.crop] : null;
    return c ? `planting ${c.name.toLowerCase()}` : "planting";
  }
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
    // Rotate the glyph to the driving heading. The SVGs are drawn facing WEST
    // (front wheels / combine header on the left), and screen-y points down while
    // meters-north points up, so the CSS rotation is (π − heading): driving east
    // → 180°, north → 90° CW, etc.
    const glyph = el.querySelector<HTMLElement>(".agent-glyph");
    if (glyph && agent.heading !== undefined) glyph.style.transform = `rotate(${Math.PI - agent.heading}rad)`;
  }
  // Tear down markers for machines that were sold.
  for (const [id, marker] of agentMarkers) {
    if (!save.agents.some((a) => a.id === id)) {
      marker.remove();
      agentMarkers.delete(id);
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
  baked: HTMLCanvasElement;
  /** How far along the route (full-route meters) we've stamped so far. */
  lastDist: number;
}
const reveals = new Map<string, Reveal>(); // keyed by fieldId

function revealTargetStatus(task: FarmTask): FieldStatus {
  return task.type === "plow" ? "tilled" : task.type === "plant" ? "planted" : "harvested";
}

function updateReveals(): void {
  if (!overlay) return;
  // Which field each active task is working right now.
  const activeByField = new Map<string, FarmTask>();
  for (const t of save.tasks) if (t.status === "active") activeByField.set(t.fieldId, t);

  // Drop reveals whose task ended or changed; stop animating that surface.
  for (const [fid, r] of reveals) {
    const t = activeByField.get(fid);
    if (!t || t.id !== r.taskId) {
      overlay.get(fid)?.setAnimating(false);
      reveals.delete(fid);
    }
  }

  for (const [fid, task] of activeByField) {
    const agent = save.agents.find((a) => a.id === task.agentId);
    if (!agent || agent.state !== "working") continue; // reveal only while working
    const path = getCoveragePath(save, task);
    const field = save.fields.find((f) => f.id === fid);
    const surface = overlay.get(fid);
    if (!path || !field || !surface) continue;

    let r = reveals.get(fid);
    if (!r || r.taskId !== task.id) {
      const baked = document.createElement("canvas");
      baked.width = surface.canvas.width;
      baked.height = surface.canvas.height;
      const bctx = baked.getContext("2d");
      if (!bctx) continue;
      drawFieldTexture(bctx, baked.width, baked.height, (mtr) => surface.toPixel(mtr), field.boundary, {
        status: revealTargetStatus(task),
        crop: field.crop,
        progress: 0,
        seed: hashSeed(fid),
      });
      r = { taskId: task.id, baked, lastDist: 0 };
      reveals.set(fid, r);
      surface.setAnimating(true); // re-upload every frame while the sweep runs
    }

    // Reveal up to the swept in-field distance implied by how much is done.
    const revealWork = Math.min(path.totalWork, (task.doneAcres * ACRE_M2) / path.swath);
    const revealDist = distanceAtWork(path, revealWork);
    if (revealDist > r.lastDist + 1e-6) {
      stampReveal(surface, r.baked, path, r.lastDist, revealDist);
      r.lastDist = revealDist;
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

/** Rebuild the right-hand queue panel: each agent's status, then queued jobs. */
let lastQueueKey = "";
function refreshQueuePanel(): void {
  // Skip DOM churn when nothing visible changed (1% progress buckets animate).
  const key = save.agents
    .map((a) => `${a.id}:${a.state}:${a.taskId ?? ""}`)
    .concat(save.tasks.map((t) => `${t.id}:${t.status}:${Math.round((t.doneAcres / t.totalAcres) * 100)}`))
    .join("|");
  if (key === lastQueueKey) return;
  lastQueueKey = key;

  const agentsEl = $("agents-rows");
  agentsEl.innerHTML = "";
  for (const agent of save.agents) {
    const task = agent.taskId ? save.tasks.find((t) => t.id === agent.taskId) : undefined;
    let status = "Idle — waiting for work";
    let pct: number | null = null;
    if (task && agent.state === "traveling") status = `Driving to ${prettyId(task.fieldId)}…`;
    else if (task && agent.state === "working") {
      pct = (task.doneAcres / task.totalAcres) * 100;
      status = `${cap(taskVerb(task))} ${prettyId(task.fieldId)}`;
    }
    const row = document.createElement("div");
    row.className = "agent-row" + (agent.state === "idle" ? " idle" : "");
    row.innerHTML = `
      <span class="icon">${(AGENT_ICON[agent.kind] ?? tractorIconSvg)(18)}</span>
      <span class="ar-info">
        <div class="ar-name">${agent.name}</div>
        <div class="ar-status">${status}</div>
        ${pct !== null ? `<div class="progress"><div class="fill" style="width:${pct.toFixed(0)}%"></div></div>` : ""}
      </span>`;
    agentsEl.appendChild(row);
  }

  const rows = $("queue-rows");
  rows.innerHTML = "";
  if (save.tasks.length === 0) {
    rows.innerHTML = `<div class="queue-empty">No jobs queued — plow, plant, or harvest a field.</div>`;
    return;
  }
  for (const task of save.tasks) {
    const pct = (task.doneAcres / task.totalAcres) * 100;
    const icon =
      task.type === "plant" && task.crop
        ? gameConfig.crops[task.crop].emoji
        : task.type === "harvest"
          ? combineIconSvg(18)
          : tractorIconSvg(18);
    const row = document.createElement("div");
    row.className = "queue-row" + (task.status === "active" ? " active" : "");
    row.innerHTML = `
      <span class="icon">${icon}</span>
      <span class="qr-info">
        <div class="qr-name">${cap(taskVerb(task))} · ${prettyId(task.fieldId)}</div>
        <div class="qr-sub">${task.totalAcres.toFixed(0)} ac · ${
          task.status === "active" ? `${pct.toFixed(0)}% done` : "waiting"
        }</div>
        ${task.status === "active" ? `<div class="progress"><div class="fill" style="width:${pct.toFixed(0)}%"></div></div>` : ""}
      </span>`;
    if (task.status === "queued") {
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
    rows.appendChild(row);
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
  $("hud-corn").textContent = save.grain.corn.toFixed(1) + " t";
  $("hud-soy").textContent = save.grain.soybeans.toFixed(1) + " t";

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
  $("btn-equip").addEventListener("click", () => {
    const el = $("equiptab");
    const opening = el.style.display !== "block";
    el.style.display = opening ? "block" : "none";
    if (opening) refreshEquipTab(true);
  });
  $("equip-close").addEventListener("click", () => ($("equiptab").style.display = "none"));
}

/** Refresh after any fleet change: HUD cash, map dots, panels. */
function afterFleetChange(): void {
  updateHud();
  updateAgentMarkers();
  refreshEquipTab(true);
  refreshQueuePanel();
}

function agentStatusText(agent: Agent): { text: string; pct: number | null } {
  const task = agent.taskId ? save.tasks.find((t) => t.id === agent.taskId) : undefined;
  if (task && agent.state === "traveling") return { text: `Driving to ${prettyId(task.fieldId)}…`, pct: null };
  if (task && agent.state === "working") {
    return { text: `${cap(taskVerb(task))} ${prettyId(task.fieldId)}`, pct: (task.doneAcres / task.totalAcres) * 100 };
  }
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
        return `${a.id}:${a.state}:${pct}`;
      })
      .join("|") +
    "#" +
    save.implements.map((i) => `${i.id}:${i.attachedTo ?? ""}`).join("|") +
    `|$${Math.round(save.money)}`;
  if (!force && key === lastEquipKey) return;
  lastEquipKey = key;

  buildEquipShop();
  buildEquipFleet();
}

/** The "buy" shop: tractors & plows in each size, plus the combine. */
function buildEquipShop(): void {
  const shop = $("equip-shop");
  shop.innerHTML = "";

  const group = (label: string, iconSvg: string) => {
    const g = document.createElement("div");
    g.className = "shop-group";
    g.innerHTML = `<div class="shop-label"><span class="icon">${iconSvg}</span>${label}</div>`;
    shop.appendChild(g);
    return g;
  };

  const tractors = group("Tractors", tractorIconSvg(16));
  for (const size of SIZES) {
    const price = agentPrice("tractor", size);
    tractors.appendChild(
      buyButton(`${SIZE_LABEL[size]}`, price, () => {
        const a = buyAgent(save, "tractor", size, homePos);
        afterFleetChange();
        toast(`Bought ${a.name} — parked at the yard`);
      }),
    );
  }

  const plows = group("Plows", "🔧");
  for (const size of SIZES) {
    const price = implementPrice("plow", size);
    const ft = gameConfig.equipment.plow[size].widthFt;
    plows.appendChild(
      buyButton(`${SIZE_LABEL[size]} · ${ft}ft`, price, () => {
        const i = buyImplement(save, "plow", size);
        afterFleetChange();
        toast(`Bought ${implementName(save, i)} — parked in the yard`);
      }),
    );
  }

  const combine = group("Combine", combineIconSvg(16));
  const cprice = gameConfig.equipment.harvester.price;
  combine.appendChild(
    buyButton("Combine", cprice, () => {
      const a = buyAgent(save, "harvester", "medium", homePos);
      afterFleetChange();
      toast(`Bought ${a.name} — parked at the yard`);
    }),
  );
}

function buyButton(label: string, price: number, onBuy: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "shop-buy";
  btn.innerHTML = `${label}<span class="small">$${price.toLocaleString()}</span>`;
  btn.disabled = price > save.money;
  btn.addEventListener("click", () => {
    try {
      onBuy();
    } catch (err) {
      toast("❌ " + (err as Error).message, 3500);
    }
  });
  return btn;
}

/** The owned fleet: tractors (with a plow selector), the combine, and yard plows. */
function buildEquipFleet(): void {
  const rows = $("equip-rows");
  rows.innerHTML = "";

  for (const agent of save.agents) {
    const { text, pct } = agentStatusText(agent);
    const row = document.createElement("div");
    row.className = "equip-row";
    row.innerHTML = `
      <span class="icon">${(AGENT_ICON[agent.kind] ?? tractorIconSvg)(20)}</span>
      <span class="er-info">
        <div class="er-name">${agent.name}</div>
        <div class="er-status">${text}</div>
        ${pct !== null ? `<div class="progress"><div class="fill" style="width:${pct.toFixed(0)}%"></div></div>` : ""}
      </span>`;

    // Tractors get a plow selector (hitch/unhitch).
    if (agent.kind === "tractor") row.appendChild(plowSelector(agent));

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

  // Plows parked in the yard (unattached) — attached ones show on their tractor.
  for (const impl of save.implements) {
    if (impl.attachedTo) continue;
    const ft = gameConfig.equipment.plow[impl.size].widthFt;
    const refund = impl.purchaseCost ?? implementPrice(impl.kind, impl.size);
    const row = document.createElement("div");
    row.className = "equip-row implement";
    row.innerHTML = `
      <span class="icon">🔧</span>
      <span class="er-info">
        <div class="er-name">${implementName(save, impl)}</div>
        <div class="er-status">In the yard · ${ft} ft wide</div>
      </span>`;
    row.appendChild(
      iconButton("💰", `Sell · $${refund.toLocaleString()}`, false, () => {
        if (!confirm(`Sell ${implementName(save, impl)} for $${refund.toLocaleString()}?`)) return;
        const { refund: paid } = sellImplement(save, impl.id);
        afterFleetChange();
        toast(`💰 Sold for $${paid.toLocaleString()}`);
      }),
    );
    rows.appendChild(row);
  }
}

/** A <select> to hitch/unhitch a plow on `tractor` (its size class or smaller). */
function plowSelector(tractor: Agent): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "er-hitch";
  const attached = save.implements.find((i) => i.attachedTo === tractor.id && i.kind === "plow");
  const options = save.implements.filter(
    (i) => i.kind === "plow" && tractor.size && canPull(tractor.size, i.size) && (!i.attachedTo || i.id === attached?.id),
  );
  const sel = document.createElement("select");
  sel.className = "hitch-select";
  sel.disabled = tractor.state !== "idle";
  sel.title = tractor.state !== "idle" ? "Can't change implements mid-job" : "Hitch a plow";
  const none = new Option("— no plow —", "");
  none.selected = !attached;
  sel.add(none);
  for (const impl of options) {
    const ft = gameConfig.equipment.plow[impl.size].widthFt;
    const o = new Option(`${implementName(save, impl)} (${ft}ft)`, impl.id);
    if (impl.id === attached?.id) o.selected = true;
    sel.add(o);
  }
  sel.addEventListener("change", () => {
    try {
      if (sel.value === "") {
        if (attached) detachImplement(save, attached.id);
      } else {
        attachImplement(save, tractor.id, sel.value);
      }
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
// Persistence: auto-save + the Reset button.
// ---------------------------------------------------------------------------
let resetting = false;

function doSave() {
  if (resetting) return; // a reset is wiping the save — don't write it back
  persistGame({ save, clockNow: clock.time(), daysPerMonth: getDaysPerMonth() });
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

/** Queue a task from a panel button, with shared feedback plumbing. */
function queueFromPanel(field: Field, type: "plow" | "plant" | "harvest", crop?: CropId): void {
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
  ].join("|");
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

  if (canPlow(eff)) {
    // --- Plow first (§10 lifecycle: stubble → tilled → planted) ---
    const cost = taskCost(field, "plow");
    if (auto) {
      body.insertAdjacentHTML("beforeend", `<div class="auto-note">🤖 Will queue plowing (needs $${cost.toLocaleString()})…</div>`);
    } else {
      body.insertAdjacentHTML("beforeend", `<div class="small" style="margin-top:8px">Plow to prepare for planting.</div>`);
      const btn = document.createElement("button");
      btn.className = "primary";
      btn.innerHTML = `🚜 Queue Plow <span class="small">$${cost.toLocaleString()}</span>`;
      btn.addEventListener("click", () => queueFromPanel(field, "plow"));
      actions.appendChild(btn);
    }
  }

  if (eff === "tilled") {
    if (auto) {
      body.insertAdjacentHTML("beforeend", `<div class="auto-note">🤖 Waiting for a planting window…</div>`);
    } else {
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
  }

  if (field.crop) {
    // --- Growing / ready / harvesting ---
    const cfg = gameConfig.crops[field.crop];
    const progress = growthProgress(field, now);
    const range = yieldRange(field, now);

    let html = `<div style="margin-top:8px">${cfg.emoji} <b>${cfg.name}</b></div>`;
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

    if (field.status === "ready" && tasksFor(save, field.id, "harvest").length === 0) {
      if (auto) {
        body.insertAdjacentHTML("beforeend", `<div class="auto-note">🤖 Harvest will be queued automatically…</div>`);
      } else {
        const btn = document.createElement("button");
        btn.className = "primary";
        btn.textContent = "🌾 Queue Harvest";
        btn.addEventListener("click", () => queueFromPanel(field, "harvest"));
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
