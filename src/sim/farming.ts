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
import type { CropId, BaleProduct } from "../config/gameConfig";
import type { SimTime } from "./clock";
import { minutesPerMonth, dateOf, MONTHS_PER_YEAR } from "./calendar";
import type { SaveState, Field, FieldStatus } from "../state/saveState";

/** Is `crop` a perennial forage crop (grass/alfalfa) — planted once, cut on
 * fixed monthly windows, never plowed/replanted? */
export function isPerennial(crop?: CropId): boolean {
  return !!crop && !!gameConfig.crops[crop].perennial;
}

/** How many of THIS campaign year's cuttings a perennial field has already
 * been mowed (0 if its stored count belongs to a prior year — the counter
 * resets when the year turns). */
function cutsThisYear(field: Field, now: SimTime): number {
  return field.cutYear === dateOf(now).year ? (field.cutsThisYear ?? 0) : 0;
}

/** What the field's bales are, for pricing + tint (2026-07-13). Reads the
 * crop's configured `baleProduct` (grass→hay, alfalfa→alfalfaHay); corn's crop
 * is already cleared by harvest time, so it falls back to corn stover. */
export function baleProductForField(field: Field): BaleProduct {
  const cfg = field.crop ? gameConfig.crops[field.crop] : undefined;
  return cfg?.baleProduct ?? "cornStover";
}

/** Bales dropped per acre for this field's product (corn 2.5, grass 1.5, …). */
export function balesPerAcreForField(field: Field): number {
  return gameConfig.baleProducts[baleProductForField(field)].balesPerAcre;
}

/** Winter months (Dec–Feb) — when a perennial stand goes dormant and its
 * texture browns off (2026-07-14). Matches the season bar's winter. */
const DORMANT_MONTHS = [11, 0, 1];

/** Is this a perennial stand in its dormant winter season (light-brown, dead-
 * grass look)? Purely a rendering cue — the stand is still alive and regrows
 * in spring. */
export function isPerennialDormant(field: Field, now: SimTime): boolean {
  return isPerennial(field.crop) && DORMANT_MONTHS.includes(dateOf(now).month);
}

/** Can a perennial stand be seeded on a field in this status? Ground must be
 * plowed first, same as an annual crop (maintainer request, 2026-07-16 — was
 * previously allowed straight onto stubble/mulched with no plow). */
export function canSeedPerennial(status: FieldStatus): boolean {
  return status === "tilled";
}

/** Is `crop` plantable in the month containing `t`? */
export function inPlantingWindow(crop: CropId, t: SimTime): boolean {
  return gameConfig.crops[crop].plantMonths.includes(dateOf(t).month);
}

/** Can this field be plowed right now (status-wise)? Bare stubble, freshly
 * harvested ground, or a baled/mulched field all take a plow. NOTE: a harvested
 * field that still owes forage (rake + bale) is gated separately — see
 * `forageDue` in tasks.ts — so this being true isn't the whole story. */
export function canPlow(status: FieldStatus): boolean {
  return status === "stubble" || status === "harvested" || status === "mulched";
}

/** Is `t` inside the plowing season (winter, `gameConfig.plowMonths`)?
 * Status-independent — combine with `canPlow` for the full check. */
export function inPlowWindow(t: SimTime): boolean {
  return gameConfig.plowMonths.includes(dateOf(t).month);
}

/** Does this field have a standing (not-yet-mature) crop in it? True for
 * planted/growing, false once it's ready/harvested or there's nothing in the
 * ground — the gate weeding and fertilizing share. */
export function hasStandingCrop(status: FieldStatus): boolean {
  return status === "planted" || status === "growing";
}

/** Whole months elapsed since `field` was planted, or null if it never was. */
function monthsSincePlanting(field: Field, now: SimTime): number | null {
  if (field.plantedAt === undefined) return null;
  const planted = dateOf(field.plantedAt);
  const cur = dateOf(now);
  return (cur.year - planted.year) * MONTHS_PER_YEAR + (cur.month - planted.month);
}

/** Weeding opens once the crop is actually GROWING (not just planted), two
 * months after planting (maintainer request, 2026-07-13 — previously a fixed
 * June-onward calendar window). */
export function inWeedingWindow(field: Field, now: SimTime): boolean {
  const m = monthsSincePlanting(field, now);
  return field.status === "growing" && m !== null && m >= 2;
}

/** Fertilizing opens once the crop is actually GROWING (not just planted),
 * the month after planting (maintainer request, 2026-07-13 — previously
 * allowed as soon as it was planted, before emergence). Perennials fertilize
 * on a fixed annual month (`fertilizeMonth`, April) instead — the stand's
 * long established, so "month after planting" doesn't apply. */
export function canFertilizeNow(field: Field, now: SimTime): boolean {
  if (!field.crop) return false;
  const cfg = gameConfig.crops[field.crop];
  if (cfg.perennial) {
    return field.status !== "ready" && dateOf(now).month === (cfg.fertilizeMonth ?? 3);
  }
  const m = monthsSincePlanting(field, now);
  return field.status === "growing" && m !== null && m >= 1;
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
  // Ground's been turned — any un-baled forage is gone. Bales already dropped in
  // the field (field.bales) stay put until sold (no collection mechanic yet).
  field.forageReady = undefined;
  field.windrowed = undefined;
}

/**
 * Plant effect: roll the hidden true yield and start the growth clock. Requires
 * plowed (tilled) ground — the §10 lifecycle. Inputs were paid at queue time.
 */
export function applyPlant(field: Field, crop: CropId, now: SimTime, rand: () => number = Math.random): void {
  const cfg = gameConfig.crops[crop];
  // Perennials (grass/alfalfa) need tilled ground too, same as annuals
  // (maintainer request, 2026-07-16).
  const okStatus = cfg.perennial ? canSeedPerennial(field.status) : field.status === "tilled";
  if (!okStatus) {
    throw new Error(cfg.perennial ? `${field.id} can't be seeded (status: ${field.status})` : `Plow ${field.id} before planting (status: ${field.status})`);
  }
  field.crop = crop;
  field.plantedAt = now;
  // The gamble (brief §6): true yield lands uniformly inside ±uncertainty of base.
  const u = cfg.yieldUncertainty;
  field.trueYieldTonsPerAcre = cfg.baseYieldTonsPerAcre * (1 - u + rand() * 2 * u);
  field.harvestedAcres = 0;
  field.status = "planted";
  // Fresh crop → a new season: let the auto-manager weed/fertilize once again,
  // and reset the weed cycle (a new flush can come with the new crop).
  field.autoWeedDone = undefined;
  field.autoFertDone = undefined;
  // A fresh crop cycle: re-arm the once-per-cycle auto mulch guard so the pass
  // can fire again after THIS crop's harvest. (residueMulched stays — it's the
  // boost this new crop earned from the previous cycle's mulch.)
  field.autoMulchDone = undefined;
  field.weedy = undefined;
  field.weeded = undefined;
  field.fertilized = undefined;
  field.lastCutProductivity = undefined;
  // Perennial: start this year's cutting count fresh.
  field.cutsThisYear = 0;
  field.cutYear = dateOf(now).year;
}

/** Mow-complete effect (2026-07-13) — the perennial "harvest": the field is
 * CUT, leaving forage to rake + bale, and this cutting is tallied. The stand
 * itself is untouched (crop/plantedAt stay) so it regrows for the next window. */
export function applyMowDone(field: Field, now: SimTime): void {
  const year = dateOf(now).year;
  if (field.cutYear !== year) {
    field.cutYear = year;
    field.cutsThisYear = 0;
    // A new year's cutting cycle — the fertilize boost/taper restarts, so
    // last year's fertilizing no longer applies until it's redone.
    field.fertilized = undefined;
  }
  field.cutsThisYear = (field.cutsThisYear ?? 0) + 1;
  field.forageReady = true;
  field.windrowed = undefined;
  field.status = "harvested";
}

/** Harvest-complete effect: back to bare ground, crop state cleared. A forage
 * crop (e.g. corn) leaves residue behind — flag it so the field owes a rake +
 * bale before it can be re-plowed (when the farm owns the gear). */
export function applyHarvestDone(field: Field): void {
  if (field.crop && gameConfig.crops[field.crop].producesForage) {
    field.forageReady = true;
    field.windrowed = undefined;
  }
  field.status = "harvested";
  // Remember what just came off — the next crop planted here compares against
  // this for the rotation yield bonus (productivityMultiplier).
  field.lastCrop = field.crop;
  field.crop = undefined;
  field.plantedAt = undefined;
  field.trueYieldTonsPerAcre = undefined;
  // Reset the yield boost — a fresh crop cycle starts at the default 100%.
  field.fertilized = undefined;
  // Consume the mulch bonus: it lifted THIS harvest (+7%); the next crop must
  // be mulched again to earn it.
  field.residueMulched = undefined;
}

/** Baling-complete effect: the windrows are gone and the field is left
 * clean/mulched. The bales themselves were dropped one at a time by the baler as
 * it worked (see `tasks.ts`) into `field.baleLocations`, and stay there until
 * sold — so this only settles the field status/flags. */
export function applyBaleDone(field: Field): void {
  // Record what the bales are (drives sale price + marker tint) while the crop
  // is still readable — for perennials it stays set, for corn it's already
  // cleared so this resolves to corn stover.
  field.baleProduct = baleProductForField(field);
  field.forageReady = undefined;
  field.windrowed = undefined;
  field.lastCutProductivity = undefined; // consumed by this bale run
  // Perennial: the stand regrows for its next cutting — never plowed under.
  // Annual (corn) residue: field settles to mulched, ready to re-plow.
  field.status = isPerennial(field.crop) ? "growing" : "mulched";
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
 * Live productivity multiplier applied to a field's actual output (maintainer
 * request, 2026-07-16 — no yield modifiers existed before this):
 *  - Weeds (`field.weedy`) cost a flat -10%.
 *  - Fertilizing adds +30% for an annual crop.
 *  - For a perennial stand, the +30% fertilize boost tapers 10 points with
 *    each cutting already taken this year — 130% → 120% → 110% → back to the
 *    default 100% once all of the year's cuttings are done. Re-fertilizing
 *    the following year restarts the taper (fertilized/cutsThisYear both
 *    reset on the year turn — see applyMowDone).
 *  - Crop rotation adds +10% (`gameConfig.rotationBonusPct`) when the current
 *    crop differs from the one this field grew immediately before
 *    (`field.lastCrop`, set at harvest — see applyHarvestDone). No bonus for
 *    replanting the same crop, and none on a field's first-ever crop (no prior
 *    crop to rotate away from).
 *  - A mulch pass on the previous cycle's residue adds a flat +7%
 *    (`field.residueMulched`, set post-harvest by the mulch task, consumed by
 *    the next harvest). Annuals only.
 * Read at whatever moment output is produced: live for a display estimate
 * (yieldRange), or at task-completion time for the actual harvested/baled
 * amount — both read the same current field state, so they agree.
 */
export interface YieldModifierStep {
  label: string;
  pct: number;
}

/** The individual modifiers behind `productivityMultiplier`, in application
 * order — the source of truth it reduces over, only listing the ones
 * currently active. Also feeds the Field View tab's yield breakdown graphic. */
export function yieldModifierSteps(field: Field, now: SimTime): YieldModifierStep[] {
  const steps: YieldModifierStep[] = [];
  if (field.weedy) steps.push({ label: "Weeds", pct: -0.1 });
  if (field.fertilized) {
    if (isPerennial(field.crop)) {
      const totalCuts = (field.crop && gameConfig.crops[field.crop].harvestMonths?.length) || 0;
      if (totalCuts > 0) steps.push({ label: "Fertilizer", pct: 0.3 * Math.max(0, 1 - cutsThisYear(field, now) / totalCuts) });
    } else {
      steps.push({ label: "Fertilizer", pct: 0.3 });
    }
  }
  // Mulched crop residue from the previous cycle adds a flat +7% (annuals only;
  // the flag is never set on a perennial). Cleared by the next harvest.
  if (field.residueMulched) steps.push({ label: "Mulch", pct: 0.07 });
  if (field.crop && field.lastCrop !== undefined && field.lastCrop !== field.crop) {
    steps.push({ label: "Rotation", pct: gameConfig.rotationBonusPct });
  }
  return steps;
}

export function productivityMultiplier(field: Field, now: SimTime): number {
  const mult = 1 + yieldModifierSteps(field, now).reduce((sum, s) => sum + s.pct, 0);
  return Math.max(0, mult);
}

/**
 * The VISIBLE yield range in tons/acre — wide at planting, narrowing toward the
 * hidden true value as harvest approaches (brief §6). Always contains the truth.
 * Scaled by `productivityMultiplier` so weeds/fertilizing show up in the estimate.
 */
export function yieldRange(field: Field, now: SimTime): { low: number; high: number } | null {
  if (!field.crop || field.trueYieldTonsPerAcre === undefined) return null;
  const cfg = gameConfig.crops[field.crop];
  const progress = growthProgress(field, now);
  const boost = productivityMultiplier(field, now);
  const fullHalf = cfg.baseYieldTonsPerAcre * cfg.yieldUncertainty * boost;
  const half = fullHalf * (1 - progress * gameConfig.yieldRangeNarrowing);
  const t = field.trueYieldTonsPerAcre * boost;
  // Center drifts from base toward truth so the band both narrows AND homes in,
  // while the truth always stays inside it.
  const center = (cfg.baseYieldTonsPerAcre + (field.trueYieldTonsPerAcre - cfg.baseYieldTonsPerAcre) * progress) * boost;
  const low = Math.max(0, Math.min(center - half, t));
  const high = Math.max(center + half, t);
  return { low, high };
}

/** Field status as derived from growth/harvest state. Pure function of the field. */
export function deriveStatus(field: Field, now: SimTime): FieldStatus {
  if (!field.crop || field.plantedAt === undefined) return field.status;
  if (isPerennial(field.crop)) return derivePerennialStatus(field, now);
  const p = growthProgress(field, now);
  if (p >= 1) return "ready";
  if (p >= 0.15) return "growing";
  return "planted";
}

/**
 * Perennial (grass/alfalfa) status on FIXED monthly cutting windows
 * (maintainer decision, 2026-07-13): the field is READY to mow whenever an
 * opened cutting window (`harvestMonths`) is still un-cut this year; it shows
 * `harvested` while cut material awaits rake/bale, and `growing` (regrowth /
 * dormant / establishing) the rest of the time. Never returns `ready` when a
 * cut is already banked for the current window — you catch up in the next one.
 */
function derivePerennialStatus(field: Field, now: SimTime): FieldStatus {
  // Cut material still on the field → awaiting rake/bale (the mow set this).
  if (field.forageReady) return "harvested";
  const cfg = gameConfig.crops[field.crop!];
  const month = dateOf(now).month;
  const windowsOpened = (cfg.harvestMonths ?? []).filter((m) => m <= month).length;
  if (windowsOpened > cutsThisYear(field, now)) return "ready";
  // Regrowing between cuttings / dormant off-season / just establishing.
  const m = monthsSincePlanting(field, now);
  return m !== null && m < 1 ? "planted" : "growing";
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
  const year = dateOf(now).year;
  for (const field of save.fields) {
    // Perennial year-turn housekeeping: reset the cutting count and re-arm the
    // annual fertilizer pass for the new season (the stand persists — there's
    // no replant to reset these at, like the annuals get in applyPlant).
    if (isPerennial(field.crop) && field.cutYear !== undefined && field.cutYear !== year) {
      field.cutYear = year;
      field.cutsThisYear = 0;
      field.autoFertDone = undefined;
    }
    const before = field.status;
    field.status = deriveStatus(field, now);
    let dirty = field.status !== before;
    // Weed flush: once the weeding window opens (growing, 2 months after
    // planting) on a not-yet-sprayed crop, weeds show up (and stay until a
    // weeding pass clears them). Perennial forage crops don't get weeds.
    if (!isPerennial(field.crop) && !field.weedy && !field.weeded && inWeedingWindow(field, now)) {
      field.weedy = true;
      dirty = true;
    }
    // The fertilizer spray dries off when the month turns — repaint back to
    // the normal texture (the darkening is applied-month only, by request).
    if (field.fertilizedAt !== undefined) {
      const applied = dateOf(field.fertilizedAt);
      const cur = dateOf(now);
      if (applied.month !== cur.month || applied.year !== cur.year) {
        field.fertilizedAt = undefined;
        dirty = true;
      }
    }
    // Weeds don't outlive the crop: harvest/plow resets the pressure.
    if (field.weedy && !hasStandingCrop(field.status) && field.status !== "ready") {
      field.weedy = undefined;
      dirty = true;
    }
    if (dirty) changed.push(field);
  }
  return { changed };
}
