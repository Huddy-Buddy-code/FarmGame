/**
 * Save/load — the game persists across refreshes (brief §2), and now across
 * multiple independent FARMS (maintainer request, 2026-07-13: a Settings tab
 * to create/load/delete separate campaigns).
 *
 * v1 was a single localStorage key holding one save. v2 keeps that same
 * "small JSON blob in localStorage" approach (still just a few KB per farm)
 * but adds an INDEX key listing every farm (id/name/timestamps) plus one
 * save-data key per farm. Exactly one farm is "active" at a time — that's
 * the one `loadGame()`/`persistGame()` read/write, so the rest of the app
 * (main.ts) doesn't need to know multi-farm exists; it just always talks to
 * "the current save." Switching farms is a page reload (same pattern the
 * existing Reset button already used), which keeps every module-level `let`
 * elsewhere in the codebase (clock, calendar pace, id counters, ...) correct
 * without a teardown/reinit path.
 *
 * A v1 single-slot save (from before farms existed) is migrated in-place on
 * first load into a farm named "Farm 1" and set active.
 */

import type { SaveState } from "./saveState";
import type { SimTime } from "../sim/clock";

const LEGACY_KEY = "farm-sim-save-v1";
const INDEX_KEY = "farm-sim-index-v1";
const FARM_KEY_PREFIX = "farm-sim-farm-v1:";

export interface PersistedGame {
  save: SaveState;
  clockNow: SimTime;
  /** Legacy (pre-task-queue saves): fields that were mid-harvest. New saves
   * don't write this — in-progress work lives in save.tasks now. */
  harvestingIds?: string[];
  /** Calendar pace knob (brief-adjacent, player-adjustable — see calendar.ts).
   * Optional so saves from before this setting existed still load: absent means
   * "use the default" rather than a corrupt save. */
  daysPerMonth?: number;
}

export interface FarmMeta {
  id: string;
  name: string;
  /** Date.now() ms — for sorting/display in the Settings tab. */
  createdAt: number;
  updatedAt: number;
}

interface FarmIndex {
  activeId: string | null;
  farms: FarmMeta[];
}

function farmKey(id: string): string {
  return FARM_KEY_PREFIX + id;
}

function readIndex(): FarmIndex {
  const raw = localStorage.getItem(INDEX_KEY);
  if (raw) {
    try {
      const idx = JSON.parse(raw) as FarmIndex;
      if (Array.isArray(idx.farms)) return idx;
    } catch {
      /* fall through to a fresh index below */
    }
  }
  // No index yet: migrate a legacy single-slot save, if there is one.
  const legacy = localStorage.getItem(LEGACY_KEY);
  if (legacy) {
    const id = "farm-1";
    localStorage.setItem(farmKey(id), legacy);
    localStorage.removeItem(LEGACY_KEY);
    const now = Date.now();
    const idx: FarmIndex = { activeId: id, farms: [{ id, name: "Farm 1", createdAt: now, updatedAt: now }] };
    writeIndex(idx);
    return idx;
  }
  return { activeId: null, farms: [] };
}

function writeIndex(idx: FarmIndex): void {
  localStorage.setItem(INDEX_KEY, JSON.stringify(idx));
}

let nextSeq = 1;
function freshFarmId(idx: FarmIndex): string {
  while (idx.farms.some((f) => f.id === `farm-${nextSeq}`)) nextSeq++;
  return `farm-${nextSeq++}`;
}

/** Every farm, most-recently-played first. */
export function listFarms(): FarmMeta[] {
  return [...readIndex().farms].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The id of the farm `loadGame()`/`persistGame()` operate on, or null if
 * none exists yet (fresh install — `ensureActiveFarm()` fixes this up). */
export function getActiveFarmId(): string | null {
  return readIndex().activeId;
}

export function getFarmMeta(id: string): FarmMeta | undefined {
  return readIndex().farms.find((f) => f.id === id);
}

/** Guarantee an active farm exists (fresh install, or every farm got
 * deleted) — creates "Farm 1" and activates it. Idempotent. Call once at
 * boot before `loadGame()`. */
export function ensureActiveFarm(): FarmMeta {
  const idx = readIndex();
  if (idx.activeId && idx.farms.some((f) => f.id === idx.activeId)) {
    return idx.farms.find((f) => f.id === idx.activeId)!;
  }
  const meta = registerFarm(idx, "Farm 1");
  idx.activeId = meta.id;
  writeIndex(idx);
  return meta;
}

function registerFarm(idx: FarmIndex, name: string): FarmMeta {
  const now = Date.now();
  const meta: FarmMeta = { id: freshFarmId(idx), name, createdAt: now, updatedAt: now };
  idx.farms.push(meta);
  return meta;
}

/** Create a new, empty farm (no save data — the caller's `newGame()` writes
 * the first `persistGame()` once play starts) and make it active. Caller
 * reloads the page afterward, same pattern as Reset. */
export function createFarm(name: string): FarmMeta {
  const idx = readIndex();
  const trimmed = name.trim();
  const meta = registerFarm(idx, trimmed || `Farm ${idx.farms.length + 1}`);
  idx.activeId = meta.id;
  writeIndex(idx);
  return meta;
}

/** Rename a farm (metadata only — doesn't touch its save data). */
export function renameFarm(id: string, name: string): void {
  const idx = readIndex();
  const meta = idx.farms.find((f) => f.id === id);
  if (!meta) throw new Error(`Farm ${id} not found`);
  const trimmed = name.trim();
  if (trimmed) meta.name = trimmed;
  writeIndex(idx);
}

/** Switch which farm is active. Caller reloads the page afterward — every
 * other module's state (clock, calendar pace, id counters) is only correct
 * for a fresh boot against the new save. */
export function switchFarm(id: string): void {
  const idx = readIndex();
  if (!idx.farms.some((f) => f.id === id)) throw new Error(`Farm ${id} not found`);
  idx.activeId = id;
  writeIndex(idx);
}

/**
 * Delete a farm entirely (meta + save data). If it was the active farm,
 * activates the next most-recently-played remaining farm, or creates a
 * fresh "Farm 1" if none are left — so there's always an active farm for
 * the caller to reload into. Returns the id that's active afterward.
 */
export function deleteFarm(id: string): string {
  const idx = readIndex();
  idx.farms = idx.farms.filter((f) => f.id !== id);
  localStorage.removeItem(farmKey(id));
  if (idx.activeId === id) {
    const next = [...idx.farms].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    idx.activeId = next ? next.id : null;
  }
  writeIndex(idx);
  return ensureActiveFarm().id;
}

/** Read a specific farm's save without switching active (for the Settings
 * tab's summary line — cash/acres/date — on farms you aren't currently
 * playing). Null if that farm has never been saved yet (brand new). */
export function loadGameFor(id: string): PersistedGame | null {
  const raw = localStorage.getItem(farmKey(id));
  if (!raw) return null;
  try {
    const game = JSON.parse(raw) as PersistedGame;
    if (typeof game.clockNow !== "number" || !Array.isArray(game.save?.fields)) return null;
    return game;
  } catch {
    return null;
  }
}

export function persistGame(game: PersistedGame): void {
  const idx = readIndex();
  const id = idx.activeId;
  if (!id) return; // no active farm yet — ensureActiveFarm() wasn't called
  localStorage.setItem(farmKey(id), JSON.stringify(game));
  const meta = idx.farms.find((f) => f.id === id);
  if (meta) {
    meta.updatedAt = Date.now();
    writeIndex(idx);
  }
}

export function loadGame(): PersistedGame | null {
  const id = readIndex().activeId;
  return id ? loadGameFor(id) : null;
}

/** Wipe the ACTIVE farm's save data (the Reset button) — keeps its name/id,
 * just like starting that same campaign over. Caller reloads the page after. */
export function clearSavedGame(): void {
  const id = readIndex().activeId;
  if (id) localStorage.removeItem(farmKey(id));
}
