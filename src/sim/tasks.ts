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

import { gameConfig, SIZE_RANK, FEET_TO_METERS } from "../config/gameConfig";
import type { CropId, EquipmentSize, BaleProduct } from "../config/gameConfig";
import type { SimTime } from "./clock";
import type { SaveState, Field, FieldStatus, FarmTask, Agent, Implement, TaskType, FieldPlan, CompletedTask } from "../state/saveState";
import { dateOf } from "./calendar";
import { areaAcres, pointInPolygon } from "../geo/geometry";
import type { Meters } from "../geo/coords";
import {
  inPlantingWindow, canPlow, applyPlow, applyPlant, applyHarvestDone, applyBaleDone,
  applyMowDone, inPlowWindow, hasStandingCrop, inWeedingWindow, canFertilizeNow,
  isPerennial, balesPerAcreForField, canSeedPerennial, productivityMultiplier, baleProductForField,
} from "./farming";
import { buildCoveragePath, buildHeadlandCoveragePath, sampleAt, workDoneAt, distanceAtWork, TASK_HEADLANDS } from "./coverage";
import type { CoveragePath } from "./coverage";
import {
  nearestFarmYard, nearestSiloForCrop, siloCapacityForCrop,
  nearestBaleStorageFor, haulBalesInto, nearestSellPointFor,
} from "./buildings";
import type { Building } from "../state/saveState";
import { planRoute } from "./roadNet";
import type { RoadNetwork } from "./roadNet";
import { recordCash } from "./ledger";
import { recordFieldCash, recordFieldCrop } from "./fieldLedger";
import { grainUnitPrice, baleUnitPrice, monthOf, SELLABLE_GRAINS } from "./market";

const ACRE_M2 = 4046.8564224;

/** Which agent kind performs each task type. */
export const TASK_AGENT_KIND: Record<TaskType, Agent["kind"]> = {
  plow: "tractor",
  plant: "tractor",
  harvest: "harvester",
  mow: "tractor", // perennial forage "harvest" — tractor + Mower, no combine
  mulch: "tractor", // optional post-harvest residue pass — tractor + Mulcher
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

/** Buyable power units. */
export type EquipmentKind = "tractor" | "harvester";
/** Buyable implements: a plow (tills), a planter (seeds), a sprayer (weeds or
 * fertilizes), a Grain Trailer (hauls a full combine to a silo) — same widths/
 * requirements, a tractor hitches one at a time. */
export type ImplementKind = "plow" | "planter" | "sprayer" | "rake" | "bailer" | "grainTrailer" | "mower" | "mulcher" | "haySpikes" | "baleTrailer";

const EQUIPMENT_NAME: Record<EquipmentKind, string> = { tractor: "Tractor", harvester: "Combine" };
const IMPLEMENT_NAME: Record<ImplementKind, string> = {
  plow: "Plow", planter: "Planter", sprayer: "Sprayer", rake: "Rake", bailer: "Baler",
  grainTrailer: "Grain Trailer", mower: "Mower", mulcher: "Mulcher", haySpikes: "Hay Spikes", baleTrailer: "Bale Trailer",
};
const SIZE_LABEL: Record<EquipmentSize, string> = { small: "Small", medium: "Medium", large: "Large" };

/** Ledger item label for each field-expense task type (hover breakdown in the
 * Finance tab's cashflow table). */
const FIELD_EXPENSE_ITEM: Partial<Record<TaskType, string>> = {
  plow: "Plowing", plant: "Planting", mow: "Mowing", mulch: "Mulching", weed: "Weeding", fertilize: "Fertilizing",
  rake: "Raking", bale: "Baling", harvest: "Harvesting",
};

/** Which implement kind a task type needs (undefined = none, e.g. harvest).
 * Weed and fertilize both use a sprayer; rake/bale use their own tools; mow
 * uses a Mower; unloadHarvester needs a Grain Trailer. Exported for the Work
 * Queue panel's per-task implement icon (main.ts). */
export const TASK_IMPLEMENT: Partial<Record<TaskType, ImplementKind>> = {
  plow: "plow", plant: "planter", mow: "mower", mulch: "mulcher", weed: "sprayer", fertilize: "sprayer",
  rake: "rake", bale: "bailer", unloadHarvester: "grainTrailer", haulBales: "haySpikes",
  // `sell` deliberately has NO fixed entry: which trailer it needs depends
  // on the product (grain vs bales), so it is resolved per task by
  // `sellTrailerKind` instead of read from this table.
};

/** Price of a power unit at a given size. */
export function agentPrice(kind: EquipmentKind, size: EquipmentSize): number {
  return kind === "harvester" ? gameConfig.equipment.harvester[size].price : gameConfig.equipment.tractor[size].price;
}

/** Grain hopper capacity of a combine at `size`, tons (maintainer request, 2026-07-12). */
export function harvesterCapacityTons(size: EquipmentSize): number {
  return gameConfig.equipment.harvester[size].capacityTons;
}

/** Cargo capacity of a Grain Trailer at `size`, tons. */
export function grainTrailerCapacityTons(size: EquipmentSize): number {
  return gameConfig.equipment.grainTrailer[size].capacityTons;
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
  grainTrailer: gameConfig.equipment.grainTrailer,
  mower: gameConfig.equipment.mower,
  mulcher: gameConfig.equipment.mulcher,
  haySpikes: gameConfig.equipment.haySpikes,
  baleTrailer: gameConfig.equipment.baleTrailer,
};

/** Price of an implement at a given size. */
export function implementPrice(kind: ImplementKind, size: EquipmentSize): number {
  return IMPLEMENT_CONFIG[kind][size].price;
}

/** Working width (meters) of an implement. */
export function implementWidthM(impl: Implement): number {
  return IMPLEMENT_CONFIG[impl.kind][impl.size].widthFt * FEET_TO_METERS;
}

/** Can a tractor of `tractorSize` pull an implement of `implSize`? (its class or smaller) */
export function canPull(tractorSize: EquipmentSize, implSize: EquipmentSize): boolean {
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
  for (const a of save.agents) {
    if (a.kind === "tractor" || a.kind === "harvester") {
      a.size ??= "medium"; // pre-size saves default to medium
      a.purchaseCost ??= agentPrice(a.kind, a.size);
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
  const base = `${EQUIPMENT_NAME[kind]} - ${SIZE_LABEL[size]}`;
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
  const kindHasWork = save.tasks.some((t) => TASK_AGENT_KIND[t.type] === agent.kind);
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
  if (!tractor.size || !canPull(tractor.size, impl.size)) {
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
    .filter((i) => i.kind === kind && !i.attachedTo && tractor.size && canPull(tractor.size, i.size))
    .sort((a, b) => SIZE_RANK[b.size] - SIZE_RANK[a.size])[0];
}

/** Can this tractor take a task needing `kind` right now — does it have (or can
 * it hitch) that implement? Used both for task assignment and UI hints. */
function tractorCanUse(save: SaveState, tractor: Agent, kind: ImplementKind): boolean {
  return !!attachedImplement(save, tractor.id, kind) || !!availableImplementFor(save, tractor, kind);
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
      if (canPull(only.size!, impl.size)) return only;
      continue;
    }
    const puller = free
      .filter((a) => canPull(a.size!, impl.size))
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
  const baler = save.implements.some((i) => i.kind === "bailer");
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
  if (!save.implements.some((i) => i.kind === "bailer")) return false;
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
  if (type === "harvest") return Math.round(acres * gameConfig.harvestCostPerAcre);
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
  if (type === "harvest" && eff !== "ready") {
    throw new Error(`${field.id} isn't ready to harvest yet`);
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

/** Cancel a still-QUEUED task, refunding what was paid. Active tasks (an agent
 * is on-site working) can't be canceled in v1. */
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
export function estimateTaskHours(save: SaveState, task: FarmTask): number {
  // Not an acres-based job — point-to-point hauling, no coverage path/width.
  // The UI shows its own phase text instead of an acres/hours estimate.
  if (task.type === "unloadHarvester" || task.type === "haulBales") return 0;
  const field = save.fields.find((f) => f.id === task.fieldId);
  if (!field) return 0;
  const remainingAcres = Math.max(0, task.totalAcres - task.doneAcres);
  const speedMPerHr = taskFieldSpeedKmh(task.type) * 1000;

  if (task.status === "active" && task.agentId) {
    const agent = save.agents.find((a) => a.id === task.agentId);
    if (agent) {
      const path = getActivePath(save, task, field, agent);
      const remainingDist = path.total * (task.totalAcres > 0 ? remainingAcres / task.totalAcres : 0);
      return remainingDist / speedMPerHr;
    }
  }

  const kind = TASK_IMPLEMENT[task.type];
  const nominalHarvesterSize = save.agents.find((a) => a.kind === "harvester")?.size ?? "medium";
  const widthFt = task.type === "harvest"
    ? gameConfig.equipment.harvester[nominalHarvesterSize].widthFt
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
  return field.status === "ready"; // harvest
}

/** In-field working speed for a task, km/h — rake and baler run at their own
 * (config) speeds so the rake pulls ahead; everything else uses the shared
 * fieldwork speed. */
function taskFieldSpeedKmh(type: TaskType): number {
  if (type === "rake") return gameConfig.forage.rakeSpeedKmh;
  if (type === "bale") return gameConfig.forage.baleSpeedKmh;
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

/** Working width (meters) for a task: from the attached implement (plow/
 * planter), or the config combine header width for harvest. */
function taskSwathMeters(save: SaveState, task: FarmTask, agent: Agent): number {
  if (task.type === "harvest") return gameConfig.equipment.harvester[agent.size ?? "medium"].widthFt * FEET_TO_METERS;
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
  // Process machines SMALLEST-first, so the smallest capable tractor picks up a
  // queued task before any larger one does — keeping big tractors free for the
  // jobs only they can pull (maintainer request, 2026-07-11). Agents already
  // mid-task just continue regardless of order; this only affects who grabs an
  // unclaimed job.
  const order = [...save.agents].sort((a, b) => SIZE_RANK[a.size ?? "medium"] - SIZE_RANK[b.size ?? "medium"]);
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
  if (agent.kind !== "tractor" && agent.kind !== "harvester") return undefined;
  // A full (or leftover-loaded) combine waits for its Grain Trailer — it
  // shouldn't wander off toward a barn mid-wait.
  if (agent.kind === "harvester" && (agent.grainOnboard ?? 0) > 0) return undefined;
  const slots = gameConfig.buildings.tractorBarn.slots;
  let best: Building | undefined;
  let bestD = Infinity;
  for (const barn of save.buildings) {
    if (barn.kind !== "tractorBarn") continue;
    const occupied = save.agents.filter(
      (a) =>
        a.id !== agent.id &&
        (a.kind === "tractor" || a.kind === "harvester") &&
        a.state === "idle" &&
        samePos(a.pos, barn.pos),
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
  const canGrow = trips.length === 0 || (trips.length < gameConfig.hauling.maxCrewSize && hasFreeCartTractor(save));
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
export function queueHaulBales(save: SaveState, fieldId: string): FarmTask | undefined {
  const field = save.fields.find((f) => f.id === fieldId);
  const bales = field?.baleLocations?.length ?? 0;
  if (!field || bales <= 0) return undefined;
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
  }
  const task: FarmTask = {
    id: `task-${++taskSeq}`,
    type: "haulBales",
    fieldId,
    totalAcres: 1,
    doneAcres: 0,
    status: "queued",
    costPaid: 0,
    baleProduct: field.baleProduct ?? "cornStover",
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

/** Pull an idle tractor+Bale-Trailer into a Haul Bales job as the hauler half
 * of the relay (auto-hitching a loose trailer if the spare tractor has none).
 * No-op if there's no spare idle tractor / no trailer available — the
 * Hay-Spikes tractor then hauls direct.
 *
 * The trailer parks at a FIXED point (the nearest remaining bale, locked in
 * `haulRendezvousRuntime`) and the Hay-Spikes tractor shuttles bales out to it;
 * when full (or the field's cleared) the trailer runs the load to storage and
 * the collector waits in-field for its return (maintainer request,
 * 2026-07-20 — re-enabled after the earlier oscillation was traced to the
 * collector chasing the trailer's *moving* position instead of its parked
 * spot). Selection is fully automatic: any idle tractor with (or able to
 * hitch) a Bale Trailer is used. */
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
  if (!helper) return;
  if (!attachedImplement(save, helper.id, "baleTrailer")) {
    const trailer = availableImplementFor(save, helper, "baleTrailer");
    if (!trailer) return;
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
    tons: n * gameConfig.forage.baleTons,
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
    if (a) {
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

/** How much of `product` is sitting in storage, ready for a sell run. Grain
 * pools farm-wide in the bin; bales are counted per storage building. Loose
 * bales still lying in a field are NOT included — those are the bale-haul
 * job's business, and it already knows how to divert to a Sell Point. */
export function sellableStock(save: SaveState, product: string): number {
  if (isGrainProduct(product)) return save.grain[product] ?? 0;
  let n = 0;
  for (const b of save.buildings) n += b.storedBales?.[product as BaleProduct] ?? 0;
  return n;
}

/** The implement a sell run needs for this product. */
function sellTrailerKind(product: string): ImplementKind {
  return isGrainProduct(product) ? "grainTrailer" : "baleTrailer";
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
 * or the nearest bale store actually holding the product. */
function sellSourcePos(save: SaveState, product: string, from: Meters): Meters | undefined {
  if (isGrainProduct(product)) {
    return nearestSiloForCrop(save, product, from)?.pos;
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
/** Is there an idle tractor that could take a Grain Trailer right now? Gates
 * growing a cart crew — see `ensureUnloadTask`. */
function hasFreeCartTractor(save: SaveState): boolean {
  return save.agents.some(
    (a) => isFreeTractor(a) && (!!attachedImplement(save, a.id, "grainTrailer") || !!availableImplementFor(save, a, "grainTrailer")),
  );
}

function assignGrainCart(save: SaveState, task: FarmTask, events: TaskEvent[]): void {
  if (task.status !== "queued") return;
  const harvester = save.agents.find((a) => a.id === task.harvesterAgentId);
  if (!harvester || (harvester.grainOnboard ?? 0) <= 1e-9) return;
  const cart = save.agents.find(
    (a) =>
      a.kind === "tractor" &&
      a.state === "idle" &&
      !a.taskId &&
      !!a.size &&
      (!!attachedImplement(save, a.id, "grainTrailer") || !!availableImplementFor(save, a, "grainTrailer")),
  );
  if (!cart) return;
  if (!attachedImplement(save, cart.id, "grainTrailer")) {
    const trailer = availableImplementFor(save, cart, "grainTrailer");
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

/** Should this idle tractor hold off on starting field work because a combine is
 * harvesting and still needs a cart it could crew? Keeps a cart-capable tractor
 * available for the unload instead of committing to a plow the combine would
 * soon be waiting behind (maintainer request, 2026-07-20 — "jump ahead of
 * queued field work"). Only reserves as many tractors as there are uncrewed
 * harvests, so surplus tractors still get field work done. */
function shouldReserveForHarvest(save: SaveState, tractor: Agent): boolean {
  if (!tractorCanUse(save, tractor, "grainTrailer")) return false;
  // No combine in the fleet → nothing will ever crew; never strand the tractor.
  if (!save.agents.some((a) => a.kind === "harvester")) return false;
  // A harvest that's running (or queued and about to run) whose unload isn't
  // already crewed. Queued counts too, so a cart-capable tractor doesn't grab
  // field work on the very tick a fresh harvest starts, before the combine has
  // banked any grain for the pre-pass to react to.
  const uncrewed = save.tasks.filter(
    (h) =>
      h.type === "harvest" &&
      (h.status === "active" || h.status === "queued") &&
      !save.tasks.some((u) => u.type === "unloadHarvester" && u.harvesterAgentId === h.agentId && u.status === "active"),
  ).length;
  if (uncrewed === 0) return false;
  // Count OTHER idle cart-capable tractors already free to take those unloads —
  // reserve only if there aren't already enough of them.
  const freeCarts = save.agents.filter(
    (a) => a.kind === "tractor" && a.id !== tractor.id && !a.taskId && tractorCanUse(save, a, "grainTrailer"),
  ).length;
  return freeCarts < uncrewed;
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
  // Guard against a pathological no-progress loop; a handful of transitions per
  // tick is the realistic ceiling.
  for (let guard = 0; budget > 1e-9 && guard < 50; guard++) {
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
          TASK_AGENT_KIND[t.type] === agent.kind &&
          (!TASK_IMPLEMENT[t.type] || tractorCanUse(save, agent, TASK_IMPLEMENT[t.type]!)) &&
          // A sell run's trailer depends on WHAT it's hauling, so it isn't in
          // TASK_IMPLEMENT — check the product's kind directly instead.
          (t.type !== "sell" || tractorCanUse(save, agent, sellTrailerKind(t.sellProduct!))) &&
          // Biggest implement available, pulled by the smallest tractor that
          // can manage it (2026-07-23). A tractor that isn't the preferred rig
          // for this job stands down and lets the right one take it; the loop
          // re-evaluates every tick, so if the preferred tractor gets claimed
          // elsewhere first, whoever's best next simply picks the job up.
          // No preferred rig at all (no implement of the kind exists, or the
          // task needs none) falls back to the old any-capable-agent rule.
          (!TASK_IMPLEMENT[t.type] ||
            (preferredTractorFor(save, TASK_IMPLEMENT[t.type]!)?.id ?? agent.id) === agent.id) &&
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
      if (next && next.type !== "unloadHarvester" && shouldReserveForHarvest(save, agent)) {
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
      const needKind = next.type === "sell" ? sellTrailerKind(next.sellProduct!) : TASK_IMPLEMENT[next.type];
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
      // Starting the next step's planting is what advances the rotation
      // (maintainer spec, 2026-07-23: "when a new crop starts the planting
      // task, it becomes the current crop"). Doing it here rather than at
      // enqueue means a canceled plant never strands the sequence a step ahead.
      if (next.type === "plant" && next.advancesRotation) {
        const f = save.fields.find((ff) => ff.id === next.fieldId);
        if (f) advanceRotation(f);
      }
      // Picking up a rake windrows the field — this unlocks the baler right away
      // (it may start before the rake finishes), and survives the rake finishing.
      if (next.type === "rake") {
        const f = save.fields.find((ff) => ff.id === next.fieldId);
        if (f) f.windrowed = true;
      }
      // Starting a bale job: empty the baler's hopper for a fresh run.
      if (next.type === "bale") {
        const b = save.implements.find((i) => i.attachedTo === agent.id && i.kind === "bailer");
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
      const kind = sellTrailerKind(product);
      const trailer = save.implements.find((i) => i.attachedTo === agent.id && i.kind === kind);
      const carried = isGrainProduct(product) ? trailer?.cargoTons ?? 0 : trailer?.cargoBales ?? 0;
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
            ? grainTrailerCapacityTons(trailer.size)
            : baleTrailerCapacityBales(trailer.size);
          const got = loadForSale(save, product, cap - carried, agent.pos);
          if (isGrainProduct(product)) {
            trailer.cargoTons = (trailer.cargoTons ?? 0) + got;
            trailer.cargoCrop = product;
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
      const trailer = save.implements.find((i) => i.attachedTo === agent.id && i.kind === "grainTrailer");
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
        agent.state = "working";
        const timer = task.phaseTimer ?? gameConfig.hauling.loadMinutes;
        const used = Math.min(timer, budget);
        budget -= used;
        const left = timer - used;
        if (left > 1e-9) {
          task.phaseTimer = left;
          continue;
        }
        const cap = grainTrailerCapacityTons(trailer.size);
        const room = Math.max(0, cap - (trailer.cargoTons ?? 0));
        const amount = Math.min(room, harvester.grainOnboard ?? 0);
        harvester.grainOnboard = (harvester.grainOnboard ?? 0) - amount;
        trailer.cargoTons = (trailer.cargoTons ?? 0) + amount;
        trailer.cargoCrop = task.crop; // captured at task creation — see ensureUnloadTask
        task.phaseTimer = undefined;
        // Multi-load grain-cart behavior (maintainer request, 2026-07-13):
        // don't run to the silo after every drain — drop back into the
        // staging decision, which sends the cart to the silo only when IT'S
        // full (or the harvest is over), and otherwise parks it back at the
        // gate to service the combine's next stop.
        task.unloadPhase = "staging";
        continue;
      }

      if (task.unloadPhase === "toSilo") {
        const crop = trailer.cargoCrop;
        // Prefer a silo with room; if the crop's silos are full/absent, divert
        // to a Sell Point rather than stalling (maintainer request, 2026-07-20).
        const dest = crop ? chooseGrainDest(save, crop, agent.pos) : undefined;
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
        task.phaseTimer = gameConfig.hauling.dumpMinutes;
        continue;
      }

      if (task.unloadPhase === "dumping") {
        agent.state = "working";
        const timer = task.phaseTimer ?? gameConfig.hauling.dumpMinutes;
        const used = Math.min(timer, budget);
        budget -= used;
        const left = timer - used;
        if (left > 1e-9) {
          task.phaseTimer = left;
          continue;
        }
        const crop = trailer.cargoCrop!;
        if (task.unloadDest === "sell") {
          // Diverted to a Sell Point — offload the whole load for cash.
          sellHauledGrain(save, crop, trailer.cargoTons ?? 0, now);
          trailer.cargoTons = 0;
          trailer.cargoCrop = undefined;
          task.waitingForSilo = false;
          finishUnload(save, task, agent, events);
          continue;
        }
        const room = Math.max(0, siloCapacityForCrop(save, crop) - save.grain[crop]);
        const amount = Math.min(room, trailer.cargoTons ?? 0);
        save.grain[crop] += amount;
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
        const cap = harvesterCapacityTons(harvester.size ?? "medium");
        const combineFull = (harvester.grainOnboard ?? 0) >= cap - 1e-9;
        const combineEmpty = (harvester.grainOnboard ?? 0) <= 1e-9;
        const stillCutting = save.tasks.some(
          (t) => t.type === "harvest" && t.status === "active" && t.agentId === harvester.id,
        );
        const trailerCap = grainTrailerCapacityTons(trailer.size);
        const cargo = trailer.cargoTons ?? 0;
        const trailerFull = cargo >= trailerCap - 1e-9;

        // Head for the silo: cart full; carrying a partial load with the
        // harvest over and the combine drained (nothing more coming); or —
        // with the combine fully drained — already ≥75% full, since a
        // nearly-full cart would have almost no room at the combine's next
        // stop (maintainer request, 2026-07-13).
        const siloRunAt = trailerCap * gameConfig.hauling.cartSiloRunFraction;
        if (
          trailerFull ||
          (cargo > 1e-9 && !stillCutting && combineEmpty) ||
          (cargo >= siloRunAt - 1e-9 && combineEmpty)
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

        if (!combineFull && stillCutting) {
          task.unloadPhase = "staging";
          // A cart that's already carrying grain has been to the combine —
          // it waits right where it drained it (maintainer request,
          // 2026-07-13), not back at the gate. Only a still-empty cart
          // stages at the field's gate on its way in.
          if (cargo > 1e-9) {
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
        const target = harvester.pos;
        agent.state = "traveling";
        if (!samePos(agent.pos, target)) {
          budget = driveToward(save, agent, target, speed, budget);
          continue;
        }
        task.unloadPhase = "onloading";
        task.phaseTimer = gameConfig.hauling.loadMinutes;
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
        const spikesImplNow = save.implements.find((i) => i.attachedTo === task.agentId && i.kind === "haySpikes");
        const spikesCargo = spikesImplNow?.cargoBales ?? 0;
        const fieldEmpty = (haulField.baleLocations?.length ?? 0) === 0;
        const spikesDone = fieldEmpty && spikesCargo <= 0;

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
        if (hasTrailer && (trailerImpl!.cargoBales ?? 0) > 0) {
          // Wait for the trailer to deliver its final load; it finishes the job.
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
        // Only shuttle to the trailer once it's actually PARKED at its spot with
        // room. While it's still arriving ("toEntrance") or off on a run
        // ("toStorage"/"dumping"), hold the load in-field and wait — chasing the
        // trailer's moving position is exactly what made this oscillate before.
        const trailerReady = task.trailerPhase === "waiting" && trailerRoom > 0;
        if (!trailerReady) {
          task.haulPhase = "waiting";
          agent.state = "working";
          budget = 0;
          continue;
        }
        // Rendezvous at the trailer's LOCKED parked spot, never its live pos.
        // Read-only (the trailer owns the lock); fall back to its pos if unset.
        const rv = haulRendezvousRuntime.get(task.id) ?? trailerAgent!.pos;
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

    if (agent.state === "traveling") {
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
      const baler = save.implements.find((i) => i.attachedTo === agent.id && i.kind === "bailer");
      const baleTons = gameConfig.forage.baleTons;
      // Even-divide the field's forage into whole bales so the count stays
      // round(acres × balesPerAcre × productivity) — float-robust, and
      // identical to before now that productivity defaults to 1×. A
      // perennial reads the snapshot taken at mow time (the taper is keyed to
      // cuttings before THIS one, not the count after it advanced); corn
      // stover has no snapshot and falls back to the live value, which is
      // always 1× since fertilized was already reset by the harvest.
      const boost = field.lastCutProductivity ?? productivityMultiplier(field, now);
      const totalBales = Math.max(1, Math.round(task.totalAcres * balesPerAcreForField(field) * boost));
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
      if (dist === undefined) dist = distanceAtWork(path, (task.doneAcres * ACRE_M2) / path.swath);

      // Mid-tie? Burn budget standing still; when the timer runs out, eject the
      // bale and empty one bale's worth from the hopper.
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
        // Drop ON the field at the tie spot: current position if inside, else the
        // last on-field position (the baler may have stopped over a concave notch
        // the path cut across — a bale must never land off the field). No
        // perpendicular scatter — the ±variance in fill distance (baleTarget)
        // already staggers the spacing, so drops stay on the driven lane.
        const inside = pointInPolygon(agent.pos, field.boundary);
        const drop = inside ? agent.pos : (baleLastInside.get(task.id) ?? agent.pos);
        (field.baleLocations ??= []).push([drop[0], drop[1]]);
        baler.cargoTons = Math.max(0, baler.cargoTons - baleTarget);
        baleTargetRuntime.delete(task.id); // re-roll the next bale's fill distance
        continue;
      }

      // Hopper hit this bale's (randomized) threshold → stop and tie a bale.
      if (baler.cargoTons >= baleTarget - 1e-9) {
        baleTieRemaining.set(task.id, gameConfig.forage.baleTieMinutes);
        continue;
      }

      // Not full: drive on, gathering forage. Clamp the drive so it stops EXACTLY
      // when the hopper hits this bale's threshold — so the bale drops where that
      // much forage was gathered — mirroring the combine's hopper-capacity clamp.
      // Working in WORK-metres (in-field only) keeps drops spread across a concave
      // field the coverage path over-sweeps.
      const roomAcres = (baleTarget - baler.cargoTons) / tonsPerAcre;
      const roomWork = workDoneAt(path, dist) + (roomAcres * ACRE_M2) / path.swath;
      const target = Math.min(path.total, distanceAtWork(path, roomWork));
      const timeNeeded = Math.max(0, (target - dist) / speed);
      const timeUsed = Math.min(timeNeeded, budget);
      const prevAcres = task.doneAcres;
      dist = Math.min(path.total, dist + speed * timeUsed);
      budget -= timeUsed;
      pathDistRuntime.set(task.id, dist);
      task.doneAcres = Math.min(task.totalAcres, (workDoneAt(path, dist) * path.swath) / ACRE_M2);
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
        completeTask(task, field, now, rand);
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
        // A finished bale run leaves loose bales on the field — auto-dispatch a
        // Haul Bales job to move them to storage (maintainer request,
        // 2026-07-17). Also player-triggerable from the field panel;
        // queueHaulBales no-ops if a haul's already covering the field.
        queueHaulBales(save, field.id);
      }
      continue;
    }

    // A Grain Trailer trip is wanted as soon as there's ANY grain aboard —
    // not just once the hopper's completely full (maintainer request,
    // 2026-07-13) — so hauling can run in parallel with ongoing cutting
    // instead of only kicking in at capacity. The combine itself only stops
    // dead (state stays "working") once truly full.
    if (task.type === "harvest" && field.crop) {
      const capacity = harvesterCapacityTons(agent.size ?? "medium");
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
    const speed = (taskFieldSpeedKmh(task.type) * 1000) / 60; // meters per sim-minute
    let dist = pathDistRuntime.get(task.id);
    if (dist === undefined) dist = distanceAtWork(path, (task.doneAcres * ACRE_M2) / path.swath);

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
    let target = path.total;
    if (task.type === "harvest" && effectiveYield) {
      const capacity = harvesterCapacityTons(agent.size ?? "medium");
      const room = Math.max(0, capacity - (agent.grainOnboard ?? 0));
      const roomAcres = room / effectiveYield;
      const roomWork = workDoneAt(path, dist) + (roomAcres * ACRE_M2) / path.swath;
      target = Math.min(path.total, distanceAtWork(path, roomWork));
    }

    const timeNeeded = (target - dist) / speed;
    const timeUsed = Math.min(timeNeeded, budget);
    dist = Math.min(target, dist + speed * timeUsed);
    budget -= timeUsed;
    pathDistRuntime.set(task.id, dist);

    const prevAcres = task.doneAcres;
    const workLen = workDoneAt(path, dist);
    task.doneAcres = Math.min(task.totalAcres, (workLen * path.swath) / ACRE_M2);
    const s = sampleAt(path, dist);
    agent.pos = s.pos;
    agent.heading = s.heading;

    if (task.type === "harvest" && field.crop && effectiveYield !== undefined) {
      // Grain banks into the combine's own hopper (not the farm bin directly
      // anymore) — a Grain Trailer carries it the rest of the way. NOT
      // clamped to capacity here: the distance-target clamp above keeps this
      // close to capacity, but `distanceAtWork`/`workDoneAt` aren't exact
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

    if (dist >= path.total - 1e-6) {
      task.doneAcres = task.totalAcres;
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
    }
  }
}

function completeTask(task: FarmTask, field: Field, now: SimTime, rand: () => number): void {
  switch (task.type) {
    case "plow":
      applyPlow(field);
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
      // and the field carries a +7% boost into its NEXT crop (residueMulched,
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
      // worked; this just settles the field to mulched.
      applyBaleDone(field);
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
  return { crop: defaultCrop(), bale: true };
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
 * Which step's crop auto-manage should put in the ground next.
 *
 * Normally the NEXT step — the current one is what's standing (or what just
 * came off). The exception is a field that has never grown anything: there's
 * no outgoing crop to hand off from, so its first planting is the step already
 * current, and the sequence does NOT advance for it. Returns the identical
 * object reference as `activePlan` in that case, which is how callers tell the
 * two situations apart.
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
    const kind = TASK_IMPLEMENT[task.type];
    const needed = TASK_AGENT_KIND[task.type];
    const haveMachine = save.agents.some((a) => a.kind === needed);
    if (!haveMachine) {
      out.push({ fieldId: task.fieldId, type: task.type, reason: `No ${needed === "harvester" ? "combine" : needed} owned` });
      continue;
    }
    if (kind && !save.implements.some((i) => i.kind === kind)) {
      out.push({ fieldId: task.fieldId, type: task.type, reason: `No ${IMPLEMENT_NAME[kind]} owned` });
      continue;
    }
    // Owned, but nothing that can pull it — a large-only implement on a
    // small-only fleet is just as stuck as not owning one.
    if (kind && !save.agents.some((a) => a.kind === "tractor" && a.size && save.implements.some((i) => i.kind === kind && canPull(a.size!, i.size)))) {
      out.push({ fieldId: task.fieldId, type: task.type, reason: `No tractor big enough for the ${IMPLEMENT_NAME[kind]}` });
    }
  }
  return out;
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
  // TWO steps are in play at once (sequence rework, 2026-07-23):
  //   `plan`     — the step running now. Owns the standing crop and everything
  //                downstream of it: weed, fertilize, harvest, mulch, rake/bale.
  //   `upcoming` — the step about to go in the ground. Owns the ground prep for
  //                its own crop: plow and plant.
  // That split is what makes residue work belong to the crop that produced it
  // while the next crop's plow/plant timing comes from its own schedule row.
  const plan = activePlan(field);
  const upcoming = planToPlant(field);
  const handoff = upcoming !== plan; // false only on a field's first-ever planting

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
        if (inPlowWindow(now) && monthMatches(now, upcoming.schedule?.plow)) {
          tryEnqueue(save, field, "plow", now);
        }
      } else if (monthMatches(now, upcoming.schedule?.plant)) {
        // Tilled — establish the stand in its (March) planting window.
        const t = tryEnqueue(save, field, "plant", now, upcoming.crop);
        if (t && handoff) t.advancesRotation = true;
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
      // before falling through to plowing (2026-07-23).
      if (
        plan.mulch &&
        !field.autoMulchDone &&
        canMulch(save, field) &&
        !inPlowWindow(now) &&
        monthMatches(now, plan.schedule?.mulch)
      ) {
        if (tryEnqueue(save, field, "mulch", now)) {
          field.autoMulchDone = true;
          break;
        }
      }
    // falls through to the plow branch
    case "stubble":
      // Auto-manage (unlike the manual Queue Plow button) still waits for
      // winter — enqueueTask itself no longer season-gates plowing. The plow
      // is ground prep for the UPCOMING crop, so it reads that step's schedule.
      if (inPlowWindow(now) && monthMatches(now, upcoming.schedule?.plow)) {
        tryEnqueue(save, field, "plow", now);
      }
      break;
    case "harvested":
      if (forageDue(save, field) && plan.bale) {
        // The forage loop: rake then bale (queued together — the baler waits in
        // the queue until the rake has started). Once baled the field is
        // "mulched" and comes back around to plowing. Straw needs no rake pass.
        if (needsRakeBeforeBaling(field)) {
          tryEnqueue(save, field, "rake", now);
        }
        tryEnqueue(save, field, "bale", now);
      } else if (
        plan.mulch &&
        !field.autoMulchDone &&
        canMulch(save, field) &&
        !inPlowWindow(now) &&
        monthMatches(now, plan.schedule?.mulch)
      ) {
        // Optional residue pass (annuals we aren't baling): shred the residue
        // back in the month(s) after harvest, before the winter plow window
        // opens. `!inPlowWindow` means a late harvest that lands in plow season
        // just skips straight to plowing. Completing it flips the field to
        // stubble, so next tick falls through to the plow branch.
        if (tryEnqueue(save, field, "mulch", now)) field.autoMulchDone = true;
      } else if (inPlowWindow(now) && monthMatches(now, upcoming.schedule?.plow)) {
        // Plow under — discard any un-baled forage so the plow isn't gated on it
        // (the plan opted out of baling, or there's no gear for it). Still
        // waits for winter, same as the stubble/mulched case above.
        if (field.forageReady) field.forageReady = undefined;
        tryEnqueue(save, field, "plow", now);
      }
      break;
    case "tilled":
      // Plant the UPCOMING step's crop, on its own schedule row. Starting the
      // task is what makes it "current" (`advancesRotation`) — queueing it
      // isn't, so a canceled plant leaves the sequence exactly where it was.
      if (monthMatches(now, upcoming.schedule?.plant)) {
        const t = tryEnqueue(save, field, "plant", now, upcoming.crop);
        if (t && handoff) t.advancesRotation = true;
      }
      break;
    case "ready":
      // Harvest's override is DELAY-ONLY (a ready field never un-readies —
      // no spoilage modeled — so waiting is always safe, and this keeps
      // retrying every tick until the chosen month arrives, same pattern as
      // everything else here).
      if (monthMatches(now, plan.schedule?.harvest)) {
        tryEnqueue(save, field, "harvest", now);
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
