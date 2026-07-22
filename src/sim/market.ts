/**
 * Market pricing (maintainer request, 2026-07-21) — replaces the flat sell
 * price with a SEASONAL one so WHEN you sell matters. Re-anchored 2026-07-21 to
 * a single fixed peak month shared by every product (was per-product, keyed to
 * each product's last harvest).
 *
 * The curve tops out at `gameConfig.market.peakMonth` (December) and tapers to
 * base moving away from it in either direction, shaped by
 * `gameConfig.market.seasonalBonusByDistance`: +25% at the peak, +15% one month
 * out, +10% two months out, +0% (base) beyond. Base is the floor — no discounts.
 *
 * Provenance + sale-time revenue attribution live here too (see §Provenance)
 * so the Field Finances tab can credit each field its real sale revenue even
 * though harvested grain / hauled bales pool farm-wide with no field tag.
 */

import { gameConfig } from "../config/gameConfig";
import type { CropId, BaleProduct } from "../config/gameConfig";
import { dateOf, MONTHS_PER_YEAR } from "./calendar";
import type { SimTime } from "./clock";
import type { SaveState } from "../state/saveState";
import { recordFieldCash } from "./fieldLedger";

/** Anything that can be sold on the market: a grain crop or a bale product.
 * (Their string values are disjoint, so a plain union is unambiguous.) */
export type MarketProduct = CropId | BaleProduct;

/** Grain crops that actually sell grain (excludes the perennial forage crops,
 * whose yield is realized as bales). */
export const SELLABLE_GRAINS: CropId[] = (Object.keys(gameConfig.crops) as CropId[]).filter(
  (c) => gameConfig.crops[c].producesGrain !== false,
);

/** Bale products that are actually reachable/sellable (`forage` never is). */
export const SELLABLE_BALES: BaleProduct[] = ["cornStover", "hay", "alfalfaHay"];

/** The single peak-price month (0-11) — December, shared by every product. */
export function peakSaleMonth(): number {
  return gameConfig.market.peakMonth;
}

/** Whole months between `month` and the peak, wrapping around the year (0..6). */
function monthsFromPeak(month: number): number {
  const d = (((month - gameConfig.market.peakMonth) % MONTHS_PER_YEAR) + MONTHS_PER_YEAR) % MONTHS_PER_YEAR;
  return Math.min(d, MONTHS_PER_YEAR - d);
}

/** Price multiplier in calendar `month` (1.0 = base price). Same curve for
 * every product, so `_product` is currently unused — kept in the signature to
 * leave room for a per-product curve without churning every call site. */
export function seasonalMultiplier(_product: MarketProduct, month: number): number {
  return 1 + (gameConfig.market.seasonalBonusByDistance[monthsFromPeak(month)] ?? 0);
}

/** Seasonal bonus as a fraction (0, 0.1, 0.15, 0.25) for `product` in `month` —
 * for the "+N%" badges in the Inventory tab. */
export function seasonalBonus(product: MarketProduct, month: number): number {
  return seasonalMultiplier(product, month) - 1;
}

/** Current per-ton grain price at `month`. */
export function grainUnitPrice(crop: CropId, month: number): number {
  return gameConfig.crops[crop].sellPricePerTon * seasonalMultiplier(crop, month);
}

/** Current per-bale price at `month`. */
export function baleUnitPrice(product: BaleProduct, month: number): number {
  return gameConfig.baleProducts[product].pricePerBale * seasonalMultiplier(product, month);
}

/** Calendar month (0-11) of a sim-time — convenience for callers that only
 * have `now`. */
export function monthOf(now: SimTime): number {
  return dateOf(now).month;
}

// --- Provenance & sale-time revenue attribution ----------------------------
// Harvested grain pools farm-wide in a shared bin and hauled bales pool in
// shared storage, with no field tag once they leave the field. To credit a
// field its REAL sale revenue (booked at sale time, decision #4), we track how
// much of each product each field has produced-but-not-yet-sold, and consume
// it as sales happen. `save.produceStock: product -> fieldId -> amount`
// (tons for grain, bales for bale products); "" would be an unattributed lot
// (legacy/seeded stock), which is simply skipped for attribution.

/** Record that `fieldId` produced `amount` of `product` (harvest / bale
 * completion). */
export function addProduce(save: SaveState, product: MarketProduct, fieldId: string, amount: number): void {
  if (amount <= 0) return;
  save.produceStock ??= {};
  const stock = (save.produceStock[product] ??= {});
  stock[fieldId] = (stock[fieldId] ?? 0) + amount;
}

/**
 * Attribute a completed sale of `amount` of `product` at `unitPrice` back to
 * the field(s) that produced it, booking each field's share as revenue in the
 * CURRENT campaign year (`recordFieldCash`). Called by every sale path, right
 * after it books the exact global `recordCash`.
 *
 * - `opts.fieldId` set (a field selling its OWN loose bales): credit that field
 *   directly for the whole amount, decrementing up to what it had tracked.
 * - otherwise (a pooled sale — grain bin, storage building, sell-point dump):
 *   consume pro-rata across every field holding this product.
 *
 * Any amount beyond what's tracked (legacy/desync) is left un-attributed — the
 * global ledger already booked the exact cash, so only the per-field breakdown
 * is best-effort.
 */
export function attributeSale(
  save: SaveState,
  product: MarketProduct,
  amount: number,
  unitPrice: number,
  opts: { label: string; fieldId?: string },
): void {
  if (amount <= 0) return;
  const credit = (fieldId: string, amt: number): void => {
    if (amt > 0) recordFieldCash(save, fieldId, "revenue", opts.label, Math.round(amt * unitPrice));
  };
  const stock = save.produceStock?.[product];

  if (opts.fieldId) {
    // A field's own bales: the revenue is unambiguously this field's.
    credit(opts.fieldId, amount);
    if (stock && stock[opts.fieldId]) {
      const left = stock[opts.fieldId]! - amount;
      if (left <= 1e-9) delete stock[opts.fieldId];
      else stock[opts.fieldId] = left;
    }
    return;
  }

  if (!stock) return; // pooled sale with no provenance tracked — unattributed
  const entries = Object.entries(stock).filter(([id, v]) => id !== "" && v > 0);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  if (total <= 0) return;
  const consume = Math.min(amount, total);
  for (const [fieldId, have] of entries) {
    const share = (have / total) * consume;
    credit(fieldId, share);
    const left = have - share;
    if (left <= 1e-9) delete stock[fieldId];
    else stock[fieldId] = left;
  }
}
