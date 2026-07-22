/**
 * Field Schedule tab (maintainer request, 2026-07-21) — a monthly calendar of
 * a rotation plan's tasks, backed by a per-task month override
 * (`FieldPlan.schedule`). This module computes which months are LEGAL to
 * schedule a task at (mirroring the real gates in farming.ts's month-
 * arithmetic — inWeedingWindow's >=2, canFertilizeNow's >=1 — so the
 * Schedule can never offer a drop target the live game would then reject),
 * and validates/applies a player's chosen override.
 *
 * harvest is DELAY-ONLY: its legal set starts at the natural ready month
 * (plantMonth + growMonths) and runs through December — a crop that's ready
 * never spoils in this game, so waiting is always safe, but auto-manage must
 * never be told to harvest before it's actually ready.
 *
 * mow (perennial) and rake/bale have NO entry here — they're intentionally
 * not independently schedulable. Perennial cutting is a fixed 3-times-a-year
 * mechanic (harvestMonths) rather than a single event a "delay to month X"
 * concept cleanly applies to, and rake/bale have never had a calendar gate —
 * they fire immediately after harvest/mow, whatever month that lands in.
 */

import { gameConfig } from "../config/gameConfig";
import type { CropId } from "../config/gameConfig";
import { isPerennial } from "./farming";
import { MONTHS_PER_YEAR } from "./calendar";
import type { FieldPlan } from "../state/saveState";

export type ScheduleTaskType = "plow" | "plant" | "weed" | "fertilize" | "mulch" | "harvest";

function monthMod(m: number): number {
  return ((m % MONTHS_PER_YEAR) + MONTHS_PER_YEAR) % MONTHS_PER_YEAR;
}

/** Inclusive month range, wrapping 0-11 (weed/fertilize windows can span a
 * year boundary for a late-planted crop). */
function rangeWrapped(fromIncl: number, toIncl: number): number[] {
  const out: number[] = [];
  for (let m = fromIncl; m <= toIncl; m++) out.push(monthMod(m));
  return out;
}

/** Inclusive month range, CLAMPED (not wrapped) at December — harvest's delay
 * window must not cross into the next rotation-plan slot's year. */
function rangeClamped(fromIncl: number, toIncl: number): number[] {
  const out: number[] = [];
  for (let m = fromIncl; m <= toIncl && m <= 11; m++) out.push(m);
  return out;
}

/**
 * Months (0-11) `type` is legal to run at, for `crop`, given the (possibly
 * overridden) month Plant currently lands at.
 */
export function legalMonthsFor(type: ScheduleTaskType, crop: CropId, plantMonth?: number): number[] {
  if (type === "plow") return isPerennial(crop) ? [] : [...gameConfig.plowMonths];
  if (type === "plant") return [...gameConfig.crops[crop].plantMonths];
  if (isPerennial(crop) || plantMonth === undefined) return [];
  const span = gameConfig.crops[crop].growMonths;
  if (type === "weed") return rangeWrapped(plantMonth + 2, plantMonth + span - 1);
  if (type === "fertilize") return rangeWrapped(plantMonth + 1, plantMonth + span - 1);
  if (type === "harvest") return rangeClamped(plantMonth + span, 11);
  // Mulch: the month(s) after the natural harvest (plant+grow), up to Nov —
  // the last month before the winter plow window (plowMonths = Dec–Feb) opens.
  // An annual residue pass only; empty for a late crop with no gap before winter.
  if (type === "mulch") return rangeClamped(plantMonth + span + 1, 10);
  return [];
}

/** The month a task will actually fire at: the override if still legal, else
 * the earliest legal month (today's behavior), else undefined (no legal
 * month exists this plan — e.g. a perennial's plow row). */
export function effectiveMonthFor(type: ScheduleTaskType, crop: CropId, override: number | undefined, plantMonth?: number): number | undefined {
  const legal = legalMonthsFor(type, crop, plantMonth);
  if (legal.length === 0) return undefined;
  if (override !== undefined && legal.includes(override)) return override;
  return legal[0];
}

/** Validating mutator for a drag/click on a Schedule cell — throws a
 * player-facing message on an illegal month (mirrors reorderTask's shape,
 * sim/tasks.ts). */
export function setScheduleOverride(plan: FieldPlan, type: ScheduleTaskType, month: number, plantMonth?: number): void {
  const legal = legalMonthsFor(type, plan.crop, plantMonth);
  if (!legal.includes(month)) throw new Error(`That month isn't legal for this task`);
  (plan.schedule ??= {})[type] = month;
}
