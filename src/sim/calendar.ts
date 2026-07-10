/**
 * Game calendar over SimTime (brief §4 — the sim clock is authoritative; this is
 * pure presentation/scheduling math on top of it).
 *
 * The game year is 12 months of a configurable length (default 30 days — a clean
 * 360-day year). Real month lengths buy us nothing gameplay-wise and make "skip to
 * month" and season math fiddly; a uniform month keeps every window (planting,
 * delivery, contracts) simple. Seasons are 3 months each, aligned to the farm year.
 *
 * Days-per-month is a **player-adjustable pace knob** (maintainer request,
 * 2026-07-09), not balance data — it changes how fast the calendar turns, not crop
 * biology. `growDays` (gameConfig) is always real days, so shortening the month
 * doesn't shorten how long a crop takes to grow — only how many "months" that spans
 * and how quickly planting windows open/close. Mutable module state, same pattern
 * as `coords.ts`'s `setProjection`: read live via `minutesPerMonth()`, never cache
 * the old constant.
 *
 * A campaign starts on March 1, Year 1 — pre-planting, so the player's first
 * decision (what to plant in April/May) is in front of them, not behind them.
 */

import type { SimTime } from "./clock";

export const MINUTES_PER_DAY = 24 * 60;
export const MONTHS_PER_YEAR = 12;

/** 0-based month index the campaign starts in (March). */
export const START_MONTH = 2;

const DEFAULT_DAYS_PER_MONTH = 30;
let daysPerMonth = DEFAULT_DAYS_PER_MONTH;

/** Current month length in days. */
export function getDaysPerMonth(): number {
  return daysPerMonth;
}

/** Change month length (the "Skip to month" / crop-calendar pace knob). Whole
 * days only; at least 1 so a "month" can never collapse to zero time. */
export function setDaysPerMonth(days: number): void {
  const d = Math.round(days);
  if (!Number.isFinite(d) || d < 1) {
    throw new Error("calendar: daysPerMonth must be a whole number >= 1");
  }
  daysPerMonth = d;
}

/** Current month length in sim-minutes — always derive live, never cache. */
export function minutesPerMonth(): SimTime {
  return daysPerMonth * MINUTES_PER_DAY;
}

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
  const mpm = minutesPerMonth();
  const totalMonths = START_MONTH + Math.floor(t / mpm);
  const year = 1 + Math.floor(totalMonths / MONTHS_PER_YEAR);
  const month = totalMonths % MONTHS_PER_YEAR;
  const day = 1 + Math.floor((t % mpm) / MINUTES_PER_DAY);
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
  const mpm = minutesPerMonth();
  const monthsSinceStart = Math.floor(t / mpm);
  const currentAbs = START_MONTH + monthsSinceStart;
  let targetAbs = currentAbs + ((month - currentAbs) % MONTHS_PER_YEAR + MONTHS_PER_YEAR) % MONTHS_PER_YEAR;
  if (targetAbs <= currentAbs) targetAbs += MONTHS_PER_YEAR;
  return (targetAbs - START_MONTH) * mpm;
}

/** Whole sim-days elapsed between two times (fractional). */
export function daysBetween(a: SimTime, b: SimTime): number {
  return (b - a) / MINUTES_PER_DAY;
}
