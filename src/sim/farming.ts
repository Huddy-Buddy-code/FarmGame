/**
 * Farming sim (brief §12 step 3, §6, §10) — crop growth + the field-state
 * primitives that fieldwork applies.
 *
 * Pure game logic on the save-state + sim clock: no map, no DOM, no I/O, so it's
 * unit-testable. Rendering reacts to what this module does (main.ts repaints a
 * field's overlay texture when its status changes).
 *
 * Plowing/planting/harvesting are no longer instant player actions: they are
 * TASKS an agent (tractor/combine) works through over realistic sim-hours — see
 * `tasks.ts`. This module keeps the growth model and the applyX primitives the
 * task system calls when work completes.
 *
 * The crux mechanic (brief §6): yield is genuinely uncertain but TRANSPARENT. The
 * true yield is rolled at planting and hidden; the player sees a confidence range
 * that starts wide and NARROWS as harvest approaches, always containing the truth.
 * Randomness around a visible narrowing estimate = fair gambling.
 */

import { gameConfig } from "../config/gameConfig";
import type { CropId } from "../config/gameConfig";
import type { SimTime } from "./clock";
import { minutesPerMonth, dateOf } from "./calendar";
import type { SaveState, Field, FieldStatus } from "../state/saveState";

/** Is `crop` plantable in the month containing `t`? */
export function inPlantingWindow(crop: CropId, t: SimTime): boolean {
  return gameConfig.crops[crop].plantMonths.includes(dateOf(t).month);
}

/** Can this field be plowed right now (status-wise)? */
export function canPlow(status: FieldStatus): boolean {
  return status === "stubble" || status === "harvested";
}

/**
 * Plow effect: stubble/harvested → tilled. Money is NOT handled here — the task
 * system charges the plow cost when the task is queued (pay-on-queue).
 */
export function applyPlow(field: Field): void {
  if (!canPlow(field.status)) {
    throw new Error(`${field.id} can't be plowed (status: ${field.status})`);
  }
  field.status = "tilled";
}

/**
 * Plant effect: roll the hidden true yield and start the growth clock. Requires
 * plowed (tilled) ground — the §10 lifecycle. Inputs were paid at queue time.
 */
export function applyPlant(field: Field, crop: CropId, now: SimTime, rand: () => number = Math.random): void {
  const cfg = gameConfig.crops[crop];
  if (field.status !== "tilled") {
    throw new Error(`Plow ${field.id} before planting (status: ${field.status})`);
  }
  field.crop = crop;
  field.plantedAt = now;
  // The gamble (brief §6): true yield lands uniformly inside ±uncertainty of base.
  const u = cfg.yieldUncertainty;
  field.trueYieldTonsPerAcre = cfg.baseYieldTonsPerAcre * (1 - u + rand() * 2 * u);
  field.harvestedAcres = 0;
  field.status = "planted";
}

/** Harvest-complete effect: back to bare ground, crop state cleared. */
export function applyHarvestDone(field: Field): void {
  field.status = "harvested";
  field.crop = undefined;
  field.plantedAt = undefined;
  field.trueYieldTonsPerAcre = undefined;
}

/** Growth progress 0..1 (1 = harvest-ready). 0 if nothing is growing.
 * Keyed to game-MONTHS (via minutesPerMonth), so the same crop ripens in the same
 * number of months — and thus the same season — whatever the days-per-month pace.
 *
 * Growth is measured from the START of the planting MONTH, not the exact plant
 * instant (maintainer request): since growMonths is a whole number, the crop hits
 * progress 1 on the 1st of the month `growMonths` later, no matter which day it
 * was actually seeded. Harvest thus becomes available on a month boundary, mirror-
 * ing how planting windows open on the 1st. */
export function growthProgress(field: Field, now: SimTime): number {
  if (field.plantedAt === undefined || !field.crop) return 0;
  const mpm = minutesPerMonth();
  const growMinutes = gameConfig.crops[field.crop].growMonths * mpm;
  const plantMonthStart = Math.floor(field.plantedAt / mpm) * mpm;
  return Math.min(1, (now - plantMonthStart) / growMinutes);
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
 * Advance all field GROWTH to `now` (planted → growing → ready). Fieldwork
 * (plow/plant/harvest) advances separately in `tickTasks` — call both each frame.
 */
export function tickFarming(save: SaveState, now: SimTime): TickResult {
  const changed: Field[] = [];
  for (const field of save.fields) {
    const before = field.status;
    field.status = deriveStatus(field, now);
    if (field.status !== before) changed.push(field);
  }
  return { changed };
}
