/**
 * Cashflow ledger (maintainer request, 2026-07-12) — every dollar that moves
 * gets booked to a YEAR + CATEGORY + ITEM, so the Finance tab can show a
 * five-year cashflow table (Land & Equipment / Loan Expenses / Field
 * Expenses / Crop Revenue → Net) with per-item hover breakdowns.
 *
 * Sign convention: money IN is positive, money OUT is negative — a category
 * total is just the sum of its items, and Net is the sum of everything.
 * Refunds (canceled task, sold-back equipment) book as positive entries under
 * the same category the spend came from, so the table reads net-of-refunds.
 *
 * The year is the campaign year the money moved in (`save.finance.openYear`,
 * which `tickLoans` keeps current). Only the most recent 5 years are kept.
 */

import type { SaveState } from "../state/saveState";

export type CashflowCategory = "landEquipment" | "loanExpenses" | "fieldExpenses" | "cropRevenue";

export const CASHFLOW_CATEGORIES: CashflowCategory[] = [
  "landEquipment", "loanExpenses", "fieldExpenses", "cropRevenue",
];

export const CASHFLOW_LABEL: Record<CashflowCategory, string> = {
  landEquipment: "Land & Equipment",
  loanExpenses: "Loan Expenses",
  fieldExpenses: "Field Expenses",
  cropRevenue: "Crop Revenue",
};

/** item label -> net dollars (in positive / out negative). */
export type LedgerYear = Partial<Record<CashflowCategory, Record<string, number>>>;

const KEEP_YEARS = 5;

/** Book a cash movement. `amount` +in / −out. No-ops on zero. */
export function recordCash(save: SaveState, category: CashflowCategory, item: string, amount: number): void {
  if (!amount) return;
  save.ledger ??= {};
  const year = save.finance?.openYear ?? 1;
  const y = (save.ledger[year] ??= {});
  const cat = (y[category] ??= {});
  cat[item] = (cat[item] ?? 0) + amount;
  // Prune to the last KEEP_YEARS years so old campaigns don't grow unbounded.
  const years = Object.keys(save.ledger).map(Number).sort((a, b) => b - a);
  for (const old of years.slice(KEEP_YEARS)) delete save.ledger[old];
}

/** Sum of one category's items for a year (0 when nothing booked). */
export function categoryTotal(y: LedgerYear | undefined, category: CashflowCategory): number {
  const cat = y?.[category];
  return cat ? Object.values(cat).reduce((s, v) => s + v, 0) : 0;
}

/** Net cashflow for a year across all categories. */
export function netCashflow(y: LedgerYear | undefined): number {
  return CASHFLOW_CATEGORIES.reduce((s, c) => s + categoryTotal(y, c), 0);
}

/** The years worth showing, current first — always includes the current year
 * (even if nothing's booked yet), capped at KEEP_YEARS. */
export function ledgerYears(save: SaveState): number[] {
  const cur = save.finance?.openYear ?? 1;
  const years = new Set<number>([cur, ...Object.keys(save.ledger ?? {}).map(Number)]);
  return [...years].sort((a, b) => b - a).slice(0, KEEP_YEARS);
}
