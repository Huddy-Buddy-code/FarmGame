/**
 * One-line summary of a farm's save — "Year 3 · $412,000 · 240 ac" — shared by
 * the Settings tab and the home screen (extracted from main.ts, 2026-07-26).
 *
 * Deliberately computed from the PersistedGame's OWN daysPerMonth, never the
 * live calendar module's — that's a global holding the ACTIVE farm's pace, and
 * reading another farm's save through it would corrupt the current farm's
 * calendar math.
 */

import type { PersistedGame } from "./persistence";
import { MINUTES_PER_DAY, MONTHS_PER_YEAR, START_MONTH } from "../sim/calendar";
import { areaAcres } from "../geo/geometry";

export function farmSummaryLine(pg: PersistedGame | null): string {
  if (!pg) return "Not started yet";
  const mpm = (pg.daysPerMonth ?? 30) * MINUTES_PER_DAY;
  const totalMonths = START_MONTH + Math.floor(pg.clockNow / mpm);
  const year = 1 + Math.floor(totalMonths / MONTHS_PER_YEAR);
  const acres = pg.save.fields.reduce((sum, f) => sum + areaAcres(f.boundary), 0);
  return `Year ${year} · $${Math.round(pg.save.money).toLocaleString()} · ${acres.toFixed(0)} ac`;
}
