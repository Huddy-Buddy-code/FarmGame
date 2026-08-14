/**
 * Rotation TIMELINE projection (maintainer rework, 2026-07-31).
 *
 * The Schedule tab used to draw one 12-month calendar per rotation STEP, with
 * chips to flip between them. That model fought the data: a rotation is a
 * CHAIN with no fixed year boundaries, so a step that overwinters (Winter
 * Wheat, Sep→Jun) didn't fit in one calendar year, and a double crop (wheat
 * off in June, beans in the same June) put two steps in one year that you
 * could only ever look at one at a time.
 *
 * So: drop the 12-month calendar entirely and project onto an ABSOLUTE month
 * axis (0 = January of campaign year 1). Each step's position is derived by
 * chaining forward from the one before, and the whole thing is one continuous
 * timeline that grows a row per step.
 *
 * THE WHOLE TRICK is `nextOccurrence`. A step's plant month is a month-OF-YEAR;
 * where it actually lands is the first such month at or after the previous
 * step's ground clearing. Both awkward cases then fall out with no special
 * casing whatsoever:
 *
 *   Winter Wheat  plant abs 8 (Sep Y1) + 9 grow  → harvest abs 17 (Jun Y2)
 *   Soybeans      nextOccurrence(17, Jun) → delta 0 → abs 17   ← DOUBLE CROP
 *                 + 4 grow                       → harvest abs 21 (Oct Y2)
 *   loop → Wheat  nextOccurrence(21, Sep) → delta 11 → abs 32  ← fallow winter
 *
 * This module is PURE — no DOM, no map, no clock reads beyond the `now` it's
 * handed — so the chaining is unit-testable, which is the point: the layout is
 * something only the maintainer can eyeball, but the arithmetic underneath it
 * doesn't have to be taken on trust.
 *
 * Task MONTHS and their legal ranges still come from `sim/schedule.ts`
 * unchanged. This only decides where a month-of-year lands on the absolute
 * axis, so the override model (`FieldPlan.schedule`, keyed by month-of-year) is
 * untouched: dragging a chip to an absolute month sets `abs % 12`.
 */

import { gameConfig } from "../config/gameConfig";
import type { CropId } from "../config/gameConfig";
import { MONTHS_PER_YEAR, dateOf } from "./calendar";
import type { SimTime } from "./clock";
import type { Field, FieldPlan } from "../state/saveState";
import { isPerennial, isChopOnlyCrop, cropProducesWrappedBale } from "./farming";
import { legalMonthsFor, effectiveMonthFor } from "./schedule";
import type { ScheduleTaskType } from "./schedule";

/** Absolute month index: 0 = January of campaign year 1. */
export type AbsMonth = number;

/** Absolute month containing `t`. */
export function absMonthOf(t: SimTime): AbsMonth {
  const d = dateOf(t);
  return (d.year - 1) * MONTHS_PER_YEAR + d.month;
}

/** Calendar year + month-of-year for an absolute month. */
export function splitAbs(abs: AbsMonth): { year: number; month: number } {
  const m = ((abs % MONTHS_PER_YEAR) + MONTHS_PER_YEAR) % MONTHS_PER_YEAR;
  return { year: Math.floor((abs - m) / MONTHS_PER_YEAR) + 1, month: m };
}

/**
 * First absolute month AT OR AFTER `fromAbs` whose month-of-year is `moy`.
 *
 * "At or after" (not "after") is what makes a double crop expressible: a step
 * planting in the very month the previous one cleared lands on the same month,
 * delta 0. Bump it to "strictly after" and wheat→beans would silently slip a
 * full year.
 */
export function nextOccurrence(fromAbs: AbsMonth, moy: number): AbsMonth {
  const delta = ((moy - (fromAbs % MONTHS_PER_YEAR)) % MONTHS_PER_YEAR + MONTHS_PER_YEAR) % MONTHS_PER_YEAR;
  return fromAbs + delta;
}

/** Last absolute month AT OR BEFORE `fromAbs` whose month-of-year is `moy`.
 * Used for the PLOW, which prepares ground ahead of the crop it belongs to —
 * so it belongs in the gap BEFORE the band, not a year after it. */
export function prevOccurrence(fromAbs: AbsMonth, moy: number): AbsMonth {
  const delta = (((fromAbs % MONTHS_PER_YEAR) - moy) % MONTHS_PER_YEAR + MONTHS_PER_YEAR) % MONTHS_PER_YEAR;
  return fromAbs - delta;
}

/** Everything the timeline can draw inside a band. */
export type TimelineTaskKind =
  | ScheduleTaskType            // plow | plant | weed | fertilize | mulch | harvest
  | "mow" | "bale" | "wrap" | "silage";

/** Which FieldPlan flag turns an optional task off. */
export type TimelineToggle = "weed" | "fertilize" | "mulch" | "bale" | "wrap" | "silage";

export interface TimelineTask {
  kind: TimelineTaskKind;
  /** Absolute month(s) it runs at. Perennial cuttings have several. */
  at: AbsMonth[];
  /** Absolute months it could be dragged to. Empty = fixed timing. */
  legal: AbsMonth[];
  /** Set only for tasks with a `FieldPlan.schedule` override. */
  scheduleType?: ScheduleTaskType;
  /** The plant month its legal window is measured from (schedule.ts needs it). */
  plantMonth?: number;
  toggle?: TimelineToggle;
  /** False when `toggle` is off — drawn hollow rather than hidden. */
  on: boolean;
}

export interface TimelineBand {
  /** Index into `field.plans`. */
  planIdx: number;
  /** 0 = this cycle, 1 = the next time round the rotation, … */
  cycle: number;
  crop: CropId;
  perennial: boolean;
  /** Ground occupied from `plantAbs` up to and including `harvestAbs`. */
  plantAbs: AbsMonth;
  harvestAbs: AbsMonth;
  tasks: TimelineTask[];
  /** True for the step actually running right now. */
  current: boolean;
  /** True when the crop is already in the ground — this band is FACT to its
   * harvest, not projection. */
  planted: boolean;
}

export interface RotationTimeline {
  todayAbs: AbsMonth;
  /** Inclusive left / right edges of the drawn axis. */
  startAbs: AbsMonth;
  endAbs: AbsMonth;
  bands: TimelineBand[];
}

export interface ProjectOptions {
  /**
   * Stop after this many bands. Defaults to ONE FULL CYCLE — one band per
   * rotation step (maintainer request, 2026-07-31: "default to 1 crop until
   * more are added"). Projecting repeats by default filled a one-crop field's
   * schedule with "Corn / Corn +1 / Corn +2 / Corn +3", which is noise: the
   * rotation loops, and saying so four times doesn't make it truer.
   */
  maxBands?: number;
  /** Never project further than this many months past today. */
  maxMonths?: number;
  /** Years of cuttings to draw for a perennial stand. */
  perennialYears?: number;
}

/** How many months of ground time a step occupies: plant → harvest. */
function growMonthsOf(crop: CropId): number {
  return Math.max(1, gameConfig.crops[crop].growMonths);
}

/** The plant month-of-year this step will actually use. */
function plantMonthOf(plan: FieldPlan): number {
  return effectiveMonthFor("plant", plan.crop, plan.schedule?.plant) ?? gameConfig.crops[plan.crop].plantMonths[0] ?? 0;
}

/** Build one annual step's task list, positioned on the absolute axis. */
function annualTasks(plan: FieldPlan, plantAbs: AbsMonth, plantMonth: number): TimelineTask[] {
  const cfg = gameConfig.crops[plan.crop];
  const out: TimelineTask[] = [];

  /** A task whose month is overridable — its legal months map onto the axis. */
  const sched = (kind: ScheduleTaskType, toggle?: TimelineToggle): void => {
    const moy = effectiveMonthFor(kind, plan.crop, plan.schedule?.[kind], plantMonth);
    if (moy === undefined) return;
    // PLOW prepares the ground ahead of this crop, so it sits BEFORE the band;
    // everything else happens at or after planting.
    const place = kind === "plow"
      ? (m: number) => prevOccurrence(plantAbs, m)
      : (m: number) => nextOccurrence(plantAbs, m);
    out.push({
      kind,
      at: [place(moy)],
      legal: legalMonthsFor(kind, plan.crop, plantMonth).map(place).sort((a, b) => a - b),
      scheduleType: kind,
      plantMonth,
      toggle,
      on: toggle ? !!plan[toggle] : true,
    });
  };

  sched("plant");
  sched("fertilize", "fertilize");
  if (!cfg.coverCrop) sched("weed", "weed");
  sched("harvest");
  // A chop-only crop (Forage, 2026-08-12) never sees a combine — relabel its
  // harvest band as "silage" for display (icon/column), while `scheduleType`
  // stays "harvest" underneath so it's still the same draggable step
  // `sim/schedule.ts` understands. No toggle: unlike a perennial's per-cutting
  // bale-vs-chop choice, this crop's route was already decided at planting.
  if (isChopOnlyCrop(plan.crop)) out[out.length - 1]!.kind = "silage";
  sched("mulch", "mulch");

  // Fixed-timing follow-on: bale fires off the back of harvest, so it has no
  // month of its own to drag and its legal set is deliberately empty.
  const harvestMoy = effectiveMonthFor("harvest", plan.crop, plan.schedule?.harvest, plantMonth);
  const harvestAbs = harvestMoy !== undefined ? nextOccurrence(plantAbs, harvestMoy) : plantAbs + growMonthsOf(plan.crop);
  if (cfg.baleProduct) {
    out.push({ kind: "bale", at: [harvestAbs], legal: [], toggle: "bale", on: !!plan.bale });
  }
  sched("plow");
  return out;
}

/** A perennial stand's repeating cuttings across `years`. */
function perennialTasks(plan: FieldPlan, standStartAbs: AbsMonth, years: number): TimelineTask[] {
  const cfg = gameConfig.crops[plan.crop];
  const cuts = cfg.harvestMonths ?? [];
  const out: TimelineTask[] = [];
  const startYear = splitAbs(standStartAbs).year;
  const every = (moy: number): AbsMonth[] => {
    const at: AbsMonth[] = [];
    for (let y = 0; y < years; y++) {
      const abs = (startYear - 1 + y) * MONTHS_PER_YEAR + moy;
      if (abs >= standStartAbs) at.push(abs);
    }
    return at;
  };
  const allCuts = cuts.flatMap(every).sort((a, b) => a - b);

  if (cfg.fertilizeMonth !== undefined) {
    out.push({ kind: "fertilize", at: every(cfg.fertilizeMonth), legal: [], toggle: "fertilize", on: !!plan.fertilize });
  }
  out.push({ kind: "mow", at: allCuts, legal: [], on: true });
  out.push({ kind: "bale", at: allCuts, legal: [], toggle: "bale", on: !!plan.bale });
  // A Silage crop (grassSilage/alfalfaSilage, 2026-08-13) wraps automatically
  // once baled — no in-season toggle, unlike the old grass/alfalfa silage
  // toggle this replaced (see `wrapPending`, sim/tasks.ts). Every other crop
  // keeps the FieldPlan.wrap toggle as-drawn, though nothing currently sets it.
  const autoWrap = cropProducesWrappedBale(plan.crop);
  if (plan.bale && (autoWrap || plan.wrap)) {
    out.push({ kind: "wrap", at: allCuts, legal: [], toggle: "wrap", on: autoWrap || !!plan.wrap });
  }
  if (cfg.silageProduct) {
    out.push({ kind: "silage", at: allCuts, legal: [], toggle: "silage", on: !!plan.silage });
  }
  return out;
}

/**
 * Project a field's rotation onto the absolute month axis, anchored at `now`.
 *
 * The chain's HEAD is anchored to reality: if a crop is already in the ground,
 * its band starts at the month it was actually planted, so the current step is
 * fact rather than projection. Everything after chains forward from it.
 */
export function projectRotation(field: Field, now: SimTime, opts: ProjectOptions = {}): RotationTimeline {
  const maxBands = opts.maxBands ?? (field.plans?.length || 1);
  const maxMonths = opts.maxMonths ?? 72;
  // A single year of cuttings is plenty to show (maintainer request,
  // 2026-08-13 — was 3, which repeated the same cutting pattern for no
  // reason: the sim already cuts a perennial stand indefinitely with no
  // year cap, this is purely how far ahead the Schedule tab draws).
  const perennialYears = opts.perennialYears ?? 1;
  const todayAbs = absMonthOf(now);
  const plans = field.plans && field.plans.length > 0 ? field.plans : [];
  const bands: TimelineBand[] = [];

  if (plans.length === 0) {
    return { todayAbs, startAbs: todayAbs, endAbs: todayAbs + 11, bands };
  }

  const startIdx = ((field.rotationIndex ?? 0) % plans.length + plans.length) % plans.length;

  // A PERENNIAL stand doesn't chain — it sits for years and is cut several
  // times a season. One band, repeating markers, no rotation walk at all.
  if (isPerennial(plans[startIdx]!.crop)) {
    const plan = plans[startIdx]!;
    const standStart = field.plantedAt !== undefined ? absMonthOf(field.plantedAt) : todayAbs;
    const tasks = perennialTasks(plan, standStart, perennialYears);
    const last = tasks.flatMap((t) => t.at).reduce((a, b) => Math.max(a, b), standStart);
    bands.push({
      planIdx: startIdx, cycle: 0, crop: plan.crop, perennial: true,
      plantAbs: standStart, harvestAbs: last, tasks, current: true,
      planted: field.plantedAt !== undefined,
    });
    return {
      todayAbs,
      startAbs: Math.min(standStart, todayAbs),
      endAbs: Math.max(last, todayAbs + 11),
      bands,
    };
  }

  // Where the chain starts. A crop already in the ground pins it to the month
  // it really went in; otherwise the current step plants at its next legal
  // month from today.
  const first = plans[startIdx]!;
  const firstPlantMoy = plantMonthOf(first);
  const inGround = field.crop !== undefined && field.plantedAt !== undefined;
  let plantAbs = inGround ? absMonthOf(field.plantedAt!) : nextOccurrence(todayAbs, firstPlantMoy);

  for (let i = 0; i < maxBands; i++) {
    const planIdx = (startIdx + i) % plans.length;
    const plan = plans[planIdx]!;
    // A perennial mid-sequence would stop the chain dead (it never clears), so
    // end the projection there rather than drawing something untrue.
    if (isPerennial(plan.crop)) break;

    const plantMoy = i === 0 ? (inGround ? splitAbs(plantAbs).month : firstPlantMoy) : plantMonthOf(plan);
    const tasks = annualTasks(plan, plantAbs, plantMoy);
    const harvestTask = tasks.find((t) => t.kind === "harvest");
    const harvestAbs = harvestTask?.at[0] ?? plantAbs + growMonthsOf(plan.crop);

    bands.push({
      planIdx, cycle: Math.floor((startIdx + i) / plans.length),
      crop: plan.crop, perennial: false,
      plantAbs, harvestAbs, tasks,
      current: i === 0,
      planted: i === 0 && inGround,
    });

    if (harvestAbs - todayAbs > maxMonths) break;

    // Ground is free from the harvest month itself — "at or after", which is
    // exactly what lets the next step double-crop into the same month.
    const nextPlan = plans[(planIdx + 1) % plans.length]!;
    if (isPerennial(nextPlan.crop)) break;
    plantAbs = nextOccurrence(harvestAbs, plantMonthOf(nextPlan));
  }

  const lastBand = bands[bands.length - 1];
  // Include the leading plow, which sits before the first band.
  const earliest = bands.length > 0
    ? Math.min(bands[0]!.plantAbs, ...bands[0]!.tasks.flatMap((t) => t.at))
    : todayAbs;
  return {
    todayAbs,
    startAbs: Math.min(earliest, todayAbs),
    endAbs: Math.max(lastBand?.harvestAbs ?? todayAbs, todayAbs + 11),
    bands,
  };
}
