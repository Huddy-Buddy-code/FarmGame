/**
 * Farming sim (brief §12 step 3, §6, §10) — plant, grow, harvest.
 *
 * Pure game logic on the save-state + sim clock: no map, no DOM, no I/O, so it's
 * unit-testable. Rendering reacts to what this module does (main.ts repaints a
 * field's overlay texture when its status changes).
 *
 * The crux mechanic (brief §6): yield is genuinely uncertain but TRANSPARENT. The
 * true yield is rolled at planting and hidden; the player sees a confidence range
 * that starts wide and NARROWS as harvest approaches, always containing the truth.
 * Randomness around a visible narrowing estimate = fair gambling.
 */

import { gameConfig } from "../config/gameConfig";
import type { CropId } from "../config/gameConfig";
import type { SimTime } from "./clock";
import { MINUTES_PER_DAY, dateOf } from "./calendar";
import type { SaveState, Field, FieldStatus } from "../state/saveState";
import { areaAcres } from "../geo/geometry";

/** Is `crop` plantable in the month containing `t`? */
export function inPlantingWindow(crop: CropId, t: SimTime): boolean {
  return gameConfig.crops[crop].plantMonths.includes(dateOf(t).month);
}

/**
 * Plant `crop` on `field`: pay inputs per acre, roll the hidden true yield, and
 * start the growth clock. Throws with a player-facing message if not allowed.
 */
export function plant(save: SaveState, field: Field, crop: CropId, now: SimTime, rand: () => number = Math.random): void {
  const cfg = gameConfig.crops[crop];
  if (field.status !== "stubble" && field.status !== "harvested") {
    throw new Error(`${field.id} isn't ready to plant (status: ${field.status})`);
  }
  if (!inPlantingWindow(crop, now)) {
    throw new Error(`${cfg.name} can't be planted this month`);
  }
  const acres = areaAcres(field.boundary);
  const cost = Math.round(acres * cfg.inputCostPerAcre);
  if (cost > save.money) {
    throw new Error(`Inputs cost $${cost.toLocaleString()} — not enough cash`);
  }
  save.money -= cost;
  field.crop = crop;
  field.plantedAt = now;
  // The gamble (brief §6): true yield lands uniformly inside ±uncertainty of base.
  const u = cfg.yieldUncertainty;
  field.trueYieldTonsPerAcre = cfg.baseYieldTonsPerAcre * (1 - u + rand() * 2 * u);
  field.harvestedAcres = 0;
  field.status = "planted";
}

/** Growth progress 0..1 (1 = harvest-ready). 0 if nothing is growing. */
export function growthProgress(field: Field, now: SimTime): number {
  if (field.plantedAt === undefined || !field.crop) return 0;
  const growMinutes = gameConfig.crops[field.crop].growDays * MINUTES_PER_DAY;
  return Math.min(1, (now - field.plantedAt) / growMinutes);
}

/**
 * The VISIBLE yield range in tons/acre — wide at planting, narrowing toward the
 * hidden true value as harvest approaches (brief §6). Always contains the truth.
 */
export function yieldRange(field: Field, now: SimTime): { low: number; high: number } | null {
  if (!field.crop || field.trueYieldTonsPerAcre === undefined) return null;
  const cfg = gameConfig.crops[field.crop];
  const progress = growthProgress(field, now);
  const fullHalf = cfg.baseYieldTonsPerAcre * cfg.yieldUncertainty;
  const half = fullHalf * (1 - progress * gameConfig.yieldRangeNarrowing);
  const t = field.trueYieldTonsPerAcre;
  // Center drifts from base toward truth so the band both narrows AND homes in,
  // while the truth always stays inside it.
  const center = cfg.baseYieldTonsPerAcre + (t - cfg.baseYieldTonsPerAcre) * progress;
  const low = Math.max(0, Math.min(center - half, t));
  const high = Math.max(center + half, t);
  return { low, high };
}

/** Field status as derived from growth/harvest state. Pure function of the field. */
export function deriveStatus(field: Field, now: SimTime): FieldStatus {
  if (!field.crop || field.plantedAt === undefined) return field.status;
  const p = growthProgress(field, now);
  if (p >= 1) return "ready";
  if (p >= 0.15) return "growing";
  return "planted";
}

export interface TickResult {
  /** Fields whose visible status changed this tick (repaint their textures). */
  changed: Field[];
}

/**
 * Advance all field lifecycles to `now`. Growth is derived (cheap); harvesting
 * accrues acres for any field the player has set harvesting on.
 */
export function tickFarming(save: SaveState, now: SimTime, dtMinutes: number): TickResult {
  const changed: Field[] = [];
  for (const field of save.fields) {
    const before = field.status;

    if (harvesting.has(field.id) && field.crop && field.trueYieldTonsPerAcre !== undefined) {
      const acres = areaAcres(field.boundary);
      const rate = gameConfig.harvestAcresPerDay / MINUTES_PER_DAY; // acres per sim-minute
      const cut = Math.min(acres - (field.harvestedAcres ?? 0), rate * dtMinutes);
      field.harvestedAcres = (field.harvestedAcres ?? 0) + cut;
      save.grain[field.crop] += cut * field.trueYieldTonsPerAcre;
      if (field.harvestedAcres >= acres) {
        harvesting.delete(field.id);
        field.status = "harvested";
        field.crop = undefined;
        field.plantedAt = undefined;
        field.trueYieldTonsPerAcre = undefined;
      }
    } else {
      field.status = deriveStatus(field, now);
    }

    if (field.status !== before) changed.push(field);
  }
  return { changed };
}

/** Fields currently being harvested (session-scoped; not saved — v1). */
const harvesting = new Set<string>();

/** Begin harvesting a ready field. Throws a player-facing message if not ready. */
export function startHarvest(field: Field, now: SimTime): void {
  if (deriveStatus(field, now) !== "ready") {
    throw new Error(`${field.id} isn't ready to harvest yet`);
  }
  harvesting.add(field.id);
}

export function isHarvesting(field: Field): boolean {
  return harvesting.has(field.id);
}

/** For persistence: which fields are mid-harvest. */
export function getHarvestingIds(): string[] {
  return [...harvesting];
}

/** For persistence: restore the mid-harvest set from a loaded save. */
export function restoreHarvesting(ids: string[]): void {
  harvesting.clear();
  for (const id of ids) harvesting.add(id);
}
