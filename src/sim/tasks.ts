/**
 * The work queue + agents (brief §9, §10) — plowing, planting, and harvesting
 * are TASKS that queue up, and discrete machines work through them one after
 * another. Machines drive a back-and-forth COVERAGE PATH across the field (see
 * `coverage.ts`) at a physical field speed, so a job's duration EMERGES from the
 * field's size and the implement's working width — no abstract acres/hour rate.
 *
 * Equipment model: a TRACTOR is a power unit that attaches an IMPLEMENT (a plow
 * or a planter — same widths/requirements, one hitched at a time). A tractor
 * pulls implements of its own size class or smaller. Plowing needs a tractor
 * WITH a plow; planting needs one WITH a planter (auto-swapped on pickup). The
 * COMBINE is self-contained (integral header). Each machine is the brief's §9
 * state machine: idle → drive to field → work the coverage path → next task.
 *
 * Money: costs are paid ON QUEUE (design decision 2026-07-10) — queueing a plow
 * or plant task charges immediately, and canceling a still-queued task refunds
 * in full. Machines/implements refund their purchase price on sell-back.
 *
 * Pure logic on the save-state (agents/implements/tasks are persisted in it): no
 * map, no DOM, so it's unit-testable like farming.ts.
 */

import { gameConfig, SIZE_RANK, FEET_TO_METERS, tonsPerBushel, SILAGE_PRODUCTS } from "../config/gameConfig";
// Re-exported: it lives in the config (a pure lookup) so `sim/buildings.ts` can
// use it without importing this module, which would be a cycle.
export { tonsPerBushel };
import type { CropId, EquipmentSize, BaleProduct, SilageProduct } from "../config/gameConfig";
import type { SimTime } from "./clock";
import type { SaveState, Field, FieldStatus, FarmTask, Agent, Implement, TaskType, FieldPlan, CompletedTask } from "../state/saveState";
import { dateOf } from "./calendar";
import { areaAcres, pointInPolygon } from "../geo/geometry";
import type { Meters } from "../geo/coords";
import {
  inPlantingWindow, canPlow, applyPlow, applyPlant, applyHarvestDone, applyBaleDone, applyWrapDone,
  canWrapBales, baleageProductFor, isWrappedProduct, resolveAgedBaleProduct, cropProducesWrappedBale,
  applyChopDone, silageProductForField, silageTonsPerAcreFor, cropMakesSilage, isChopOnlyCrop,
  applyMowDone, hasStandingCrop, inWeedingWindow, canFertilizeNow,
  isPerennial, balesPerAcreForField, canSeedPerennial, productivityMultiplier, baleProductForField, baleTonsOf,
  stampBaleProduct,
} from "./farming";
import { buildCoveragePath, buildHeadlandCoveragePath, sampleAt, acresDoneAt, distanceAtAcres, TASK_HEADLANDS } from "./coverage";
import type { CoveragePath } from "./coverage";
import {
  nearestFarmYard, nearestSiloForCrop, siloCapacityForCrop,
  nearestBaleStorageFor, haulBalesInto, nearestSellPointFor,
  nearestSilageBunkerFor, storeSilage,
} from "./buildings";
import type { Building } from "../state/saveState";
import { planRoute } from "./roadNet";
import type { RoadNetwork } from "./roadNet";
import { recordCash } from "./ledger";
import { recordFieldCash, recordFieldCrop } from "./fieldLedger";
import { grainUnitPrice, baleUnitPrice, silageUnitPrice, monthOf, SELLABLE_GRAINS } from "./market";
import { effectiveMonthFor, plowDueAt, plantDueAt } from "./schedule";

const ACRE_M2 = 4046.8564224;

/** Which agent kind performs each task type. */
export const TASK_AGENT_KIND: Record<TaskType, Agent["kind"]> = {
  plow: "tractor",
  plant: "tractor",
  harvest: "harvester",
  chop: "forageHarvester", // the silage counterpart of harvest
  // Perennial forage "harvest" — tractor + Mower, no combine. A Self-Propelled
  // Windrower can take it too (2026-07-24); this table holds the PRIMARY kind,
  // and `agentCanDoTask` is the real gate.
  mow: "tractor",
  mulch: "tractor", // optional post-harvest residue pass — tractor + Mulcher
  wrap: "tractor", // seals dropped round bales into baleage — tractor + Wrapper
  weed: "tractor",
  fertilize: "tractor",
  rake: "tractor",
  bale: "tractor",
  sell: "tractor", // hauls stored produce to a Sell Point
  unloadHarvester: "tractor",
  haulBales: "tractor",
};

let taskSeq = 0;

/** After loading a save, continue task ids past the highest existing one. */
export function initTaskIds(save: SaveState): void {
  for (const t of save.tasks) {
    const m = /^task-(\d+)$/.exec(t.id);
    if (m) taskSeq = Math.max(taskSeq, Number(m[1]));
  }
}

/** Buyable power units. The Self-Propelled Windrower (2026-07-24) is one:
 * unlike a Mower it is not pulled by anything, it IS the machine. */
export type EquipmentKind = "tractor" | "harvester" | "windrower" | "forageHarvester";

/**
 * Can this machine take this kind of task?
 *
 * `TASK_AGENT_KIND` is a 1:1 map, which was true until the windrower arrived —
 * mowing now has two answers (a tractor pulling a Mower, or a windrower on its
 * own), so every "is this my kind of job" check goes through here instead of
 * comparing against the table directly.
 */
export function agentCanDoTask(agent: Agent, type: TaskType): boolean {
  if (agent.kind === "windrower") return type === "mow";
  // A chopper does exactly one job (2026-07-31) — it can't plow, cut or
  // combine anything. Stated here rather than relying on the table so it can
  // never pick up a `mow` just because a tractor could.
  if (agent.kind === "forageHarvester") return type === "chop";
  return TASK_AGENT_KIND[type] === agent.kind;
}

/**
 * Which head a chopper needs for `crop` (2026-07-31) — the same crop-dependent
 * shape as `harvestHeaderKind`, and absent from `TASK_IMPLEMENT` for the same
 * reason.
 *
 * Corn (and Forage, its chop-only twin — 2026-08-12) is chopped STANDING,
 * whole plant, through row units. Grass and alfalfa are mowed and wilted
 * first, so the chopper picks the windrow up off the ground instead — which
 * is why haylage still needs the mower, and why a farm that only chops corn
 * or forage never buys a pickup head.
 */
export function chopHeadKind(crop: CropId): ImplementKind {
  return crop === "corn" || crop === "forage" ? "rowCropHead" : "pickupHead";
}

/** A windrower carries no implement — it IS the mower — so the implement
 * checks (own one, hitch it, be the preferred rig for it) don't apply to it. */
function needsImplementFor(agent: Agent, type: TaskType): ImplementKind | undefined {
  if (agent.kind === "windrower") return undefined;
  return TASK_IMPLEMENT[type];
}

/** An idle Self-Propelled Windrower, free to take a cut. Tractors stand down
 * from mowing while one exists, so the specialist machine isn't left parked
 * while a tractor ties itself up doing its job. */
function freeWindrower(save: SaveState): Agent | undefined {
  return save.agents.find((a) => a.kind === "windrower" && a.state === "idle" && !a.taskId);
}
/** Buyable implements: a plow (tills), a planter (seeds), a sprayer (weeds or
 * fertilizes), a Grain Trailer (hauls a full combine to a silo) — same widths/
 * requirements, a tractor hitches one at a time. */
export type ImplementKind =
  | "plow" | "planter" | "sprayer" | "rake" | "bailer" | "squareBaler" | "grainTrailer"
  | "mower" | "mulcher" | "haySpikes" | "baleTrailer"
  // Silage Phase 1 (2026-07-31): a wrapper seals dropped round bales into
  // baleage in a second pass; a combi baler rolls AND seals in one.
  | "baleWrapper" | "combiBaler"
  // Silage Phases 2-3: the forage wagon is the chopper's cart (it hitches to a
  // TRACTOR); the two heads hitch to the CHOPPER, like combine headers, and
  // which one a job needs depends on the crop — see `chopHeadKind`.
  | "forageWagon" | "rowCropHead" | "pickupHead"
  // Combine headers (2026-07-24). Unlike every other implement these hitch to a
  // HARVESTER, not a tractor, and which one a job needs depends on the CROP —
  // see `harvestHeaderKind`.
  | "cornHeader" | "grainHeader";

/**
 * Which header a combine needs to cut `crop` (maintainer decision, 2026-07-24).
 *
 * Corn is its own machine: row units that pull stalks down and strip the cobs
 * off. Everything else — soybeans, the small grains, canola, sunflowers — is cut
 * off at the base by a platform/draper header. So this is a real, if simple,
 * equipment decision: a corn-and-beans rotation needs BOTH headers, and a farm
 * that only grows small grains never buys a corn head at all.
 *
 * Crop-dependent, so harvest deliberately has no entry in `TASK_IMPLEMENT` —
 * same treatment as a sell run's trailer (`sellTrailerKind`).
 */
export function harvestHeaderKind(crop: CropId): ImplementKind {
  return crop === "corn" ? "cornHeader" : "grainHeader";
}

const EQUIPMENT_NAME: Record<EquipmentKind, string> = {
  tractor: "Tractor", harvester: "Combine", windrower: "Windrower", forageHarvester: "Forage Harvester",
};
const IMPLEMENT_NAME: Record<ImplementKind, string> = {
  plow: "Plow", planter: "Planter", sprayer: "Sprayer", rake: "Rake", bailer: "Round Baler",
  grainTrailer: "Grain Trailer", mower: "Mower", mulcher: "Mulcher", haySpikes: "Hay Spike", baleTrailer: "Bale Trailer",
  cornHeader: "Corn Header", grainHeader: "Grain Header", squareBaler: "Square Baler",
  baleWrapper: "Bale Wrapper", combiBaler: "Round Baler with Wrapper",
  forageWagon: "Forage Wagon", rowCropHead: "Forage Row-Crop Header", pickupHead: "Forage Pickup Header",
};

/**
 * Is this field's crop still waiting to be wrapped into baleage?
 *
 * True while a wrap task is queued/underway, and also for the gap between the
 * baler dropping bales and the wrap being queued — otherwise the eager
 * auto-haul (bales are collectable the moment they land) would carry them off
 * as hay before the wrapper ever got to them.
 *
 * Goes false the instant the same-month window shuts, so a field whose wrap
 * never happened releases its bales to the haulers instead of stranding them.
 *
 * Does NOT go false just because no Bale Wrapper is currently owned (removed
 * 2026-08-14, maintainer report: a Silage-crop field with a plain baler and
 * no wrapper was hauling off unwrapped — the exact bales the mechanic exists
 * to hold back). A field in this state instead stays held, and the wrap task
 * `tryEnqueue` puts in the queue sits there — correctly visible in the Work
 * Queue's blocked-work list (`TASK_IMPLEMENT.wrap` is set, so `blockedWork()`
 * already reports a queued task no owned implement can perform) rather than
 * silently downgrading the bales to hay. Buying a wrapper (or the window
 * closing — see above) is what resolves it.
 */
export function wrapPending(save: SaveState, field: Field, now: SimTime): boolean {
  if (tasksFor(save, field.id, "wrap").length > 0) return true;
  // A Silage crop (grassSilage/alfalfaSilage) wraps by design — no in-season
  // toggle needed, unlike the old grass/alfalfa silage toggle it replaced
  // (2026-08-13). `activePlan(field).wrap` still works as an explicit
  // override for anything else that might set it.
  if (!activePlan(field).wrap && !cropProducesWrappedBale(field.crop)) return false;
  // `canWrapBales` carries the same-month rule and the already-wrapped check
  // (a Combi Baler seals as it rolls, so its bales never reach here needing
  // anything further). `now` is threaded in rather than read off `save.clock`
  // — that field is a creation-time placeholder nothing ever updates, so
  // trusting it would silently evaluate the whole window against month zero.
  return canWrapBales(field, now);
}

/** Both baler kinds. Shape is the KIND now (2026-07-24), not a size tier —
 * which is what lets a Round and a Square baler both be Medium. A bale task
 * takes either, so every "does this rig have a baler" question goes through
 * here rather than naming one. */
const BALER_KINDS = ["bailer", "squareBaler", "combiBaler"] as const;
// Combi baler FIRST (2026-08-13) — used for a Silage-crop field so auto-hitch
// reaches for the machine that bales AND wraps in one pass before falling
// back to a plain baler. Every other crop uses `BALER_KINDS`'s order, where a
// combi baler (expensive, and would-be wasted wrap capability) is last.
const BALER_KINDS_WRAP_PREFERRED = ["combiBaler", "bailer", "squareBaler"] as const;
const BALER_KIND_SET: ReadonlySet<ImplementKind> = new Set<ImplementKind>(BALER_KINDS);

/** Is this implement a baler of any shape (round, square, or combi)? */
export function isBalerKind(kind: ImplementKind): boolean {
  return BALER_KIND_SET.has(kind);
}

/** The baler hitched to `agentId`, of any shape. */
function attachedBaler(save: SaveState, agentId: string): Implement | undefined {
  return save.implements.find((i) => i.attachedTo === agentId && isBalerKind(i.kind));
}

/** Which baler this rig would bale with: the one already hitched, else the best
 * one free in the yard. Undefined if it can't get hold of either.
 *
 * Bale is crop-independent but EQUIPMENT-dependent, so like a sell run's
 * trailer it has no fixed `TASK_IMPLEMENT` entry — the answer depends on what
 * the farm owns. */
function balerKindFor(save: SaveState, agent: Agent, preferCombi = false): ImplementKind | undefined {
  const held = attachedBaler(save, agent.id);
  if (held) return held.kind;
  const order = preferCombi ? BALER_KINDS_WRAP_PREFERRED : BALER_KINDS;
  for (const kind of order) if (availableImplementFor(save, agent, kind)) return kind;
  return undefined;
}
const SIZE_LABEL: Record<EquipmentSize, string> = { small: "Small", medium: "Medium", large: "Large" };

/** Ledger item label for each field-expense task type (hover breakdown in the
 * Finance tab's cashflow table). */
const FIELD_EXPENSE_ITEM: Partial<Record<TaskType, string>> = {
  plow: "Plowing", plant: "Planting", mow: "Mowing", mulch: "Mulching", weed: "Weeding", fertilize: "Fertilizing",
  rake: "Raking", bale: "Baling", harvest: "Harvesting", wrap: "Wrapping", chop: "Chopping",
};

/** Which implement kind a task type needs (undefined = none, e.g. harvest).
 * Weed and fertilize both use a sprayer; rake/bale use their own tools; mow
 * uses a Mower; unloadHarvester needs a Grain Trailer. Exported for the Work
 * Queue panel's per-task implement icon (main.ts). */
export const TASK_IMPLEMENT: Partial<Record<TaskType, ImplementKind>> = {
  plow: "plow", plant: "planter", mow: "mower", mulch: "mulcher", weed: "sprayer", fertilize: "sprayer",
  rake: "rake", unloadHarvester: "grainTrailer", haulBales: "haySpikes", wrap: "baleWrapper",
  // `bale` deliberately has NO fixed entry (2026-07-24): either baler kind can
  // do it, so it's resolved per rig by `balerKindFor` — same treatment as a
  // sell run's product-dependent trailer.
  // `sell` deliberately has NO fixed entry: which trailer it needs depends
  // on the product (grain vs bales), so it is resolved per task by
  // `sellTrailerKind` instead of read from this table.
};

/** Price of a power unit at a given size. */
export function agentPrice(kind: EquipmentKind, size: EquipmentSize): number {
  // The windrower is sold in one size only, so its price ignores `size`.
  if (kind === "windrower") return gameConfig.equipment.windrower.price;
  return kind === "harvester" ? gameConfig.equipment.harvester[size].price : gameConfig.equipment.tractor[size].price;
}

/**
 * How long a grain cart holding `tons` takes to empty into a silo or Sell
 * Point, in sim-minutes (2026-07-25).
 *
 * The silo leg used to be a flat `hauling.dumpMinutes` — ~10 seconds however
 * much was aboard, so a 1500 bu cart emptied as fast as an almost-empty one.
 * That was a free pass at precisely the end of the loop that's meant to be the
 * harvest bottleneck. Rate-based now, at a cart auger's own (faster than the
 * combine-limited `unloadTonsPerMinute`) rate.
 *
 * Keeps a floor of `dumpMinutes` so a near-empty cart still pauses to hook up
 * rather than teleporting through the phase.
 */
export function grainDumpMinutes(tons: number): number {
  return Math.max(gameConfig.hauling.dumpMinutes, Math.max(0, tons) / gameConfig.hauling.dumpTonsPerMinute);
}

/** Cutting width (meters) of the Self-Propelled Windrower. */
export function windrowerWidthM(): number {
  return gameConfig.equipment.windrower.widthFt * FEET_TO_METERS;
}

/** Grain hopper VOLUME of a combine at `size`, bushels. */
export function harvesterCapacityBushels(size: EquipmentSize): number {
  return gameConfig.equipment.harvester[size].capacityBushels;
}

/** Cargo VOLUME of a Grain Trailer at `size`, bushels. */
export function grainTrailerCapacityBushels(size: EquipmentSize): number {
  return gameConfig.equipment.grainTrailer[size].capacityBushels;
}

/**
 * How many TONS of `crop` a combine of `size` can hold — its bushel capacity
 * converted at that crop's test weight (2026-07-24; it used to be a flat
 * per-tier tonnage). Light crops fill the tank sooner: a 500 bu tank is ~14 t of
 * corn but only ~7 t of sunflowers.
 *
 * `crop` is optional so the shop and other crop-less display contexts can still
 * quote a representative figure; they get corn's.
 */
export function harvesterCapacityTons(size: EquipmentSize, crop: CropId = "corn"): number {
  return harvesterCapacityBushels(size) * tonsPerBushel(crop);
}

/** Tons of `crop` a Grain Trailer at `size` can carry. See `harvesterCapacityTons`. */
export function grainTrailerCapacityTons(size: EquipmentSize, crop: CropId = "corn"): number {
  return grainTrailerCapacityBushels(size) * tonsPerBushel(crop);
}

/** How many bales the Hay Spikes hold at `size` (Small 1 / Medium 2). */
export function haySpikesCapacityBales(size: EquipmentSize): number {
  return gameConfig.equipment.haySpikes[size].capacityBales;
}

/** How many bales a Bale Trailer holds at `size` (Small 10 / Medium 20). */
export function baleTrailerCapacityBales(size: EquipmentSize): number {
  return gameConfig.equipment.baleTrailer[size].capacityBales;
}

/** Manual escape hatch (maintainer request, 2026-07-13): a harvester with
 * grain onboard but no `lastCrop` on record (a leftover from before that
 * tracking existed, sitting alongside 2+ crops' worth of silos so the
 * automatic same-crop-silo guess can't disambiguate) has no other way to
 * ever get unstuck — this lets the player just say what's in the hopper. */
export function setHarvesterCrop(save: SaveState, agentId: string, crop: CropId): void {
  const agent = save.agents.find((a) => a.id === agentId);
  if (!agent || agent.kind !== "harvester") throw new Error(`No such combine`);
  if (!((agent.grainOnboard ?? 0) > 0)) throw new Error(`${agent.name} has no grain onboard`);
  agent.lastCrop = crop;
}

/** Config (price + width) for each implement kind, by size. */
const IMPLEMENT_CONFIG: Record<ImplementKind, Record<EquipmentSize, { price: number; widthFt: number }>> = {
  plow: gameConfig.equipment.plow,
  planter: gameConfig.equipment.planter,
  sprayer: gameConfig.equipment.sprayer,
  rake: gameConfig.equipment.rake,
  bailer: gameConfig.equipment.bailer,
  squareBaler: gameConfig.equipment.squareBaler,
  baleWrapper: gameConfig.equipment.baleWrapper,
  combiBaler: gameConfig.equipment.combiBaler,
  forageWagon: gameConfig.equipment.forageWagon,
  rowCropHead: gameConfig.equipment.rowCropHead,
  pickupHead: gameConfig.equipment.pickupHead,
  grainTrailer: gameConfig.equipment.grainTrailer,
  mower: gameConfig.equipment.mower,
  mulcher: gameConfig.equipment.mulcher,
  haySpikes: gameConfig.equipment.haySpikes,
  baleTrailer: gameConfig.equipment.baleTrailer,
  cornHeader: gameConfig.equipment.cornHeader,
  grainHeader: gameConfig.equipment.grainHeader,
};

/** Price of an implement at a given size. */
export function implementPrice(kind: ImplementKind, size: EquipmentSize): number {
  return IMPLEMENT_CONFIG[kind][size].price;
}

/** The header kind a harvest task needs, from the crop standing in its field
 * (the task itself may not carry a crop — a panel-queued harvest doesn't set
 * one). Undefined when the field/crop can't be resolved. */
function headerKindForTask(save: SaveState, task: FarmTask): ImplementKind | undefined {
  const crop = task.crop ?? save.fields.find((f) => f.id === task.fieldId)?.crop;
  return crop ? harvestHeaderKind(crop) : undefined;
}

/** The chopper head a chop task needs, from the crop in its field. A perennial
 * has already been mowed by the time the chopper arrives, so `crop` is still
 * set on the stand; an annual reads `lastCrop` once cleared. */
export function chopHeadKindForTask(save: SaveState, task: FarmTask): ImplementKind | undefined {
  const field = save.fields.find((f) => f.id === task.fieldId);
  const crop = task.crop ?? field?.crop ?? field?.lastCrop;
  return crop ? chopHeadKind(crop) : undefined;
}

/**
 * Should (and can) this field be chopped for silage right now? Requires the
 * farm to actually be equipped (a chopper, a wagon, the right head) — missing
 * gear falls back to the grain/hay route rather than stranding the field, the
 * same "auto-manage never traps" rule the baler already follows.
 *
 * TWO different reasons a field can be chop-eligible (2026-08-12):
 *  - PERENNIAL (grass/alfalfa): chop-vs-bale is a real in-season choice each
 *    cutting, so the plan's `silage` toggle still decides it.
 *  - ANNUAL (Forage): the choice was already made at PLANTING — it's a
 *    separate crop from Corn with no combine route at all
 *    (`isChopOnlyCrop`) — so it always chops once equipped, no toggle. A
 *    grain annual (corn, soy, …) has no chop route to opt into any more.
 */
export function canChopField(save: SaveState, field: Field): boolean {
  const crop = field.crop ?? field.lastCrop;
  if (!cropMakesSilage(crop)) return false;
  if (isPerennial(crop)) {
    if (!activePlan(field).silage) return false;
  } else if (!isChopOnlyCrop(crop)) {
    return false;
  }
  if (!save.agents.some((a) => a.kind === "forageHarvester")) return false;
  if (!save.implements.some((i) => i.kind === "forageWagon")) return false;
  return save.implements.some((i) => i.kind === chopHeadKind(crop!));
}

/** Does the farm own a forage wagon at all? The chopper's hard prerequisite —
 * it has no tank, so with nothing to unload into it cannot work (maintainer
 * requirement, 2026-07-31). */
function farmHasForageWagon(save: SaveState): boolean {
  return save.implements.some((i) => i.kind === "forageWagon");
}

/** Working width (meters) of an implement. */
export function implementWidthM(impl: Implement): number {
  return IMPLEMENT_CONFIG[impl.kind][impl.size].widthFt * FEET_TO_METERS;
}

/** Can a tractor of `tractorSize` pull an implement of `implSize`? (its class
 * or smaller) — except the Hay Spike (`implKind`, optional so existing
 * 2-arg callers/tests are unaffected), which breaks that rule on purpose
 * (maintainer request, 2026-08-14): a bale spear needs no real horsepower,
 * so it's open to Small AND Medium tractors regardless of its own "medium"
 * shop size, but capped away from Large — the one machine on the farm that
 * DOESN'T get to do a smaller tractor's errand just because it's bigger. */
export function canPull(tractorSize: EquipmentSize, implSize: EquipmentSize, implKind?: ImplementKind): boolean {
  if (implKind === "haySpikes") return tractorSize !== "large";
  return SIZE_RANK[implSize] <= SIZE_RANK[tractorSize];
}

/** Display name for a machine/implement including its size ("Plow - Medium",
 * maintainer request, 2026-07-13 — "<Kind> - <Size>" everywhere, not the
 * old "<Size> <Kind>" order). */
function sizedName(base: string, size: EquipmentSize, n: number): string {
  const sized = `${base} - ${SIZE_LABEL[size]}`;
  return n === 1 ? sized : `${sized} ${n}`;
}

/** A display name not already taken — "Tractor - Medium", then
 * "Tractor - Medium 2", 3, … — so names stay unique even after machines are
 * bought and sold. */
function uniqueName(taken: string[], base: string): string {
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/** Make sure the starting fleet exists (also upgrades pre-agent saves): a medium
 * tractor + medium combine, plus a medium plow hitched to the tractor so plowing
 * works out of the box. `home` is where machines park (county center v1). */
export function ensureAgents(save: SaveState, home: Meters): void {
  save.implements ??= [];
  // Only seed/migrate the starter fleet once ever — otherwise selling
  // equipment down to zero on a later reload would just re-grant it free.
  if (!save.starterFleetGranted) {
    // Migrate/seed power units.
    for (const kind of ["tractor", "harvester"] as const) {
      if (!save.agents.some((a) => a.kind === kind)) {
        save.agents.push(makeAgent(save, kind, "medium", home));
      }
    }
    // Seed a medium plow attached to a tractor, if the farm owns no plow yet.
    if (!save.implements.some((i) => i.kind === "plow")) {
      const impl = makeImplement(save, "plow", "medium");
      const tractor = save.agents.find((a) => a.kind === "tractor");
      if (tractor) impl.attachedTo = tractor.id;
      save.implements.push(impl);
    }
    // Seed a medium planter, parked in the yard (a tractor only hitches one
    // implement at a time — it swaps in when a plant task comes up).
    if (!save.implements.some((i) => i.kind === "planter")) {
      save.implements.push(makeImplement(save, "planter", "medium"));
    }
    save.starterFleetGranted = true;
  }
  // Combine headers (2026-07-24). A combine cannot cut without one, so this
  // runs for EVERY save, not just fresh ones: an existing farm's combine would
  // otherwise be silently bricked by the update. Its own flag, because older
  // saves already have `starterFleetGranted` set and would skip the block above.
  // Both kinds are granted — a farm handed a combine that can only cut half its
  // rotation isn't a decision, it's a papercut. The choice still bites later:
  // a Large combine wants a Large header to use its width, and a sold header
  // has to be replaced.
  // Balers: shape used to be the SIZE TIER (Large == square, 2026-07-24 morning)
  // and is now the implement KIND. Convert in place so a save made in between
  // keeps the machine it paid for — a Large baler WAS a square baler.
  for (const impl of save.implements) {
    if (impl.kind === "bailer" && impl.size === "large") {
      impl.kind = "squareBaler";
      impl.size = "medium";
    } else if (impl.kind === "bailer" && impl.size === "small") {
      impl.size = "medium"; // the Small tier is gone; it was never more than a cheaper Medium
    }
  }
  if (!save.headersGranted) {
    for (const kind of ["cornHeader", "grainHeader"] as const) {
      if (!save.implements.some((i) => i.kind === kind)) {
        save.implements.push(makeImplement(save, kind, "medium"));
      }
    }
    const combine = save.agents.find((a) => a.kind === "harvester");
    const corn = save.implements.find((i) => i.kind === "cornHeader" && !i.attachedTo);
    if (combine && corn) corn.attachedTo = combine.id;
    save.headersGranted = true;
  }
  for (const a of save.agents) {
    if (parksInBarn(a)) {
      a.size ??= "medium"; // pre-size saves default to medium
      a.purchaseCost ??= agentPrice(a.kind as EquipmentKind, a.size);
    }
  }
  // De-dup display names (older saves numbered by live count, which could collide
  // once a machine had been sold — e.g. two "Medium Tractor 2"). Keep the first,
  // renumber later clashes.
  const taken = new Set<string>();
  for (const a of save.agents) {
    if (taken.has(a.name)) a.name = uniqueName([...taken], a.name.replace(/ \d+$/, ""));
    taken.add(a.name);
  }
}

function makeAgent(save: SaveState, kind: EquipmentKind, size: EquipmentSize, pos: Meters): Agent {
  let n = 1;
  while (save.agents.some((a) => a.id === `${kind}-${n}`)) n++;
  // Unique display name within the fleet ("Tractor - Medium", "Tractor - Medium 2"…).
  // The windrower is sold in one size, so a size suffix would be noise.
  const base = kind === "windrower" ? EQUIPMENT_NAME[kind] : `${EQUIPMENT_NAME[kind]} - ${SIZE_LABEL[size]}`;
  return {
    id: `${kind}-${n}`,
    kind,
    name: uniqueName(save.agents.map((a) => a.name), base),
    size,
    pos,
    state: "idle",
    purchaseCost: agentPrice(kind, size),
  };
}

function makeImplement(save: SaveState, kind: ImplementKind, size: EquipmentSize): Implement {
  let n = 1;
  while (save.implements.some((i) => i.id === `${kind}-${n}`)) n++;
  return { id: `${kind}-${n}`, kind, size, purchaseCost: implementPrice(kind, size) };
}

/** Display name for an implement including its size, numbered within its class. */
export function implementName(save: SaveState, impl: Implement): string {
  const peers = save.implements.filter((i) => i.kind === impl.kind && i.size === impl.size);
  const nth = peers.indexOf(impl) + 1;
  return sizedName(IMPLEMENT_NAME[impl.kind], impl.size, nth);
}

/** Buy a power unit at a given size (brief §8 capital). Parks at `home`, starts
 * pulling from the queue immediately. Throws if unaffordable. */
export function buyAgent(save: SaveState, kind: EquipmentKind, size: EquipmentSize, home: Meters): Agent {
  const price = agentPrice(kind, size);
  if (price > save.money) {
    throw new Error(`A ${SIZE_LABEL[size].toLowerCase()} ${EQUIPMENT_NAME[kind].toLowerCase()} costs $${price.toLocaleString()} — not enough cash`);
  }
  save.money -= price;
  recordCash(save, "landEquipment", `${EQUIPMENT_NAME[kind]}s`, -price);
  const agent = makeAgent(save, kind, size, home);
  save.agents.push(agent);
  return agent;
}

/** Buy an implement at a given size. Parks unattached in the yard. */
export function buyImplement(save: SaveState, kind: ImplementKind, size: EquipmentSize): Implement {
  const price = implementPrice(kind, size);
  if (price > save.money) {
    throw new Error(`A ${SIZE_LABEL[size].toLowerCase()} ${IMPLEMENT_NAME[kind].toLowerCase()} costs $${price.toLocaleString()} — not enough cash`);
  }
  save.money -= price;
  recordCash(save, "landEquipment", `${IMPLEMENT_NAME[kind]}s`, -price);
  const impl = makeImplement(save, kind, size);
  save.implements.push(impl);
  return impl;
}

/**
 * Sell a power unit back for its purchase price (same rule as land). Any attached
 * implement drops back to the yard (kept, not sold). Refuses if it's mid-job, or
 * if it's the last tractor/combine while jobs that need it are still queued.
 */
export function sellAgent(save: SaveState, agentId: string): { agent: Agent; refund: number } {
  const idx = save.agents.findIndex((a) => a.id === agentId);
  if (idx === -1) throw new Error(`Machine ${agentId} not found`);
  const agent = save.agents[idx]!;
  if (agent.state !== "idle") {
    throw new Error(`${agent.name} is mid-job — let it finish first`);
  }
  if (agent.kind === "harvester" && (agent.grainOnboard ?? 0) > 0) {
    throw new Error(`${agent.name} still has ${(agent.grainOnboard ?? 0).toFixed(1)}t of grain onboard — get it unloaded first`);
  }
  const lastOfKind = !save.agents.some((a) => a.id !== agentId && a.kind === agent.kind);
  const kindHasWork = save.tasks.some((t) => agentCanDoTask(agent, t.type));
  if (lastOfKind && kindHasWork) {
    throw new Error(`Jobs are waiting for your only ${EQUIPMENT_NAME[agent.kind as EquipmentKind]?.toLowerCase() ?? agent.kind} — cancel them first`);
  }
  // Unhitch anything it was carrying (implement stays in the yard).
  for (const impl of save.implements) if (impl.attachedTo === agentId) impl.attachedTo = undefined;
  const refund = agent.purchaseCost ?? (agent.size ? agentPrice(agent.kind as EquipmentKind, agent.size) : 0);
  save.agents.splice(idx, 1);
  save.money += refund;
  recordCash(save, "landEquipment", `${EQUIPMENT_NAME[agent.kind as EquipmentKind] ?? "Machine"}s`, refund);
  return { agent, refund };
}

/** Sell an implement back for its purchase price. Unhitches first; refuses if the
 * tractor it's on is mid-job. */
export function sellImplement(save: SaveState, implId: string): { impl: Implement; refund: number } {
  const idx = save.implements.findIndex((i) => i.id === implId);
  if (idx === -1) throw new Error(`Implement ${implId} not found`);
  const impl = save.implements[idx]!;
  if (impl.attachedTo) {
    const host = save.agents.find((a) => a.id === impl.attachedTo);
    if (host && host.state !== "idle") {
      throw new Error(`${host.name} is using that ${IMPLEMENT_NAME[impl.kind].toLowerCase()} — let it finish first`);
    }
  }
  if ((impl.cargoBales ?? 0) > 0) {
    throw new Error(`That ${IMPLEMENT_NAME[impl.kind].toLowerCase()} still has ${impl.cargoBales} bale(s) loaded — deliver them first`);
  }
  const refund = impl.purchaseCost ?? implementPrice(impl.kind, impl.size);
  save.implements.splice(idx, 1);
  save.money += refund;
  recordCash(save, "landEquipment", `${IMPLEMENT_NAME[impl.kind]}s`, refund);
  return { impl, refund };
}

/** Hitch an implement to a tractor. Enforces the pull-size rule and unhitches
 * whatever either side was previously attached to. Refuses while the tractor is
 * mid-job. */
export function attachImplement(save: SaveState, tractorId: string, implId: string): void {
  const tractor = save.agents.find((a) => a.id === tractorId);
  const impl = save.implements.find((i) => i.id === implId);
  if (!tractor || tractor.kind !== "tractor") throw new Error(`No such tractor`);
  if (!impl) throw new Error(`No such implement`);
  if (tractor.state !== "idle") throw new Error(`${tractor.name} is mid-job`);
  if (!tractor.size || !canPull(tractor.size, impl.size, impl.kind)) {
    throw new Error(`${tractor.name} can't pull a ${SIZE_LABEL[impl.size].toLowerCase()} ${IMPLEMENT_NAME[impl.kind].toLowerCase()}`);
  }
  // One implement per tractor: detach whatever the tractor currently holds, and
  // detach this implement from any other tractor.
  for (const i of save.implements) if (i.attachedTo === tractorId) i.attachedTo = undefined;
  impl.attachedTo = tractorId;
}

/** Unhitch an implement (park it in the yard). Refuses while its tractor works. */
export function detachImplement(save: SaveState, implId: string): void {
  const impl = save.implements.find((i) => i.id === implId);
  if (!impl) throw new Error(`No such implement`);
  if (impl.attachedTo) {
    const host = save.agents.find((a) => a.id === impl.attachedTo);
    if (host && host.state !== "idle") throw new Error(`${host.name} is mid-job`);
  }
  impl.attachedTo = undefined;
}

/** The implement of `kind` currently hitched to `tractor`, if any. */
function attachedImplement(save: SaveState, tractorId: string, kind: ImplementKind): Implement | undefined {
  return save.implements.find((i) => i.attachedTo === tractorId && i.kind === kind);
}

/** An idle, unattached implement of `kind` this tractor could hitch (largest
 * that fits first). */
function availableImplementFor(save: SaveState, tractor: Agent, kind: ImplementKind): Implement | undefined {
  return save.implements
    .filter((i) => i.kind === kind && !i.attachedTo && tractor.size && canPull(tractor.size, i.size, kind))
    .sort((a, b) => SIZE_RANK[b.size] - SIZE_RANK[a.size])[0];
}

/** Can this tractor take a task needing `kind` right now — does it have (or can
 * it hitch) that implement? Used both for task assignment and UI hints. */
function tractorCanUse(save: SaveState, tractor: Agent, kind: ImplementKind): boolean {
  return !!attachedImplement(save, tractor.id, kind) || !!availableImplementFor(save, tractor, kind);
}

/**
 * A POWER UNIT — a machine the player buys and parks, as opposed to an
 * implement it tows. All three park in a Tractor Barn (or the Farm Yard)
 * between jobs and all three count against a barn's slots.
 *
 * Worth a named predicate rather than an inline "tractor or harvester": that
 * phrase was written in three places before the windrower existed, and every
 * one of them silently excluded it — it never drove home after a cut, and a
 * barn it was parked in counted as having a free slot (maintainer report,
 * 2026-07-24).
 */
function parksInBarn(agent: Agent): boolean {
  // forageHarvester joined 2026-08-14 — same class of bug the windrower had
  // (maintainer report): a machine kind added after this predicate existed
  // just never got listed, so it stood exactly where it finished its last
  // job forever instead of driving home.
  return agent.kind === "tractor" || agent.kind === "harvester" || agent.kind === "windrower" || agent.kind === "forageHarvester";
}

/** A tractor free to be given a new job right now. */
function isFreeTractor(a: Agent): boolean {
  return a.kind === "tractor" && a.state === "idle" && !a.taskId && !!a.size;
}

/**
 * Which tractor SHOULD take a job needing `kind`: the one that can pull the
 * biggest implement available for it, and among those, the smallest tractor
 * that can manage it (maintainer request, 2026-07-23).
 *
 * The old behavior fell out of processing agents smallest-first: the smallest
 * idle tractor grabbed the job and then hitched the largest implement IT could
 * pull. So a farm with a small tractor idle would do a 400-acre field with a
 * 5-foot plow while a large tractor and a 20-foot plow both sat in the yard.
 * Picking the implement FIRST inverts that — take the widest tool on the farm,
 * then the smallest power unit that can actually pull it, which keeps the big
 * tractors free for the jobs only they can do.
 *
 * Returns null when no rig exists (caller then leaves assignment alone, so
 * combines and other implement-less work are unaffected).
 */
function preferredTractorFor(save: SaveState, kind: ImplementKind): Agent | null {
  const free = save.agents.filter(isFreeTractor);
  if (free.length === 0) return null;
  // Candidate implements: unhitched ones (anybody can take them), plus ones
  // already hitched to a free tractor — those come with their tractor fixed,
  // which mirrors what `availableImplementFor` will actually do at hitch time.
  const candidates: Array<{ impl: Implement; only?: Agent }> = [];
  for (const impl of save.implements) {
    if (impl.kind !== kind) continue;
    if (!impl.attachedTo) candidates.push({ impl });
    else {
      const host = free.find((a) => a.id === impl.attachedTo);
      if (host) candidates.push({ impl, only: host });
    }
  }
  if (candidates.length === 0) return null;
  // Widest tool first; for each, the smallest tractor that can pull it.
  candidates.sort((a, b) => SIZE_RANK[b.impl.size] - SIZE_RANK[a.impl.size]);
  for (const { impl, only } of candidates) {
    if (only) {
      if (canPull(only.size!, impl.size, impl.kind)) return only;
      continue;
    }
    const puller = free
      .filter((a) => canPull(a.size!, impl.size, impl.kind))
      .sort((a, b) => SIZE_RANK[a.size!] - SIZE_RANK[b.size!])[0];
    if (puller) return puller;
  }
  return null;
}

/** Can this tractor take a plow task right now — does it have (or can it hitch) a
 * plow? Used both for task assignment and UI hints. */
export function tractorCanPlow(save: SaveState, tractor: Agent): boolean {
  return tractorCanUse(save, tractor, "plow");
}

/** Can this tractor take a plant task right now — does it have (or can it hitch)
 * a planter? Used both for task assignment and UI hints. */
export function tractorCanPlant(save: SaveState, tractor: Agent): boolean {
  return tractorCanUse(save, tractor, "planter");
}

/**
 * Couldn't afford a task. A distinct error TYPE rather than a message string so
 * auto-manage can tell "you're broke" (worth telling the player about — it will
 * never resolve on its own) apart from the many benign reasons an enqueue is
 * refused mid-tick, like being out of season (2026-07-23). Its message is still
 * player-facing — the manual queue buttons show it as-is.
 */
export class InsufficientFundsError extends Error {
  constructor(readonly cost: number, readonly available: number) {
    super(`That costs $${Math.round(cost).toLocaleString()} — not enough cash`);
    this.name = "InsufficientFundsError";
  }
}

/** All not-yet-finished tasks for a field (optionally of one type). */
export function tasksFor(save: SaveState, fieldId: string, type?: TaskType): FarmTask[] {
  return save.tasks.filter((t) => t.fieldId === fieldId && (!type || t.type === type));
}

/** Is an agent actively harvesting this field right now? */
export function isFieldHarvesting(save: SaveState, fieldId: string): boolean {
  return save.tasks.some((t) => t.fieldId === fieldId && t.type === "harvest" && t.status === "active");
}

/** Does the farm own the gear to bale — at least one rake AND one baler? Baling
 * is only *required* before re-plowing when the player can actually do it; a
 * farm with no baler just plows the residue under (so auto-manage never traps). */
export function forageEquipped(save: SaveState): boolean {
  const baler = save.implements.some((i) => i.kind === "bailer" || i.kind === "squareBaler");
  return baler && save.implements.some((i) => i.kind === "rake");
}

/**
 * Does this field's residue have to be RAKED into windrows before the baler can
 * run? True for hay crops; false for small-grain STRAW (maintainer decision,
 * 2026-07-23) — a combine already drops straw in a windrow behind it, so a
 * separate raking pass is redundant, which is also how it works in reality.
 */
export function needsRakeBeforeBaling(field: Field): boolean {
  return baleProductForField(field) !== "straw";
}

/** The gear needed to bale THIS field: always a baler, plus a rake unless the
 * field's residue is straw. Used so a straw-only farm isn't told it can't bale
 * for want of a rake it will never use. */
export function baleEquippedFor(save: SaveState, field: Field): boolean {
  if (!save.implements.some((i) => i.kind === "bailer" || i.kind === "squareBaler")) return false;
  return !needsRakeBeforeBaling(field) || save.implements.some((i) => i.kind === "rake");
}

/** Does this field still owe a rake + bale before it can be re-plowed? True only
 * for a harvested forage field on a farm that owns the baling gear. */
export function forageDue(save: SaveState, field: Field): boolean {
  return field.status === "harvested" && !!field.forageReady && baleEquippedFor(save, field);
}

/**
 * Can this field take an (optional) mulch pass right now?
 *
 * Every ANNUAL crop is mulchable (maintainer request, 2026-07-23), in any of
 * three states: freshly `harvested` with its residue still down (the full
 * `mulchBonusPct`), `mulched` — the clean surface a bale run leaves — where
 * only the stubble is left to work in (the reduced `mulchBonusBaledPct`, via
 * `Field.residueBaled`), or `withered`, where a whole lost crop goes back into
 * the ground and is worth the full rate (the one salvage from a missed window).
 *
 * Still refuses while a rake or bale is QUEUED: mulching clears `forageReady`/
 * `windrowed`, so running it first would quietly cancel the baling the player
 * already paid for. Perennials are excluded outright — they keep their stand.
 */
export function canMulch(save: SaveState, field: Field): boolean {
  return (
    (field.status === "harvested" || field.status === "mulched" || field.status === "withered") &&
    !isPerennial(field.crop) &&
    !isPerennial(field.lastCrop) &&
    !field.residueMulched &&
    tasksFor(save, field.id, "rake").length === 0 &&
    tasksFor(save, field.id, "bale").length === 0
  );
}

/**
 * The status a field WILL have once its pending tasks finish — what queueing
 * validates against, so a player can queue plow + plant back-to-back.
 */
export function effectiveStatus(save: SaveState, field: Field): FieldStatus {
  let status = field.status;
  for (const t of save.tasks) {
    if (t.fieldId !== field.id) continue;
    if (t.type === "plow") status = "tilled";
    else if (t.type === "plant") status = "planted";
    else if (t.type === "harvest" || t.type === "mow") status = "harvested";
    else if (t.type === "bale") status = isPerennial(field.crop) ? "growing" : "mulched";
    else if (t.type === "mulch") status = "stubble"; // residue shredded → bare stubble
    // weed/fertilize/rake don't change the field's lifecycle status.
  }
  return status;
}

/** What queueing this task would charge right now, for button labels. */
export function taskCost(field: Field, type: TaskType, crop?: CropId): number {
  const acres = areaAcres(field.boundary);
  if (type === "plow") return Math.round(acres * gameConfig.plowCostPerAcre);
  if (type === "plant") return Math.round(acres * gameConfig.crops[crop!].inputCostPerAcre);
  if (type === "mow") return Math.round(acres * gameConfig.mowCostPerAcre);
  if (type === "mulch") return Math.round(acres * gameConfig.mulchCostPerAcre);
  if (type === "weed") return Math.round(acres * gameConfig.weedCostPerAcre);
  if (type === "fertilize") return Math.round(acres * gameConfig.crops[crop ?? field.crop!].fertilizeCostPerAcre);
  if (type === "rake") return Math.round(acres * gameConfig.forage.rakeCostPerAcre);
  if (type === "bale") return Math.round(acres * gameConfig.forage.baleCostPerAcre);
  if (type === "wrap") return Math.round(acres * gameConfig.forage.wrapCostPerAcre);
  if (type === "harvest") return Math.round(acres * gameConfig.harvestCostPerAcre);
  if (type === "chop") return Math.round(acres * gameConfig.forage.chopCostPerAcre);
  return 0; // unloadHarvester/haulBales: relays, charged via their own field work
}

/**
 * Queue a task (pay-on-queue). Validates against the field's EFFECTIVE status so
 * chains like plow→plant queue together. Throws player-facing messages. Weed and
 * fertilize are independent of the plow/plant/harvest chain and of each other —
 * they gate only on the field's ACTUAL current state (a standing crop), not the
 * effective/pending one, since there's nothing to chain them behind.
 */
export function enqueueTask(save: SaveState, field: Field, type: TaskType, now: SimTime, crop?: CropId): FarmTask {
  if (tasksFor(save, field.id, type).length > 0) {
    throw new Error(`${field.id} already has a ${type} task queued`);
  }
  const eff = effectiveStatus(save, field);
  if (type === "plow") {
    // Perennials are never plowed — the stand persists year to year.
    if (isPerennial(field.crop)) throw new Error(`${field.id} is a perennial stand — it isn't plowed`);
    if (!canPlow(eff)) throw new Error(`${field.id} can't be plowed (status: ${eff})`);
    // A harvested forage field owes a rake + bale first (unless a bale is
    // already queued, which pushes eff to "mulched" and clears this branch).
    if (eff === "harvested" && forageDue(save, field)) {
      throw new Error(`Rake & bale ${field.id} before plowing`);
    }
    // NOTE: no winter-window check here (maintainer request, 2026-07-16) —
    // manual plowing (this function, and forcePlow below) is allowed any
    // time the ground has no crop planted. Auto-manage still only queues its
    // OWN plow this way in winter — see the season check in autoManageField.
  }
  if (type === "plant") {
    if (!crop) throw new Error("Pick a crop to plant");
    // Perennials establish on bare ground (no plow); annuals need tilled soil.
    const perennial = gameConfig.crops[crop].perennial;
    if (perennial ? !canSeedPerennial(eff) : eff !== "tilled") {
      throw new Error(perennial ? `${field.id} can't be seeded (status: ${eff})` : `Plow ${field.id} before planting (status: ${eff})`);
    }
    if (!inPlantingWindow(crop, now)) {
      throw new Error(`${gameConfig.crops[crop].name} can't be planted this month`);
    }
  }
  if (type === "harvest") {
    if (eff !== "ready") throw new Error(`${field.id} isn't ready to harvest yet`);
    // Forage (2026-08-12): a chop-only crop has no combine route at all —
    // the whole plant only ever leaves as silage. See `isChopOnlyCrop`.
    if (isChopOnlyCrop(field.crop)) {
      throw new Error(`${gameConfig.crops[field.crop!].name} can't be combined — chop it for silage instead`);
    }
  }
  if (type === "mow") {
    if (!isPerennial(field.crop)) throw new Error(`${field.id} has no perennial forage to mow`);
    if (field.status !== "ready") throw new Error(`${field.id} isn't ready to cut yet`);
  }
  if (type === "mulch" && !canMulch(save, field)) {
    if (isPerennial(field.crop) || isPerennial(field.lastCrop)) {
      throw new Error(`${field.id} is a perennial stand — mulching is for annual residue`);
    }
    if (field.status !== "harvested" && field.status !== "mulched" && field.status !== "withered") {
      throw new Error(`${field.id} has no residue to mulch (status: ${field.status})`);
    }
    if (field.residueMulched) throw new Error(`${field.id} is already mulched`);
    throw new Error(`${field.id} has baling queued — mulch it once the baler is done`);
  }
  if (type === "weed") {
    if (!hasStandingCrop(field.status)) throw new Error(`${field.id} has nothing to weed (status: ${field.status})`);
    if (!inWeedingWindow(field, now)) throw new Error(`Weeding opens once the crop is growing, 2 months after planting`);
  }
  if (type === "fertilize") {
    if (!hasStandingCrop(field.status)) throw new Error(`${field.id} has nothing to fertilize (status: ${field.status})`);
    if (!canFertilizeNow(field, now)) throw new Error(`Fertilizing opens once the crop is growing, the month after planting`);
  }
  if (type === "rake") {
    if (field.status !== "harvested" || !field.forageReady) {
      throw new Error(`${field.id} has no forage to rake`);
    }
  }
  if (type === "bale") {
    if (field.status !== "harvested" || !field.forageReady) {
      throw new Error(`${field.id} has no forage to bale`);
    }
    // The baler follows the rake — it can start once raking has begun, so a rake
    // must at least be queued/underway (or already done, i.e. windrowed).
    // Straw skips this entirely: the combine already left it in a windrow.
    if (needsRakeBeforeBaling(field) && !field.windrowed && tasksFor(save, field.id, "rake").length === 0) {
      throw new Error(`Rake ${field.id} first — the baler follows the rake`);
    }
  }
  if (type === "chop") {
    const crop = field.crop ?? field.lastCrop;
    if (!cropMakesSilage(crop)) {
      throw new Error(`${crop ? gameConfig.crops[crop].name : field.id} can't be chopped for silage`);
    }
    if (isPerennial(field.crop)) {
      // A perennial is chopped off the windrow, so it follows the mow exactly
      // as a bale run does — the chopper wears a pickup head, not a mower.
      if (field.status !== "harvested" || !field.forageReady) {
        throw new Error(`Mow ${field.id} first — the chopper picks the windrow up`);
      }
    } else if (effectiveStatus(save, field) !== "ready") {
      throw new Error(`${field.id} isn't ready to chop yet`);
    }
    // Equipment ownership (2026-08-13) — previously unchecked here, so a
    // field with no Forage Harvester or head implement just queued a chop
    // task that could never be picked up (task-selection requires both) and
    // sat "ready" forever with no explanation. Checked in the same order the
    // field panel's button tooltip reports them, so the two never disagree.
    if (!save.agents.some((a) => a.kind === "forageHarvester")) {
      throw new Error(`A Forage Harvester is needed to chop ${field.id}`);
    }
    if (!save.implements.some((i) => i.kind === "forageWagon")) {
      throw new Error(`A Forage Wagon is needed — a chopper has no tank and can't work without one`);
    }
    const headKind = chopHeadKind(crop!);
    if (!save.implements.some((i) => i.kind === headKind)) {
      throw new Error(`A ${IMPLEMENT_NAME[headKind]} is needed — the chopper can't cut ${gameConfig.crops[crop!].name} without one`);
    }
  }
  if (type === "wrap") {
    // The same-month window (see `canWrapBales`) is checked HERE, at queue
    // time, rather than only on completion — a wrap that could never convert
    // anything must not be startable at all, or the player pays for plastic and
    // a pass and gets hay back.
    if (!field.baleLocations?.length) {
      throw new Error(`${field.id} has no bales to wrap`);
    }
    const product = field.baleProduct;
    if (product && isWrappedProduct(product)) {
      throw new Error(`${field.id}'s bales are already wrapped`);
    }
    if (product && !baleageProductFor(product)) {
      throw new Error(`${gameConfig.baleProducts[product].name} can't be wrapped — only grass or alfalfa bales make baleage`);
    }
    if (!cropProducesWrappedBale(field.crop ?? field.lastCrop)) {
      throw new Error(`${field.id}'s crop can't be wrapped — only Grass (Silage)/Alfalfa (Silage) fields make baleage`);
    }
    if (!canWrapBales(field, now)) {
      throw new Error(`${field.id}'s bales are too old to wrap — baleage has to be sealed the same month it's baled`);
    }
  }
  const cost = taskCost(field, type, crop);
  if (cost > save.money) {
    throw new InsufficientFundsError(cost, save.money);
  }
  save.money -= cost;
  recordCash(save, "fieldExpenses", FIELD_EXPENSE_ITEM[type] ?? "Other", -cost);
  recordFieldCash(save, field.id, "expenses", FIELD_EXPENSE_ITEM[type] ?? "Other", -cost);
  // Stamp the year's crop for the Finances tab as soon as it's planted (before
  // any revenue exists), so the row shows the crop for the whole season.
  if (type === "plant" && crop) recordFieldCrop(save, field.id, crop);
  const task: FarmTask = {
    id: `task-${++taskSeq}`,
    type,
    fieldId: field.id,
    crop,
    totalAcres: areaAcres(field.boundary),
    doneAcres: 0,
    status: "queued",
    costPaid: cost,
  };
  save.tasks.push(task);
  return task;
}

/** Cancel a still-QUEUED task, refunding what was paid. For an ACTIVE task
 * (an agent is already on-site/underway) see `forceCancelActiveTask` below —
 * a different tool for a different job: this is a normal "changed my mind"
 * cancel, that one's an emergency unstick with no refund. */
export function cancelTask(save: SaveState, taskId: string): FarmTask {
  const idx = save.tasks.findIndex((t) => t.id === taskId);
  if (idx === -1) throw new Error(`Task ${taskId} not found`);
  const task = save.tasks[idx]!;
  if (task.status !== "queued") {
    throw new Error(`Can't cancel — ${task.type} is already underway`);
  }
  save.tasks.splice(idx, 1);
  clearTaskRuntime(taskId);
  save.money += task.costPaid;
  recordCash(save, "fieldExpenses", FIELD_EXPENSE_ITEM[task.type] ?? "Other", task.costPaid);
  recordFieldCash(save, task.fieldId, "expenses", FIELD_EXPENSE_ITEM[task.type] ?? "Other", task.costPaid);
  return task;
}

/**
 * Reset a still-QUEUED task: cancel it (refunding what was paid) and
 * immediately re-queue an equivalent one at the back of the queue, freshly
 * validated and re-paid (maintainer request, 2026-08-13 — distinct from
 * Cancel, which just removes it for good).
 *
 * Only meaningful for a normal field task — a system task (`haulBales`,
 * `unloadHarvester`, `sell`) self-regenerates on its own every tick its
 * trigger condition still holds, so "reset" and "cancel" are the same thing
 * for those; callers should just use `cancelTask` instead of this for them.
 */
export function resetQueuedTask(save: SaveState, taskId: string, now: SimTime): FarmTask {
  const existing = save.tasks.find((t) => t.id === taskId);
  if (!existing) throw new Error(`Task ${taskId} not found`);
  if (existing.status !== "queued") {
    throw new Error(`Can't reset — ${existing.type} is already underway`);
  }
  const field = save.fields.find((f) => f.id === existing.fieldId);
  if (!field) throw new Error(`${existing.fieldId} no longer exists`);
  const { type, crop } = existing;
  cancelTask(save, taskId);
  return enqueueTask(save, field, type, now, crop);
}

/** Detach every agent working `task` (its own `agentId` plus, for a bale
 * relay, `trailerAgentId`) and drop whatever route it was driving — shared
 * by both force-cancel and restart below. Matched by `taskId` rather than by
 * name because that's how the sim itself links an agent to its job. */
function freeTaskAgents(save: SaveState, task: FarmTask): void {
  for (const a of save.agents) {
    if (a.taskId === task.id) {
      a.taskId = undefined;
      a.state = "idle";
      clearAgentRoute(a.id);
    }
  }
}

/**
 * Force-cancel an ACTIVE task — the escape hatch for a task visibly wedged
 * by a bug (bad pathing, a relay stuck on a phase that never resolves) that
 * reloading the page doesn't clear, since save state is exactly what's
 * broken. Removes the task outright and frees every agent on it so they're
 * immediately available for other work. No refund: real time (and for a
 * plow/plant task, real money already spent on it) may already be sunk into
 * it, and this is an emergency exit, not a normal `cancelTask`.
 *
 * Also cascades to any unloadHarvester relay that was servicing THIS task's
 * agent (a harvest/chop task's combine/chopper) — a relay left chasing a
 * machine that's just gone idle would only end up stuck itself, defeating
 * the point.
 */
export function forceCancelActiveTask(save: SaveState, taskId: string): FarmTask {
  const task = save.tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (task.status !== "active") throw new Error(`${task.type} isn't active — use Cancel instead`);
  save.tasks.splice(save.tasks.indexOf(task), 1);
  freeTaskAgents(save, task);
  clearTaskRuntime(task.id);
  for (const relay of save.tasks.filter((t) => t.type === "unloadHarvester" && t.harvesterAgentId === task.agentId)) {
    save.tasks.splice(save.tasks.indexOf(relay), 1);
    freeTaskAgents(save, relay);
    clearTaskRuntime(relay.id);
  }
  return task;
}

/**
 * Restart an ACTIVE task IN PLACE — for when it's visibly wedged (agent
 * parked, no progress, a relay stuck "waiting" on something that never
 * resolves) but you'd rather it just pick back up than lose the job and its
 * spot in line. Wipes every piece of cached/decided runtime state (coverage
 * path + distance, relay phase, bale-tie tracking, staging gate, rendezvous
 * point, locked haul/unload destination) so the task's own tick logic
 * re-derives all of it from current reality next tick, instead of whatever
 * it was wedged on — every phase field here has a documented "undefined ⇒
 * start fresh" fallthrough in the tick loop (see e.g. the unloadPhase chain).
 *
 * This is NOT a partial-progress-preserving retry: clearing the cached
 * coverage path resets `doneAcres` too (the tick loop derives it from
 * distance along that path, not an independent counter) — ground already
 * covered stays visually painted, but the task re-walks from the start.
 * Deliberate: if the corrupted path/distance IS the bug, keeping either one
 * would just reproduce the same stuck state.
 */
export function restartActiveTask(save: SaveState, taskId: string): FarmTask {
  const task = save.tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (task.status !== "active") throw new Error(`${task.type} isn't active — nothing to restart`);
  clearTaskRuntime(taskId);
  task.doneAcres = 0;
  task.unloadPhase = undefined;
  task.phaseTimer = undefined;
  task.waitingForSilo = undefined;
  task.unloadDest = undefined;
  task.haulPhase = undefined;
  task.trailerPhase = undefined;
  task.trailerTimer = undefined;
  task.waitingForStorage = undefined;
  task.haulDest = undefined;
  task.trailerDest = undefined;
  task.sellPhase = undefined;
  task.wrapPhase = undefined;
  if (task.agentId) clearAgentRoute(task.agentId);
  if (task.trailerAgentId) clearAgentRoute(task.trailerAgentId);
  return task;
}

/**
 * Reorder a still-QUEUED task within the queue (drag-to-reorder in the Work
 * Queue panel). Active tasks aren't reorderable — an agent is already
 * committed to them, and their position in `save.tasks` doesn't affect
 * anything once they're running. `beforeTaskId` is the queued task `taskId`
 * should be inserted before, or undefined to move it to the end of the queue.
 */
export function reorderTask(save: SaveState, taskId: string, beforeTaskId: string | undefined): void {
  const task = save.tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (task.status !== "queued") throw new Error(`Can't reorder — ${task.type} is already underway`);
  save.tasks.splice(save.tasks.indexOf(task), 1);
  if (!beforeTaskId) {
    save.tasks.push(task);
    return;
  }
  const before = save.tasks.find((t) => t.id === beforeTaskId);
  save.tasks.splice(before ? save.tasks.indexOf(before) : save.tasks.length, 0, task);
}

/**
 * Rough remaining time for a task, in hours, from the physical field-speed ×
 * swath-width model (brief §10). Active tasks use their real coverage-path
 * route (turns included) for a precise figure; queued tasks — no agent
 * assigned yet — estimate off a nominal (currently owned, or medium default)
 * implement width, ignoring headland turns.
 */
/** Working width (ft) for a QUEUED chop task, before any agent/head is
 * attached yet. Mirrors `taskSwathMeters`'s chop branch (the owned head's
 * width, falling back to the windrow it'll pick up, then a nominal rake) but
 * reads the farm's owned implement rather than one hitched to an agent —
 * a queued task has no agent to hitch one to yet. */
function queuedChopWidthFt(save: SaveState, field: Field, task: FarmTask): number {
  const crop = task.crop ?? field.crop ?? field.lastCrop;
  const headKind = crop ? chopHeadKind(crop) : undefined;
  const head = headKind ? save.implements.find((i) => i.kind === headKind) : undefined;
  if (head) return IMPLEMENT_CONFIG[headKind!][head.size].widthFt;
  if (field.windrowWidthM) return field.windrowWidthM / FEET_TO_METERS;
  return IMPLEMENT_CONFIG.rake.medium.widthFt;
}

export function estimateTaskHours(save: SaveState, task: FarmTask): number {
  // Not an acres-based job — point-to-point hauling, no coverage path/width.
  // The UI shows its own phase text instead of an acres/hours estimate.
  // "wrap" joined this list 2026-08-14 (per-bale redesign): calling
  // `getActivePath` below for it would build a coverage path at the Bale
  // Wrapper's width, which is 0 (it has none of its own) — the same
  // zero-swath crash `taskSwathMeters` is now documented to never risk for
  // "wrap" specifically, because nothing is supposed to call it that way.
  if (task.type === "unloadHarvester" || task.type === "haulBales" || task.type === "wrap") return 0;
  const field = save.fields.find((f) => f.id === task.fieldId);
  if (!field) return 0;
  const remainingAcres = Math.max(0, task.totalAcres - task.doneAcres);

  if (task.status === "active" && task.agentId) {
    const agent = save.agents.find((a) => a.id === task.agentId);
    if (agent) {
      const path = getActivePath(save, task, field, agent);
      const remainingDist = path.total * (task.totalAcres > 0 ? remainingAcres / task.totalAcres : 0);
      return remainingDist / (taskFieldSpeedKmh(task.type, agent) * 1000);
    }
  }

  const kind = TASK_IMPLEMENT[task.type];
  const nominalHarvesterSize = save.agents.find((a) => a.kind === "harvester")?.size ?? "medium";
  // A cut on a farm that owns a Self-Propelled Windrower will be taken by it —
  // it gets first refusal (see the pickup gate) and carries no implement, so it
  // cuts at its OWN width. Without this the estimate fell through to a Mower
  // the farm might not even own, at a nominal "medium" 25 ft (2026-07-24).
  // Its own SPEED rides along with it (2026-07-25) — quoting a windrower's
  // width at a tractor's speed would over-state the job by a third.
  const windrower = task.type === "mow" ? save.agents.find((a) => a.kind === "windrower") : undefined;
  const windrowerTakesIt = windrower !== undefined;
  const speedMPerHr = taskFieldSpeedKmh(task.type, windrower) * 1000;
  // A baler has no width of its own (2026-07-24) — it clears the windrow, whose
  // width the field records. It also has no TASK_IMPLEMENT entry now, so this
  // has to be handled before the table lookup below rather than falling into it.
  const widthFt = task.type === "bale"
    ? (field.windrowWidthM ?? IMPLEMENT_CONFIG.rake.medium.widthFt * FEET_TO_METERS) / FEET_TO_METERS
    : task.type === "harvest"
      ? gameConfig.equipment.harvester[nominalHarvesterSize].widthFt
      : task.type === "chop"
        ? queuedChopWidthFt(save, field, task)
        : windrowerTakesIt
          ? gameConfig.equipment.windrower.widthFt
          : (save.implements.find((i) => i.kind === kind)?.size
              ? IMPLEMENT_CONFIG[kind!][save.implements.find((i) => i.kind === kind)!.size].widthFt
              : IMPLEMENT_CONFIG[kind!].medium.widthFt);
  const widthM = widthFt * FEET_TO_METERS;
  const rateAcresPerHr = (speedMPerHr * widthM) / ACRE_M2;
  return rateAcresPerHr > 0 ? remainingAcres / rateAcresPerHr : 0;
}

/**
 * Cancel every queued task on a field (refunding) — used when selling a field.
 * Throws if an agent is actively working it (can't sell ground mid-job).
 */
export function releaseFieldTasks(save: SaveState, fieldId: string): void {
  if (save.tasks.some((t) => t.fieldId === fieldId && t.status === "active")) {
    throw new Error(`Can't sell ${fieldId} while a machine is working it`);
  }
  for (const t of tasksFor(save, fieldId)) cancelTask(save, t.id);
}

/**
 * Manual "Queue Plow" (maintainer request, 2026-07-16): available whenever the
 * field isn't mid-harvest, regardless of what's currently growing on it —
 * INCLUDING an established perennial stand (this is the mechanism to clear
 * grass/alfalfa and start the field over; the normal plow path in
 * `enqueueTask` still refuses perennials, since that one guards the
 * auto-managed lifecycle). If the field already qualifies for a plow
 * (bare/harvested/mulched, no crop), this behaves exactly like the normal
 * plow button. Otherwise it forfeits whatever's standing — cancels any
 * queued work and resets the field to fresh stubble — before queuing the plow.
 */
export function forcePlow(save: SaveState, field: Field, now: SimTime): FarmTask {
  releaseFieldTasks(save, field.id); // throws if a machine is actively working the field
  // Force past the forage-first gate too — this is an explicit "start over",
  // not the guarded auto-progression, so any un-baled residue is forfeited.
  field.forageReady = undefined;
  field.windrowed = undefined;
  field.baleLocations = undefined;
  field.baleProduct = undefined;
  if (!canPlow(field.status) || field.crop) {
    field.status = "stubble";
    field.crop = undefined;
    field.plantedAt = undefined;
    field.trueYieldTonsPerAcre = undefined;
    field.harvestedAcres = undefined;
    field.weedy = undefined;
    field.weeded = undefined;
    field.autoWeedDone = undefined;
    field.autoFertDone = undefined;
    field.cutsThisYear = undefined;
    field.cutYear = undefined;
  }
  return enqueueTask(save, field, "plow", now);
}

/** Is this queued task startable given the field's CURRENT state? (A plant task
 * queued behind a plow task waits until the ground is actually tilled.) */
function isStartable(task: FarmTask, field: Field): boolean {
  // System-generated — always startable once queued; it just needs its
  // fieldId to still resolve (for display), not any particular field status.
  if (task.type === "unloadHarvester") return true;
  if (task.type === "plow") return canPlow(field.status);
  // Perennials seed on bare stubble too (no plow); annuals need tilled ground.
  if (task.type === "plant") {
    const perennial = task.crop && gameConfig.crops[task.crop].perennial;
    return perennial ? canSeedPerennial(field.status) : field.status === "tilled";
  }
  if (task.type === "mow") return field.status === "ready"; // perennial cut
  // Post-harvest residue, the stubble left by a bale run ("mulched"), or a
  // whole lost crop ("withered").
  if (task.type === "mulch") {
    return field.status === "harvested" || field.status === "mulched" || field.status === "withered";
  }
  // Both only ever queue once the crop is already growing (see enqueueTask's
  // window checks) — require it still be growing when picked up too, rather
  // than the looser hasStandingCrop (which also allows "planted").
  if (task.type === "weed" || task.type === "fertilize") return field.status === "growing";
  if (task.type === "rake") return field.status === "harvested" && !!field.forageReady;
  // Baler follows the rake: startable once raking has begun (windrowed) and the
  // field hasn't been baled yet (still "harvested"). Straw needs no rake, so it
  // only waits on the field still being un-baled.
  if (task.type === "bale") {
    return field.status === "harvested" && (!!field.windrowed || !needsRakeBeforeBaling(field));
  }
  // Haul Bales: startable while the field still has bales on the ground —
  // field STATUS doesn't matter (bales sit on a mulched/re-plowed field the
  // same way). If they're all gone (sold, or already hauled), it's moot.
  if (task.type === "haulBales") return (field.baleLocations?.length ?? 0) > 0;
  // Wrap: same rule, and for the same reason. Baling settles a field to
  // "mulched" (or back to "growing" on a perennial) BEFORE the wrapper runs,
  // so gating on status would leave every wrap task queued forever — which is
  // exactly what falling through to the harvest default below did.
  if (task.type === "wrap") return (field.baleLocations?.length ?? 0) > 0;
  // CHOP has two shapes, matching what it replaces (2026-07-31):
  //   - an ANNUAL (corn) is chopped standing, so it waits for "ready" exactly
  //     like the combine pass it stands in for;
  //   - a PERENNIAL is chopped off the windrow, so it waits for the mow and
  //     the rake, exactly like the bale run it stands in for.
  if (task.type === "chop") {
    if (isPerennial(field.crop)) {
      return field.status === "harvested" && (!!field.windrowed || !!field.forageReady);
    }
    return field.status === "ready";
  }
  return field.status === "ready"; // harvest
}

/** In-field working speed for a task, km/h — rake and baler run at their own
 * (config) speeds so the rake pulls ahead; everything else uses the shared
 * fieldwork speed. Exported (2026-08-14) for the Work Queue's mph readout. */
export function taskFieldSpeedKmh(type: TaskType, agent?: Agent): number {
  // The Self-Propelled Windrower is the one speed keyed to the MACHINE rather
  // than the task (2026-07-25): a purpose-built windrower runs its header
  // faster than a tractor pulling a mower over the same ground, and that speed
  // is half of what the machine is for now its width is a realistic 25 ft. A
  // tractor+mower on the very same `mow` task still gets the default.
  if (agent?.kind === "windrower") return gameConfig.work.windrowerSpeedKmh;
  if (type === "rake") return gameConfig.forage.rakeSpeedKmh;
  if (type === "bale") return gameConfig.forage.baleSpeedKmh;
  // "wrap" deliberately has no entry (2026-08-14) — it's a per-bale task now,
  // driving point to point between bale spots at the shared travel speed
  // (see the `wrap` tick block), not a coverage pass with its own field speed.
  // The heavy passes got their own speeds 2026-07-24 — the shared default is
  // tuned for planting and spraying and was roughly double a real combine.
  if (type === "harvest") return gameConfig.work.harvestSpeedKmh;
  if (type === "chop") return gameConfig.forage.chopSpeedKmh;
  if (type === "plow") return gameConfig.work.plowSpeedKmh;
  return gameConfig.work.fieldSpeedKmh;
}

// --- coverage-path runtime (not persisted; rebuilt from doneAcres on reload) ---
const pathCache = new Map<string, CoveragePath>();
const pathDistRuntime = new Map<string, number>();
// Baler-only runtime: the sim-minutes left in the current "tie a bale" pause
// (undefined = not tying). The hopper itself lives on the baler implement
// (`cargoTons`), so it persists across save/reload like the combine's.
const baleTieRemaining = new Map<string, number>();
// The last on-field spot the baler occupied — bales are dropped HERE so they
// never land in a concave notch the coverage path cuts across (farmstead, yard).
const baleLastInside = new Map<string, Meters>();
// The randomized forage threshold (tons) the baler is filling toward for its
// CURRENT bale — baleTons × a ±baleFillVariance factor, re-rolled after each
// drop (maintainer request, 2026-07-20). Varying it staggers the on-path drop
// spacing so bales don't land in a rigid lattice, without any perpendicular
// scatter. Cleared after each drop (re-rolls) and with the task.
const baleTargetRuntime = new Map<string, number>();
// The staging gate a grain cart committed to for an unload trip. Locked on
// first choice — re-picking "nearest gate to the combine" every tick made the
// cart bounce between gates as the combine swept back and forth (maintainer
// report, 2026-07-13). Cleared with the task; a reload just re-picks once.
const stageGateRuntime = new Map<string, Meters>();
// Where a Bale Trailer parks in the field to be loaded: the nearest remaining
// bale, LOCKED so the collector has a fixed rendezvous (a moving target made it
// oscillate). Re-chosen each time the trailer returns from a storage run (the
// lock is cleared on the toStorage→toEntrance transition), so it follows the
// work as bales clear (maintainer request, 2026-07-20). Keyed by haulBales task.
const haulRendezvousRuntime = new Map<string, Meters>();
// The specific bale a Hay-Spikes tractor is currently driving to, LOCKED for
// the whole trip (maintainer report, 2026-07-17): re-picking "nearest bale"
// every tick made the collector oscillate between storage and the field gate
// — as it moved, which bale was nearest (and thus which gate the road route
// used) flipped, so it drove back and forth. Locked until reached + loaded.
const haulTargetRuntime = new Map<string, Meters>();
// Same lock, for the Wrap tractor visiting bale spots one at a time
// (2026-08-14) — see the `wrap` tick block.
const wrapTargetRuntime = new Map<string, Meters>();

/** Working width (meters) for a task: from the attached implement (plow/
 * planter), or the config combine header width for harvest. */
function taskSwathMeters(save: SaveState, task: FarmTask, agent: Agent): number {
  if (task.type === "harvest") {
    // The HEADER's width, not the combine's (2026-07-24) — that's the whole
    // point of choosing one. Falls back to the combine tier's nominal width for
    // the (guarded-against, but not impossible) case of a header-less harvest.
    const crop = task.crop ?? save.fields.find((f) => f.id === task.fieldId)?.crop;
    const header = crop ? attachedImplement(save, agent.id, harvestHeaderKind(crop)) : undefined;
    return header ? implementWidthM(header) : gameConfig.equipment.harvester[agent.size ?? "medium"].widthFt * FEET_TO_METERS;
  }
  // A windrower's cut is its own width — it carries no implement to read one from.
  if (agent.kind === "windrower") return windrowerWidthM();
  // A BALER has no working width of its own (maintainer note, 2026-07-24): it
  // swallows a windrow, so the ground it clears per pass is whatever laid that
  // windrow down — the rake, or the combine header on straw (which skips the
  // rake). The field carries the answer; see `Field.windrowWidthM`.
  //
  // A WRAPPER (2026-07-31) is the same case for the same reason: it works the
  // bale line the baler just laid, and its own `widthFt` is 0. Leaving it to
  // fall through to the generic branch below gave a swath of ZERO — a
  // degenerate coverage path the task could never finish driving.
  // A CHOPPER's width is its HEAD's, exactly like a combine's — except a
  // pickup head has none of its own (it follows the windrow the mower left),
  // so that case falls through to the windrow rule below.
  if (task.type === "chop") {
    const crop = task.crop ?? save.fields.find((f) => f.id === task.fieldId)?.crop
      ?? save.fields.find((f) => f.id === task.fieldId)?.lastCrop;
    const head = crop ? attachedImplement(save, agent.id, chopHeadKind(crop)) : undefined;
    const w = head ? implementWidthM(head) : 0;
    if (w > 0) return w;
    const field = save.fields.find((f) => f.id === task.fieldId);
    if (field?.windrowWidthM) return field.windrowWidthM;
    return IMPLEMENT_CONFIG.rake.medium.widthFt * FEET_TO_METERS;
  }
  // "wrap" deliberately has no entry here (2026-08-14) — it no longer builds
  // a coverage path (point-to-point between bale spots instead), so this
  // function is never called for it.
  if (task.type === "bale") {
    const field = save.fields.find((f) => f.id === task.fieldId);
    if (field?.windrowWidthM) return field.windrowWidthM;
    // Nothing recorded (a legacy save, or a field hand-set up in a test) —
    // fall back to a nominal rake so the pass still has a sane width.
    return IMPLEMENT_CONFIG.rake.medium.widthFt * FEET_TO_METERS;
  }
  const kind = TASK_IMPLEMENT[task.type]!;
  const impl = attachedImplement(save, agent.id, kind);
  return impl ? implementWidthM(impl) : IMPLEMENT_CONFIG[kind].medium.widthFt * FEET_TO_METERS;
}

/** The coverage path an active task is driving, built + cached on first use. */
function getActivePath(save: SaveState, task: FarmTask, field: Field, agent: Agent): CoveragePath {
  let path = pathCache.get(task.id);
  if (!path) {
    const swath = taskSwathMeters(save, task, agent);
    const headland = TASK_HEADLANDS[task.type];
    path = headland
      ? buildHeadlandCoveragePath(field.boundary, swath, headland.laps, headland.order)
      : buildCoveragePath(field.boundary, swath);
    pathCache.set(task.id, path);
  }
  return path;
}

/** The coverage path for an active task, for the RENDERER (reveal). Null unless
 * the task is active with a known agent + field. */
export function getCoveragePath(save: SaveState, task: FarmTask): CoveragePath | null {
  if (task.status !== "active" || !task.agentId) return null;
  const agent = save.agents.find((a) => a.id === task.agentId);
  const field = save.fields.find((f) => f.id === task.fieldId);
  if (!agent || !field) return null;
  return getActivePath(save, task, field, agent);
}

function clearTaskRuntime(taskId: string): void {
  pathCache.delete(taskId);
  pathDistRuntime.delete(taskId);
  baleTieRemaining.delete(taskId);
  baleLastInside.delete(taskId);
  baleTargetRuntime.delete(taskId);
  stageGateRuntime.delete(taskId);
  haulRendezvousRuntime.delete(taskId);
  haulTargetRuntime.delete(taskId);
  wrapTargetRuntime.delete(taskId);
}

/** Things that happened during a tick, for the UI to toast. */
export interface TaskEvent {
  kind: "started" | "finished";
  task: FarmTask;
  agent: Agent;
}

export interface TasksTickResult {
  /** Fields whose status changed (repaint their textures). */
  changed: Field[];
  events: TaskEvent[];
}

/** Advance every agent by `dtMinutes` of sim time: pick up queued tasks, drive
 * to the field, work at the configured rate, complete, repeat within the tick
 * (so high time-compression doesn't stall between jobs). */
export function tickTasks(save: SaveState, now: SimTime, dtMinutes: number, rand: () => number = Math.random): TasksTickResult {
  const changed: Field[] = [];
  const events: TaskEvent[] = [];
  dropStrandedHarvests(save);
  dropStrandedHaulBales(save, now);
  // Before anyone picks their next job: make sure every combine that's sitting
  // with grain has an unload trip AND crew it with a free tractor — so a free
  // tractor rescues the combine instead of starting queued field work
  // (maintainer request, 2026-07-20). Running here, ahead of the agent loop,
  // wins that race (ensureUnloadTask both creates the trip and recruits a cart).
  for (const a of save.agents) {
    if (a.kind === "harvester" && (a.grainOnboard ?? 0) > 1e-9 && a.lastCrop) {
      ensureUnloadTask(save, a, a.lastFieldId ?? "", a.lastCrop, events);
    }
  }
  // Pickup order. Agents already mid-task just continue regardless; this only
  // decides who grabs an UNCLAIMED job.
  //
  // Tractors go SMALLEST-first, so the smallest capable one takes a queued task
  // and the big ones stay free for the jobs only they can pull (maintainer
  // request, 2026-07-11).
  //
  // Combines go LARGEST-first (maintainer request, 2026-07-24) — the opposite
  // rule, for the opposite reason. Header width is the entire point of a big
  // combine, and a ripe crop only has `harvestWindowMonths` before it withers,
  // so leaving the standing crop to the small machine is exactly backwards.
  // Done by building the smallest-first order as before and then swapping the
  // combines around WITHIN their own slots, rather than by a comparator that
  // sorts one group up and the other down — that wouldn't be a consistent
  // ordering, and grouping combines ahead of tractors instead would quietly
  // change the within-tick pipeline (a cart draining a hopper in the same tick
  // the combine filled it, rather than the next one).
  const order = [...save.agents].sort((a, b) => SIZE_RANK[a.size ?? "medium"] - SIZE_RANK[b.size ?? "medium"]);
  const combines = order
    .filter((a) => a.kind === "harvester")
    .sort((a, b) => SIZE_RANK[b.size ?? "medium"] - SIZE_RANK[a.size ?? "medium"]);
  let nextCombine = 0;
  for (let i = 0; i < order.length; i++) {
    if (order[i]!.kind === "harvester") order[i] = combines[nextCombine++]!;
  }
  for (const agent of order) {
    tickAgent(save, agent, now, dtMinutes, changed, events, rand);
  }
  return { changed, events };
}

/**
 * Cancel queued harvests on fields that have nothing left to harvest.
 *
 * A crop that withers (missed its harvest window, 2026-07-23) takes any queued
 * harvest down with it: `isStartable` requires status "ready", so the task
 * would otherwise sit in the Work Queue forever, un-startable and blocking the
 * player's read of what's actually pending. Refunded via the normal
 * `cancelTask` path so the money and both ledgers stay consistent — no work was
 * ever done, and the player is already paying for the miss with the whole crop.
 *
 * Only touches QUEUED tasks; an active harvest is never interrupted (and
 * `tickFarming` won't wither a field that has one running).
 */
function dropStrandedHarvests(save: SaveState): void {
  for (const task of [...save.tasks]) {
    if (task.type !== "harvest" || task.status !== "queued") continue;
    const field = save.fields.find((f) => f.id === task.fieldId);
    if (field && field.status === "withered") cancelTask(save, task.id);
  }
}

/**
 * Cancel queued Haul Bales tasks whose field has run dry with nothing more
 * coming (maintainer report, 2026-08-14: "a Haul Bales job gets stuck in the
 * queued tasks but there are no bales to haul... keeps auto advance from
 * happening").
 *
 * Same shape of bug as `dropStrandedHarvests`: `isStartable` correctly
 * requires the target field to still have bales down, but a CREW task (the
 * 2nd/3rd hauler `queueHaulBales` spawns while a field still has plenty)
 * can sit queued, with no agent yet, right up until a sibling hauler
 * already on the field clears the very last bale before this one ever gets
 * picked up. After that `isStartable` is permanently false and nothing was
 * ever canceling it — it just sat in the Work Queue forever, un-startable,
 * tripping every check that treats "a task exists" as "there's still work
 * to do" (Skip Month's auto-advance idle gate among them).
 *
 * Only cancels once nothing could still put bales back: no active/queued
 * `bale` run still adding to the pile, and no wrap in progress
 * (`wrapPending`) that will hand sealed bales back to the field once it
 * finishes. A task genuinely just waiting its turn is left alone.
 */
function dropStrandedHaulBales(save: SaveState, now: SimTime): void {
  for (const task of [...save.tasks]) {
    if (task.type !== "haulBales" || task.status !== "queued") continue;
    const field = save.fields.find((f) => f.id === task.fieldId);
    if (!field) {
      cancelTask(save, task.id); // field itself is gone — nothing to haul, ever
      continue;
    }
    if ((field.baleLocations?.length ?? 0) > 0) continue;
    if (save.tasks.some((t) => t.type === "bale" && t.fieldId === field.id && (t.status === "active" || t.status === "queued"))) continue;
    if (wrapPending(save, field, now)) continue;
    cancelTask(save, task.id);
  }
}

/** Two points count as "the same spot" (an agent parked there) within a
 * half-meter — exact equality would miss agents that arrived by slightly
 * different paths. */
function samePos(a: Meters, b: Meters): boolean {
  return Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.5;
}

// --- Road-following travel (brief §9: "routes via roads") -------------------
// The county road graph, injected by main.ts once the county package loads.
// Null (tests, load failure) = the old straight-line travel, unchanged.
let roadNet: RoadNetwork | null = null;
export function setRoadNetwork(net: RoadNetwork | null): void {
  roadNet = net;
  agentRoutes.clear();
}

interface AgentRoute {
  /** The destination this route was planned for (replanned if it changes). */
  target: Meters;
  /** Route polyline, or null = "planned and rejected, drive straight" — the
   * negative result is cached too, so a straight-line trip doesn't re-run
   * snapping + A* every tick of the drive. */
  pts: Meters[] | null;
  /** Cumulative distance at each pt (empty for straight-line trips). */
  cum: number[];
  /** How far along the polyline the agent has driven. */
  dist: number;
}
// Runtime-only (not persisted): after a reload the agent just replans.
const agentRoutes = new Map<string, AgentRoute>();

/** The field (with gates) containing `p`, if any — for gate-aware travel. */
function fieldWithGatesAt(save: SaveState, p: Meters): Field | undefined {
  return save.fields.find((f) => f.accessPoints && f.accessPoints.length >= 2 && pointInPolygon(p, f.boundary));
}

/** Whichever of a field's gates is closest to `p`. */
function nearestGate(field: Field, p: Meters): Meters {
  let best = field.accessPoints![0]!;
  let bestD = Infinity;
  for (const g of field.accessPoints!) {
    const d = Math.hypot(g[0] - p[0], g[1] - p[1]);
    if (d < bestD) {
      bestD = d;
      best = g;
    }
  }
  return best;
}

/**
 * Plan the full drivable polyline for a trip, honoring field gates: leave the
 * origin field via its nearest gate, take the roads (when they serve the
 * trip), and enter the destination field through the gate nearest the
 * approach. Returns null when a plain straight line is correct — the two
 * points are in the same field (or in none with gates), and roads don't help.
 */
function planAgentPath(save: SaveState, from: Meters, to: Meters): Meters[] | null {
  const fromField = fieldWithGatesAt(save, from);
  const toField = fieldWithGatesAt(save, to);
  // Moving within one field never detours through a gate.
  if (fromField && fromField === toField) return null;
  const exitGate = fromField ? nearestGate(fromField, from) : null;
  const entryGate = toField ? nearestGate(toField, exitGate ?? from) : null;
  const roadFrom = exitGate ?? from;
  const roadTo = entryGate ?? to;
  const mid = roadNet ? planRoute(roadNet, roadFrom, roadTo) : null;
  if (!mid && !exitGate && !entryGate) return null; // nothing to add — straight
  const raw: Meters[] = [from];
  if (exitGate) raw.push(exitGate);
  if (mid) raw.push(...mid);
  else {
    raw.push(roadFrom);
    raw.push(roadTo);
  }
  if (entryGate) raw.push(entryGate);
  raw.push(to);
  // Collapse duplicates (gate == road endpoint == etc.).
  const pts: Meters[] = [];
  for (const p of raw) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(last[0] - p[0], last[1] - p[1]) > 0.25) pts.push(p);
  }
  return pts.length > 2 ? pts : null;
}

/**
 * Drive `agent` toward `target` for up to `budget` sim-minutes at `speed`
 * (m/min), following field gates + roads when they serve the trip (leave the
 * field via its gate, drive the roads, enter the destination through its
 * gate), else straight. Returns the unused budget; `agent.pos` equals
 * `target` exactly on arrival (same contract as the old inline code).
 */
function driveToward(save: SaveState, agent: Agent, target: Meters, speed: number, budget: number): number {
  let route = agentRoutes.get(agent.id);
  // Replan when the destination moved meaningfully (a combine still cutting
  // creeps along its lanes — don't re-run A* every tick chasing half-meter
  // drift; the final approach closes the gap as a short straight hop).
  // A rejected plan is cached as pts=null so the straight-line drive doesn't
  // re-run snapping + A* every tick until arrival.
  if (!route || Math.hypot(route.target[0] - target[0], route.target[1] - target[1]) > 25) {
    const pts = planAgentPath(save, agent.pos, target);
    const cum: number[] = [0];
    if (pts) {
      for (let i = 1; i < pts.length; i++) {
        cum.push(cum[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]));
      }
    }
    route = { target: [target[0], target[1]], pts, cum, dist: 0 };
    agentRoutes.set(agent.id, route);
  }

  if (!route.pts) {
    // Straight-line fallback (no network / short hop / bad coverage).
    const dx = target[0] - agent.pos[0];
    const dy = target[1] - agent.pos[1];
    const dist = Math.hypot(dx, dy);
    if (dist <= 1e-9) {
      agent.pos = [target[0], target[1]];
      agentRoutes.delete(agent.id);
      return budget;
    }
    agent.heading = Math.atan2(dy, dx);
    const timeNeeded = dist / speed;
    if (timeNeeded <= budget) {
      agent.pos = [target[0], target[1]];
      agentRoutes.delete(agent.id);
      return budget - timeNeeded;
    }
    const f = (budget * speed) / dist;
    agent.pos = [agent.pos[0] + dx * f, agent.pos[1] + dy * f];
    return 0;
  }

  const total = route.cum[route.cum.length - 1]!;
  const travel = Math.min(speed * budget, total - route.dist);
  route.dist += travel;
  const used = travel / speed;
  // Sample position + heading at route.dist.
  let i = 1;
  while (i < route.cum.length - 1 && route.cum[i]! < route.dist) i++;
  const a = route.pts[i - 1]!, b = route.pts[i]!;
  const segLen = route.cum[i]! - route.cum[i - 1]!;
  const t = segLen > 1e-9 ? (route.dist - route.cum[i - 1]!) / segLen : 1;
  agent.pos = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  if (segLen > 1e-9) agent.heading = Math.atan2(b[1] - a[1], b[0] - a[0]);
  if (route.dist >= total - 1e-6) {
    agent.pos = [target[0], target[1]];
    agentRoutes.delete(agent.id);
    return budget - used;
  }
  return 0;
}

/** Drop any planned route (agent is switching activities / going idle). */
function clearAgentRoute(agentId: string): void {
  agentRoutes.delete(agentId);
}

/** Where an idle tractor/harvester with no queued work should park: the
 * nearest Tractor Barn with a free slot (occupancy = other idle machines
 * already sitting at that barn's spot), else the nearest Farm Yard, else
 * `undefined` — stay put, the pre-buildings behavior. Implements have no
 * position of their own (they ride hitched or sit in the abstract "yard"),
 * so only tractors/harvesters home. */
function homeTargetFor(save: SaveState, agent: Agent): Meters | undefined {
  if (!parksInBarn(agent)) return undefined;
  // A full (or leftover-loaded) combine waits for its Grain Trailer — it
  // shouldn't wander off toward a barn mid-wait.
  if (agent.kind === "harvester" && (agent.grainOnboard ?? 0) > 0) return undefined;
  const slots = gameConfig.buildings.tractorBarn.slots;
  let best: Building | undefined;
  let bestD = Infinity;
  for (const barn of save.buildings) {
    if (barn.kind !== "tractorBarn") continue;
    const occupied = save.agents.filter(
      (a) => a.id !== agent.id && parksInBarn(a) && a.state === "idle" && samePos(a.pos, barn.pos),
    ).length;
    if (occupied >= slots) continue;
    const d = Math.hypot(barn.pos[0] - agent.pos[0], barn.pos[1] - agent.pos[1]);
    if (d < bestD) {
      bestD = d;
      best = barn;
    }
  }
  if (best) return best.pos;
  return nearestFarmYard(save, agent.pos)?.pos;
}

/** Best-effort guess at what crop a leftover hopper holds when
 * `agent.lastCrop` isn't set (legacy saves from before it was tracked) —
 * the crop with exactly one silo-assignment candidate, if unambiguous.
 * Otherwise `undefined` (leaves the hopper stuck rather than guessing
 * wrong and dumping the wrong crop's grain into a silo). */
function guessLeftoverCrop(save: SaveState): CropId | undefined {
  const candidates = (Object.keys(gameConfig.crops) as CropId[]).filter((c) =>
    save.buildings.some((b) => b.kind === "silo" && b.assignedCrop === c),
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Queue an "Unload Harvester" trip for `harvester` if one isn't already
 * coming (maintainer request, 2026-07-12) — system-generated, no cost, no
 * player action. A tractor+Grain Trailer picks it up like any other queued
 * task via the existing generic assignment loop below. `fieldId`/`crop` are
 * passed explicitly (not re-read from `field.crop` later) because
 * `applyHarvestDone` clears the field's crop the moment the harvest task
 * itself completes — the trailer for the last, still-in-the-hopper load
 * would otherwise have no idea what it's hauling by the time it arrives. */
function ensureUnloadTask(save: SaveState, harvester: Agent, fieldId: string, crop: CropId, events?: TaskEvent[]): void {
  const trips = save.tasks.filter((t) => t.type === "unloadHarvester" && t.harvesterAgentId === harvester.id);
  // A CREW of carts, not just one (maintainer request, 2026-07-23): while one
  // cart is away at the silo, another can already be alongside the combine, so
  // a big harvest isn't paced by a single trailer's round trip.
  //
  // Another trip is only spawned once every existing one is actually CREWED —
  // otherwise this would create maxCrewSize empty tasks on the first tick and
  // they'd just sit there looking like a stuck queue.
  let task = trips.find((t) => !t.agentId);
  // The FIRST trip is always created even with nothing free to crew it — a
  // combine with grain needs a pending trip so a tractor bought (or freed up)
  // later has something to pick up, and the "no cart yet" wait is a state the
  // UI already reports. EXTRA trips are different: spawning one with no free
  // rig just parks a permanently uncrewed task in the queue, which reads as
  // stuck. So a crew only grows when there's actually someone to join it.
  // ...and only once EVERY combine carrying grain has a cart of its own
  // (maintainer request, 2026-07-24: "make sure each harvest has at least one
  // trailer assigned before adding multiple"). A second cart alongside a
  // combine that already has one is worth far less than the first cart
  // alongside a combine that has none — and whichever combine happened to ask
  // first used to take the whole crew cap, leaving the other stood in the
  // field on a full tank.
  const canGrow =
    trips.length === 0 ||
    (trips.length < gameConfig.hauling.maxCrewSize && hasFreeCartTractor(save) && everyLoadedHarvesterHasACart(save, harvester));
  if (!task && canGrow) {
    task = {
      id: `task-${++taskSeq}`,
      type: "unloadHarvester",
      fieldId,
      crop,
      totalAcres: 1,
      doneAcres: 0,
      status: "queued",
      costPaid: 0,
      harvesterAgentId: harvester.id,
      unloadPhase: "toHarvester",
    };
    save.tasks.push(task);
  }
  // Proactively crew it the same tick it's created, so a free tractor is claimed
  // for the combine before it can start queued field work (maintainer request,
  // 2026-07-20). No-op if already crewed or nothing's free.
  if (task && events) assignGrainCart(save, task, events);
}

/**
 * The silage twin of `ensureUnloadTask` (2026-07-31): make sure a chopper with
 * material aboard has a forage wagon coming, and crew it if anything's free.
 *
 * Simpler than the grain version on purpose. A chopper's buffer is two tons,
 * so it is ALWAYS effectively full while it works — the "has it got enough to
 * be worth a trip" reasoning the grain path does is meaningless here. What
 * matters is that a wagon exists and is on its way, because without one the
 * machine is stopped.
 */
function ensureSilageHaul(
  save: SaveState,
  chopper: Agent,
  fieldId: string,
  product: SilageProduct,
  events?: TaskEvent[],
): void {
  const trips = save.tasks.filter((t) => t.type === "unloadHarvester" && t.harvesterAgentId === chopper.id);
  let task = trips.find((t) => !t.agentId);
  // Same crew rules as the grain cart: the first trip always exists so a wagon
  // bought later has something to pick up; extra trips only spawn when there's
  // actually a free rig, so the queue never fills with uncrewed ghosts.
  const canGrow =
    trips.length === 0 ||
    (trips.length < gameConfig.hauling.maxCrewSize && hasFreeCartTractor(save, "forageWagon"));
  if (!task && canGrow) {
    task = {
      id: `task-${++taskSeq}`,
      type: "unloadHarvester",
      fieldId,
      totalAcres: 1,
      doneAcres: 0,
      status: "queued",
      costPaid: 0,
      harvesterAgentId: chopper.id,
      unloadPhase: "toHarvester",
      cargoKind: "silage",
      silageProduct: product,
    };
    save.tasks.push(task);
  }
  if (task && events) assignGrainCart(save, task, events);
}

/**
 * Could another bale hauler usefully be put on this field? Bales on the ground,
 * and room in the crew for one more (`gameConfig.hauling.maxCrewSize`).
 *
 * Shared by the auto-queue hook after baling and by the field panel's "Haul to
 * Storage" button, so the button is never offered when `queueHaulBales` would
 * just decline — the two must agree or the button silently does nothing.
 */
export function fieldHasLooseBales(save: SaveState, fieldId: string): boolean {
  const field = save.fields.find((f) => f.id === fieldId);
  const bales = field?.baleLocations?.length ?? 0;
  if (bales <= 0) return false;
  const existing = save.tasks.filter((t) => t.type === "haulBales" && t.fieldId === fieldId);
  if (existing.length === 0) return true;
  return (
    existing.length < gameConfig.hauling.maxCrewSize &&
    existing.every((t) => !!t.agentId) &&
    bales > existing.length
  );
}

/** Queue a "Haul Bales" job for a field's loose bales, if one isn't already
 * running (system-generated after baling AND player-triggerable from the field
 * panel — maintainer request, 2026-07-17). No cost, like `unloadHarvester`. A
 * Hay-Spikes tractor picks it up via the generic assignment loop (and pulls in
 * a Bale-Trailer helper there if one's idle). Returns the task, or undefined if
 * there was nothing to haul / one's already going. */
export function queueHaulBales(save: SaveState, fieldId: string, now: SimTime): FarmTask | undefined {
  const field = save.fields.find((f) => f.id === fieldId);
  const bales = field?.baleLocations?.length ?? 0;
  if (!field || bales <= 0) return undefined;
  // WRAP BEFORE YOU HAUL (2026-07-31). Bales are collectable the instant they
  // hit the ground, so without this the haulers would carry a field's bales off
  // to storage as plain hay while the wrap that was going to turn them into
  // baleage still hadn't run — and once they're in a store there is no wrapping
  // them. Hold the haul until the field's bales are sealed (or the window has
  // closed and there's nothing left to wait for).
  if (wrapPending(save, field, now)) return undefined;
  // FARM-WIDE BALANCE (maintainer request, 2026-08-13): never let more than
  // one extra ACTIVE Hay-Spikes rig pile up ahead of ACTIVE Bale Trailers —
  // across the whole farm, not just this field, so a fleet doesn't end up
  // with a growing backlog of collectors idling on full loads waiting on too
  // few trailers. (The reverse — more trailers than spikes — can't happen
  // structurally: a trailer only ever gets hitched because some Hay-Spikes
  // task summoned it via `assignTrailerHelper`.)
  if (!haulCrewIsBalanced(save)) return undefined;
  // A CREW of haulers on one field (maintainer request, 2026-07-23), spawned as
  // parallel tasks so each keeps its own independent collect/haul brain rather
  // than one task juggling several machines. Three gates, all of which have to
  // hold before another hauler is worth adding:
  //   - the crew cap,
  //   - every existing hauler is already crewed (else we'd spawn empty tasks
  //     that just sit in the queue looking stuck),
  //   - and there are actually more bales down than haulers already on it —
  //     no sending a second tractor out for one bale.
  const existing = save.tasks.filter((t) => t.type === "haulBales" && t.fieldId === fieldId);
  if (existing.length > 0) {
    if (existing.length >= gameConfig.hauling.maxCrewSize) return undefined;
    if (existing.some((t) => !t.agentId)) return undefined;
    if (bales <= existing.length) return undefined;
    // Same rule as the grain-cart crew: don't park an uncrewed extra task in
    // the queue when there's no free tractor to ever pick it up.
    if (!save.agents.some(isFreeTractor)) return undefined;
    // PAIR BEFORE YOU MULTIPLY (maintainer request, 2026-07-24). A relay that's
    // still missing its Bale Trailer half has the spare tractor's best job
    // waiting for it: without a trailer the hay-spikes rig shuttles to storage
    // one or two bales at a time, and a SECOND rig doing the same thing is a
    // far worse use of the machine than completing the first relay. Only holds
    // while a trailer could actually join — if the farm owns none free, waiting
    // for one that will never come would just stall the field.
    //
    // Doesn't hold at all once another trailer's already on the field with
    // room to SHARE (2026-08-13, `maxSpikesPerTrailer`) — the new rig just
    // joins that one via `assignTrailerHelper` instead of needing its own,
    // so it's no longer competing with the unpaired task for the same tractor.
    if (existing.some((t) => !t.trailerAgentId) && hasFreeBaleTrailerTractor(save) && !shareableTrailerOn(save, fieldId)) {
      return undefined;
    }
  }
  const task: FarmTask = {
    id: `task-${++taskSeq}`,
    type: "haulBales",
    fieldId,
    totalAcres: 1,
    doneAcres: 0,
    status: "queued",
    costPaid: 0,
    // Ages a wrapped product into its Aged Baleage twin if it's sat wrapped
    // long enough (2026-08-13) — see `resolveAgedBaleProduct`. This is the
    // one choke point every field's bales pass through on their way off
    // the field.
    baleProduct: resolveAgedBaleProduct(field, now) ?? "cornStover",
    haulPhase: "toBale",
  };
  save.tasks.push(task);
  return task;
}

// --- Bale-hauling relay helpers (2026-07-17) -------------------------------

/** Index of the bale nearest `p` in `locs` (the next one a Hay-Spikes tractor
 * drives to). */
function nearestBaleIndex(locs: Meters[], p: Meters): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < locs.length; i++) {
    const d = Math.hypot(locs[i]![0] - p[0], locs[i]![1] - p[1]);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** The Bale-Trailer's parking spot for a haul job: the remaining bale nearest
 * `from` (the trailer's position as it enters/returns), LOCKED in
 * `haulRendezvousRuntime` so the collector shuttles to a FIXED point — a moving
 * target is what made it oscillate before. The lock is cleared whenever the
 * trailer heads back after a storage run, so the next call re-picks the nearest
 * bale and the trailer follows the work inward as the field clears (maintainer
 * request, 2026-07-20). `undefined` when no bales remain. */
function haulRendezvous(task: FarmTask, field: Field, from: Meters): Meters | undefined {
  const locked = haulRendezvousRuntime.get(task.id);
  if (locked) return locked;
  const locs = field.baleLocations;
  if (!locs || locs.length === 0) return undefined;
  const b = locs[nearestBaleIndex(locs, from)]!;
  const rv: Meters = [b[0], b[1]];
  haulRendezvousRuntime.set(task.id, rv);
  return rv;
}

/** Farm-wide bale-hauling balance (2026-08-13, maintainer request): at most
 * one more ACTIVE Hay-Spikes task than ACTIVE Bale Trailers, counted across
 * every field. Gates growing the Hay-Spikes crew further in `queueHaulBales`
 * — trailers can't get ahead of spikes to begin with (see `trailerSpikeCount`
 * doc), so this only ever needs to hold spikes back. */
function haulCrewIsBalanced(save: SaveState): boolean {
  const active = save.tasks.filter((t) => t.type === "haulBales" && t.status === "active");
  const trailersActive = new Set(active.map((t) => t.trailerAgentId).filter((id): id is string => !!id)).size;
  return active.length - trailersActive <= 1;
}

/** How many `haulBales` tasks currently point their `trailerAgentId` at this
 * trailer agent — i.e. how many Hay-Spikes rigs are already sharing it
 * (2026-08-13). Caps against `gameConfig.hauling.maxSpikesPerTrailer`. */
function trailerSpikeCount(save: SaveState, trailerAgentId: string): number {
  return save.tasks.filter((t) => t.type === "haulBales" && t.trailerAgentId === trailerAgentId).length;
}

/** An already-paired Bale Trailer on the SAME field with room for another
 * Hay-Spikes rig to share it (2026-08-13) — the trailer's own tick brain
 * stays driven by whichever task first paired it (`helper.taskId`); a task
 * that joins later only needs `trailerAgentId` pointed at the same agent to
 * start delivering to it (see the "Carrying bales" branch below, which reads
 * the OWNING task's phase/rendezvous rather than its own). */
function shareableTrailerOn(save: SaveState, fieldId: string): string | undefined {
  const paired = save.tasks.find(
    (t) =>
      t.type === "haulBales" &&
      t.fieldId === fieldId &&
      t.trailerAgentId &&
      trailerSpikeCount(save, t.trailerAgentId) < gameConfig.hauling.maxSpikesPerTrailer,
  );
  return paired?.trailerAgentId;
}

/** Pull a Bale-Trailer into a Haul Bales job as the hauler half of the relay:
 * recruit an idle tractor+Bale-Trailer of its OWN (auto-hitching a loose
 * trailer if the spare tractor has none) if one's available, else SHARE an
 * already-paired trailer on this field that has room (2026-08-13, capped at
 * `maxSpikesPerTrailer`). No-op if neither is available — the Hay-Spikes
 * tractor then hauls direct.
 *
 * RECRUIT BEFORE YOU SHARE (2026-08-15 fix — was the other way round).
 * Sharing first meant a farm that owned TWO Bale Trailers still only ever
 * put one to work: the second Hay-Spikes rig always found room on the first
 * trailer (below `maxSpikesPerTrailer`) and grabbed it before ever checking
 * whether a whole second trailer rig sat idle, silently halving the field's
 * haul throughput and parking real, paid-for equipment (maintainer report:
 * "two tractors and two trailers... stacked... fill with the same 30 bale
 * capacity when two trailers working should handle 60" — the "stacked" part
 * was both Hay-Spikes rigs converging on the ONE shared trailer's fixed
 * rendezvous point instead of each running its own). Sharing is now purely
 * the fallback for when the farm has fewer trailers than Hay-Spikes rigs —
 * exactly the case `maxSpikesPerTrailer` was originally built for
 * (2026-08-13/14: "two hay spikes to support 1 trailer") — which still
 * works unchanged: by the time a SECOND rig looks for a trailer, the only
 * one on the farm is already busy (`!a.taskId` excludes it), so recruiting
 * fails and it falls through to sharing, exactly as before.
 *
 * A newly-hitched trailer parks at a FIXED point (the nearest remaining
 * bale, locked in `haulRendezvousRuntime`) and every Hay-Spikes tractor
 * sharing it shuttles bales out to that same spot; when full (or the field's
 * cleared) the trailer runs the load to storage and the collector(s) wait
 * in-field for its return (maintainer request, 2026-07-20 — re-enabled after
 * the earlier oscillation was traced to the collector chasing the trailer's
 * *moving* position instead of its parked spot). Selection is fully
 * automatic: any idle tractor with (or able to hitch) a Bale Trailer is used. */
const TRAILER_RELAY_ENABLED = true;
function assignTrailerHelper(save: SaveState, task: FarmTask, spikesAgent: Agent): void {
  if (!TRAILER_RELAY_ENABLED) return;
  const helper = save.agents.find(
    (a) =>
      a.kind === "tractor" &&
      a.id !== spikesAgent.id &&
      a.state === "idle" &&
      !a.taskId &&
      !!a.size &&
      (!!attachedImplement(save, a.id, "baleTrailer") || !!availableImplementFor(save, a, "baleTrailer")),
  );
  if (helper) {
    if (!attachedImplement(save, helper.id, "baleTrailer")) {
      // Guaranteed to exist — the `helper` filter above already required
      // either an attached trailer or an available one to hitch.
      const trailer = availableImplementFor(save, helper, "baleTrailer")!;
      for (const i of save.implements) if (i.attachedTo === helper.id) i.attachedTo = undefined;
      trailer.attachedTo = helper.id;
    }
    const trailer = attachedImplement(save, helper.id, "baleTrailer")!;
    trailer.cargoBales ??= 0;
    trailer.cargoBaleProduct = task.baleProduct;
    task.trailerAgentId = helper.id;
    task.trailerPhase = "toEntrance";
    helper.taskId = task.id;
    helper.state = "traveling";
    // The rendezvous bale is locked lazily the first time the trailer stages
    // (in its brain), so it's picked relative to where the trailer enters.
    return;
  }
  const shared = shareableTrailerOn(save, task.fieldId);
  if (shared) task.trailerAgentId = shared;
}

/** Where a bale hauler should head with its load: the nearest Bale Storage
 * with room, or — if none exists or all of it's full — the nearest Sell
 * Point (maintainer request, 2026-07-17: "prefer storage, fall back to
 * selling"). `undefined` when neither exists (the caller waits, ⚠️). */
function chooseBaleDest(save: SaveState, product: BaleProduct, from: Meters): { pos: Meters; sell: boolean } | undefined {
  const store = nearestBaleStorageFor(save, product, from);
  if (store) return { pos: store.pos, sell: false };
  const sellPt = nearestSellPointFor(save, from);
  if (sellPt) return { pos: sellPt.pos, sell: true };
  return undefined;
}

/** Sell bales dropped at a Sell Point on the spot — a hauler's fallback when
 * no Bale Storage exists or all of it's full (maintainer request,
 * 2026-07-17). Records the sale like any other bale sale so it shows up in
 * the Work Queue's Completed section + cashflow, even though no player click
 * triggered it. (Per-field revenue is already booked at bale time — no
 * field attribution happens here.) */
function sellHauledBales(save: SaveState, product: BaleProduct, n: number, now: SimTime): void {
  if (n <= 0) return;
  const cfg = gameConfig.baleProducts[product];
  const unit = baleUnitPrice(product, monthOf(now));
  const revenue = Math.round(n * unit);
  save.money += revenue;
  recordCash(save, "cropRevenue", `${cfg.name} bales`, revenue);
  appendCompletedTask(save, {
    id: `sale-${++taskSeq}`,
    type: "sellBales",
    label: cfg.name,
    bales: n,
    tons: n * baleTonsOf(product),
    revenue,
    completedAt: now,
  });
}

/** The whole relay is done: release both tractors and drop the task. */
function finishHaul(save: SaveState, task: FarmTask, agent: Agent, events: TaskEvent[]): void {
  events.push({ kind: "finished", task, agent });
  for (const id of [task.agentId, task.trailerAgentId]) {
    if (!id) continue;
    const a = save.agents.find((x) => x.id === id);
    // Only free an agent THIS task actually owns (agent.taskId === task.id).
    // A Bale Trailer shared across multiple haulBales tasks (2026-08-13) has
    // its taskId pointing at whichever one paired it — a non-owning task
    // finishing its own half must not yank the trailer out from under
    // whichever task still owns it.
    if (a && a.taskId === task.id) {
      a.taskId = undefined;
      a.state = "idle";
      clearAgentRoute(a.id);
    }
  }
  const idx = save.tasks.indexOf(task);
  if (idx >= 0) save.tasks.splice(idx, 1);
  clearTaskRuntime(task.id);
}

/** Where a grain cart should take its load: the nearest silo for the crop IF the
 * crop's pooled silo capacity still has room, else the nearest Sell Point to
 * offload for cash (maintainer request, 2026-07-20 — so a cart doesn't stall at
 * a full silo mid-harvest). `undefined` when neither is available (cart waits,
 * ⚠️). Mirrors `chooseBaleDest`. */
// ---------------------------------------------------------------------------
// RELAY POLYMORPHISM (2026-07-31, silage Phase 2)
//
// `unloadHarvester` serves BOTH harvest chains. The phases — onloading →
// staging → toSilo → dumping — are identical whether a cart is taking grain
// from a combine to a silo or a wagon is taking chopped forage from a chopper
// to a bunker, and forking them would have meant duplicating the trickiest
// loop in the sim (the one that already produced the 2026-07-25 deadlock).
//
// So the four things that genuinely differ are isolated here, and the loop
// itself asks these rather than naming grain. `task.cargoKind` is absent on
// every task in an existing save, and absent means grain.
// ---------------------------------------------------------------------------

/** Is this relay trip hauling chopped silage rather than grain? */
export function isSilageRun(task: FarmTask): boolean {
  return task.cargoKind === "silage";
}

/** Which trailer this trip needs. */
export function relayTrailerKind(task: FarmTask): ImplementKind {
  return isSilageRun(task) ? "forageWagon" : "grainTrailer";
}

/**
 * A point `chopperTrailMeters` directly BEHIND the chopper, for a Forage
 * Wagon to aim for instead of the harvester's raw position (maintainer
 * request, 2026-08-13: "trail just behind the harvester instead of next to
 * it" — the wagon catches the chopper's spout, not its side). Grain carts
 * are untouched by this — they still target `harvester.pos` directly, kept
 * that way deliberately (maintainer request, 2026-08-13: "revert back the
 * grain cart logic to keep it simple") rather than routed through a shared
 * "approach point" abstraction. `harvester.heading` (radians, set by
 * `driveToward` as it moves) gives the direction to trail behind; falls back
 * to the harvester's raw position if it's never moved yet (no direction to
 * compute).
 */
function chopperTrailPoint(harvester: Agent): Meters {
  if (harvester.heading === undefined) return harvester.pos;
  const h = harvester.heading;
  const d = gameConfig.hauling.chopperTrailMeters;
  return [harvester.pos[0] - d * Math.cos(h), harvester.pos[1] - d * Math.sin(h)];
}

/** How much that trailer can carry on this trip, TONS. Grain converts through
 * the crop's test weight (a trailer is a fixed VOLUME); a forage wagon is
 * rated in tons outright. */
function relayCapacityTons(trailer: Implement, task: FarmTask): number {
  if (isSilageRun(task)) return gameConfig.equipment.forageWagon[trailer.size].capacityTons;
  return grainTrailerCapacityTons(trailer.size, task.crop);
}

/** Where a loaded trailer should head: its store if there's room, else a Sell
 * Point, else nowhere (the caller waits, and the UI reports it). */
function chooseRelayDest(save: SaveState, task: FarmTask, from: Meters): { pos: Meters; sell: boolean } | undefined {
  if (isSilageRun(task)) {
    const product = task.silageProduct ?? "cornForage";
    const bunker = nearestSilageBunkerFor(save, product, from);
    if (bunker) return { pos: bunker.pos, sell: false };
    const sellPt = nearestSellPointFor(save, from);
    if (sellPt) return { pos: sellPt.pos, sell: true };
    return undefined;
  }
  const crop = task.crop ?? "corn";
  return chooseGrainDest(save, crop, from);
}

/** Tip a load into storage. Returns the tons ACCEPTED — a partial accept means
 * the store filled mid-dump and the rest needs rerouting. `from` is the
 * trailer's current position — for silage, it's used to deposit into the
 * SPECIFIC bunker the wagon actually just drove to (via `chooseRelayDest`),
 * only spilling into a farther one if that bunker filled mid-dump. */
function depositRelayLoad(save: SaveState, task: FarmTask, trailer: Implement, tons: number, from: Meters): number {
  if (isSilageRun(task)) {
    return storeSilage(save, task.silageProduct ?? "cornForage", tons, from);
  }
  const crop = trailer.cargoCrop!;
  const room = Math.max(0, siloCapacityForCrop(save, crop) - save.grain[crop]);
  const amount = Math.min(room, tons);
  save.grain[crop] += amount;
  return amount;
}

/** Sell a load on the spot at a Sell Point — the fallback when storage is
 * full or missing. */
function sellRelayLoad(save: SaveState, task: FarmTask, trailer: Implement, tons: number, now: SimTime): void {
  if (isSilageRun(task)) {
    sellHauledSilage(save, task.silageProduct ?? "cornForage", tons, now);
    return;
  }
  sellHauledGrain(save, trailer.cargoCrop!, tons, now);
}

function chooseGrainDest(save: SaveState, crop: CropId, from: Meters): { pos: Meters; sell: boolean } | undefined {
  const room = siloCapacityForCrop(save, crop) - save.grain[crop];
  if (room > 1e-9) {
    const silo = nearestSiloForCrop(save, crop, from);
    if (silo) return { pos: silo.pos, sell: false };
  }
  const sellPt = nearestSellPointFor(save, from);
  if (sellPt) return { pos: sellPt.pos, sell: true };
  return undefined;
}

/** Sell a grain cart's load at a Sell Point on the spot — its fallback when the
 * silos are full/absent (maintainer request, 2026-07-20). Flat crop price, same
 * as selling from a silo; recorded so it shows in the Completed list + cashflow.
 * (Per-field revenue is already booked at harvest time — no field attribution
 * happens here.) */
/** The silage counterpart: tip a wagon-load at a Sell Point for cash — either
 * a genuine sale via the "sell" task (2026-08-15, storage → market, same as
 * grain/bales), or the chop-relay's own fallback when the bunkers are full or
 * the farm has none (2026-07-31). Full SEASONAL price (2026-08-15 — was a
 * flat config-listed price with no seasonal swing; see the pricing note on
 * `gameConfig.silageProducts.silage` for why that changed), same as hauling
 * grain or bales the same way. */
function sellHauledSilage(save: SaveState, product: SilageProduct, tons: number, now: SimTime): void {
  if (tons <= 1e-9) return;
  const cfg = gameConfig.silageProducts[product];
  const unit = silageUnitPrice(product, monthOf(now));
  const revenue = Math.round(tons * unit);
  save.money += revenue;
  recordCash(save, "cropRevenue", cfg.name, revenue);
  appendCompletedTask(save, {
    id: `sale-${++taskSeq}`,
    type: "sellGrain",
    label: cfg.name,
    tons,
    revenue,
    completedAt: now,
  });
}

function sellHauledGrain(save: SaveState, crop: CropId, tons: number, now: SimTime): void {
  if (tons <= 1e-9) return;
  const unit = grainUnitPrice(crop, monthOf(now));
  const revenue = Math.round(tons * unit);
  save.money += revenue;
  recordCash(save, "cropRevenue", gameConfig.crops[crop].name, revenue);
  appendCompletedTask(save, {
    id: `sale-${++taskSeq}`,
    type: "sellGrain",
    crop,
    // Label + crop both set so this merges with the Inventory panel's instant
    // sale of the same crop — the merge key compares them exactly.
    label: gameConfig.crops[crop].name,
    tons,
    revenue,
    completedAt: now,
  });
}

// --- Sell runs: storage → Sell Point (maintainer request, 2026-07-23) -------

/** Is this market product a grain (sold by the ton from the bin) rather than a
 * bale product (counted per bale, stored per building)? */
function isGrainProduct(product: string): product is CropId {
  return (SELLABLE_GRAINS as string[]).includes(product);
}

/** Is this market product bunker silage (sold by the ton, stored per
 * bunker — 2026-08-15)? Named distinctly from `isSilageRun`, which checks a
 * chop-relay TASK's cargo kind, not a sell-run PRODUCT id — unrelated
 * systems that happen to share a vocabulary. */
function isSilageProduct(product: string): product is SilageProduct {
  return (SILAGE_PRODUCTS as string[]).includes(product);
}

/** How much of `product` is sitting in storage, ready for a sell run. Grain
 * pools farm-wide in the bin; silage and bales are both counted per storage
 * building (silage moved off its old farm-wide pool 2026-08-15, matching
 * bales, so a bunker could be dedicated to one product for real). Loose
 * bales still lying in a field are NOT included — those are the bale-haul
 * job's business, and it already knows how to divert to a Sell Point. */
export function sellableStock(save: SaveState, product: string): number {
  if (isGrainProduct(product)) return save.grain[product] ?? 0;
  if (isSilageProduct(product)) {
    let n = 0;
    for (const b of save.buildings) n += b.storedSilage?.[product] ?? 0;
    return n;
  }
  let n = 0;
  for (const b of save.buildings) n += b.storedBales?.[product as BaleProduct] ?? 0;
  return n;
}

/** The implement a sell run needs for this product — a Forage Wagon for
 * silage (2026-08-15), the same implement that already carries it from
 * field to bunker. */
function sellTrailerKind(product: string): ImplementKind {
  if (isGrainProduct(product)) return "grainTrailer";
  if (isSilageProduct(product)) return "forageWagon";
  return "baleTrailer";
}

/**
 * Queue a Sell run for `product`, if one's worth making: there's stock in
 * storage, a Sell Point to take it to, and room in the crew.
 *
 * Crews here follow the same shape as grain carts and bale haulers — parallel
 * tasks, each with its own rig — and grow only while a free tractor exists to
 * join, so a full crew never leaves an uncrewed task parked in the queue.
 */
export function queueSellRun(save: SaveState, product: string): FarmTask | undefined {
  if (sellableStock(save, product) <= 0) return undefined;
  if (!save.buildings.some((b) => b.kind === "sellPoint")) return undefined;
  const existing = save.tasks.filter((t) => t.type === "sell" && t.sellProduct === product);
  if (existing.length > 0) {
    if (existing.length >= gameConfig.hauling.maxCrewSize) return undefined;
    if (existing.some((t) => !t.agentId)) return undefined;
    const kind = sellTrailerKind(product);
    const free = save.agents.some(
      (a) => isFreeTractor(a) && (!!attachedImplement(save, a.id, kind) || !!availableImplementFor(save, a, kind)),
    );
    if (!free) return undefined;
  }
  const task: FarmTask = {
    id: `task-${++taskSeq}`,
    type: "sell",
    fieldId: "", // display-only: a sale isn't tied to one field
    totalAcres: 1,
    doneAcres: 0,
    status: "queued",
    costPaid: 0,
    sellProduct: product,
    sellPhase: "toSource",
  };
  save.tasks.push(task);
  return task;
}

/** Where a sell run picks its load up: the nearest silo assigned to the crop,
 * the nearest bunker actually holding the silage product, or the nearest
 * bale store actually holding the bale product. */
function sellSourcePos(save: SaveState, product: string, from: Meters): Meters | undefined {
  if (isGrainProduct(product)) {
    return nearestSiloForCrop(save, product, from)?.pos;
  }
  if (isSilageProduct(product)) {
    const bunkers = save.buildings.filter((b) => b.kind === "silageBunker" && (b.storedSilage?.[product] ?? 0) > 0);
    return nearestByPos(bunkers, from)?.pos;
  }
  const stores = save.buildings.filter(
    (b) => (b.kind === "baleBarn" || b.kind === "baleArea") && (b.storedBales?.[product as BaleProduct] ?? 0) > 0,
  );
  return nearestByPos(stores, from)?.pos;
}

/** Take up to `capacity` of `product` out of storage for a sell run. Returns
 * how much was actually loaded. */
function loadForSale(save: SaveState, product: string, capacity: number, from: Meters): number {
  if (isGrainProduct(product)) {
    const take = Math.min(capacity, save.grain[product] ?? 0);
    if (take > 0) save.grain[product] -= take;
    return take;
  }
  if (isSilageProduct(product)) {
    // Drain the nearest bunker first, topping up from others if there's
    // still room on the wagon — same pattern as bales below.
    let left = capacity;
    let loaded = 0;
    const bunkers = save.buildings
      .filter((b) => b.kind === "silageBunker" && (b.storedSilage?.[product] ?? 0) > 0)
      .sort((a, b) => dist2(a.pos, from) - dist2(b.pos, from));
    for (const bunker of bunkers) {
      if (left <= 0) break;
      const have = bunker.storedSilage![product] ?? 0;
      const take = Math.min(left, have);
      bunker.storedSilage![product] = have - take;
      left -= take;
      loaded += take;
    }
    return loaded;
  }
  // Bales: drain the nearest store first, topping up from others if there's
  // still room on the trailer — a full load beats a short one.
  let left = capacity;
  let loaded = 0;
  const stores = save.buildings
    .filter((b) => (b.kind === "baleBarn" || b.kind === "baleArea") && (b.storedBales?.[product as BaleProduct] ?? 0) > 0)
    .sort((a, b) => dist2(a.pos, from) - dist2(b.pos, from));
  for (const store of stores) {
    if (left <= 0) break;
    const have = store.storedBales![product as BaleProduct] ?? 0;
    const take = Math.min(left, have);
    store.storedBales![product as BaleProduct] = have - take;
    left -= take;
    loaded += take;
  }
  return loaded;
}

function dist2(a: Meters, b: Meters): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
}

function nearestByPos<T extends { pos: Meters }>(items: T[], from: Meters): T | undefined {
  let best: T | undefined;
  let bestD = Infinity;
  for (const it of items) {
    const d = dist2(it.pos, from);
    if (d < bestD) {
      bestD = d;
      best = it;
    }
  }
  return best;
}

/** A sell run is over: release the rig and drop the task. */
function finishSell(save: SaveState, task: FarmTask, agent: Agent, events: TaskEvent[]): void {
  events.push({ kind: "finished", task, agent });
  agent.taskId = undefined;
  agent.state = "idle";
  clearAgentRoute(agent.id);
  const idx = save.tasks.indexOf(task);
  if (idx >= 0) save.tasks.splice(idx, 1);
  clearTaskRuntime(task.id);
}

/** An unload trip is done: release the cart and drop the task. */
function finishUnload(save: SaveState, task: FarmTask, agent: Agent, events: TaskEvent[]): void {
  events.push({ kind: "finished", task, agent });
  save.tasks.splice(save.tasks.indexOf(task), 1);
  agent.taskId = undefined;
  clearAgentRoute(agent.id);
  agent.state = "idle";
  clearTaskRuntime(task.id);
}

/** Proactively pull an idle tractor + grain cart onto a combine that's sitting
 * with grain but no cart yet, jumping ahead of queued field work (maintainer
 * request, 2026-07-20 — "same join-mid-job idea as the baler"). Auto-hitches a
 * loose Grain Trailer if the spare tractor has none. No-op when the task's
 * already crewed, the combine's empty, or nothing's free. */
/**
 * Is every OTHER combine that's sitting on grain already looked after — at
 * least one unload trip of its own?
 *
 * The second half of the crew-growth gate (maintainer request, 2026-07-24).
 * `except` is the combine asking to grow, which is excluded because it
 * obviously already has one. A combine with no grain aboard isn't waiting on
 * anything, so it doesn't hold the fleet up.
 */
function everyLoadedHarvesterHasACart(save: SaveState, except: Agent): boolean {
  return save.agents.every(
    (a) =>
      a.kind !== "harvester" ||
      a.id === except.id ||
      (a.grainOnboard ?? 0) <= 1e-9 ||
      save.tasks.some((t) => t.type === "unloadHarvester" && t.harvesterAgentId === a.id),
  );
}

/** Is there an idle tractor that could take a Bale Trailer right now? Gates
 * growing a bale-haul crew — an unpaired relay gets the spare rig first (see
 * `queueHaulBales`). */
function hasFreeBaleTrailerTractor(save: SaveState): boolean {
  return save.agents.some(
    (a) => isFreeTractor(a) && (!!attachedImplement(save, a.id, "baleTrailer") || !!availableImplementFor(save, a, "baleTrailer")),
  );
}

/** Tons currently aboard the cart working `task`. */
function cartCargoOf(save: SaveState, task: FarmTask): number {
  const cart = save.implements.find((i) => i.attachedTo === task.agentId && i.kind === "grainTrailer");
  return cart?.cargoTons ?? 0;
}

/**
 * The ONE cart allowed to approach `harvesterId` right now. Everyone else on
 * the crew waits at the field entrance (maintainer request, 2026-07-24: "the
 * second cart should always wait at field entrance until the first is full").
 *
 * Picked as the most-loaded cart still in the field, so whoever is closest to
 * full keeps topping up and leaves the rotation soonest — a second cart can
 * never cut in front of a half-loaded one and strand it mid-fill. Ties (two
 * empty carts at the start of a harvest) fall back to creation order, so the
 * choice is stable rather than flapping tick to tick.
 *
 * Carts already on their way to the silo are excluded, which is exactly what
 * hands the baton over: the moment the leader fills up and departs, the next
 * cart in the queue becomes active.
 */
function activeCartTaskFor(save: SaveState, harvesterId: string): FarmTask | undefined {
  const inField = save.tasks.filter(
    (t) =>
      t.type === "unloadHarvester" &&
      t.harvesterAgentId === harvesterId &&
      !!t.agentId &&
      t.unloadPhase !== "toSilo" &&
      t.unloadPhase !== "dumping",
  );
  if (inField.length <= 1) return inField[0];
  return inField.sort(
    (a, b) => cartCargoOf(save, b) - cartCargoOf(save, a) || a.id.localeCompare(b.id, undefined, { numeric: true }),
  )[0];
}

/** Is there an idle tractor that could take a Grain Trailer right now? Gates
 * growing a cart crew — see `ensureUnloadTask`. */
function hasFreeCartTractor(save: SaveState, kind: ImplementKind = "grainTrailer"): boolean {
  return save.agents.some(
    (a) => isFreeTractor(a) && (!!attachedImplement(save, a.id, kind) || !!availableImplementFor(save, a, kind)),
  );
}

function assignGrainCart(save: SaveState, task: FarmTask, events: TaskEvent[]): void {
  if (task.status !== "queued") return;
  const harvester = save.agents.find((a) => a.id === task.harvesterAgentId);
  if (!harvester || (harvester.grainOnboard ?? 0) <= 1e-9) return;
  // Grain cart or forage wagon, depending on what this relay is hauling.
  const trailerKind = relayTrailerKind(task);
  const cart = save.agents.find(
    (a) =>
      a.kind === "tractor" &&
      a.state === "idle" &&
      !a.taskId &&
      !!a.size &&
      (!!attachedImplement(save, a.id, trailerKind) || !!availableImplementFor(save, a, trailerKind)),
  );
  if (!cart) return;
  if (!attachedImplement(save, cart.id, trailerKind)) {
    const trailer = availableImplementFor(save, cart, trailerKind);
    if (!trailer) return;
    for (const i of save.implements) if (i.attachedTo === cart.id) i.attachedTo = undefined;
    trailer.attachedTo = cart.id;
  }
  task.status = "active";
  task.agentId = cart.id;
  cart.taskId = task.id;
  cart.state = "traveling";
  events.push({ kind: "started", task, agent: cart });
}

/** Should this idle tractor hold off on starting field work because a
 * harvester/chopper still needs a cart or wagon it could crew? Keeps a
 * relay-capable tractor available for the unload instead of committing to a
 * plow the combine/chopper would soon be waiting behind (maintainer request,
 * 2026-07-20 — "jump ahead of queued field work"; generalized to the forage
 * wagon relay 2026-08-13 — a chop job stalls the exact same way an uncrewed
 * harvest does when every wagon-capable tractor wanders off first). Only
 * reserves as many tractors as there are uncrewed relays, so surplus
 * tractors still get field work done. */
function shouldReserveForRelay(save: SaveState, tractor: Agent): boolean {
  // TRACTORS ONLY (maintainer report, 2026-07-25: "game stuck, waiting on a
  // harvester for a queued task. The harvester is Idle"). The pickup loop runs
  // this over EVERY idle agent, so without this guard a COMBINE (or chopper)
  // could reserve ITSELF as its own cart/wagon and then never drive it — see
  // `reservedForRelayKind` for the rest of that story. Only tractors ever run
  // `unloadHarvester` (TASK_AGENT_KIND), so nothing else has any business
  // standing down for one.
  if (tractor.kind !== "tractor") return false;
  return (
    reservedForRelayKind(save, tractor, "harvest", "harvester", "grainTrailer") ||
    reservedForRelayKind(save, tractor, "chop", "forageHarvester", "forageWagon")
  );
}

/** The shared logic behind `shouldReserveForRelay`, for one source-task-type
 * / trailer-kind pair (harvest+grainTrailer or chop+forageWagon). */
function reservedForRelayKind(
  save: SaveState,
  tractor: Agent,
  sourceType: "harvest" | "chop",
  sourceAgentKind: Agent["kind"],
  trailerKind: ImplementKind,
): boolean {
  if (!tractorCanUse(save, tractor, trailerKind)) return false;
  // No combine/chopper in the fleet → nothing will ever crew; never strand
  // the tractor. Every condition below was satisfiable by one otherwise:
  // `canPull` only compares size classes so a loose trailer looks usable, a
  // fleet with the source machine obviously has one, the queued job counts
  // ITSELF as uncrewed, and a farm with no spare tractor has zero free carts.
  // One combine + one unhitched Grain Trailer + no idle tractor was a
  // permanent (and invisible) deadlock — every ownership/size check genuinely
  // passed, so ⚠️ blocked-work had nothing to report. Reachable by a
  // windrower too (sized "large", so a Medium trailer looked crewable).
  if (!save.agents.some((a) => a.kind === sourceAgentKind)) return false;
  // A source job that's running (or queued and about to run) whose relay
  // isn't already crewed. Queued counts too, so a relay-capable tractor
  // doesn't grab field work on the very tick a fresh job starts, before
  // anything's banked for the pre-pass to react to.
  const uncrewed = save.tasks.filter(
    (h) =>
      h.type === sourceType &&
      (h.status === "active" || h.status === "queued") &&
      !save.tasks.some((u) => u.type === "unloadHarvester" && u.harvesterAgentId === h.agentId && u.status === "active"),
  ).length;
  if (uncrewed === 0) return false;
  // Count OTHER idle relay-capable tractors already free to take those
  // unloads — reserve only if there aren't already enough of them.
  const freeRelayTractors = save.agents.filter(
    (a) => a.kind === "tractor" && a.id !== tractor.id && !a.taskId && tractorCanUse(save, a, trailerKind),
  ).length;
  return freeRelayTractors < uncrewed;
}

function tickAgent(
  save: SaveState,
  agent: Agent,
  now: SimTime,
  dtMinutes: number,
  changed: Field[],
  events: TaskEvent[],
  rand: () => number,
): void {
  let budget = dtMinutes;
  // Guard against a pathological no-progress loop. A handful of transitions
  // per tick is the realistic ceiling at normal speed, but the Skip Month/
  // Spring montage (main.ts's `runMontage`) can legitimately hand a single
  // tick a large `dtMinutes` — e.g. draining a long haul-bale or wrap-bale
  // backlog, where each transition is only ~0.17-0.66 sim-minutes (see
  // `hauling.loadMinutes`/`dumpMinutes`, `forage.wrapMinutesPerBale`). 500
  // gives that headroom (worst case ~350 transitions to drain the montage's
  // own capped chunk size, see `MONTAGE_MAX_CHUNK_MINUTES`) without making a
  // genuinely stuck agent spin unreasonably long before the guard kicks in.
  for (let guard = 0; budget > 1e-9 && guard < 500; guard++) {
    const task = agent.taskId ? save.tasks.find((t) => t.id === agent.taskId) : undefined;

    if (!task) {
      // Self-healing: an idle harvester with grain still in its hopper but
      // no Unload Harvester trip coming (e.g. it finished a field before
      // any silo existed) should keep looking to get one going, every tick
      // — not just at the moment the grain first banked (maintainer
      // request, 2026-07-13). Covers legacy saves from before `lastCrop`
      // was tracked via a same-crop-silo guess.
      if (agent.kind === "harvester" && (agent.grainOnboard ?? 0) > 1e-9) {
        const crop = agent.lastCrop ?? guessLeftoverCrop(save);
        if (crop) ensureUnloadTask(save, agent, agent.lastFieldId ?? "", crop, events);
      }
      // Pick the first queued task of this agent's kind that's startable now.
      // Plow/plant also need the tractor to have (or be able to hitch) the
      // matching implement.
      const next = save.tasks.find(
        (t) =>
          t.status === "queued" &&
          agentCanDoTask(agent, t.type) &&
          // A free windrower gets first refusal on a cut: it can do nothing
          // else, so letting a tractor take the job would park the specialist
          // and tie up a machine that had other options.
          (t.type !== "mow" || agent.kind === "windrower" || !freeWindrower(save)) &&
          (!needsImplementFor(agent, t.type) || tractorCanUse(save, agent, needsImplementFor(agent, t.type)!)) &&
          // A sell run's trailer depends on WHAT it's hauling, so it isn't in
          // TASK_IMPLEMENT — check the product's kind directly instead.
          (t.type !== "sell" || tractorCanUse(save, agent, sellTrailerKind(t.sellProduct!))) &&
          // Either baler kind will do — see `balerKindFor`.
          (t.type !== "bale" || !!balerKindFor(save, agent)) &&
          // A combine needs the RIGHT header for what's standing in the field
          // (2026-07-24) — corn head for corn, grain head for everything else.
          // Crop-dependent like a sell run's trailer, so it isn't in
          // TASK_IMPLEMENT and gets checked here instead.
          (t.type !== "harvest" || !headerKindForTask(save, t) || tractorCanUse(save, agent, headerKindForTask(save, t)!)) &&
          // A chopper needs the right HEAD for the crop (row-crop for standing
          // corn, pickup for a wilted windrow) — crop-dependent like a
          // combine's, so checked here rather than via TASK_IMPLEMENT.
          (t.type !== "chop" || !chopHeadKindForTask(save, t) || tractorCanUse(save, agent, chopHeadKindForTask(save, t)!)) &&
          // ...AND a forage wagon must exist to take the material away
          // (maintainer requirement: the chopper cannot work without a
          // trailer). Checked at PICKUP so the machine never drives out to a
          // field it would only stall in; `blockedWork` explains the wait.
          (t.type !== "chop" || farmHasForageWagon(save)) &&
          // Biggest implement available, pulled by the smallest tractor that
          // can manage it (2026-07-23). A tractor that isn't the preferred rig
          // for this job stands down and lets the right one take it; the loop
          // re-evaluates every tick, so if the preferred tractor gets claimed
          // elsewhere first, whoever's best next simply picks the job up.
          // No preferred rig at all (no implement of the kind exists, or the
          // task needs none) falls back to the old any-capable-agent rule.
          (!needsImplementFor(agent, t.type) ||
            (preferredTractorFor(save, needsImplementFor(agent, t.type)!)?.id ?? agent.id) === agent.id) &&
          // unloadHarvester's fieldId is display-only (may be a legacy/
          // unknown "" for a recovered leftover hopper), and a sell run's is
          // empty outright (a sale spans the farm) — neither needs the field
          // to actually exist, unlike every other task type.
          (t.type === "unloadHarvester" || t.type === "sell" ||
            save.fields.some((f) => f.id === t.fieldId && isStartable(t, f))),
      );
      // Hold a cart-capable tractor back from starting FIELD work while a combine
      // is harvesting and still needs a cart — so it stays free to crew the
      // unload rather than committing to a plow the combine waits behind
      // (maintainer request, 2026-07-20). Unloads themselves are never held.
      if (next && next.type !== "unloadHarvester" && shouldReserveForRelay(save, agent)) {
        agent.state = "idle";
        return;
      }
      if (!next) {
        // No work queued — drive home (Tractor Barn with room, else Farm
        // Yard) if the farm's built somewhere for it to park; otherwise
        // stay exactly where it stopped (pre-buildings behavior).
        const home = homeTargetFor(save, agent);
        if (home && !samePos(agent.pos, home)) {
          const speed = (gameConfig.work.travelSpeedKmh * 1000) / 60; // meters per sim-minute
          agent.state = "traveling";
          budget = driveToward(save, agent, home, speed, budget);
          continue;
        }
        agent.state = "idle";
        return;
      }
      // Auto-hitch the needed implement if the tractor isn't already carrying
      // it — swapping off whatever else it's carrying (one implement at a time).
      // A sell run's trailer is product-dependent, so it isn't in the table.
      const needKind =
        next.type === "sell" ? sellTrailerKind(next.sellProduct!)
        : next.type === "harvest" ? headerKindForTask(save, next)
        : next.type === "chop" ? chopHeadKindForTask(save, next)
        : next.type === "bale" ? balerKindFor(save, agent, cropProducesWrappedBale(save.fields.find((f) => f.id === next.fieldId)?.crop))
        : needsImplementFor(agent, next.type);
      if (needKind && !attachedImplement(save, agent.id, needKind)) {
        const impl = availableImplementFor(save, agent, needKind);
        if (impl) {
          for (const i of save.implements) if (i.attachedTo === agent.id) i.attachedTo = undefined;
          impl.attachedTo = agent.id;
        }
      }
      next.status = "active";
      next.agentId = agent.id;
      agent.taskId = next.id;
      agent.state = "traveling";
      // Picking up a rake windrows the field — this unlocks the baler right away
      // (it may start before the rake finishes), and survives the rake finishing.
      // It also SETS the windrow width: a rake sweeps its own width into a
      // single row, so that's what the baler will be clearing per pass. This
      // runs after the harvest's own write (below), which is the right order —
      // on a raked crop the rake has the final say.
      if (next.type === "rake") {
        const f = save.fields.find((ff) => ff.id === next.fieldId);
        if (f) {
          f.windrowed = true;
          f.windrowWidthM = taskSwathMeters(save, next, agent);
        }
      }
      // Starting a bale job: empty the baler's hopper for a fresh run.
      if (next.type === "bale") {
        const b = attachedBaler(save, agent.id);
        if (b) b.cargoTons = 0;
      }
      // Starting a Haul Bales job: pull in an idle tractor+Bale-Trailer as the
      // hauler half of the relay, if one's available (else the Hay-Spikes
      // tractor hauls its 1–2 bales straight to storage itself).
      if (next.type === "haulBales") {
        assignTrailerHelper(save, next, agent);
      }
      events.push({ kind: "started", task: next, agent });
      continue;
    }

    // A SELL run (2026-07-23), like the unload below, is point-to-point travel
    // rather than field coverage — storage → Sell Point, repeating until the
    // store is empty. Its `fieldId` is empty (a sale isn't tied to a field), so
    // it must be handled before the field lookup further down.
    if (task.type === "sell") {
      const product = task.sellProduct!;
      // Re-offer this product to the crew-scaling gate EVERY TICK a sell run
      // is active for it (2026-08-15, maintainer request: "allow for
      // multiple machines to work on a Sell task, selling the same
      // product") — same fix as `queueHaulBales` got earlier today.
      // `queueSellRun`'s own crew-growth logic (crew cap, "every existing
      // hauler already crewed", a free tractor+trailer actually available)
      // was already correct — it's what already lets a haul-bales crew grow
      // — but nothing ever called it again once the FIRST sell task for a
      // product started, so a second machine never joined an in-progress
      // run no matter how true the growth conditions stayed. Safe to call
      // redundantly (once per active task per tick, so twice a tick with a
      // 2-machine crew already running): it decides per-call whether
      // growing is actually warranted.
      queueSellRun(save, product);
      const kind = sellTrailerKind(product);
      const trailer = save.implements.find((i) => i.attachedTo === agent.id && i.kind === kind);
      // Grain and silage are both hauled by the ton (`cargoTons`); bales are
      // counted (`cargoBales`) — silage joined 2026-08-15, reusing grain's
      // cargo field rather than adding a third one.
      const tonsBased = isGrainProduct(product) || isSilageProduct(product);
      const carried = tonsBased ? trailer?.cargoTons ?? 0 : trailer?.cargoBales ?? 0;
      if (!trailer) {
        // Trailer detached mid-run — don't strand the tractor.
        finishSell(save, task, agent, events);
        continue;
      }
      const speed = (gameConfig.work.travelSpeedKmh * 1000) / 60;

      if (task.sellPhase === "loading" || task.sellPhase === "dumping") {
        agent.state = "working";
        task.phaseTimer = (task.phaseTimer ?? 0) - budget;
        if (task.phaseTimer > 0) {
          budget = 0;
          break;
        }
        const overshoot = -task.phaseTimer;
        task.phaseTimer = undefined;
        budget = overshoot;

        if (task.sellPhase === "loading") {
          const cap = isGrainProduct(product)
            // Volume, so the tonnage depends on what's being hauled (2026-07-24).
            ? grainTrailerCapacityTons(trailer.size, product)
            : isSilageProduct(product)
              ? gameConfig.equipment.forageWagon[trailer.size].capacityTons
              : baleTrailerCapacityBales(trailer.size);
          const got = loadForSale(save, product, cap - carried, agent.pos);
          if (isGrainProduct(product)) {
            trailer.cargoTons = (trailer.cargoTons ?? 0) + got;
            trailer.cargoCrop = product;
          } else if (isSilageProduct(product)) {
            trailer.cargoTons = (trailer.cargoTons ?? 0) + got;
            trailer.cargoSilage = product;
          } else {
            trailer.cargoBales = (trailer.cargoBales ?? 0) + got;
            trailer.cargoBaleProduct = product as BaleProduct;
          }
          // Nothing left to pick up and nothing aboard: the run is pointless.
          if (got <= 0 && carried <= 0) {
            finishSell(save, task, agent, events);
            continue;
          }
          task.sellPhase = "toMarket";
          continue;
        }

        // dumping: cash the load in at the FULL seasonal price — that premium
        // is the whole point of hauling instead of clicking Sell.
        if (isGrainProduct(product)) {
          sellHauledGrain(save, product, trailer.cargoTons ?? 0, now);
          trailer.cargoTons = 0;
          trailer.cargoCrop = undefined;
        } else if (isSilageProduct(product)) {
          sellHauledSilage(save, product, trailer.cargoTons ?? 0, now);
          trailer.cargoTons = 0;
          trailer.cargoSilage = undefined;
        } else {
          sellHauledBales(save, product as BaleProduct, trailer.cargoBales ?? 0, now);
          trailer.cargoBales = 0;
          trailer.cargoBaleProduct = undefined;
        }
        // More in storage? Go back for it; otherwise the run is done.
        if (sellableStock(save, product) > 0 && sellSourcePos(save, product, agent.pos)) {
          task.sellPhase = "toSource";
          continue;
        }
        finishSell(save, task, agent, events);
        continue;
      }

      if (task.sellPhase === "toMarket") {
        const market = nearestSellPointFor(save, agent.pos);
        if (!market) {
          // Sell Point sold out from under the run while it was loaded.
          agent.state = "idle";
          budget = 0;
          break;
        }
        agent.state = "traveling";
        budget = driveToward(save, agent, market.pos, speed, budget);
        if (samePos(agent.pos, market.pos)) {
          task.sellPhase = "dumping";
          task.phaseTimer = gameConfig.hauling.dumpMinutes;
        }
        continue;
      }

      // toSource
      const source = sellSourcePos(save, product, agent.pos);
      if (!source) {
        // Storage emptied by something else (a manual sale) mid-trip.
        if (carried > 0) {
          task.sellPhase = "toMarket";
          continue;
        }
        finishSell(save, task, agent, events);
        continue;
      }
      agent.state = "traveling";
      budget = driveToward(save, agent, source, speed, budget);
      if (samePos(agent.pos, source)) {
        task.sellPhase = "loading";
        task.phaseTimer = gameConfig.hauling.loadMinutes;
      }
      continue;
    }

    // Unload Harvester is fundamentally different from every other task: it's
    // point-to-point travel (combine → silo), not a field coverage path, so
    // it's handled entirely here rather than falling into the generic
    // "traveling"/"working" blocks below. Checked BEFORE the field lookup
    // below — its `fieldId` is only for display and may be a legacy/unknown
    // value ("") for a leftover hopper recovered without a known source
    // field (maintainer request, 2026-07-13); it doesn't need the field to
    // actually exist.
    if (task.type === "unloadHarvester") {
      const harvester = save.agents.find((a) => a.id === task.harvesterAgentId);
      const trailer = save.implements.find((i) => i.attachedTo === agent.id && i.kind === relayTrailerKind(task));
      if (!harvester || !trailer) {
        // Combine sold (shouldn't happen — see sellAgent's onboard-grain
        // guard) or trailer detached mid-job — don't strand the tractor.
        save.tasks.splice(save.tasks.indexOf(task), 1);
        agent.taskId = undefined;
      clearAgentRoute(agent.id);
        agent.state = "idle";
        continue;
      }
      const speed = (gameConfig.work.travelSpeedKmh * 1000) / 60; // meters per sim-minute

      if (task.unloadPhase === "onloading") {
        // ON THE GO (maintainer request, 2026-07-24). This used to be a fixed
        // pause next to a stationary combine, then one instant transfer. Now
        // the cart keeps station alongside while the combine KEEPS CUTTING, and
        // grain crosses at a rate — which is both how it works on a real farm
        // and, with bushel-sized tanks, the difference between a combine that
        // cuts continuously and one that idles at the end of every tank.
        const cap = relayCapacityTons(trailer, task);
        const room = Math.max(0, cap - (trailer.cargoTons ?? 0));
        const available = harvester.grainOnboard ?? 0;
        if (room <= 1e-9 || available <= 1e-9) {
          // Cart full, or the tank's dry — back to the staging decision, which
          // sends it to the silo if it's full and otherwise keeps it waiting
          // for the combine's next tankful.
          task.phaseTimer = undefined;
          task.unloadPhase = "staging";
          continue;
        }
        // The combine is a MOVING target, so "arrived" is a gap, not a point —
        // chasing an exact position it can never hold would leave the cart
        // permanently travelling and never transferring. Grain stays beside
        // it (harvester.pos, unchanged); silage trails behind instead
        // (`chopperTrailPoint`).
        const approach = isSilageRun(task) ? chopperTrailPoint(harvester) : harvester.pos;
        const gap = Math.hypot(approach[0] - agent.pos[0], approach[1] - agent.pos[1]);
        if (gap > gameConfig.hauling.alongsideMeters) {
          agent.state = "traveling";
          budget = driveToward(save, agent, approach, speed, budget);
          continue;
        }
        agent.state = "working";
        const rate = gameConfig.hauling.unloadTonsPerMinute;
        const minutesNeeded = Math.min(room, available) / rate;
        const used = Math.min(minutesNeeded, budget);
        budget -= used;
        const moved = Math.min(Math.min(room, available), used * rate);
        harvester.grainOnboard = available - moved;
        trailer.cargoTons = (trailer.cargoTons ?? 0) + moved;
        // Both captured at task creation — see ensureUnloadTask. A silage run
        // stamps the product instead of the crop, since silage isn't keyed by
        // CropId.
        if (isSilageRun(task)) trailer.cargoSilage = task.silageProduct;
        else trailer.cargoCrop = task.crop;
        continue;
      }

      if (task.unloadPhase === "toSilo") {
        // Prefer the store with room (silo for grain, bunker for silage); if
        // it's full or absent, divert to a Sell Point rather than stalling
        // (maintainer request, 2026-07-20).
        const hasCargoId = isSilageRun(task) ? !!trailer.cargoSilage : !!trailer.cargoCrop;
        const dest = hasCargoId ? chooseRelayDest(save, task, agent.pos) : undefined;
        if (!dest) {
          // No silo room AND no Sell Point — sit tight (⚠️ surfaced in the UI).
          task.waitingForSilo = true;
          agent.state = "working";
          budget = 0;
          continue;
        }
        task.waitingForSilo = false;
        task.unloadDest = dest.sell ? "sell" : "silo";
        if (!samePos(agent.pos, dest.pos)) {
          agent.state = "traveling";
          budget = driveToward(save, agent, dest.pos, speed, budget);
          continue;
        }
        task.unloadPhase = "dumping";
        task.phaseTimer = grainDumpMinutes(trailer.cargoTons ?? 0);
        continue;
      }

      if (task.unloadPhase === "dumping") {
        agent.state = "working";
        const timer = task.phaseTimer ?? grainDumpMinutes(trailer.cargoTons ?? 0);
        const used = Math.min(timer, budget);
        budget -= used;
        const left = timer - used;
        if (left > 1e-9) {
          task.phaseTimer = left;
          continue;
        }
        if (task.unloadDest === "sell") {
          // Diverted to a Sell Point — offload the whole load for cash.
          sellRelayLoad(save, task, trailer, trailer.cargoTons ?? 0, now);
          trailer.cargoTons = 0;
          trailer.cargoCrop = undefined;
          trailer.cargoSilage = undefined;
          task.waitingForSilo = false;
          finishUnload(save, task, agent, events);
          continue;
        }
        const amount = depositRelayLoad(save, task, trailer, trailer.cargoTons ?? 0, agent.pos);
        trailer.cargoTons = (trailer.cargoTons ?? 0) - amount;
        if ((trailer.cargoTons ?? 0) > 1e-9) {
          // Silo filled up mid-dump — reroute the rest (another silo, or a Sell
          // Point) instead of stalling here (maintainer request, 2026-07-20).
          task.unloadPhase = "toSilo";
          task.waitingForSilo = true;
          continue;
        }
        trailer.cargoTons = 0;
        trailer.cargoCrop = undefined;
        task.waitingForSilo = false;
        finishUnload(save, task, agent, events);
        continue;
      }

      // Default / "staging" / "toHarvester": the grain-cart brain. Don't
      // chase a combine that's still cutting — stage at the field's access
      // gate (ONE gate, locked on first choice) and move in only when it
      // actually STOPS for unloading: hopper full, field finished, or
      // otherwise sitting idle with grain. After each drain the cart comes
      // back through here: silo only when the CART's full or the harvest is
      // over; otherwise back to the gate for the combine's next stop
      // (maintainer requests, 2026-07-13).
      {
        const cap = harvesterCapacityTons(harvester.size ?? "medium", task.crop);
        // The call-out threshold, not "brim full" (2026-07-24): a cart is sent
        // for at `callCartAtFraction` so it can be alongside BEFORE the tank
        // fills, and the pair then run together while the combine keeps cutting.
        const combineWantsCart = (harvester.grainOnboard ?? 0) >= cap * gameConfig.hauling.callCartAtFraction - 1e-9;
        const combineEmpty = (harvester.grainOnboard ?? 0) <= 1e-9;
        const stillCutting = save.tasks.some(
          (t) => t.type === "harvest" && t.status === "active" && t.agentId === harvester.id,
        );
        const trailerCap = grainTrailerCapacityTons(trailer.size, task.crop);
        const cargo = trailer.cargoTons ?? 0;
        const trailerFull = cargo >= trailerCap - 1e-9;
        // ONE cart on the combine at a time (maintainer request, 2026-07-24).
        // Whoever is carrying the most keeps the job until it's full and
        // leaves; every other cart on the crew waits at the field entrance.
        // Computed here (not just below) so the early-return silo check can
        // also send a WAITING cart on early — see `cartReturnIdleFraction`.
        const iAmActive = activeCartTaskFor(save, harvester.id)?.id === task.id;
        const idleAndMostlyFull =
          !iAmActive && cargo >= trailerCap * gameConfig.hauling.cartReturnIdleFraction - 1e-9;

        // Head for the silo: cart full; carrying a partial load with the
        // harvest over and the combine drained (nothing more coming); or
        // (2026-08-13) a WAITING cart that's already mostly full — it isn't
        // getting topped off any time soon, so there's nothing to lose by
        // running it now instead of holding capacity hostage at the gate.
        //
        // A cart used to ALSO leave early once it was ≥ cartSiloRunFraction
        // (75%) full REGARDLESS of whether it was active — the maintainer
        // dropped that 2026-07-24 because it wasted a quarter of every round
        // trip on the ACTIVE cart, which really did have more room coming.
        // `idleAndMostlyFull` only fires for a cart that's already stood down.
        if (
          trailerFull ||
          (cargo > 1e-9 && !stillCutting && combineEmpty) ||
          (cargo > 1e-9 && idleAndMostlyFull)
        ) {
          task.unloadPhase = "toSilo";
          continue;
        }
        // Nothing loaded, nothing coming: the trip's moot — stand down.
        if (cargo <= 1e-9 && combineEmpty && !stillCutting) {
          save.tasks.splice(save.tasks.indexOf(task), 1);
          clearTaskRuntime(task.id);
          agent.taskId = undefined;
          clearAgentRoute(agent.id);
          agent.state = "idle";
          continue;
        }

        if (!iAmActive || (!combineWantsCart && stillCutting)) {
          task.unloadPhase = "staging";
          // The ACTIVE cart, part-loaded, waits right where it last drained the
          // combine (maintainer request, 2026-07-13) — it's mid-job and the
          // combine will come back round to it. A cart that ISN'T active goes
          // and sits at the gate whatever it's carrying, so it stays out of the
          // working pair's way.
          if (iAmActive && cargo > 1e-9) {
            agent.state = "working";
            budget = 0;
            continue;
          }
          // Lock the staging gate on first choice — re-picking "nearest to
          // the combine" every tick bounced the cart between gates as the
          // combine swept back and forth.
          let gate = stageGateRuntime.get(task.id);
          if (!gate) {
            const field = save.fields.find((f) => f.id === task.fieldId);
            if (field?.accessPoints && field.accessPoints.length >= 2) {
              gate = nearestGate(field, harvester.pos);
              stageGateRuntime.set(task.id, gate);
            }
          }
          if (gate && !samePos(agent.pos, gate)) {
            agent.state = "traveling";
            budget = driveToward(save, agent, gate, speed, budget);
            continue;
          }
          // Parked at the gate (or in place, for a gateless legacy field) —
          // engine idling until the combine stops.
          agent.state = "working";
          budget = 0;
          continue;
        }
        task.unloadPhase = "toHarvester";
        agent.state = "traveling";
        // Alongside, not on top of, for grain — behind, for silage — the
        // combine/chopper is still moving, and `onloading` keeps station
        // from here (see above, same grain/silage split).
        const approach = isSilageRun(task) ? chopperTrailPoint(harvester) : harvester.pos;
        const gap = Math.hypot(approach[0] - agent.pos[0], approach[1] - agent.pos[1]);
        if (gap > gameConfig.hauling.alongsideMeters) {
          budget = driveToward(save, agent, approach, speed, budget);
          continue;
        }
        task.unloadPhase = "onloading";
        agent.state = "working";
        continue;
      }
    }

    // Haul Bales: a two-tractor relay, also point-to-point (not a coverage
    // path), so handled here like unloadHarvester. One agent runs the
    // Hay-Spikes brain (task.agentId — collects bales in-field), the other the
    // Bale-Trailer brain (task.trailerAgentId — stages at the field entrance
    // and runs full loads to storage). Both reference this same task; we branch
    // by which one is being ticked (maintainer request, 2026-07-17).
    if (task.type === "haulBales") {
      const haulField = save.fields.find((f) => f.id === task.fieldId);
      const product = task.baleProduct ?? "cornStover";
      const speed = (gameConfig.work.travelSpeedKmh * 1000) / 60; // meters per sim-minute
      const trailerAgent = task.trailerAgentId ? save.agents.find((a) => a.id === task.trailerAgentId) : undefined;
      const trailerImpl = trailerAgent ? save.implements.find((i) => i.attachedTo === trailerAgent.id && i.kind === "baleTrailer") : undefined;
      const hasTrailer = !!trailerAgent && !!trailerImpl;

      if (!haulField) {
        // Field sold mid-haul — nothing left to reference. Drop the whole job.
        finishHaul(save, task, agent, events);
        continue;
      }

      // Re-offer the field to the crew-scaling gate EVERY TICK a haul is
      // active on it (2026-08-14 fix), not just at the moments something new
      // happened to it (a bale dropping, wrap finishing, the manual button).
      // Without this, a field with a large already-down backlog and only one
      // Hay-Spikes rig working it never grew a second one — the crew-size/
      // trailer-sharing conditions in `queueHaulBales` could all be true, but
      // nothing was ever calling it again to notice, once the one-time
      // trigger that started the first task had already fired and passed.
      // Mirrors `ensureUnloadTask`'s existing pattern for the grain-cart crew
      // (called every tick a harvester carries grain, not just once) — safe
      // to call redundantly, since `queueHaulBales`'s own gates (crew cap,
      // "every existing hauler already crewed", bales-vs-haulers, wrap
      // pending, etc.) already decide per-call whether adding one is
      // actually warranted.
      queueHaulBales(save, haulField.id, now);

      // How big this job is, for the Work Queue's progress bar (2026-07-25).
      // A HIGH-WATER MARK rather than a count taken at task creation, because
      // baling and hauling overlap (maintainer request, 2026-07-23) — bales
      // keep landing in the field while the relay is already clearing it, and a
      // fixed denominator would show progress running past 100%. Counting what
      // the rigs are carrying too keeps it from dipping as they load up.
      {
        const spikesImpl = save.implements.find((i) => i.attachedTo === agent.id && i.kind === "haySpikes");
        const carried = (spikesImpl?.cargoBales ?? 0) + (trailerImpl?.cargoBales ?? 0);
        const seen = (haulField.baleLocations?.length ?? 0) + carried;
        if (seen > (task.haulTotalBales ?? 0)) task.haulTotalBales = seen;
      }

      // --- TRAILER brain ---
      if (agent.id === task.trailerAgentId) {
        if (!trailerImpl) {
          // Trailer got detached — demote to a direct haul; release this agent.
          task.trailerAgentId = undefined;
          task.trailerPhase = undefined;
          agent.taskId = undefined;
          clearAgentRoute(agent.id);
          agent.state = "idle";
          continue;
        }
        const trailerCap = baleTrailerCapacityBales(trailerImpl.size);
        const tCargo = trailerImpl.cargoBales ?? 0;
        // Every Hay-Spikes task sharing THIS trailer (2026-08-13), not just
        // this (the owning) task's own — the trailer can't call the job done
        // while any of them is still carrying a load out in the field.
        const sharingSpikesCargo = save.tasks
          .filter((t) => t.type === "haulBales" && t.trailerAgentId === task.trailerAgentId)
          .reduce((sum, t) => sum + (save.implements.find((i) => i.attachedTo === t.agentId && i.kind === "haySpikes")?.cargoBales ?? 0), 0);
        const fieldEmpty = (haulField.baleLocations?.length ?? 0) === 0;
        const spikesDone = fieldEmpty && sharingSpikesCargo <= 0;

        if (task.trailerPhase === "dumping") {
          agent.state = "working";
          const timer = task.trailerTimer ?? gameConfig.hauling.dumpMinutes;
          const used = Math.min(timer, budget);
          budget -= used;
          if (timer - used > 1e-9) {
            task.trailerTimer = timer - used;
            continue;
          }
          task.trailerTimer = undefined;
          if (task.trailerDest === "sell") {
            sellHauledBales(save, product, tCargo, now);
            trailerImpl.cargoBales = 0;
            trailerImpl.cargoBaleProduct = undefined;
            task.waitingForStorage = false;
            task.trailerPhase = "toEntrance";
            haulRendezvousRuntime.delete(task.id); // re-pick nearest bale on return
            continue;
          }
          const store = nearestBaleStorageFor(save, product, agent.pos);
          const added = store ? haulBalesInto(store, product, tCargo) : 0;
          trailerImpl.cargoBales = tCargo - added;
          if ((trailerImpl.cargoBales ?? 0) > 0) {
            // Barn filled mid-dump — reroute what's left (another storage, or
            // Sell Point as a last resort) instead of stalling on this one.
            const dest = chooseBaleDest(save, product, agent.pos);
            if (!dest) {
              task.waitingForStorage = true;
              task.trailerPhase = "toStorage";
              budget = 0;
              continue;
            }
            task.waitingForStorage = false;
            task.trailerDest = dest.sell ? "sell" : "storage";
            if (!samePos(agent.pos, dest.pos)) {
              task.trailerPhase = "toStorage";
              agent.state = "traveling";
              budget = driveToward(save, agent, dest.pos, speed, budget);
              continue;
            }
            task.trailerPhase = "dumping";
            task.trailerTimer = gameConfig.hauling.dumpMinutes;
            agent.state = "working";
            continue;
          }
          trailerImpl.cargoBaleProduct = undefined;
          task.waitingForStorage = false;
          task.trailerPhase = "toEntrance";
          haulRendezvousRuntime.delete(task.id); // re-pick nearest bale on return
          continue;
        }

        // Everything delivered and nothing left to collect — the relay's done.
        if (spikesDone && tCargo <= 0) {
          finishHaul(save, task, agent, events);
          continue;
        }

        // Run to storage when the trailer's full, or the field's fully
        // collected and it's holding the final partial load.
        if (tCargo >= trailerCap - 1e-9 || (spikesDone && tCargo > 0)) {
          const dest = chooseBaleDest(save, product, agent.pos);
          if (!dest) {
            task.waitingForStorage = true;
            agent.state = "working";
            budget = 0;
            continue;
          }
          task.waitingForStorage = false;
          task.trailerDest = dest.sell ? "sell" : "storage";
          if (!samePos(agent.pos, dest.pos)) {
            task.trailerPhase = "toStorage";
            agent.state = "traveling";
            budget = driveToward(save, agent, dest.pos, speed, budget);
            continue;
          }
          task.trailerPhase = "dumping";
          task.trailerTimer = gameConfig.hauling.dumpMinutes;
          agent.state = "working";
          continue;
        }

        // Otherwise drive to the rendezvous (nearest remaining bale, locked) and
        // wait there to be loaded.
        const rv = haulRendezvous(task, haulField, agent.pos);
        if (rv && !samePos(agent.pos, rv)) {
          task.trailerPhase = "toEntrance";
          agent.state = "traveling";
          budget = driveToward(save, agent, rv, speed, budget);
          continue;
        }
        task.trailerPhase = "waiting";
        agent.state = "working";
        budget = 0;
        continue;
      }

      // --- HAY-SPIKES brain (task.agentId) ---
      const spikes = save.implements.find((i) => i.attachedTo === agent.id && i.kind === "haySpikes");
      if (!spikes) {
        // Spikes detached — can't collect; drop the job (release both).
        finishHaul(save, task, agent, events);
        continue;
      }
      const spikesCap = haySpikesCapacityBales(spikes.size);

      if (task.haulPhase === "loading") {
        agent.state = "working";
        const timer = task.phaseTimer ?? gameConfig.hauling.loadMinutes;
        const used = Math.min(timer, budget);
        budget -= used;
        if (timer - used > 1e-9) {
          task.phaseTimer = timer - used;
          continue;
        }
        task.phaseTimer = undefined;
        const locs = haulField.baleLocations ?? [];
        if (locs.length > 0) {
          locs.splice(nearestBaleIndex(locs, agent.pos), 1);
          spikes.cargoBales = (spikes.cargoBales ?? 0) + 1;
          spikes.cargoBaleProduct = product;
        }
        task.haulPhase = "toBale";
        continue;
      }

      if (task.haulPhase === "unloadToTrailer") {
        agent.state = "working";
        const timer = task.phaseTimer ?? gameConfig.hauling.loadMinutes;
        const used = Math.min(timer, budget);
        budget -= used;
        if (timer - used > 1e-9) {
          task.phaseTimer = timer - used;
          continue;
        }
        task.phaseTimer = undefined;
        if (trailerImpl) {
          const room = baleTrailerCapacityBales(trailerImpl.size) - (trailerImpl.cargoBales ?? 0);
          const moved = Math.max(0, Math.min(spikes.cargoBales ?? 0, room));
          spikes.cargoBales = (spikes.cargoBales ?? 0) - moved;
          trailerImpl.cargoBales = (trailerImpl.cargoBales ?? 0) + moved;
          trailerImpl.cargoBaleProduct = product;
        }
        if ((spikes.cargoBales ?? 0) <= 0) spikes.cargoBaleProduct = undefined;
        task.haulPhase = "toBale";
        continue;
      }

      if (task.haulPhase === "dumping") {
        agent.state = "working";
        const timer = task.phaseTimer ?? gameConfig.hauling.dumpMinutes;
        const used = Math.min(timer, budget);
        budget -= used;
        if (timer - used > 1e-9) {
          task.phaseTimer = timer - used;
          continue;
        }
        task.phaseTimer = undefined;
        if (task.haulDest === "sell") {
          sellHauledBales(save, product, spikes.cargoBales ?? 0, now);
          spikes.cargoBales = 0;
          spikes.cargoBaleProduct = undefined;
          task.waitingForStorage = false;
          task.haulPhase = "toBale";
          continue;
        }
        const store = nearestBaleStorageFor(save, product, agent.pos);
        const added = store ? haulBalesInto(store, product, spikes.cargoBales ?? 0) : 0;
        spikes.cargoBales = (spikes.cargoBales ?? 0) - added;
        if ((spikes.cargoBales ?? 0) > 0) {
          // Barn filled mid-dump — reroute what's left (another storage, or
          // Sell Point as a last resort) instead of stalling on this one.
          const dest = chooseBaleDest(save, product, agent.pos);
          if (!dest) {
            task.waitingForStorage = true;
            task.haulPhase = "toStorage";
            budget = 0;
            continue;
          }
          task.waitingForStorage = false;
          task.haulDest = dest.sell ? "sell" : "storage";
          if (!samePos(agent.pos, dest.pos)) {
            task.haulPhase = "toStorage";
            agent.state = "traveling";
            budget = driveToward(save, agent, dest.pos, speed, budget);
            continue;
          }
          task.haulPhase = "dumping";
          task.phaseTimer = gameConfig.hauling.dumpMinutes;
          agent.state = "working";
          continue;
        }
        spikes.cargoBaleProduct = undefined;
        task.waitingForStorage = false;
        task.haulPhase = "toBale";
        continue;
      }

      // --- decision (phases toBale / toTrailer / toStorage / waiting) ---
      const cargo = spikes.cargoBales ?? 0;
      const fieldEmpty = (haulField.baleLocations?.length ?? 0) === 0;

      // Mid-job trailer join: if this haul started with no trailer free (direct
      // haul) but an idle tractor+Bale-Trailer has since come available, pull it
      // in now for the rest of the field. Only when the collector is EMPTY with
      // bales still to grab — a safe decision point (never yanks it mid storage
      // run, never leaves it holding a load while the trailer drives over). Re-
      // enter the loop so the relay branch takes over with hasTrailer now true.
      if (!hasTrailer && cargo <= 0 && !fieldEmpty) {
        const before = task.trailerAgentId;
        assignTrailerHelper(save, task, agent);
        if (task.trailerAgentId !== before) continue;
      }

      // Still room on the spikes and bales left to grab → go collect one.
      // LOCK onto a single target bale for the whole trip: re-choosing "nearest"
      // every tick made the collector oscillate near the gate (maintainer
      // report, 2026-07-17). Re-lock only if the committed bale is gone (loaded).
      if (cargo < spikesCap && !fieldEmpty) {
        const locs = haulField.baleLocations!;
        let target = haulTargetRuntime.get(task.id);
        if (!target || !locs.some((l) => samePos(l, target!))) {
          const b = locs[nearestBaleIndex(locs, agent.pos)]!;
          target = [b[0], b[1]];
          haulTargetRuntime.set(task.id, target);
        }
        if (!samePos(agent.pos, target)) {
          task.haulPhase = "toBale";
          agent.state = "traveling";
          budget = driveToward(save, agent, target, speed, budget);
          continue;
        }
        haulTargetRuntime.delete(task.id); // reached it — free the lock
        task.haulPhase = "loading";
        task.phaseTimer = gameConfig.hauling.loadMinutes;
        agent.state = "working";
        continue;
      }
      // About to deliver (or wait) — no bale committed; clear any stale lock.
      haulTargetRuntime.delete(task.id);

      // Nothing on board and nothing left in the field.
      if (cargo <= 0) {
        // If THIS task owns the shared trailer (2026-08-13: `trailerAgent`
        // may be feeding more than one Hay-Spikes task now — reaching this
        // point already means the field's clear, or the branch above would
        // have sent this rig collecting instead), it can't call itself
        // done — and free the trailer — while the trailer's still holding a
        // load, or another rig sharing it is still carrying. A non-owning
        // task has none of that to wait for: it's free to finish the moment
        // its own cargo is empty (`finishHaul` only ever frees an agent it
        // actually owns, so it can never disturb the trailer either way).
        const iOwnTrailer = hasTrailer && trailerAgent!.taskId === task.id;
        const trailerStillNeeded =
          iOwnTrailer &&
          ((trailerImpl!.cargoBales ?? 0) > 0 ||
            save.tasks.some(
              (t) =>
                t.type === "haulBales" &&
                t.id !== task.id &&
                t.trailerAgentId === task.trailerAgentId &&
                (save.implements.find((i) => i.attachedTo === t.agentId && i.kind === "haySpikes")?.cargoBales ?? 0) > 0,
            ));
        if (trailerStillNeeded) {
          // Wait for the trailer to finish its last run, or for every other
          // rig sharing it to empty out too.
          task.haulPhase = "waiting";
          agent.state = "working";
          budget = 0;
          continue;
        }
        finishHaul(save, task, agent, events);
        continue;
      }

      // Carrying bales (spikes full, or field cleared with a partial load).
      if (hasTrailer) {
        const trailerRoom = baleTrailerCapacityBales(trailerImpl!.size) - (trailerImpl!.cargoBales ?? 0);
        // The trailer's phase/rendezvous lock live on whichever task actually
        // OWNS it (`trailerAgent.taskId` — the one driving its tick brain,
        // below). For the task that first paired the trailer those are the
        // same task, but a SECOND Hay-Spikes task sharing it (2026-08-13,
        // `assignTrailerHelper`) never gets its own `trailerPhase` written —
        // only the owner's tick brain ever sets one — so it has to read the
        // owner's state instead of its own.
        const ownerTask = trailerAgent!.taskId ? save.tasks.find((t) => t.id === trailerAgent!.taskId) : undefined;
        // Only shuttle to the trailer once it's actually PARKED at its spot with
        // room. While it's still arriving ("toEntrance") or off on a run
        // ("toStorage"/"dumping"), hold the load in-field and wait — chasing the
        // trailer's moving position is exactly what made this oscillate before.
        const trailerReady = ownerTask?.trailerPhase === "waiting" && trailerRoom > 0;
        if (!trailerReady) {
          task.haulPhase = "waiting";
          agent.state = "working";
          budget = 0;
          continue;
        }
        // Rendezvous at the trailer's LOCKED parked spot, never its live pos.
        // Read-only (the trailer owns the lock); fall back to its pos if unset.
        const rv = (ownerTask ? haulRendezvousRuntime.get(ownerTask.id) : undefined) ?? trailerAgent!.pos;
        if (!samePos(agent.pos, rv)) {
          task.haulPhase = "toTrailer";
          agent.state = "traveling";
          budget = driveToward(save, agent, rv, speed, budget);
          continue;
        }
        task.haulPhase = "unloadToTrailer";
        task.phaseTimer = gameConfig.hauling.loadMinutes;
        agent.state = "working";
        continue;
      }

      // No trailer — haul the 1–2 bales straight to storage, falling back to
      // a Sell Point if no storage exists / has room (maintainer request,
      // 2026-07-17: "prefer storage, sell as a last resort").
      const dest = chooseBaleDest(save, product, agent.pos);
      if (!dest) {
        task.waitingForStorage = true;
        agent.state = "working";
        budget = 0;
        continue;
      }
      task.waitingForStorage = false;
      task.haulDest = dest.sell ? "sell" : "storage";
      if (!samePos(agent.pos, dest.pos)) {
        task.haulPhase = "toStorage";
        agent.state = "traveling";
        budget = driveToward(save, agent, dest.pos, speed, budget);
        continue;
      }
      task.haulPhase = "dumping";
      task.phaseTimer = gameConfig.hauling.dumpMinutes;
      agent.state = "working";
      continue;
    }

    const field = save.fields.find((f) => f.id === task.fieldId);
    if (!field) {
      // Field vanished mid-task (sold) — drop the job.
      save.tasks.splice(save.tasks.indexOf(task), 1);
      agent.taskId = undefined;
      clearAgentRoute(agent.id);
      agent.state = "idle";
      continue;
    }

    // "wrap" skips this (2026-08-14) — it has no coverage path to start at
    // any more; its own dedicated block below drives point-to-point to the
    // nearest bale instead, same as Hay-Spikes' collector leg.
    if (agent.state === "traveling" && task.type !== "wrap") {
      // Drive to the field's coverage-path START (not the centroid), so work
      // begins exactly where the first lane does.
      const path = getActivePath(save, task, field, agent);
      const target = path.pts[0]!;
      const speed = (gameConfig.work.travelSpeedKmh * 1000) / 60; // meters per sim-minute
      budget = driveToward(save, agent, target, speed, budget);
      if (samePos(agent.pos, target)) agent.state = "working";
      continue;
    }

    // The baler works LIKE THE COMBINE (maintainer request, 2026-07-14): it
    // gathers forage into a hopper (on the baler implement, `cargoTons`, so it
    // persists across save/reload) as it drives; the moment the hopper holds a
    // full bale's worth it stops, ties, and ejects a bale at its spot, emptying
    // the hopper — then carries on. Any partial load left when the field is
    // finished is discarded (the hopper is cleared). Forage tons come from the
    // field's product yield (corn stover 2.5 t/ac, grass hay 1.5, alfalfa 1.6).
    if (task.type === "bale") {
      const path = getActivePath(save, task, field, agent);
      const speed = (taskFieldSpeedKmh("bale") * 1000) / 60; // meters per sim-minute
      const baler = attachedBaler(save, agent.id);
      // Shape follows the baler KIND (2026-07-24) — square bales are heavier,
      // fewer per acre and worth more each.
      const square = baler?.kind === "squareBaler";
      // A combi baler seals each bale as it rolls it (2026-07-31), so the field
      // ends up holding baleage with no separate wrap pass.
      const wrapping = baler?.kind === "combiBaler";
      const baleTons = baleTonsOf(baleProductForField(field, square));
      // Even-divide the field's forage into whole bales so the count stays
      // round(acres × balesPerAcre × productivity) — float-robust, and
      // identical to before now that productivity defaults to 1×. A
      // perennial reads the snapshot taken at mow time (the taper is keyed to
      // cuttings before THIS one, not the count after it advanced); corn
      // stover has no snapshot and falls back to the live value, which is
      // always 1× since fertilized was already reset by the harvest.
      const boost = field.lastCutProductivity ?? productivityMultiplier(field, now);
      const totalBales = Math.max(1, Math.round(task.totalAcres * balesPerAcreForField(field, square) * boost));
      const tonsPerAcre = task.totalAcres > 0 ? (totalBales * baleTons) / task.totalAcres : 0;
      if (!baler || tonsPerAcre <= 0) {
        budget = 0; // defensive: no baler hitched — shouldn't happen (auto-hitch)
        continue;
      }
      baler.cargoTons ??= 0;

      // Forage this particular bale fills to: a nominal bale ± baleFillVariance,
      // re-rolled after each drop (deleted below). A bigger threshold means a
      // longer drive before the tie, so drop SPACING along the path varies
      // naturally — no perpendicular scatter, so every bale lands on baled
      // ground (maintainer request, 2026-07-20). rand()=0.5 (test default) →
      // exactly baleTons, so deterministic tests keep their exact bale counts.
      let baleTarget = baleTargetRuntime.get(task.id);
      if (baleTarget === undefined) {
        const v = gameConfig.forage.baleFillVariance;
        baleTarget = baleTons * (1 + (rand() - 0.5) * 2 * v);
        baleTargetRuntime.set(task.id, baleTarget);
      }

      let dist = pathDistRuntime.get(task.id);
      if (dist === undefined) dist = distanceAtAcres(path, task.doneAcres, task.totalAcres);

      // Eject the current bale: drop it, empty one bale's worth from the
      // hopper, and fire the usual wrap/haul follow-ups. Shared by the
      // round/combi tie-pause below and the square baler's on-the-fly drop
      // (2026-08-16, maintainer request — a real square baler's knotter ties
      // while still rolling; only a round baler has to stop to eject).
      const dropBale = () => {
        // Drop ON the field at the tie spot: current position if inside, else the
        // last on-field position (the baler may have stopped over a concave notch
        // the path cut across — a bale must never land off the field). No
        // perpendicular scatter — the ±variance in fill distance (baleTarget)
        // already staggers the spacing, so drops stay on the driven lane.
        const inside = pointInPolygon(agent.pos, field.boundary);
        const drop = inside ? agent.pos : (baleLastInside.get(task.id) ?? agent.pos);
        const firstBaleOfRun = (field.baleLocations?.length ?? 0) === 0;
        (field.baleLocations ??= []).push([drop[0], drop[1]]);
        baler!.cargoTons = Math.max(0, (baler!.cargoTons ?? 0) - baleTarget!);
        baleTargetRuntime.delete(task.id); // re-roll the next bale's fill distance
        // The wrapper trails the baler (2026-08-14, maintainer request) —
        // same "starts once the lead machine has produced something to work
        // on" shape as the rake/baler relay (`field.windrowed` flips true at
        // rake PICKUP, not completion). Stamp `field.baleProduct`/`baledAt`
        // on the FIRST bale — `wrap`'s enqueue validation (`canWrapBales`)
        // needs a real product to check, which `applyBaleDone` used to only
        // set at the run's COMPLETION, so a wrap attempted any earlier than
        // that always failed silently. `tryEnqueue` runs on every drop
        // rather than gating on "is this the first one" too — its catch
        // makes every call after the first a harmless no-op ("already has a
        // wrap task queued"). Unlike the rake/baler pair, `wrap` can't
        // structurally outrun `bale` at all now (2026-08-14 redesign): it
        // visits EXISTING bale spots one at a time (see the `wrap` tick
        // block) rather than sweeping a coverage path at its own speed, so
        // there's nothing to "catch up to" — it just waits when it runs out
        // of unwrapped bales and baling is still adding more.
        if (firstBaleOfRun) stampBaleProduct(field, square, now, wrapping);
        if (cropProducesWrappedBale(field.crop ?? field.lastCrop)) tryEnqueue(save, field, "wrap", now);
        // Collectable the moment it hits the ground (maintainer request,
        // 2026-07-24) — a hauler no longer waits for the baler to finish the
        // whole field, which on a big one meant the entire crop lying out while
        // an idle hay-spikes rig had nothing to do. No-ops if a haul is already
        // covering the field or there's nothing free to send — or if the field
        // is destined for the wrapper (see `wrapPending`).
        queueHaulBales(save, field.id, now);
      };

      // Mid-tie? Burn budget standing still; when the timer runs out, eject
      // the bale. Square balers never enter this state (see below) — they
      // never have a tie timer to be mid-way through.
      const tie = baleTieRemaining.get(task.id);
      if (tie !== undefined) {
        const used = Math.min(tie, budget);
        budget -= used;
        const left = tie - used;
        if (left > 1e-9) {
          baleTieRemaining.set(task.id, left);
          continue; // still tying (out of budget) — resume next tick
        }
        baleTieRemaining.delete(task.id);
        dropBale();
        continue;
      }

      // Hopper hit this bale's (randomized) threshold. A round/combi baler
      // stops and ties (real machines eject the finished bale before the
      // knotter can start the next one); a square baler's knotter ties
      // continuously as it rolls, so it ejects on the fly at full speed and
      // never loses any drive budget (2026-08-16, maintainer request).
      if (baler.cargoTons >= baleTarget - 1e-9) {
        if (square) {
          dropBale();
        } else {
          baleTieRemaining.set(task.id, gameConfig.forage.baleTieMinutes);
        }
        continue;
      }

      // Not full: drive on, gathering forage. Clamp the drive so it stops EXACTLY
      // when the hopper hits this bale's threshold — so the bale drops where that
      // much forage was gathered — mirroring the combine's hopper-capacity clamp.
      // Working in WORK-metres (in-field only) keeps drops spread across a concave
      // field the coverage path over-sweeps.
      const roomAcres = (baleTarget - baler.cargoTons) / tonsPerAcre;
      const fillAt = acresDoneAt(path, dist, task.totalAcres) + roomAcres;
      const target = Math.min(path.total, distanceAtAcres(path, fillAt, task.totalAcres));
      const timeNeeded = Math.max(0, (target - dist) / speed);
      const timeUsed = Math.min(timeNeeded, budget);
      const prevAcres = task.doneAcres;
      dist = Math.min(path.total, dist + speed * timeUsed);
      budget -= timeUsed;
      pathDistRuntime.set(task.id, dist);
      task.doneAcres = Math.min(task.totalAcres, acresDoneAt(path, dist, task.totalAcres));
      baler.cargoTons += Math.max(0, task.doneAcres - prevAcres) * tonsPerAcre;
      const s = sampleAt(path, dist);
      agent.pos = s.pos;
      agent.heading = s.heading;
      if (pointInPolygon(agent.pos, field.boundary)) baleLastInside.set(task.id, agent.pos);

      if (dist >= path.total - 1e-6 && baler.cargoTons < baleTarget - 1e-9) {
        // Field finished with less than this bale's threshold left — discard the
        // partial hopper and settle up. Record the ACTUAL bales dropped (the
        // count varies run to run now that fill distance is randomized), not the
        // nominal target — the field started empty, so baleLocations is this run.
        task.doneAcres = task.totalAcres;
        baler.cargoTons = 0;
        const baledCount = field.baleLocations?.length ?? totalBales;
        completeTask(task, field, now, rand, square, wrapping);
        recordCompletion(save, task, field, agent, now, { tons: baledCount * baleTons, bales: baledCount });
        // Field Finances (2026-07-22): revenue is booked HERE, at bale time —
        // bales x the base config price. Simpler and consistent vs. tracing the
        // eventual sale of pooled storage back to fields. applyBaleDone (inside
        // completeTask) already stamped field.baleProduct while the crop was
        // still readable, so it's authoritative here.
        const baleCfg = gameConfig.baleProducts[field.baleProduct ?? "cornStover"];
        recordFieldCash(save, field.id, "revenue", `${baleCfg.name} bales`, Math.round(baledCount * baleCfg.pricePerBale));
        changed.push(field);
        events.push({ kind: "finished", task, agent });
        clearTaskRuntime(task.id);
        save.tasks.splice(save.tasks.indexOf(task), 1);
        agent.taskId = undefined;
        clearAgentRoute(agent.id);
        agent.state = "idle";
        // A finished bale run leaves loose bales on the field. If the plan says
        // wrap them, queue that FIRST — it has to land inside the same-month
        // window, and the bales must not leave the field before it runs.
        // Otherwise auto-dispatch the haul to storage (maintainer request,
        // 2026-07-17); queueHaulBales no-ops if one's already covering the field.
        if (wrapPending(save, field, now)) {
          tryEnqueue(save, field, "wrap", now);
        } else {
          queueHaulBales(save, field.id, now);
        }
      }
      continue;
    }

    // WRAP (2026-08-14 redesign, maintainer report: "not a back & forth
    // task... the tractor seeks out Round Bales and Square Bales and wraps
    // them, converting them from unwrapped product to wrapped product...
    // Then the Bale is hauled out"). Single-agent collector brain, same
    // "lock the nearest target for the whole trip" shape as Hay-Spikes
    // (`haulTargetRuntime` below) minus the cargo/delivery half — sealing
    // happens IN PLACE, nothing gets carried anywhere.
    if (task.type === "wrap") {
      const wrapField = save.fields.find((f) => f.id === task.fieldId);
      if (!wrapField) {
        // Field sold mid-wrap — nothing left to reference. Drop the job.
        // `finishHaul` is generic enough to reuse here (frees whichever
        // agent this task actually owns; wrap has no trailerAgentId, which
        // it already handles as a no-op).
        finishHaul(save, task, agent, events);
        continue;
      }
      const speed = (gameConfig.work.travelSpeedKmh * 1000) / 60; // meters per sim-minute

      if (task.wrapPhase === "wrapping") {
        agent.state = "working";
        const timer = task.phaseTimer ?? gameConfig.forage.wrapMinutesPerBale;
        const used = Math.min(timer, budget);
        budget -= used;
        if (timer - used > 1e-9) {
          task.phaseTimer = timer - used;
          continue;
        }
        task.phaseTimer = undefined;
        const locs = wrapField.baleLocations ?? [];
        if (locs.length > 0) {
          const idx = nearestBaleIndex(locs, agent.pos);
          const [sealed] = locs.splice(idx, 1);
          const wrapped = (wrapField.wrappedBaleLocations ??= []);
          wrapped.push(sealed!);
          // Starts the aging clock toward its own Aged Baleage twin
          // (`resolveAgedBaleProduct`) from the truthful moment — the FIRST
          // bale actually sealed, not whenever this batch happens to finish.
          if (wrapped.length === 1) wrapField.wrappedAt = now;
        }
        wrapTargetRuntime.delete(task.id);
        task.wrapPhase = "toBale";
        // No `changed.push` here (2026-08-14 perf fix) — wrapping never
        // touches `field.status`/texture, only the bale MARKERS, which
        // main.ts already refreshes every tick on its own cheap diff
        // (`updateBaleMarkers` → `baleStateKey`, independent of `changed`).
        // Pushing here queued a full canvas texture repaint (`renderField`)
        // per BALE — up to hundreds per field per wrap run — which is what
        // bogged the game down mid-wrap (maintainer report).
        continue;
      }

      const remaining = wrapField.baleLocations ?? [];
      if (remaining.length > 0) {
        // Lock onto one target bale for the whole trip — re-picking "nearest"
        // every tick oscillates as the agent moves (same fix Hay-Spikes'
        // `haulTargetRuntime` already made, 2026-07-17).
        let target = wrapTargetRuntime.get(task.id);
        if (!target || !remaining.some((l) => samePos(l, target!))) {
          const b = remaining[nearestBaleIndex(remaining, agent.pos)]!;
          target = [b[0], b[1]];
          wrapTargetRuntime.set(task.id, target);
        }
        if (!samePos(agent.pos, target)) {
          task.wrapPhase = "toBale";
          agent.state = "traveling";
          budget = driveToward(save, agent, target, speed, budget);
          continue;
        }
        wrapTargetRuntime.delete(task.id); // reached it — free the lock
        task.wrapPhase = "wrapping";
        task.phaseTimer = gameConfig.forage.wrapMinutesPerBale;
        agent.state = "working";
        continue;
      }

      // Nothing left to seal right now. If baling is still adding to this
      // field (the wrapper trailing the baler, see the `bale` drop branch
      // above), park and wait for the next one instead of declaring victory
      // early — mirrors how the rake/baler relay's follower doesn't finish
      // just because it caught up to the leader.
      wrapTargetRuntime.delete(task.id);
      if (save.tasks.some((t) => t.type === "bale" && t.fieldId === wrapField.id && t.status === "active")) {
        agent.state = "working";
        budget = 0;
        continue;
      }

      // Truly done: merge the sealed pile back into `baleLocations` as the
      // wrapped product (`applyWrapDone`), then release the field to hauling
      // exactly like any other bale product — no special casing downstream.
      // No `changed.push` (see the perf-fix comment above) — this touches
      // `baleProduct`/`baleLocations`, never the field's texture/status.
      const sealedCount = wrapField.wrappedBaleLocations?.length ?? 0;
      applyWrapDone(wrapField);
      recordCompletion(save, task, wrapField, agent, now, { bales: sealedCount });
      events.push({ kind: "finished", task, agent });
      clearTaskRuntime(task.id);
      save.tasks.splice(save.tasks.indexOf(task), 1);
      agent.taskId = undefined;
      clearAgentRoute(agent.id);
      agent.state = "idle";
      queueHaulBales(save, wrapField.id, now);
      continue;
    }

    // A Grain Trailer trip is wanted as soon as there's ANY grain aboard —
    // not just once the hopper's completely full (maintainer request,
    // 2026-07-13) — so hauling can run in parallel with ongoing cutting
    // instead of only kicking in at capacity. The combine itself only stops
    // dead (state stays "working") once truly full.
    if (task.type === "harvest" && field.crop) {
      const capacity = harvesterCapacityTons(agent.size ?? "medium", field.crop);
      agent.grainOnboard ??= 0;
      if (agent.grainOnboard > 1e-9) ensureUnloadTask(save, agent, field.id, field.crop, events);
      if (agent.grainOnboard >= capacity - 1e-9) {
        budget = 0;
        continue;
      }
    }

    // Working: drive the coverage path at field speed; swept in-field distance ×
    // swath = area worked, which is where doneAcres comes from (physical model).
    const path = getActivePath(save, task, field, agent);
    const speed = (taskFieldSpeedKmh(task.type, agent) * 1000) / 60; // meters per sim-minute
    let dist = pathDistRuntime.get(task.id);
    if (dist === undefined) dist = distanceAtAcres(path, task.doneAcres, task.totalAcres);

    // Harvest is capacity-limited: don't let one (possibly large, at high
    // time-compression) tick's travel budget drive the combine past what its
    // hopper can still hold — clamp the distance target to the hopper's
    // remaining room, so it stops EXACTLY at the fill point instead of
    // cutting ground the hopper has no room to bank.
    // Effective (boosted/penalized) tons/acre this field actually yields right
    // now — weeds/fertilizing (productivityMultiplier, farming.ts) apply here
    // so the hopper fills, and the harvested tonnage, both reflect it.
    const effectiveYield = field.trueYieldTonsPerAcre !== undefined
      ? field.trueYieldTonsPerAcre * productivityMultiplier(field, now)
      : undefined;
    // Chopped silage per acre — the whole plant, so it has nothing to do with
    // the GRAIN yield above and comes from its own config figure.
    const chopYield = task.type === "chop" ? silageTonsPerAcreFor(field, now) : 0;
    let target = path.total;
    if (task.type === "harvest" && effectiveYield) {
      const capacity = harvesterCapacityTons(agent.size ?? "medium", field.crop ?? "corn");
      const room = Math.max(0, capacity - (agent.grainOnboard ?? 0));
      const roomAcres = room / effectiveYield;
      const fullAt = acresDoneAt(path, dist, task.totalAcres) + roomAcres;
      target = Math.min(path.total, distanceAtAcres(path, fullAt, task.totalAcres));
    }
    // THE CHOPPER CANNOT WORK WITHOUT A WAGON (maintainer requirement).
    // Mechanically it's the combine's full-hopper stop, but the buffer is a
    // couple of tons — a chopper has no tank, only a spout — so it fills in
    // seconds and the machine simply stops until a wagon is taking material.
    // That makes wagon logistics the whole constraint of a silage harvest.
    if (task.type === "chop" && chopYield > 0) {
      const capacity = gameConfig.equipment.forageHarvester[agent.size ?? "medium"].capacityTons;
      const room = Math.max(0, capacity - (agent.grainOnboard ?? 0));
      const roomAcres = room / chopYield;
      const fullAt = acresDoneAt(path, dist, task.totalAcres) + roomAcres;
      target = Math.min(path.total, distanceAtAcres(path, fullAt, task.totalAcres));
    }

    const timeNeeded = (target - dist) / speed;
    const timeUsed = Math.min(timeNeeded, budget);
    dist = Math.min(target, dist + speed * timeUsed);
    budget -= timeUsed;
    pathDistRuntime.set(task.id, dist);

    const prevAcres = task.doneAcres;
    task.doneAcres = Math.min(task.totalAcres, acresDoneAt(path, dist, task.totalAcres));
    const s = sampleAt(path, dist);
    agent.pos = s.pos;
    agent.heading = s.heading;

    if (task.type === "harvest" && field.crop && effectiveYield !== undefined) {
      // Grain banks into the combine's own hopper (not the farm bin directly
      // anymore) — a Grain Trailer carries it the rest of the way. NOT
      // clamped to capacity here: the distance-target clamp above keeps this
      // close to capacity, but `distanceAtAcres`/`acresDoneAt` aren't exact
      // inverses of each other across a coverage path's headland turns, so a
      // tick can still bank a hair over the target (bug found in testing —
      // clamping here silently discarded that sliver of grain every fill
      // cycle instead of letting the hopper run fractionally over).
      agent.grainOnboard = (agent.grainOnboard ?? 0) + (task.doneAcres - prevAcres) * effectiveYield;
      field.harvestedAcres = task.doneAcres;
      // Remember where/what this hopper came from — survives the harvest
      // task's own completion (and applyHarvestDone clearing field.crop),
      // so a leftover load can still get routed later even if the harvest
      // task itself is long gone (maintainer request, 2026-07-13).
      agent.lastFieldId = field.id;
      agent.lastCrop = field.crop;
      // A trip's wanted the moment there's any grain at all (see the
      // pre-check above) — this catches the case where a tick banks the
      // FIRST grain of the job (pre-check ran before this tick had any).
      if (agent.grainOnboard > 1e-9) ensureUnloadTask(save, agent, field.id, field.crop, events);
    }

    // Chopped material goes into the same tiny onboard buffer the wagon then
    // drains — the relay is shared, so the bookkeeping is too.
    if (task.type === "chop" && chopYield > 0) {
      const product = silageProductForField(field);
      agent.grainOnboard = (agent.grainOnboard ?? 0) + (task.doneAcres - prevAcres) * chopYield;
      agent.lastFieldId = field.id;
      if (product && agent.grainOnboard > 1e-9) {
        ensureSilageHaul(save, agent, field.id, product, events);
      }
    }

    if (dist >= path.total - 1e-6) {
      task.doneAcres = task.totalAcres;
      // Whatever just CUT this field decides how wide the material lying on it
      // is (2026-07-24) — that's the baler's working width later, since a baler
      // has none of its own. On a crop that gets raked this is overwritten when
      // the rake starts; on straw, which skips the rake, the combine header's
      // width is the final answer.
      if (task.type === "harvest" || task.type === "mow") field.windrowWidthM = path.swath;
      // Capture the tons harvested AND the crop BEFORE completeTask
      // (applyHarvestDone clears both field.trueYieldTonsPerAcre and
      // field.crop once the crop comes off).
      const cropAtHarvest = field.crop;
      const harvestTons = task.type === "harvest" && effectiveYield !== undefined
        ? task.totalAcres * effectiveYield
        : undefined;
      completeTask(task, field, now, rand);
      recordCompletion(save, task, field, agent, now, harvestTons !== undefined ? { tons: harvestTons } : {});
      // Field Finances tab (2026-07-22): revenue at production time — tons x
      // the base config sell price, booked the moment the crop comes off. The
      // grain pools farm-wide from here, so per-field sale tracing was dropped.
      if (harvestTons !== undefined && cropAtHarvest) {
        recordFieldCash(save, field.id, "revenue", gameConfig.crops[cropAtHarvest].name,
          Math.round(harvestTons * gameConfig.crops[cropAtHarvest].sellPricePerTon));
        recordFieldCrop(save, field.id, cropAtHarvest);
      }
      // A finished rake changes no field STATUS, and its windrows are already on
      // the surface (revealed strip-by-strip as it drove). Forcing a full repaint
      // here would wipe any mulch a concurrent baler has already revealed — so
      // skip it for the rake; the reveal already left the surface correct.
      if (task.type !== "rake") changed.push(field);
      events.push({ kind: "finished", task, agent });
      clearTaskRuntime(task.id);
      save.tasks.splice(save.tasks.indexOf(task), 1);
      agent.taskId = undefined;
      clearAgentRoute(agent.id);
      agent.state = "idle";
      // The last partial hopper (never hit "full" mid-job) still needs a ride
      // — usually already queued by the post-banking check above, but the
      // field can finish on the SAME tick that check saw zero grain yet.
      // agent.lastFieldId/lastCrop were captured by that same banking code
      // (applyHarvestDone, just above, already cleared field.crop).
      if (task.type === "harvest" && agent.lastCrop && (agent.grainOnboard ?? 0) > 1e-9) {
        ensureUnloadTask(save, agent, agent.lastFieldId ?? field.id, agent.lastCrop, events);
      }
      // "wrap" never reaches here (2026-08-14) — its own dedicated block
      // above always `continue`s, including the haul it queues on
      // completion; this generic coverage-path block is unreachable for it.
    }
  }
}

function completeTask(task: FarmTask, field: Field, now: SimTime, rand: () => number, square = false, wrapping = false): void {
  switch (task.type) {
    case "plow":
      applyPlow(field);
      // Fresh ground = the next step of the rotation is now the current one
      // (maintainer correction, 2026-07-23 — this used to happen when the new
      // crop's PLANT task started). Plowing is the real boundary between one
      // crop's cycle and the next: everything before it (residue, baling,
      // mulching) belongs to the crop that came off, and everything after is
      // the new crop's.
      //
      // Derived rather than flagged on the task: advance exactly when the
      // pointer is still sitting on the crop that just came off. That makes it
      // idempotent (a second plow before planting won't skip a step, since the
      // pointer has already moved past `lastCrop`), and it works for a plow the
      // PLAYER queued by hand, which a flag set by auto-manage never would.
      if (field.lastCrop !== undefined && activePlan(field).crop === field.lastCrop) {
        advanceRotation(field);
      }
      break;
    case "plant":
      // The window was open at queue time; the work is committed even if the
      // calendar rolled past it while the tractor caught up.
      applyPlant(field, task.crop!, now, rand);
      break;
    case "harvest":
      applyHarvestDone(field);
      break;
    case "mow":
      // Snapshot the productivity boost for THIS cut before applyMowDone
      // advances cutsThisYear — the fertilize taper is keyed to how many
      // cuttings were done BEFORE this one, and baling (which reads this
      // snapshot) always happens after the count's already moved on.
      field.lastCutProductivity = productivityMultiplier(field, now);
      // Perennial "harvest": the field is cut and left with forage to rake +
      // bale; the stand itself (crop/plantedAt) is untouched so it regrows.
      applyMowDone(field, now);
      break;
    case "mulch":
      // Residue shredded + worked back in: the surface returns to bare stubble,
      // and the field carries a `mulchBonusPct` boost into its NEXT crop (residueMulched,
      // consumed by that harvest — productivityMultiplier, farming.ts). Mulching
      // is the alternative to baling, so any un-baled residue is now spent.
      field.status = "stubble";
      field.residueMulched = true;
      field.forageReady = undefined;
      field.windrowed = undefined;
      break;
    case "rake":
      // Windrowing has no separate field-status effect — the field.windrowed
      // flag was already set when the rake was picked up (so the baler could
      // start before the rake finished).
      break;
    case "bale":
      // Bales were dropped one-by-one into field.baleLocations as the baler
      // worked; this just settles the field to mulched. `square` says which
      // baler did it (2026-07-24) — that's what fixes the product, and so the
      // price and the tonnage, for everything downstream.
      applyBaleDone(field, square, now, wrapping);
      break;
    // "wrap" deliberately has no case here (2026-08-14) — it no longer runs
    // through the generic coverage-path completion this switch serves; its
    // own dedicated tick block calls `applyWrapDone` directly.
    case "chop":
      // Silage banked into the chopper's buffer as it drove and left on a
      // wagon; this settles the field. On corn that means cleared with NO
      // residue (the whole plant went); on a perennial the stand regrows.
      applyChopDone(field);
      break;
    case "weed":
      // Clears the weed flush; no new one comes until the next crop goes in.
      field.weedy = undefined;
      field.weeded = true;
      break;
    case "fertilize":
      // fertilizedAt is visual only: the wet-spray darkening lasts through
      // this month (tickFarming clears it on the month turn). fertilized
      // persists for the rest of the crop cycle and drives the +30% yield
      // boost (productivityMultiplier, farming.ts).
      field.fertilizedAt = now;
      field.fertilized = true;
      break;
  }
}

/** How many finished-task records to keep (maintainer request, 2026-07-14:
 * a "Completed" section on the Work Queue) — a flat log is enough since the
 * UI buckets/prunes by calendar month; this just stops it growing forever. */
const MAX_COMPLETED_TASKS = 200;

/** Append one record to `save.completedTasks`, capped at `MAX_COMPLETED_TASKS`
 * — shared by task completions (below) and sale records (main.ts, since a
 * sale isn't a `FarmTask` at all — it's a direct player action in economy.ts). */
/** Sale records are ACCUMULATED rather than appended one per delivery — see
 * `appendCompletedTask`. Field-work completions are never merged: each one is a
 * discrete job on a specific field, and collapsing them would lose that. */
function isSaleRecord(type: CompletedTask["type"]): boolean {
  return type === "sellGrain" || type === "sellBales";
}

/**
 * Log a finished job (or a sale) to the Work Queue's Completed feed.
 *
 * SALES ACCUMULATE INTO ONE ROW PER PRODUCT (maintainer request, 2026-07-23).
 * A sell run makes as many trips as the trailer needs — 150 t of corn is three
 * deliveries — and logging each one separately buried the feed in near-identical
 * rows that individually meant nothing. Now a delivery folds its tons, bales and
 * revenue into the product's existing row, so it reads as one running total that
 * climbs as the rig works.
 *
 * Merging is scoped to the same CALENDAR MONTH, because that's exactly what the
 * panel shows: an entry from last month is already filtered out, so extending it
 * would silently drop the new revenue off the display. A month turn mid-run
 * simply starts a fresh row, which is also the honest way to report it.
 */
export function appendCompletedTask(save: SaveState, entry: CompletedTask): void {
  const log = (save.completedTasks ??= []);
  if (isSaleRecord(entry.type)) {
    const at = dateOf(entry.completedAt);
    const existing = log.find((c) => {
      if (c.type !== entry.type || c.crop !== entry.crop || c.label !== entry.label) return false;
      const cAt = dateOf(c.completedAt);
      return cAt.year === at.year && cAt.month === at.month;
    });
    if (existing) {
      existing.tons = (existing.tons ?? 0) + (entry.tons ?? 0);
      existing.bales = (existing.bales ?? 0) + (entry.bales ?? 0);
      existing.revenue = (existing.revenue ?? 0) + (entry.revenue ?? 0);
      // Once a total spans more than one source, naming one field on it would
      // be a lie — drop the attribution rather than keep whichever came first.
      if (existing.fieldId !== entry.fieldId) existing.fieldId = undefined;
      // Move it to "just happened" so a run in progress keeps surfacing at the
      // top of the feed instead of sinking under older, finished work.
      existing.completedAt = entry.completedAt;
      return;
    }
  }
  log.push(entry);
  if (log.length > MAX_COMPLETED_TASKS) log.splice(0, log.length - MAX_COMPLETED_TASKS);
}

/** Snapshot a task that's about to be discarded into `save.completedTasks`,
 * since `FarmTask` itself (doneAcres, costPaid) is spliced out the instant
 * the work finishes and nothing else records what happened. */
function recordCompletion(
  save: SaveState,
  task: FarmTask,
  field: Field,
  agent: Agent,
  now: SimTime,
  extra: { tons?: number; bales?: number } = {},
): void {
  // Stamp the year's crop for the Finances tab. Covers perennial mow/bale
  // years that never re-plant (field.crop stays set for grass/alfalfa); for
  // an annual harvest field.crop is already cleared by completeTask, but the
  // plant/harvest sites already stamped it.
  if (field.crop) recordFieldCrop(save, field.id, field.crop);
  appendCompletedTask(save, {
    id: task.id,
    type: task.type,
    fieldId: field.id,
    crop: task.crop,
    acres: task.totalAcres,
    costPaid: task.costPaid,
    agentName: agent.name,
    completedAt: now,
    ...extra,
  });
}

/** The mutually-exclusive field-lifecycle task types (§10): only one of these
 * should ever be pending on a field at a time. Weed/fertilize are deliberately
 * NOT here — they're independent side-tasks (brief request, 2026-07-11) and
 * must never block the lifecycle from advancing, including while stuck queued
 * for lack of a sprayer. */
const LIFECYCLE_TASKS: ReadonlySet<TaskType> = new Set(["plow", "plant", "harvest", "mow", "mulch", "rake", "bale"]);

/** The config's first crop — the fallback when an auto-managed field has no plans. */
function defaultCrop(): CropId {
  return (Object.keys(gameConfig.crops) as CropId[])[0]!;
}

/** A sensible default plan for an auto-managed field with none defined yet. */
export function defaultPlan(): FieldPlan {
  const crop = defaultCrop();
  // Bale only when the crop actually leaves balable residue (2026-07-23) — this
  // was a flat `true`, which became meaningless once corn stopped making stover.
  return { crop, bale: !!gameConfig.crops[crop].producesForage };
}

/** The rotation step currently running on `field`: `plans[rotationIndex % len]`
 * (maintainer redesign, 2026-07-23 — was keyed to the campaign year). Falls back
 * to a single default plan when none are set. `now` is no longer read, but is
 * kept in the signature: every call site has it, and a future step-level "how
 * long has this been current" rule would want it back. */
export function activePlan(field: Field, _now?: SimTime): FieldPlan {
  const plans = field.plans && field.plans.length > 0 ? field.plans : [defaultPlan()];
  return plans[rotationStep(field, plans.length)]!;
}

/** The NEXT step in the sequence — what auto-manage plants once the current
 * crop is off the field. Wraps to the start after the last step. */
export function nextPlan(field: Field): FieldPlan {
  const plans = field.plans && field.plans.length > 0 ? field.plans : [defaultPlan()];
  return plans[(rotationStep(field, plans.length) + 1) % plans.length]!;
}

/** `field.rotationIndex` normalized into a valid index for a `len`-step
 * sequence — tolerates an unset index (legacy saves migrate in main.ts, but a
 * field built in a test or trimmed to fewer steps must not read out of range). */
function rotationStep(field: Field, len: number): number {
  return ((field.rotationIndex ?? 0) % len + len) % len;
}

/** Move the sequence on by one step. Called the moment the next step's PLANT
 * task starts (see the task-pickup branch in `tickAgent`) — not at harvest, so
 * the outgoing crop keeps ownership of its own residue work (bale/mulch/plow). */
export function advanceRotation(field: Field): void {
  const len = field.plans?.length ?? 1;
  field.rotationIndex = (rotationStep(field, len) + 1) % len;
}

/**
 * Drop step `idx` from a field's rotation, keeping `rotationIndex` pointing at
 * the SAME step object it pointed at before wherever possible.
 *
 * Worth its own function (and its own tests) because getting it wrong is
 * invisible but real: naively splicing without fixing the pointer silently
 * shifts which crop the field is growing. Removing a step BEFORE the running
 * one slides everything down by one; removing the running step itself has
 * nowhere to stay, so it lands on whatever moved into that slot (clamped, since
 * removing the last step wraps to the front). Refuses to empty the sequence.
 */
export function removeRotationStep(field: Field, idx: number): void {
  const plans = field.plans;
  if (!plans || plans.length <= 1 || idx < 0 || idx >= plans.length) return;
  const active = rotationStep(field, plans.length);
  plans.splice(idx, 1);
  if (active > idx) field.rotationIndex = active - 1;
  else if (active === idx) field.rotationIndex = active % plans.length;
  else field.rotationIndex = active;
}

/**
 * The step the NEXT plow is preparing ground for — whose schedule row therefore
 * drives when that plow runs.
 *
 * Normally the next step, since the pointer is still on the crop that just came
 * off. The exception is a field that has never grown anything: there's nothing
 * to hand off from, so the ground is being prepared for the step already
 * current. Returns the identical object reference as `activePlan` in that case.
 *
 * Only meaningful BEFORE the plow — once it completes the pointer advances onto
 * this step and `activePlan` takes over (see the plow completion case).
 */
export function planToPlant(field: Field): FieldPlan {
  const virgin = field.crop === undefined && field.lastCrop === undefined;
  return virgin ? activePlan(field) : nextPlan(field);
}

// --- Blocked work (maintainer request, 2026-07-23) --------------------------
/**
 * Work the farm WANTS to do but can't. Surfaced in the Work Queue with a ⚠️ so
 * a field that has quietly stopped progressing explains itself, instead of the
 * player having to notice an absence.
 *
 * Deliberately narrow: only blockers the player can actually act on. Being out
 * of season, or waiting on an earlier step, resolves itself and would sit there
 * as a permanent warning — those stay silent.
 */
export interface BlockedWork {
  fieldId: string;
  type: TaskType;
  /** Player-facing, already specific ("No mulcher owned", "Needs $4,200 — you have $900"). */
  reason: string;
}

/**
 * Auto-manage's cash refusals for this tick, keyed field+task.
 *
 * Runtime-only and rebuilt every `autoManageAll` pass, exactly like the
 * coverage-path caches: it's a snapshot of "what did the manager just try and
 * fail to do", which is meaningless to persist and wrong to keep across ticks
 * (the player might have sold something in between).
 */
const blockedByCash = new Map<string, BlockedWork>();

/** Record an auto-manage enqueue failure, but only if it's worth showing. */
function noteBlocked(field: Field, type: TaskType, err: unknown): void {
  if (!(err instanceof InsufficientFundsError)) return; // out of season etc. — self-resolving
  blockedByCash.set(`${field.id}:${type}`, {
    fieldId: field.id,
    type,
    reason: `Needs $${Math.round(err.cost).toLocaleString()} — you have $${Math.round(err.available).toLocaleString()}`,
  });
}

/** Enqueue for auto-manage: swallows the expected refusals exactly as the bare
 * try/catch blocks used to, but classifies them first. Returns the task, or
 * undefined if it didn't happen. */
function tryEnqueue(save: SaveState, field: Field, type: TaskType, now: SimTime, crop?: CropId): FarmTask | undefined {
  try {
    return enqueueTask(save, field, type, now, crop);
  } catch (err) {
    noteBlocked(field, type, err);
    return undefined;
  }
}

/**
 * Everything currently blocked, for the Work Queue panel: auto-manage's cash
 * refusals, plus any QUEUED task that no machine on the farm can perform.
 *
 * The second case can't come from a caught error — enqueueing succeeds fine, the
 * task simply never gets picked up, so it would otherwise sit in the queue
 * forever with no explanation. That's the single most confusing state in the
 * game ("why isn't anything happening?"), and the one blocker guaranteed never
 * to resolve on its own.
 */
export function blockedWork(save: SaveState): BlockedWork[] {
  const out: BlockedWork[] = [...blockedByCash.values()].filter((b) =>
    // Drop anything that has since been queued after all.
    !save.tasks.some((t) => t.fieldId === b.fieldId && t.type === b.type),
  );
  for (const task of save.tasks) {
    if (task.status !== "queued") continue;
    // Harvest's implement is crop-dependent (which header) and bale's is
    // equipment-dependent (either baler kind), so neither is in the table —
    // resolve them per task instead.
    const kind = task.type === "harvest"
      ? headerKindForTask(save, task)
      : task.type === "chop"
        ? chopHeadKindForTask(save, task)
        : task.type === "bale"
          ? (BALER_KINDS.find((k) => save.implements.some((i) => i.kind === k)) ?? "bailer")
          : TASK_IMPLEMENT[task.type];
    const needed = TASK_AGENT_KIND[task.type];
    // `agentCanDoTask`, not a bare kind comparison: a cut counts as covered by
    // a windrower as well as by a tractor (2026-07-24).
    if (!save.agents.some((a) => agentCanDoTask(a, task.type))) {
      const what = needed === "harvester" ? "combine" : needed === "forageHarvester" ? "forage harvester" : needed;
      out.push({
        fieldId: task.fieldId, type: task.type,
        reason: task.type === "mow" ? "No tractor or windrower owned" : `No ${what} owned`,
      });
      continue;
    }
    // A cut is covered by a Self-Propelled Windrower whether or not the farm
    // owns a Mower — the windrower needs no implement at all, so neither the
    // "own one" nor the "big enough tractor" check below applies to it.
    if (task.type === "mow" && save.agents.some((a) => a.kind === "windrower")) continue;
    if (kind && !save.implements.some((i) => i.kind === kind)) {
      out.push({ fieldId: task.fieldId, type: task.type, reason: `No ${IMPLEMENT_NAME[kind]} owned` });
      continue;
    }
    // A chopper has no tank: with nothing to unload into it cannot turn a
    // wheel, so this is a stop, not a slowdown, and worth saying plainly.
    if (task.type === "chop" && !farmHasForageWagon(save)) {
      out.push({
        fieldId: task.fieldId, type: task.type,
        reason: "No Forage Wagon owned — a chopper can't work without one",
      });
      continue;
    }
    // Owned, but nothing that can carry it — a large-only implement on a
    // small-only fleet is just as stuck as not owning one. Headers ride on the
    // COMBINE, so they're checked against combines rather than tractors.
    const carrier = task.type === "harvest" ? "harvester" : task.type === "chop" ? "forageHarvester" : "tractor";
    if (kind && !save.agents.some((a) => a.kind === carrier && a.size && save.implements.some((i) => i.kind === kind && canPull(a.size!, i.size, kind)))) {
      out.push({
        fieldId: task.fieldId, type: task.type,
        reason: `No ${carrier === "harvester" ? "combine" : carrier === "forageHarvester" ? "forage harvester" : "tractor"} big enough for the ${IMPLEMENT_NAME[kind]}`,
      });
    }
  }
  return out;
}

/**
 * Is the plow due this month for the step the ground is being prepared for?
 * Replaces the old fixed Dec–Feb `inPlowWindow` season (2026-07-23): the window
 * is now derived from the crop's own cycle — anything after the ground clears
 * and before that crop goes in — defaulting to January, or to the month after
 * harvest for a crop that overwinters.
 */
function plowDue(now: SimTime, upcoming: FieldPlan): boolean {
  const plantMonth = effectiveMonthFor("plant", upcoming.crop, upcoming.schedule?.plant);
  return plowDueAt(upcoming.crop, dateOf(now).month, upcoming.schedule?.plow, plantMonth);
}

/** Is this step's crop due to go in the ground? Soft-retries from its chosen
 * month through the rest of the crop's planting window — see `plantDueAt`. */
function plantDue(now: SimTime, plan: FieldPlan): boolean {
  return plantDueAt(plan.crop, dateOf(now).month, plan.schedule?.plant);
}

/**
 * Is a planned mulch still OWED on this field — the plan asks for one, it hasn't
 * run yet this cycle, and the field can still take it?
 *
 * The plow WAITS while this is true (maintainer request, 2026-07-23). Plowing
 * turns the residue under, so a plow that ran ahead of a scheduled mulch would
 * silently cancel it and its yield bonus — the mulch has to go first.
 * Perennials never mulch (canMulch is false for them), so this is always false
 * there.
 */
function mulchPending(save: SaveState, field: Field, plan: FieldPlan): boolean {
  return !!plan.mulch && !field.autoMulchDone && canMulch(save, field);
}

/** Field Schedule tab (2026-07-21): does the current month satisfy this
 * task's schedule override, if any? Undefined = no override set = today's
 * behavior (fire the moment the underlying gate opens). A set override
 * narrows an otherwise-open gate down to firing only in that one chosen
 * month — the gate itself (inWeedingWindow, canFertilizeNow, inPlowWindow,
 * "ready") stays the real floor, checked separately at each call site. */
function monthMatches(now: SimTime, override: number | undefined): boolean {
  return override === undefined || dateOf(now).month === override;
}

/**
 * Idle-game auto-management (player-requested, brief §7-adjacent): drive the
 * field's lifecycle against its active rotation plan (`activePlan`) — plow →
 * plant the plan's crop → (weed / fertilize if the plan folds them in) → harvest
 * → rake+bale or plow-under per the plan — looping year to year. Failures (can't
 * afford it, out of season) are silently retried next tick.
 */
export function autoManageField(save: SaveState, field: Field, now: SimTime): void {
  // TWO steps are in play, either side of the PLOW (maintainer correction,
  // 2026-07-23 — the handover used to be at planting):
  //   `plan`     — the step the pointer is on. Before the plow that's the crop
  //                that just came off, so it owns the residue work (mulch,
  //                rake/bale); after the plow it IS the new crop, so it owns
  //                planting and everything downstream (weed, fertilize, harvest).
  //   `upcoming` — the step the plow is preparing ground for. Only meaningful
  //                BEFORE the plow, which is the only place it's read: once the
  //                plow completes, the pointer advances onto it and `plan`
  //                takes over.
  const plan = activePlan(field);
  const upcoming = planToPlant(field);

  // Optional side-tasks first — independent of the lifecycle, once per crop.
  // A schedule override just narrows WHICH month within the open window
  // counts as "on" — if the chosen month is missed (e.g. unaffordable that
  // tick), the window itself is still open on later ticks, so this keeps
  // retrying every tick same as the un-overridden case (soft-retry, per
  // maintainer request — never worse than today's behavior).
  if (plan.weed && !field.autoWeedDone && inWeedingWindow(field, now) && monthMatches(now, plan.schedule?.weed)) {
    // Only mark the pass done if it actually queued — a failed enqueue must
    // stay retryable, or one broke tick would silently skip weeding for the
    // whole crop cycle.
    if (tryEnqueue(save, field, "weed", now)) field.autoWeedDone = true;
  }
  if (plan.fertilize && !field.autoFertDone && canFertilizeNow(field, now) && monthMatches(now, plan.schedule?.fertilize)) {
    if (tryEnqueue(save, field, "fertilize", now)) field.autoFertDone = true;
  }

  const lifecycleBusy = save.tasks.some((t) => t.fieldId === field.id && LIFECYCLE_TASKS.has(t.type));
  if (lifecycleBusy) return; // a plow/plant/harvest/mow/rake/bale step is already lined up

  // Perennial forage (grass/alfalfa): plow, establish once, then cut → rake →
  // bale each cutting window — never replanted after that. Fertilize was
  // already handled above (canFertilizeNow's perennial branch = its April window).
  // A standing perennial stand keeps this branch for as long as it lives; a
  // BARE field only enters it when the step about to be planted is perennial.
  if (isPerennial(field.crop) || (!field.crop && isPerennial(upcoming.crop))) {
    if (!field.crop) {
      // Ground needs plowing first, same as an annual crop (maintainer
      // request, 2026-07-16) — still waits for the winter plow window. Plow and
      // plant both read the UPCOMING step's schedule: they're prep for its crop.
      if (canPlow(field.status)) {
        if (plowDue(now, upcoming)) {
          tryEnqueue(save, field, "plow", now);
        }
      } else if (plantDue(now, plan)) {
        // Tilled — establish the stand in its (March) planting window. The plow
        // already moved the pointer, so `plan` is the crop going in.
        tryEnqueue(save, field, "plant", now, plan.crop);
      }
      return;
    }
    if (field.status === "ready") {
      try {
        enqueueTask(save, field, "mow", now); // the perennial "harvest"
      } catch {
        /* no mower / cash yet — retry next tick */
      }
      return;
    }
    if (field.status === "harvested") {
      if (forageDue(save, field) && plan.bale) {
        tryEnqueue(save, field, "rake", now);
        tryEnqueue(save, field, "bale", now);
      } else if (field.forageReady) {
        // Not baling (opted out / no gear) — drop the cut forage; the stand
        // regrows for the next window (a perennial is never plowed under).
        field.forageReady = undefined;
      }
      return;
    }
    return; // growing / planted — nothing to do until the next cutting window
  }

  switch (field.status) {
    case "withered":
    case "mulched":
      // "mulched" = the clean surface a bale run leaves; "withered" = a crop
      // lost to a missed harvest window. Both can still take a mulch pass
      // before plowing (2026-07-23). While a mulch is owed the plow WAITS, so
      // we never fall through to plowing this tick.
      if (mulchPending(save, field, plan)) {
        // Fire on the mulch's scheduled month, or right away if the plow's come
        // due — either way the plow holds off until the mulch is done.
        if (monthMatches(now, plan.schedule?.mulch) || plowDue(now, upcoming)) {
          if (tryEnqueue(save, field, "mulch", now)) field.autoMulchDone = true;
        }
        break;
      }
    // no mulch owed — fall through to the plow branch
    case "stubble":
      // The plow is ground prep for the UPCOMING crop, so it reads that step's
      // schedule. (Reached from stubble directly, or after a mulch has settled a
      // withered/mulched field — never while a mulch is still owed.)
      if (plowDue(now, upcoming)) {
        tryEnqueue(save, field, "plow", now);
      }
      break;
    case "harvested":
      // HAYLAGE (Phase 2): a cut perennial can be chopped off the windrow
      // instead of raked and baled. It still needs the rake — a pickup head
      // lifts a windrow, it doesn't gather one — so the rake goes in first and
      // the chopper follows, exactly where the baler would have.
      if (isPerennial(field.crop) && field.forageReady && canChopField(save, field)) {
        if (needsRakeBeforeBaling(field)) tryEnqueue(save, field, "rake", now);
        tryEnqueue(save, field, "chop", now);
        break;
      }
      if (forageDue(save, field) && plan.bale) {
        // The forage loop: rake then bale (queued together — the baler waits in
        // the queue until the rake has started). Once baled the field is
        // "mulched" and comes back around to plowing. Straw needs no rake pass.
        if (needsRakeBeforeBaling(field)) {
          tryEnqueue(save, field, "rake", now);
        }
        tryEnqueue(save, field, "bale", now);
      } else if (mulchPending(save, field, plan)) {
        // Optional residue pass (annuals we aren't baling): shred the residue
        // back in. It fires on its scheduled month, OR immediately once the plow
        // has come due — because the plow WAITS for a planned mulch
        // (maintainer request, 2026-07-23) rather than turning the residue under
        // ahead of it. Completing it flips the field to stubble → next tick plows.
        // While it's still owed but neither trigger has hit, we simply wait
        // (the plow branch below is unreachable while a mulch is pending).
        if (monthMatches(now, plan.schedule?.mulch) || plowDue(now, upcoming)) {
          if (tryEnqueue(save, field, "mulch", now)) field.autoMulchDone = true;
        }
      } else if (plowDue(now, upcoming)) {
        // No mulch owed — plow under. Discard any un-baled forage so the plow
        // isn't gated on it (the plan opted out of baling, or there's no gear).
        if (field.forageReady) field.forageReady = undefined;
        tryEnqueue(save, field, "plow", now);
      }
      break;
    case "tilled":
      // Ground is ready, so the plow has already advanced the pointer — `plan`
      // IS the crop going in, on its own schedule row. Due from the chosen month
      // through the rest of the crop's window, so a plow that finished late
      // doesn't cost the field a year (maintainer report, 2026-07-24).
      if (plantDue(now, plan)) {
        tryEnqueue(save, field, "plant", now, plan.crop);
      }
      break;
    case "ready":
      // Harvest's override is DELAY-ONLY (a ready field never un-readies —
      // no spoilage modeled — so waiting is always safe, and this keeps
      // retrying every tick until the chosen month arrives, same pattern as
      // everything else here).
      if (monthMatches(now, plan.schedule?.harvest)) {
        if (canChopField(save, field)) {
          tryEnqueue(save, field, "chop", now);
        } else if (!isChopOnlyCrop(field.crop)) {
          // A chop-only crop (Forage) has no combine fallback — with no
          // chopper/wagon/head yet, it just waits rather than misrouting to
          // a "harvest" the crop was never going to produce grain for.
          tryEnqueue(save, field, "harvest", now);
        }
      }
      break;
  }
}

/** Run auto-management for every flagged field (call once per tick, before
 * tickTasks so freshly queued work can start the same tick). */
export function autoManageAll(save: SaveState, now: SimTime): void {
  // Blocked-work notes are a snapshot of THIS pass, not a running log — a
  // shortfall from ten ticks ago may well have been resolved since.
  blockedByCash.clear();
  for (const field of save.fields) {
    if (field.autoManage) autoManageField(save, field, now);
  }
}
