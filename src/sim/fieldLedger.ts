/**
 * Per-field cashflow (maintainer request, 2026-07-21) — feeds the Field
 * Finances tab's multi-year profit & loss table. Mirrors `sim/ledger.ts`'s
 * shape/API but keyed by field id too, so two fields growing the same crop
 * each get their own correctly-separated totals (the global ledger pools
 * everything farm-wide by category, with no field key at all).
 *
 * Additive, not a replacement: every dollar booked here is booked ALONGSIDE
 * the existing global `recordCash` call at the same site — the whole-farm
 * Finance tab is completely unaffected by this module's existence.
 *
 * Revenue is booked as PRODUCTION VALUE at harvest/bale completion time
 * (tons/bales x the BASE config sell price), not traced through an actual
 * sale — grain pools farm-wide in a shared bin and hauled bales pool in
 * shared storage, so real-cash-at-sale per-field attribution was fragile and
 * inconsistent (a sale-time provenance system existed 2026-07-21..22 and was
 * removed, maintainer request). Any seasonal bonus captured at the actual
 * sale simply isn't reflected per-field — base value is the deliberate,
 * simple approximation.
 *
 * Sign convention matches ledger.ts: expenses negative, revenue positive.
 */

import type { SaveState } from "../state/saveState";
import type { CropId } from "../config/gameConfig";

export type FieldCashCategory = "expenses" | "revenue";

/** item label -> net dollars, for one field, one year. `crop` is the crop
 * grown on the field that year (for the Finances tab's per-row crop icon),
 * stamped at plant/harvest/mow time. */
export interface FieldLedgerYear {
  expenses?: Record<string, number>;
  revenue?: Record<string, number>;
  crop?: CropId;
}

const KEEP_YEARS = 5;

/** Book a cash movement to ONE field's ledger. No-ops on zero. */
export function recordFieldCash(
  save: SaveState,
  fieldId: string,
  category: FieldCashCategory,
  item: string,
  amount: number,
): void {
  if (!amount) return;
  save.fieldLedger ??= {};
  const year = save.finance?.openYear ?? 1;
  const f = (save.fieldLedger[fieldId] ??= {});
  const y = (f[year] ??= {});
  const cat = (y[category] ??= {});
  cat[item] = (cat[item] ?? 0) + amount;
  // Prune to the last KEEP_YEARS years for THIS field, same discipline as
  // the global ledger, so a long-running farm doesn't grow this unbounded.
  const years = Object.keys(f).map(Number).sort((a, b) => b - a);
  for (const old of years.slice(KEEP_YEARS)) delete f[old];
}

/** Stamp the crop grown on `fieldId` this campaign year — drives the
 * Finances tab's per-row crop icon. Creates the year entry if needed (a
 * planted-but-not-yet-harvested year still shows its crop). */
export function recordFieldCrop(save: SaveState, fieldId: string, crop: CropId): void {
  save.fieldLedger ??= {};
  const year = save.finance?.openYear ?? 1;
  const f = (save.fieldLedger[fieldId] ??= {});
  (f[year] ??= {}).crop = crop;
}

/** Sum of one category's items for a field-year (0 when nothing booked). */
export function fieldCategoryTotal(y: FieldLedgerYear | undefined, category: FieldCashCategory): number {
  const cat = y?.[category];
  return cat ? Object.values(cat).reduce((s, v) => s + v, 0) : 0;
}

/** Net cashflow (profit/loss) for a field-year across both categories. */
export function fieldNetCashflow(y: FieldLedgerYear | undefined): number {
  return fieldCategoryTotal(y, "expenses") + fieldCategoryTotal(y, "revenue");
}

/** The years worth showing for one field, current first — always includes
 * the current campaign year (even if nothing's booked yet), capped at
 * KEEP_YEARS. */
export function fieldLedgerYears(save: SaveState, fieldId: string): number[] {
  const cur = save.finance?.openYear ?? 1;
  const years = new Set<number>([cur, ...Object.keys(save.fieldLedger?.[fieldId] ?? {}).map(Number)]);
  return [...years].sort((a, b) => b - a).slice(0, KEEP_YEARS);
}
