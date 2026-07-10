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
import type { CropId } from "../config/gameConfig";
import type { SaveState } from "../state/saveState";

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
  return { tons: sold, revenue };
}
