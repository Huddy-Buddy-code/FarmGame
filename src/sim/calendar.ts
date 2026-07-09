/**
 * Game calendar over SimTime (brief §4 — the sim clock is authoritative; this is
 * pure presentation/scheduling math on top of it).
 *
 * The game year is 12 months × 30 days (360-day year). Real month lengths buy us
 * nothing gameplay-wise and make "skip to month" and season math fiddly; a clean
 * 30-day month keeps every window (planting, delivery, contracts) simple. Seasons
 * are 3 months each, aligned to the farm year.
 *
 * A campaign starts on March 1, Year 1 — pre-planting, so the player's first
 * decision (what to plant in April/May) is in front of them, not behind them.
 */

import type { SimTime } from "./clock";

export const MINUTES_PER_DAY = 24 * 60;
export const DAYS_PER_MONTH = 30;
export const MONTHS_PER_YEAR = 12;
export const MINUTES_PER_MONTH = DAYS_PER_MONTH * MINUTES_PER_DAY;

/** 0-based month index the campaign starts in (March). */
export const START_MONTH = 2;

export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

export const MONTH_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

export interface CalendarDate {
  /** 1-based campaign year. */
  year: number;
  /** 0-based month (0 = January). */
  month: number;
  /** 1-based day of month. */
  day: number;
}

/** Convert sim-time (minutes since campaign start) to a calendar date. */
export function dateOf(t: SimTime): CalendarDate {
  const totalMonths = START_MONTH + Math.floor(t / MINUTES_PER_MONTH);
  const year = 1 + Math.floor(totalMonths / MONTHS_PER_YEAR);
  const month = totalMonths % MONTHS_PER_YEAR;
  const day = 1 + Math.floor((t % MINUTES_PER_MONTH) / MINUTES_PER_DAY);
  return { year, month, day };
}

/** e.g. "Apr 12, Year 1". */
export function formatDate(t: SimTime): string {
  const d = dateOf(t);
  return `${MONTH_SHORT[d.month]} ${d.day}, Year ${d.year}`;
}

/**
 * Sim-time of the NEXT occurrence of the 1st of `month` (0-based) strictly after
 * `t`. If we're mid-April and you ask for April, you get April 1 of next year.
 */
export function nextMonthStart(t: SimTime, month: number): SimTime {
  const monthsSinceStart = Math.floor(t / MINUTES_PER_MONTH);
  const currentAbs = START_MONTH + monthsSinceStart;
  let targetAbs = currentAbs + ((month - currentAbs) % MONTHS_PER_YEAR + MONTHS_PER_YEAR) % MONTHS_PER_YEAR;
  if (targetAbs <= currentAbs) targetAbs += MONTHS_PER_YEAR;
  return (targetAbs - START_MONTH) * MINUTES_PER_MONTH;
}

/** Whole sim-days elapsed between two times (fractional). */
export function daysBetween(a: SimTime, b: SimTime): number {
  return (b - a) / MINUTES_PER_DAY;
}
