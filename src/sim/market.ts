/**
 * Market pricing (maintainer request, 2026-07-21) — replaces the flat sell
 * price with a SEASONAL one so WHEN you sell matters. Re-anchored 2026-07-21 to
 * a single fixed peak month shared by every product (was per-product, keyed to
 * each product's last harvest).
 *
 * The curve tops out at `gameConfig.market.peakMonth` (July, as of the
 * 2026-07-25 realism pass — cash grain bottoms at harvest and peaks the
 * following early summer) and tapers to base moving away from it in either
 * direction, shaped by `gameConfig.market.seasonalBonusByDistance`: +12% at the
 * peak, +8% one month out, +4% two months out, +0% (base) beyond. Base is the
 * floor — no discounts.
 *
 * (Per-field revenue is NOT traced through sales anymore — the Field Finances
 * tab books production value at harvest/bale time instead; see
 * `sim/fieldLedger.ts`. The sale-time provenance system that used to live here
 * was removed 2026-07-22, maintainer request — it was complex and inconsistent.)
 */

import { gameConfig, SILAGE_PRODUCTS } from "../config/gameConfig";
import type { CropId, BaleProduct, SilageProduct } from "../config/gameConfig";
import { dateOf, MONTHS_PER_YEAR } from "./calendar";
import type { SimTime } from "./clock";

/** Anything that can be sold on the market: a grain crop, a bale product, or
 * a bunker silage product (2026-08-15 — bunker silage joined the same
 * Auto/Manual/Haul system grain and bales already had). Their string values
 * are disjoint, so a plain union is unambiguous. */
export type MarketProduct = CropId | BaleProduct | SilageProduct;

/** Grain crops that actually sell grain (excludes the perennial forage crops,
 * whose yield is realized as bales). */
export const SELLABLE_GRAINS: CropId[] = (Object.keys(gameConfig.crops) as CropId[]).filter(
  (c) => gameConfig.crops[c].producesGrain !== false,
);

/**
 * Every bale product — all of them reachable/sellable now (the one
 * permanently-unreachable one, "forage", was cut from the config entirely
 * 2026-08-15 rather than filtered out here; see the BaleProduct union's
 * comment, config/gameConfig.ts).
 *
 * Derived from `gameConfig.baleProducts` (2026-08-14 fix), not hand-listed —
 * a hardcoded list here silently went stale every time a new BaleProduct
 * shipped (baleage 2026-07-31, square baleage + generic aged silage
 * 2026-08-13): none of those ever made it into this list, so a Bale Storage
 * building holding nothing BUT baleage showed its per-product breakdown as
 * "Empty" despite a real non-zero count (`storedBalesTotal` sums the whole
 * record; the Inventory tab's breakdown only iterates THIS list) — and, more
 * seriously, `ALL_MARKET_PRODUCTS` (below) meant auto-sell never covered
 * wrapped bales either. Deriving this from the config union means a NEW
 * product can't recreate the same bug by omission again.
 */
export const SELLABLE_BALES: BaleProduct[] = Object.keys(gameConfig.baleProducts) as BaleProduct[];

/**
 * Freshly-wrapped baleage, and fresh-chopped Corn Forage, that auto-sell
 * holds onto rather than cashing out early (maintainer request, 2026-08-14
 * for baleage, extended 2026-08-15 to Corn Forage on the same terms: "the
 * Corn Forage will get the same 'held until Silage' treatment as the
 * wrapped grass and alfalfa bales"). Once `resolveAgedBaleProduct`/
 * `tickBaleAging` (bales) or `tickSilageAging` (the bunker) convert one
 * into its aged twin after `forage.silageAgingMonths`, THAT product is
 * fully auto-sellable — this only holds the pre-aged form. Still sellable
 * by hand from the Inventory tab any time, and still haulable to a Sell
 * Point on demand; this is auto-sell-only.
 */
export const AUTO_SELL_HOLDS_UNTIL_AGED: ReadonlySet<BaleProduct | SilageProduct> = new Set([
  "hayBaleage", "alfalfaBaleage", "haySquareBaleage", "alfalfaHaySquareBaleage",
  "cornForage",
]);

/** Every product the market deals in — what the farm-wide auto-sell covers. */
export const ALL_MARKET_PRODUCTS: MarketProduct[] = [
  ...SELLABLE_GRAINS,
  ...SELLABLE_BALES.filter((p) => !AUTO_SELL_HOLDS_UNTIL_AGED.has(p)),
  ...SILAGE_PRODUCTS.filter((p) => !AUTO_SELL_HOLDS_UNTIL_AGED.has(p)),
];

/**
 * When, and whether, `product` auto-sells.
 *
 * A product with its own row in `sellSchedule` uses it — that's the per-product
 * override. Everything else follows the farm-wide `sellAll` default, which is
 * what lets the master toggle cover crops that aren't in store yet (maintainer
 * request, 2026-07-24: "this includes current, and any future adds").
 *
 * Shared by `tickAutoSell` and the Inventory tab on purpose: a switch that
 * showed one thing and sold another would be worse than no switch.
 */
export function effectiveSellPlan(
  save: { sellSchedule?: Record<string, { month: number; auto: boolean }>; sellAll?: { month: number; auto: boolean } },
  product: MarketProduct,
): { month: number; auto: boolean; fromAll: boolean } {
  // The master WINS while it's on (maintainer decision, 2026-07-24: "when they
  // hit the master toggle it overrides all the individual ones and moves them
  // to on"). Per-product rows only speak when the master is off — which is why
  // the UI hides them while it's on: a visible control that couldn't change
  // anything would be a lie.
  if (save.sellAll?.auto) return { month: save.sellAll.month, auto: true, fromAll: true };
  const own = save.sellSchedule?.[product];
  if (own) return { ...own, fromAll: false };
  return { month: save.sellAll?.month ?? peakSaleMonth(), auto: false, fromAll: true };
}

/** The single peak-price month (0-11) — July, shared by every product. */
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

/** Seasonal bonus as a fraction (0, 0.04, 0.08, 0.12) for `product` in `month` —
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

/** Current per-ton bunker silage price at `month` (2026-08-15 — silage now
 * follows the same seasonal curve as grain/bales, replacing the flat
 * year-round price it launched with; see the pricing note on
 * `gameConfig.silageProducts` for why). */
export function silageUnitPrice(product: SilageProduct, month: number): number {
  return gameConfig.silageProducts[product].pricePerTon * seasonalMultiplier(product, month);
}

/**
 * The DELIVERED price is the one above (`grainUnitPrice`/`baleUnitPrice`): you
 * hauled the load to a Sell Point yourself, so you get the seasonal premium.
 *
 * These two are the INSTANT price (2026-07-23) — selling straight from the
 * Inventory panel, where a buyer collects. That forgoes the seasonal premium
 * entirely AND takes `market.instantSellPenaltyPct` off the base for pickup, so
 * it is always the worst price available. The gap between the two IS the Sell
 * task's reason to exist: at July's peak, hauling is worth ~24% more than
 * clicking sell (it was ~39% under the old, larger December premium).
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

/** Per-ton bunker silage price when sold instantly from Inventory (no season,
 * less fee) — same discount structure as grain/bales (2026-08-15). */
export function silageInstantPrice(product: SilageProduct): number {
  return gameConfig.silageProducts[product].pricePerTon * instantPriceFactor();
}

/** Calendar month (0-11) of a sim-time — convenience for callers that only
 * have `now`. */
export function monthOf(now: SimTime): number {
  return dateOf(now).month;
}
