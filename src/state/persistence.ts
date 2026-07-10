/**
 * Save/load — the game persists across refreshes (brief §2).
 *
 * v1: localStorage with a versioned key. The whole save is a few KB of JSON
 * (parcels/fields as meter coordinates), so localStorage is plenty; we can move
 * to IndexedDB (the brief's eventual choice) behind these same two functions if
 * saves ever outgrow it. The clock time and the mid-harvest field set live
 * alongside the SaveState so a refresh drops you exactly where you were.
 */

import type { SaveState } from "./saveState";
import type { SimTime } from "../sim/clock";

const KEY = "farm-sim-save-v1";

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

export function persistGame(game: PersistedGame): void {
  localStorage.setItem(KEY, JSON.stringify(game));
}

export function loadGame(): PersistedGame | null {
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    const game = JSON.parse(raw) as PersistedGame;
    // Minimal sanity check; a corrupt/old-shape save starts fresh rather than crashing.
    if (typeof game.clockNow !== "number" || !Array.isArray(game.save?.fields)) return null;
    return game;
  } catch {
    return null;
  }
}

/** Delete the save (the Reset button). Caller reloads the page after. */
export function clearSavedGame(): void {
  localStorage.removeItem(KEY);
}
