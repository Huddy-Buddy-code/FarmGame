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
 * (Per-field revenue is NOT traced through sales anymore — the Field Finances
 * tab books production value at harvest/bale time instead; see
 * `sim/fieldLedger.ts`. The sale-time provenance system that used to live here
 * was removed 2026-07-22, maintainer request — it was complex and inconsistent.)
 */

import { gameConfig } from "../config/gameConfig";
import type { CropId, BaleProduct } from "../config/gameConfig";
import { dateOf, MONTHS_PER_YEAR } from "./calendar";
import type { SimTime } from "./clock";

/** Anything that can be sold on the market: a grain crop or a bale product.
 * (Their string values are disjoint, so a plain union is unambiguous.) */
export type MarketProduct = CropId | BaleProduct;

/** Grain crops that actually sell grain (excludes the perennial forage crops,
 * whose yield is realized as bales). */
export const SELLABLE_GRAINS: CropId[] = (Object.keys(gameConfig.crops) as CropId[]).filter(
  (c) => gameConfig.crops[c].producesGrain !== false,
);

/** Bale products that are actually reachable/sellable (`forage` never is). */
export const SELLABLE_BALES: BaleProduct[] = ["cornStover", "straw", "hay", "alfalfaHay"];

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

/**
 * The DELIVERED price is the one above (`grainUnitPrice`/`baleUnitPrice`): you
 * hauled the load to a Sell Point yourself, so you get the seasonal premium.
 *
 * These two are the INSTANT price (2026-07-23) — selling straight from the
 * Inventory panel, where a buyer collects. That forgoes the seasonal premium
 * entirely AND takes `market.instantSellPenaltyPct` off the base for pickup, so
 * it is always the worst price available. The gap between the two IS the Sell
 * task's reason to exist: at December's peak, hauling is worth ~39% more than
 * clicking sell.
 */
export function instantPriceFactor(): number {
  return 1 - gameConfig.market.instantSellPenaltyPct;
}

/** Per-ton grain price when sold instantly from Inventory (no season, less fee). */
export function grainInstantPrice(crop: CropId): number {
  return gameConfig.crops[crop].sellPricePerTon * instantPriceFactor();
}

/** Per-bale price when sold instantly from Inventory. */
export function baleInstantPrice(product: BaleProduct): number {
  return gameConfig.baleProducts[product].pricePerBale * instantPriceFactor();
}

/** Calendar month (0-11) of a sim-time — convenience for callers that only
 * have `now`. */
export function monthOf(now: SimTime): number {
  return dateOf(now).month;
}
