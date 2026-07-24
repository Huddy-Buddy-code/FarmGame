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
 * (plantMonth + growMonths) and runs for `harvestWindowMonths` — a ripe crop
 * WITHERS once that closes (2026-07-23), so this must never offer a month the
 * crop wouldn't survive to, nor one before it's actually ready.
 *
 * plow spans the gap between crops: every month the ground isn't occupied,
 * ordered from the month after it clears to the month before the next crop
 * goes in. It defaults to January, except where the crop overwinters and
 * January isn't available — see `effectiveMonthFor`.
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

/**
 * Inclusive month range measured in ABSOLUTE months from planting, wrapped into
 * 0-11 and capped at `maxSpanMonths` so a delay window can't lap the calendar.
 *
 * This replaced a December CLAMP (2026-07-23). The clamp existed because a
 * rotation plan was one campaign YEAR, so nothing was allowed to cross Jan 1 —
 * but it silently produced EMPTY legal sets for any crop whose cycle ends after
 * December. Winter Wheat plants in month 8 (Sep) and grows 9 months, so harvest
 * asked for `rangeClamped(17, 11)` = nothing at all, and the Schedule tab drew
 * blank Harvest, Mulch, and Rake/Bale rows (maintainer report + screenshot).
 * Now that the rotation is a sequence rather than a per-year slot, a step is
 * free to span the year boundary and the wrap is simply correct.
 */
function rangeWrappedCapped(fromIncl: number, toIncl: number, maxSpanMonths = MONTHS_PER_YEAR - 1): number[] {
  const out: number[] = [];
  const end = Math.min(toIncl, fromIncl + maxSpanMonths);
  for (let m = fromIncl; m <= end; m++) out.push(monthMod(m));
  return out;
}

/**
 * How many months a crop physically occupies the ground: from the month it goes
 * in, through the end of its harvest window. Nothing can be plowed during it.
 */
function occupancyMonths(crop: CropId): number {
  return gameConfig.crops[crop].growMonths + gameConfig.harvestWindowMonths;
}

/**
 * The months a field can be plowed for `crop`, ORDERED from the first month
 * after the ground clears to the last month before the crop goes back in
 * (maintainer request, 2026-07-23 — plowing used to be locked to a fixed
 * Dec–Feb winter season).
 *
 * The order matters: it's what makes "at or after the chosen month" a simple
 * index comparison for auto-manage's soft retry, without any modular
 * arithmetic at the call site.
 *
 * A crop that occupies the ground for a full year would leave nothing here, so
 * the month before planting is kept as a floor — a field must always have
 * somewhere to be plowed, or it could never be replanted at all.
 */
function plowMonthsInOrder(crop: CropId, plantMonth: number): number[] {
  const span = occupancyMonths(crop);
  const out: number[] = [];
  for (let i = span; i < MONTHS_PER_YEAR; i++) out.push(monthMod(plantMonth + i));
  return out.length > 0 ? out : [monthMod(plantMonth - 1)];
}

/**
 * Months (0-11) `type` is legal to run at, for `crop`, given the (possibly
 * overridden) month Plant currently lands at.
 */
export function legalMonthsFor(type: ScheduleTaskType, crop: CropId, plantMonth?: number): number[] {
  // Plow applies to PERENNIALS too: a stand is never re-plowed once it's up,
  // but the ground is still turned once before it's established (the 2026-07-16
  // rule), and auto-manage needs a window to do that in. Returning [] here used
  // to be masked by the old season-based gate; with the window derived per
  // crop it would have left perennials unable to be planted at all.
  if (type === "plow") {
    const pm = plantMonth ?? gameConfig.crops[crop].plantMonths[0];
    return pm === undefined ? [] : plowMonthsInOrder(crop, pm);
  }
  if (type === "plant") return [...gameConfig.crops[crop].plantMonths];
  if (isPerennial(crop) || plantMonth === undefined) return [];
  const span = gameConfig.crops[crop].growMonths;
  if (type === "weed") return rangeWrapped(plantMonth + 2, plantMonth + span - 1);
  if (type === "fertilize") return rangeWrapped(plantMonth + 1, plantMonth + span - 1);
  // Harvest is DELAY-ONLY, and now bounded by the crop's real HARVEST WINDOW
  // (2026-07-23): from the month it ripens through `harvestWindowMonths`. This
  // is not just a UI limit — a crop still standing when the window closes
  // withers and is lost (`harvestWindowClosed`/`applyWither`, farming.ts), so
  // offering a later month here would be offering the player a way to destroy
  // their own crop.
  if (type === "harvest") {
    return rangeWrappedCapped(plantMonth + span, plantMonth + span + gameConfig.harvestWindowMonths - 1);
  }
  // Mulch: the months following the natural harvest. An annual residue pass.
  if (type === "mulch") {
    return rangeWrappedCapped(plantMonth + span + 1, plantMonth + span + gameConfig.schedule.mulchWindowMonths);
  }
  return [];
}

/** The month a plow defaults to when the player hasn't chosen one: JANUARY —
 * the traditional slack-season pass, and the default the maintainer asked for
 * (2026-07-23). */
const DEFAULT_PLOW_MONTH = 0;

/**
 * The month a task will actually fire at: the override if still legal, else the
 * task's default, else undefined (no legal month exists — e.g. a perennial's
 * plow row).
 *
 * Every task defaults to its earliest legal month EXCEPT plow, which defaults
 * to January when January is available. For a spring-planted crop that's the
 * quiet middle of the plow window. For a crop that OVERWINTERS — Winter Wheat
 * is in the ground from September to July — January isn't available at all, and
 * the fallback (the first legal month, i.e. the first one after the ground
 * clears) lands right where it should: the month after harvest, just ahead of
 * that crop's own autumn planting. Defaulting those to January would have been
 * actively broken, scheduling the plow ten months after the seed.
 */
export function effectiveMonthFor(type: ScheduleTaskType, crop: CropId, override: number | undefined, plantMonth?: number): number | undefined {
  const legal = legalMonthsFor(type, crop, plantMonth);
  if (legal.length === 0) return undefined;
  if (override !== undefined && legal.includes(override)) return override;
  if (type === "plow" && legal.includes(DEFAULT_PLOW_MONTH)) return DEFAULT_PLOW_MONTH;
  return legal[0];
}

/**
 * Is a plow due for `crop` at `month` — is this a legal plow month at or after
 * the one the schedule picked? "Or after" keeps auto-manage's soft retry: a
 * month missed because the farm was broke is picked up by the next legal month
 * rather than waiting a whole year.
 */
export function plowDueAt(crop: CropId, month: number, override: number | undefined, plantMonth?: number): boolean {
  const legal = legalMonthsFor("plow", crop, plantMonth);
  const chosen = effectiveMonthFor("plow", crop, override, plantMonth);
  if (chosen === undefined) return false;
  const at = legal.indexOf(month);
  return at >= 0 && at >= legal.indexOf(chosen);
}

/** Validating mutator for a drag/click on a Schedule cell — throws a
 * player-facing message on an illegal month (mirrors reorderTask's shape,
 * sim/tasks.ts). */
export function setScheduleOverride(plan: FieldPlan, type: ScheduleTaskType, month: number, plantMonth?: number): void {
  const legal = legalMonthsFor(type, plan.crop, plantMonth);
  if (!legal.includes(month)) throw new Error(`That month isn't legal for this task`);
  (plan.schedule ??= {})[type] = month;
}
