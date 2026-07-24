/**
 * Economy — v0 placeholder sale (brief §12 step 5, simplified).
 *
 * Selling here is instant and at a flat config price: no buyers, no hauling, no
 * local-demand drop yet. It exists so the money loop closes (grow → sell →
 * reinvest) while the real market slice (brief §5: buyers with capacity, price
 * recovery, trucking on real roads) is built. That slice replaces THIS module's
 * internals; the call shape (sell some tons, get paid) stays.
 */

import { gameConfig } from "../config/gameConfig";
import type { CropId, BaleProduct } from "../config/gameConfig";
import type { SaveState, Field, Agent, Implement, Building } from "../state/saveState";
import { areaAcres } from "../geo/geometry";
import { agentPrice, implementPrice, appendCompletedTask, queueSellRun } from "./tasks";
import type { EquipmentKind } from "./tasks";
import { recordCash } from "./ledger";
import type { SimTime } from "./clock";
import { START_MONTH, MONTHS_PER_YEAR, minutesPerMonth } from "./calendar";
import { grainInstantPrice, baleInstantPrice, SELLABLE_GRAINS } from "./market";
import type { MarketProduct } from "./market";

export interface SaleResult {
  tons: number;
  revenue: number;
}

/**
 * Sell `tons` of `crop` from the bin (clamped to what's stored) at the current
 * month's SEASONAL price (`sim/market.ts`). Mutates the save; returns what
 * actually sold.
 */
export function sellGrain(save: SaveState, crop: CropId, tons: number, _now?: SimTime): SaleResult {
  const available = save.grain[crop];
  const sold = Math.min(available, Math.max(0, tons));
  if (sold <= 0) return { tons: 0, revenue: 0 };
  // INSTANT sale from the panel: base price less the pickup fee, no seasonal
  // premium (2026-07-23). Hauling it to a Sell Point yourself pays the full
  // seasonal rate -- that's the Sell task.
  const unit = grainInstantPrice(crop);
  const revenue = Math.round(sold * unit);
  save.grain[crop] -= sold;
  save.money += revenue;
  recordCash(save, "cropRevenue", gameConfig.crops[crop].name, revenue);
  return { tons: sold, revenue };
}

/**
 * Sell every bale sitting in `field` at the current month's seasonal price.
 * Mutates the save; returns what sold. Bales are tracked per-field and stay put
 * until sold — this is the field's "market interface."
 */
export function sellBales(save: SaveState, field: Field, _now?: SimTime): { bales: number; revenue: number } {
  const bales = field.baleLocations?.length ?? 0;
  if (bales <= 0) return { bales: 0, revenue: 0 };
  const productId = field.baleProduct ?? "cornStover";
  const product = gameConfig.baleProducts[productId];
  const unit = baleInstantPrice(productId); // instant pickup price -- see sellGrain
  const revenue = Math.round(bales * unit);
  field.baleLocations = [];
  save.money += revenue;
  // Book by product so the Finance cashflow breakdown separates hay/alfalfa/stover.
  recordCash(save, "cropRevenue", `${product.name} bales`, revenue);
  return { bales, revenue };
}

/** One product's aggregated bale stock across every field (Inventory tab). */
export interface BaleStock {
  product: BaleProduct;
  name: string;
  bales: number;
  pricePerBale: number;
  value: number;
  color: "hay" | "alfalfa";
}

/** Every bale sitting in every field, summed per product (2026-07-14) — the
 * Inventory tab's bale section. `pricePerBale`/`value` are at the current
 * month's seasonal price. Only products with at least one bale appear. */
export function baleInventory(save: SaveState, _now?: SimTime): BaleStock[] {
  const counts = new Map<BaleProduct, number>();
  for (const f of save.fields) {
    const n = f.baleLocations?.length ?? 0;
    if (n <= 0) continue;
    const product = f.baleProduct ?? "cornStover";
    counts.set(product, (counts.get(product) ?? 0) + n);
  }
  const out: BaleStock[] = [];
  for (const [product, bales] of counts) {
    const cfg = gameConfig.baleProducts[product];
    const unit = baleInstantPrice(product); // quote what clicking Sell pays
    out.push({ product, name: cfg.name, bales, pricePerBale: Math.round(unit), value: Math.round(bales * unit), color: cfg.color });
  }
  // Stable, readable order (highest value first).
  return out.sort((a, b) => b.value - a.value);
}

/** Sell the bales of `product` stored in one Bale Storage building at the flat
 * price (2026-07-17 — bales can now be hauled into storage). Mutates the save. */
export function sellStoredBalesFrom(save: SaveState, building: Building, product: BaleProduct, _now?: SimTime): { bales: number; revenue: number } {
  const bales = building.storedBales?.[product] ?? 0;
  if (bales <= 0) return { bales: 0, revenue: 0 };
  const cfg = gameConfig.baleProducts[product];
  const unit = baleInstantPrice(product); // instant pickup price -- see sellGrain
  const revenue = Math.round(bales * unit);
  building.storedBales![product] = 0;
  save.money += revenue;
  recordCash(save, "cropRevenue", `${cfg.name} bales`, revenue);
  return { bales, revenue };
}

/** Sell EVERY field's bales of one product at once (Inventory "Sell all"). */
export function sellBalesOfProduct(save: SaveState, product: BaleProduct, now: SimTime): { bales: number; revenue: number } {
  let bales = 0;
  let revenue = 0;
  for (const field of save.fields) {
    if ((field.baleLocations?.length ?? 0) === 0) continue;
    if ((field.baleProduct ?? "cornStover") !== product) continue;
    const r = sellBales(save, field, now);
    bales += r.bales;
    revenue += r.revenue;
  }
  return { bales, revenue };
}

// --- Auto-sell (maintainer request, 2026-07-21) ----------------------------

let autoSellSeq = 0;

/** Sell EVERYTHING of `product` currently in inventory at the current month's
 * price and log it to the Completed feed — grain from the bin, bale products
 * from every Bale-Storage building AND every field's loose bales. Used by the
 * scheduled auto-sell. */
export function sellAllOfProduct(save: SaveState, product: MarketProduct, now: SimTime): void {
  if ((SELLABLE_GRAINS as string[]).includes(product)) {
    const crop = product as CropId;
    const { tons, revenue } = sellGrain(save, crop, Infinity, now);
    if (tons > 0) {
      appendCompletedTask(save, {
        id: `autosell-${++autoSellSeq}`, type: "sellGrain", crop,
        label: gameConfig.crops[crop].name, tons, revenue, completedAt: now,
      });
    }
    return;
  }
  const p = product as BaleProduct;
  let bales = 0;
  let revenue = 0;
  for (const b of save.buildings) {
    if (b.kind !== "baleBarn" && b.kind !== "baleArea") continue;
    const r = sellStoredBalesFrom(save, b, p, now);
    bales += r.bales;
    revenue += r.revenue;
  }
  const fr = sellBalesOfProduct(save, p, now);
  bales += fr.bales;
  revenue += fr.revenue;
  if (bales > 0) {
    appendCompletedTask(save, {
      id: `autosell-${++autoSellSeq}`, type: "sellBales",
      label: gameConfig.baleProducts[p].name, bales, tons: bales * gameConfig.forage.baleTons,
      revenue, completedAt: now,
    });
  }
}

/**
 * Fire any due scheduled auto-sells (call once per tick, after `tickLoans`).
 * Loops over every month crossed since the last call — like `tickLoans`'s
 * payment loop — so it survives time-compression / skip-month and fires each
 * product's sell exactly once in its chosen month. Prices each month's sale at
 * that month's seasonal rate.
 */
export function tickAutoSell(save: SaveState, now: SimTime): void {
  save.sellSchedule ??= {};
  const curAbs = Math.floor(now / minutesPerMonth());
  if (save.sellLastMonthAbs === undefined) {
    // First run (new game / freshly-loaded save) — arm the cursor, never
    // retro-fire for months that already elapsed.
    save.sellLastMonthAbs = curAbs;
    return;
  }
  if (curAbs <= save.sellLastMonthAbs) return;
  for (let mAbs = save.sellLastMonthAbs + 1; mAbs <= curAbs; mAbs++) {
    const cal = (START_MONTH + mAbs) % MONTHS_PER_YEAR;
    const monthNow = mAbs * minutesPerMonth(); // a sim-time in that month → correct price
    for (const [product, sched] of Object.entries(save.sellSchedule)) {
      if (!sched.auto || sched.month !== cal) continue;
      // Prefer a real HAUL to a Sell Point: it fetches the full seasonal price
      // (2026-07-23). Falls back to the instant, discounted sale only when a
      // run isn't possible at all — no Sell Point built, or nothing free to
      // pull a trailer. A scheduled sell that silently did nothing would be
      // far worse than one that quietly took the lower price.
      const queued = queueSellRun(save, product);
      if (!queued) sellAllOfProduct(save, product as MarketProduct, monthNow);
    }
  }
  save.sellLastMonthAbs = curAbs;
}

/** A field's liquidation value — mirrors `sellField`'s refund exactly (what
 * was actually paid, not a recomputed market rate; brief request: sell-back
 * = purchase price). */
function fieldValue(field: Field): number {
  return field.purchaseCost ?? Math.round(areaAcres(field.boundary) * gameConfig.landPricePerAcre);
}

/** A machine's liquidation value — mirrors `sellAgent`'s refund. */
function agentValue(agent: Agent): number {
  return agent.purchaseCost ?? (agent.size ? agentPrice(agent.kind as EquipmentKind, agent.size) : 0);
}

/** An implement's liquidation value — mirrors `sellImplement`'s refund. */
function implementValue(impl: Implement): number {
  return impl.purchaseCost ?? implementPrice(impl.kind, impl.size);
}

export interface NetWorth {
  cash: number;
  landValue: number;
  equipmentValue: number;
  /** Total owed: this year's still-open borrowed balance + every locked
   * loan's remaining principal. */
  debt: number;
  total: number;
}

/**
 * Net worth = cash + land value + equipment value − debt (maintainer spec,
 * 2026-07-11, revised: loan debt IS subtracted — see `debt` below).
 * Land/equipment are valued at what they'd refund if sold right now (their
 * purchase price — the game's existing sell-back rule), not a recomputed
 * current-market rate.
 */
export function netWorth(save: SaveState): NetWorth {
  const landValue = save.fields.reduce((sum, f) => sum + fieldValue(f), 0);
  const equipmentValue =
    save.agents.reduce((sum, a) => sum + agentValue(a), 0) +
    save.implements.reduce((sum, i) => sum + implementValue(i), 0);
  const cash = save.money;
  const debt = save.finance.pendingPrincipal + save.finance.loans.reduce((sum, l) => sum + l.principal, 0);
  return { cash, landValue, equipmentValue, debt, total: cash + landValue + equipmentValue - debt };
}
