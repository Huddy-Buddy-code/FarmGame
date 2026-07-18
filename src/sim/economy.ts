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
import { agentPrice, implementPrice } from "./tasks";
import type { EquipmentKind } from "./tasks";
import { recordCash } from "./ledger";

export interface SaleResult {
  tons: number;
  revenue: number;
}

/**
 * Sell `tons` of `crop` from the bin (clamped to what's stored) at the flat
 * config price. Mutates the save; returns what actually sold.
 */
export function sellGrain(save: SaveState, crop: CropId, tons: number): SaleResult {
  const available = save.grain[crop];
  const sold = Math.min(available, Math.max(0, tons));
  if (sold <= 0) return { tons: 0, revenue: 0 };
  const revenue = Math.round(sold * gameConfig.crops[crop].sellPricePerTon);
  save.grain[crop] -= sold;
  save.money += revenue;
  recordCash(save, "cropRevenue", gameConfig.crops[crop].name, revenue);
  return { tons: sold, revenue };
}

/**
 * Sell every bale sitting in `field` at the flat config price. Mutates the save;
 * returns what sold. Bales are tracked per-field and stay put until sold (no
 * collection mechanic yet) — this is the field's "market interface."
 */
export function sellBales(save: SaveState, field: Field): { bales: number; revenue: number } {
  const bales = field.baleLocations?.length ?? 0;
  if (bales <= 0) return { bales: 0, revenue: 0 };
  const product = gameConfig.baleProducts[field.baleProduct ?? "cornStover"];
  const revenue = Math.round(bales * product.pricePerBale);
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
 * Inventory tab's bale section. Only products with at least one bale appear. */
export function baleInventory(save: SaveState): BaleStock[] {
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
    out.push({ product, name: cfg.name, bales, pricePerBale: cfg.pricePerBale, value: Math.round(bales * cfg.pricePerBale), color: cfg.color });
  }
  // Stable, readable order (highest value first).
  return out.sort((a, b) => b.value - a.value);
}

/** Sell the bales of `product` stored in one Bale Storage building at the flat
 * price (2026-07-17 — bales can now be hauled into storage). Mutates the save. */
export function sellStoredBalesFrom(save: SaveState, building: Building, product: BaleProduct): { bales: number; revenue: number } {
  const bales = building.storedBales?.[product] ?? 0;
  if (bales <= 0) return { bales: 0, revenue: 0 };
  const cfg = gameConfig.baleProducts[product];
  const revenue = Math.round(bales * cfg.pricePerBale);
  building.storedBales![product] = 0;
  save.money += revenue;
  recordCash(save, "cropRevenue", `${cfg.name} bales`, revenue);
  return { bales, revenue };
}

/** Sell EVERY field's bales of one product at once (Inventory "Sell all"). */
export function sellBalesOfProduct(save: SaveState, product: BaleProduct): { bales: number; revenue: number } {
  let bales = 0;
  let revenue = 0;
  for (const field of save.fields) {
    if ((field.baleLocations?.length ?? 0) === 0) continue;
    if ((field.baleProduct ?? "cornStover") !== product) continue;
    const r = sellBales(save, field);
    bales += r.bales;
    revenue += r.revenue;
  }
  return { bales, revenue };
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
