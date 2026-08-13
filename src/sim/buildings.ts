/**
 * Farm buildings (maintainer request, 2026-07-12): storage + a rally point.
 * Purchasable/sellable point fixtures on the map — same money rules as land
 * and equipment (sell-back refunds the purchase price). Capacity numbers
 * (silo tons, barn slots, bale-storage counts) are computed here for the UI
 * and for a follow-up mechanics pass; nothing in the sim currently BLOCKS on
 * them (harvest/baling/equipment parking are unchanged this slice).
 *
 * Silos are SIZED like equipment (Small/Medium/Large — maintainer request,
 * 2026-07-12), each tier a bigger, cheaper-per-ton tank. Every other building
 * is one fixed size.
 */

import { gameConfig, tonsPerBushel } from "../config/gameConfig";
import type { CropId, EquipmentSize, BaleProduct, SilageProduct } from "../config/gameConfig";
import type { BuildingKind, Building, SaveState } from "../state/saveState";
import type { Meters } from "../geo/coords";
import { recordCash } from "./ledger";
import { minutesPerMonth } from "./calendar";

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
  sellPoint: "Sell Point",
  silageBunker: "Silage Bunker",
};

/** Buildings that come in Small/Medium/Large tiers, like equipment. Everything
 * else is one fixed size — asked in three places (name, price, purchase), so
 * it's stated once rather than repeating `kind === "silo" || …` at each. */
export function buildingIsSized(kind: BuildingKind): boolean {
  return kind === "silo" || kind === "silageBunker";
}

const SIZE_LABEL: Record<EquipmentSize, string> = { small: "Small", medium: "Medium", large: "Large" };

/** Display name including size tier for a silo ("Silo - Medium", maintainer
 * request 2026-07-13 — "<Kind> - <Size>" everywhere); everything else is
 * unsized (`BUILDING_NAME[kind]`). */
export function buildingDisplayName(kind: BuildingKind, size?: EquipmentSize): string {
  if (buildingIsSized(kind)) return `${BUILDING_NAME[kind]} - ${SIZE_LABEL[size ?? "small"]}`;
  return BUILDING_NAME[kind];
}

/** Price of a building — silos take a size (defaults to Small); every other
 * kind is one fixed price and ignores `size`. */
export function buildingPrice(kind: BuildingKind, size?: EquipmentSize): number {
  if (kind === "silo") return gameConfig.buildings.silo[size ?? "small"].price;
  if (kind === "silageBunker") return gameConfig.buildings.silageBunker[size ?? "small"].price;
  return gameConfig.buildings[kind].price;
}

/** Grain capacity of a single silo at `size`, BUSHELS — the real, crop-agnostic
 * figure (2026-07-24). A bin is a fixed volume. */
export function siloCapacityOf(size: EquipmentSize): number {
  return gameConfig.buildings.silo[size].capacityBushels;
}

/** That capacity in TONS of `crop`. `save.grain` is pooled in tons, so every
 * "is there room" check converts through here — and a bin therefore holds far
 * fewer tons of oats (32 lb/bu) than of corn (56), which is the whole point. */
export function siloCapacityTonsOf(size: EquipmentSize, crop: CropId): number {
  return siloCapacityOf(size) * tonsPerBushel(crop);
}

/** Buy a building and drop it at `pos`. `size` only applies to (and is
 * required to matter for) silos — defaults to Small. Throws if unaffordable. */
export function buyBuildingAt(save: SaveState, kind: BuildingKind, pos: Meters, size?: EquipmentSize): Building {
  const price = buildingPrice(kind, size);
  if (price > save.money) {
    throw new Error(`A ${buildingDisplayName(kind, size)} costs $${price.toLocaleString()} — not enough cash`);
  }
  save.money -= price;
  recordCash(save, "landEquipment", "Buildings", -price);
  const building: Building = { id: nextId("bld"), kind, pos, size: buildingIsSized(kind) ? (size ?? "small") : undefined };
  save.buildings.push(building);
  return building;
}

/** Sell a building back for its full purchase price (same rule as land/equipment). */
export function sellBuilding(save: SaveState, buildingId: string): { building: Building; refund: number } {
  const idx = save.buildings.findIndex((b) => b.id === buildingId);
  if (idx === -1) throw new Error(`Building ${buildingId} not found`);
  const building = save.buildings[idx]!;
  const refund = buildingPrice(building.kind, building.size);
  save.buildings.splice(idx, 1);
  save.money += refund;
  recordCash(save, "landEquipment", "Buildings", refund);
  return { building, refund };
}

/** Total grain storage across every owned Silo, BUSHELS, regardless of crop
 * assignment — the farm's total silo footprint. */
export function siloCapacityBushels(save: SaveState): number {
  return save.buildings
    .filter((b) => b.kind === "silo")
    .reduce((sum, b) => sum + siloCapacityOf(b.size ?? "small"), 0);
}

/** Grain storage assigned to `crop`, TONS OF THAT CROP — only silos dedicated
 * to it count, and each one's bushels convert at the crop's test weight. A silo
 * holds no capacity for anything until it's assigned. */
export function siloCapacityForCrop(save: SaveState, crop: CropId): number {
  return save.buildings
    .filter((b) => b.kind === "silo" && b.assignedCrop === crop)
    .reduce((sum, b) => sum + siloCapacityTonsOf(b.size ?? "small", crop), 0);
}

/** Assign (or clear, with `undefined`) which crop a Silo is dedicated to.
 * Throws if the building isn't a silo. */
export function assignSiloCrop(save: SaveState, buildingId: string, crop: CropId | undefined): void {
  const building = save.buildings.find((b) => b.id === buildingId);
  if (!building) throw new Error(`Building ${buildingId} not found`);
  if (building.kind !== "silo") throw new Error(`${BUILDING_NAME[building.kind]} can't be assigned a crop`);
  building.assignedCrop = crop;
}

/** True for the two bale-storage building kinds (Barn + Area). */
export function isBaleStorage(kind: BuildingKind): kind is "baleBarn" | "baleArea" {
  return kind === "baleBarn" || kind === "baleArea";
}

/** Bale capacity of one storage building. Both kinds are capped as of
 * 2026-07-24 — the outdoor Area used to be unlimited, which meant the hauler's
 * "storage full, go sell it instead" fallback could never fire once one existed. */
export function baleStorageCapacityOf(kind: "baleBarn" | "baleArea"): number {
  return gameConfig.buildings[kind].capacityBales;
}

/** Total bale storage across all owned Bale Barns + Bale Areas. */
export function baleCapacity(save: SaveState): number {
  return save.buildings.reduce((sum, b) => (isBaleStorage(b.kind) ? sum + baleStorageCapacityOf(b.kind) : sum), 0);
}

/** How many bales are physically stored in one building, summed across products. */
export function storedBalesTotal(building: Building): number {
  const s = building.storedBales;
  if (!s) return 0;
  let n = 0;
  for (const k in s) n += s[k as BaleProduct] ?? 0;
  return n;
}

/** Free bale slots in one storage building. */
export function baleStorageRoom(building: Building): number {
  if (!isBaleStorage(building.kind)) return 0;
  return baleStorageCapacityOf(building.kind) - storedBalesTotal(building);
}

/** Can this store take `product`? Unassigned stores accept anything (and may
 * then hold a mix); an assigned store only its one product. */
export function baleStorageAccepts(building: Building, product: BaleProduct): boolean {
  return isBaleStorage(building.kind) && (building.assignedProduct === undefined || building.assignedProduct === product);
}

/** The nearest Bale Storage to `from` that accepts `product` and has room —
 * where a bale hauler dumps its load (mirrors `nearestSiloForCrop`). The
 * caller re-checks room right before dumping (it can fill in between). */
export function nearestBaleStorageFor(save: SaveState, product: BaleProduct, from: Meters): Building | undefined {
  let best: Building | undefined;
  let bestD = Infinity;
  for (const b of save.buildings) {
    if (!isBaleStorage(b.kind) || !baleStorageAccepts(b, product) || baleStorageRoom(b) <= 0) continue;
    const d = Math.hypot(b.pos[0] - from[0], b.pos[1] - from[1]);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

/** The nearest Sell Point to `from`, if one's been built — a bale hauler's
 * fallback destination when no Bale Storage exists or all of it's full
 * (maintainer request, 2026-07-17). Unlike storage it has no capacity and
 * takes any product; the caller sells on arrival rather than storing. */
export function nearestSellPointFor(save: SaveState, from: Meters): Building | undefined {
  return nearestOfKind(save, "sellPoint", from);
}

/** Move up to `n` bales of `product` into `building`, clamped to its free room
 * (unlimited for an Area). Returns how many actually landed. */
export function haulBalesInto(building: Building, product: BaleProduct, n: number): number {
  const added = Math.max(0, Math.min(n, baleStorageRoom(building)));
  if (added <= 0) return 0;
  const s = (building.storedBales ??= {});
  s[product] = (s[product] ?? 0) + added;
  return added;
}

// ---------------------------------------------------------------------------
// SILAGE BUNKERS (2026-07-31, Phase 2)
//
// Deliberately the SIMPLEST storage in the game (maintainer decision: "treat
// it more like a silo for now"). Capacity in tons, pooled farm-wide across
// every bunker, no per-product assignment and no spoilage — a bunker is
// assumed sealed and packed. Cover/feed-out mechanics are a later slice.
// ---------------------------------------------------------------------------

/** Tons one bunker of this tier holds. */
export function bunkerCapacityOf(size: EquipmentSize): number {
  return gameConfig.buildings.silageBunker[size].capacityTons;
}

/** Total silage capacity across every bunker on the farm, tons. Unlike silos
 * this is NOT per-product: a bunker takes whatever's tipped into it. */
export function silageCapacityTons(save: SaveState): number {
  return save.buildings
    .filter((b) => b.kind === "silageBunker")
    .reduce((sum, b) => sum + bunkerCapacityOf(b.size ?? "small"), 0);
}

/** Tons of silage currently stored, all products. */
export function silageStoredTons(save: SaveState): number {
  if (!save.silage) return 0;
  return (Object.values(save.silage) as number[]).reduce((a, b) => a + b, 0);
}

/** Room left in the farm's bunkers, tons. */
export function silageRoomTons(save: SaveState): number {
  return Math.max(0, silageCapacityTons(save) - silageStoredTons(save));
}

/** Put silage into the bunkers, capped by room. Returns the tons ACCEPTED, so
 * the caller can reroute (or hold) whatever wouldn't fit — same contract as
 * `haulBalesInto`. */
export function storeSilage(save: SaveState, product: SilageProduct, tons: number): number {
  const accepted = Math.min(Math.max(0, tons), silageRoomTons(save));
  if (accepted <= 0) return 0;
  save.silage ??= { cornSilage: 0, haylage: 0, alfalfaHaylage: 0 };
  save.silage[product] = (save.silage[product] ?? 0) + accepted;
  return accepted;
}

/** The bunker nearest `from`, or undefined if the farm has none. */
export function nearestBunker(save: SaveState, from: Meters): Building | undefined {
  return nearestOfKind(save, "silageBunker", from);
}

/** Fraction of a bale store's contents lost per month to rot (2026-07-25). */
export function baleSpoilRateOf(kind: "baleBarn" | "baleArea"): number {
  return gameConfig.buildings[kind].spoilPctPerMonth;
}

/**
 * The monthly loss rate that actually applies to `product` sitting in `kind`.
 *
 * WRAPPED bales ignore the building entirely (2026-07-31): they're sealed in
 * plastic, so a stack of baleage on an open pad keeps as well as one under a
 * roof. That immunity IS the feature — it's what the wrapper, the film and the
 * extra pass are bought for, and it's why the Bale Barn and the Bale Wrapper
 * are deliberately competing answers to the same problem.
 */
export function baleSpoilRateFor(kind: "baleBarn" | "baleArea", product: BaleProduct): number {
  if (gameConfig.baleProducts[product].wrapped) return gameConfig.forage.wrappedSpoilPctPerMonth;
  return baleSpoilRateOf(kind);
}

/**
 * BALE ROT (maintainer request, 2026-07-25) — stored bales decay, outdoors far
 * faster than under cover.
 *
 * This is what finally makes the Bale Barn a real choice: it and the Bale Area
 * were mechanically identical, so the game charged $70k instead of $25k for
 * nothing. It's also the honest half of alfalfa's rebalance — hay's real
 * downside is that it doesn't keep, and hay is what gets stored as bales.
 *
 * Loss is a fraction of the pile per month, which almost never comes out as a
 * whole bale, so the remainder accrues in `building.spoilAccrued` and a bale
 * comes off each time it crosses 1. `storedBales` therefore stays integral —
 * bales are physical objects that get hauled, sold and drawn.
 *
 * Takes elapsed minutes rather than `now` so it's stateless, and decays
 * EXPONENTIALLY — `n * (1-rate)^months` — rather than taking a flat `rate` off
 * the starting count. That's not pedantry: a flat rate compounds when the sim
 * ticks finely and doesn't when it ticks coarsely, so the same six months would
 * cost differently depending on frame rate, and a reload's single catch-up jump
 * would be cheaper than having played it through. The exponential form gives
 * the same answer however the span is chopped up.
 */
export function tickBaleSpoilage(save: SaveState, dtMinutes: number): void {
  if (dtMinutes <= 0) return;
  const months = dtMinutes / minutesPerMonth();
  for (const b of save.buildings) {
    if (!isBaleStorage(b.kind)) continue;
    if (!b.storedBales) continue;
    for (const key of Object.keys(b.storedBales) as BaleProduct[]) {
      // Per-PRODUCT, not per-building: wrapped bales keep almost indefinitely
      // wherever they're stacked, so the rate has to be resolved inside the
      // loop rather than once for the whole store.
      const rate = baleSpoilRateFor(b.kind as "baleBarn" | "baleArea", key);
      if (rate <= 0) continue;
      const n = b.storedBales[key] ?? 0;
      if (n <= 0) {
        if (b.spoilAccrued) delete b.spoilAccrued[key];
        continue;
      }
      const accrued = (b.spoilAccrued?.[key] ?? 0) + n * (1 - Math.pow(1 - rate, months));
      const lost = Math.min(n, Math.floor(accrued));
      const remainder = accrued - lost;
      if (lost > 0) b.storedBales[key] = n - lost;
      if ((b.storedBales[key] ?? 0) <= 0) {
        // Pile gone — drop the leftover fraction rather than billing the next
        // load that arrives for rot that happened to a different one.
        delete b.storedBales[key];
        if (b.spoilAccrued) delete b.spoilAccrued[key];
      } else {
        (b.spoilAccrued ??= {})[key] = remainder;
      }
    }
  }
}

/** Assign (or clear, with `undefined`) which product a Bale Store is dedicated
 * to. Throws if the building isn't bale storage. */
export function assignBaleStorageProduct(save: SaveState, buildingId: string, product: BaleProduct | undefined): void {
  const building = save.buildings.find((b) => b.id === buildingId);
  if (!building) throw new Error(`Building ${buildingId} not found`);
  if (!isBaleStorage(building.kind)) throw new Error(`${BUILDING_NAME[building.kind]} can't store bales`);
  building.assignedProduct = product;
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

/** The nearest Silo assigned to `crop`, if one exists — where a Grain
 * Trailer hauls a load (maintainer request, 2026-07-12). Capacity is pooled
 * per crop (`siloCapacityForCrop`), not per building, so this only picks a
 * physical destination — the caller checks room separately. */
export function nearestSiloForCrop(save: SaveState, crop: CropId, from: Meters): Building | undefined {
  let best: Building | undefined;
  let bestD = Infinity;
  for (const b of save.buildings) {
    if (b.kind !== "silo" || b.assignedCrop !== crop) continue;
    const d = Math.hypot(b.pos[0] - from[0], b.pos[1] - from[1]);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}
