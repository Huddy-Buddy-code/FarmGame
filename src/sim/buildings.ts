/**
 * Farm buildings (maintainer request, 2026-07-12): storage + a rally point.
 * Purchasable/sellable point fixtures on the map — same money rules as land
 * and equipment (sell-back refunds the purchase price). Capacity numbers
 * (silo tons, barn slots, bale-storage counts) are computed here for the UI
 * and for a follow-up mechanics pass; nothing in the sim currently BLOCKS on
 * them (harvest/baling/equipment parking are unchanged this slice).
 */

import { gameConfig } from "../config/gameConfig";
import type { BuildingKind, Building, SaveState } from "../state/saveState";
import type { Meters } from "../geo/coords";

const seq: Record<string, number> = {};
const nextId = (prefix: string) => `${prefix}-${(seq[prefix] = (seq[prefix] ?? 0) + 1)}`;

/** After loading a save, continue the id sequence past the highest existing id. */
export function initBuildingIdCounters(save: SaveState): void {
  for (const id of save.buildings.map((b) => b.id)) {
    const m = /^(.+)-(\d+)$/.exec(id);
    if (m) seq[m[1]!] = Math.max(seq[m[1]!] ?? 0, Number(m[2]));
  }
}

export const BUILDING_NAME: Record<BuildingKind, string> = {
  silo: "Silo",
  baleBarn: "Bale Storage Barn",
  baleArea: "Bale Storage Area",
  tractorBarn: "Tractor Barn",
  implementBarn: "Implement Barn",
  farmYard: "Farm Yard",
};

export function buildingPrice(kind: BuildingKind): number {
  return gameConfig.buildings[kind].price;
}

/** Buy a building and drop it at `pos`. Throws if unaffordable. */
export function buyBuildingAt(save: SaveState, kind: BuildingKind, pos: Meters): Building {
  const price = buildingPrice(kind);
  if (price > save.money) {
    throw new Error(`A ${BUILDING_NAME[kind]} costs $${price.toLocaleString()} — not enough cash`);
  }
  save.money -= price;
  const building: Building = { id: nextId("bld"), kind, pos };
  save.buildings.push(building);
  return building;
}

/** Sell a building back for its full purchase price (same rule as land/equipment). */
export function sellBuilding(save: SaveState, buildingId: string): { building: Building; refund: number } {
  const idx = save.buildings.findIndex((b) => b.id === buildingId);
  if (idx === -1) throw new Error(`Building ${buildingId} not found`);
  const building = save.buildings[idx]!;
  const refund = buildingPrice(building.kind);
  save.buildings.splice(idx, 1);
  save.money += refund;
  return { building, refund };
}

/** Total grain storage across all owned Silos, tons. 0 if none built. */
export function siloCapacityTons(save: SaveState): number {
  const n = save.buildings.filter((b) => b.kind === "silo").length;
  return n * gameConfig.buildings.silo.capacityTons;
}

/** Total bale storage across all owned Bale Barns + Bale Areas. Computed for
 * the UI/future use — nothing currently caps bale creation against this. */
export function baleCapacity(save: SaveState): number {
  return save.buildings.reduce((sum, b) => {
    if (b.kind === "baleBarn") return sum + gameConfig.buildings.baleBarn.capacityBales;
    if (b.kind === "baleArea") return sum + gameConfig.buildings.baleArea.capacityBales;
    return sum;
  }, 0);
}

/** Max machines/implements a Tractor Barn / Implement Barn holds, and how many
 * such barns exist — for a future slot-occupancy pass. */
export function barnSlotTotal(save: SaveState, kind: "tractorBarn" | "implementBarn"): number {
  const n = save.buildings.filter((b) => b.kind === kind).length;
  return n * gameConfig.buildings[kind].slots;
}

/** The nearest building of `kind` to `from`, if any exist. */
export function nearestOfKind(save: SaveState, kind: BuildingKind, from: Meters): Building | undefined {
  let best: Building | undefined;
  let bestD = Infinity;
  for (const b of save.buildings) {
    if (b.kind !== kind) continue;
    const d = Math.hypot(b.pos[0] - from[0], b.pos[1] - from[1]);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

/** The nearest Farm Yard to `from`, if one's been built — the farm's rally
 * point / default spawn location for new equipment. */
export function nearestFarmYard(save: SaveState, from: Meters): Building | undefined {
  return nearestOfKind(save, "farmYard", from);
}
