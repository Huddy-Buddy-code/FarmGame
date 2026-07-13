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
import type { CropId, EquipmentSize } from "../config/gameConfig";
import type { SimTime } from "./clock";
import type { SaveState, Field, FieldStatus, FarmTask, Agent, Implement, TaskType, FieldPlan } from "../state/saveState";
import { dateOf } from "./calendar";
import { areaAcres, pointInPolygon } from "../geo/geometry";
import type { Meters } from "../geo/coords";
import {
  inPlantingWindow, canPlow, applyPlow, applyPlant, applyHarvestDone, applyBaleDone,
  inPlowWindow, hasStandingCrop, inWeedingWindow, canFertilizeNow,
} from "./farming";
import { buildCoveragePath, sampleAt, workDoneAt, distanceAtWork } from "./coverage";
import type { CoveragePath } from "./coverage";
import { nearestFarmYard, nearestSiloForCrop, siloCapacityForCrop } from "./buildings";
import type { Building } from "../state/saveState";
import { planRoute } from "./roadNet";
import type { RoadNetwork } from "./roadNet";
import { recordCash } from "./ledger";

const ACRE_M2 = 4046.8564224;

/** Which agent kind performs each task type. */
export const TASK_AGENT_KIND: Record<TaskType, Agent["kind"]> = {
  plow: "tractor",
  plant: "tractor",
  harvest: "harvester",
  weed: "tractor",
  fertilize: "tractor",
  rake: "tractor",
  bale: "tractor",
  unloadHarvester: "tractor",
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
export type ImplementKind = "plow" | "planter" | "sprayer" | "rake" | "bailer" | "grainTrailer";

const EQUIPMENT_NAME: Record<EquipmentKind, string> = { tractor: "Tractor", harvester: "Combine" };
const IMPLEMENT_NAME: Record<ImplementKind, string> = {
  plow: "Plow", planter: "Planter", sprayer: "Sprayer", rake: "Rake", bailer: "Baler",
  grainTrailer: "Grain Trailer",
};
const SIZE_LABEL: Record<EquipmentSize, string> = { small: "Small", medium: "Medium", large: "Large" };

/** Ledger item label for each field-expense task type (hover breakdown in the
 * Finance tab's cashflow table). */
const FIELD_EXPENSE_ITEM: Partial<Record<TaskType, string>> = {
  plow: "Plowing", plant: "Planting", weed: "Weeding", fertilize: "Fertilizing",
  rake: "Raking", bale: "Baling",
};

/** Which implement kind a task type needs (undefined = none, e.g. harvest).
 * Weed and fertilize both use a sprayer; rake/bale use their own tools;
 * unloadHarvester needs a Grain Trailer. */
const TASK_IMPLEMENT: Partial<Record<TaskType, ImplementKind>> = {
  plow: "plow", plant: "planter", weed: "sprayer", fertilize: "sprayer",
  rake: "rake", bale: "bailer", unloadHarvester: "grainTrailer",
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

/** Display name for a machine/implement including its size ("Medium Plow"). */
function sizedName(base: string, size: EquipmentSize, n: number): string {
  const sized = `${SIZE_LABEL[size]} ${base}`;
  return n === 1 ? sized : `${sized} ${n}`;
}

/** A display name not already taken — "Medium Tractor", then "Medium Tractor 2",
 * 3, … — so names stay unique even after machines are bought and sold. */
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
  // Migrate/seed power units.
  for (const kind of ["tractor", "harvester"] as const) {
    if (!save.agents.some((a) => a.kind === kind)) {
      save.agents.push(makeAgent(save, kind, "medium", home));
    }
  }
  for (const a of save.agents) {
    if (a.kind === "tractor" || a.kind === "harvester") {
      a.size ??= "medium"; // pre-size saves default to medium
      a.purchaseCost ??= agentPrice(a.kind, a.size);
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
  // Unique display name within the fleet ("Medium Tractor", "Medium Tractor 2"…).
  const base = `${SIZE_LABEL[size]} ${EQUIPMENT_NAME[kind]}`;
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
  return save.implements.some((i) => i.kind === "rake") && save.implements.some((i) => i.kind === "bailer");
}

/** Does this field still owe a rake + bale before it can be re-plowed? True only
 * for a harvested forage field on a farm that owns the baling gear. */
export function forageDue(save: SaveState, field: Field): boolean {
  return field.status === "harvested" && !!field.forageReady && forageEquipped(save);
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
    else if (t.type === "harvest") status = "harvested";
    else if (t.type === "bale") status = "mulched";
    // weed/fertilize/rake don't change the field's lifecycle status.
  }
  return status;
}

/** What queueing this task would charge right now, for button labels. */
export function taskCost(field: Field, type: TaskType, crop?: CropId): number {
  const acres = areaAcres(field.boundary);
  if (type === "plow") return Math.round(acres * gameConfig.plowCostPerAcre);
  if (type === "plant") return Math.round(acres * gameConfig.crops[crop!].inputCostPerAcre);
  if (type === "weed") return Math.round(acres * gameConfig.weedCostPerAcre);
  if (type === "fertilize") return Math.round(acres * gameConfig.fertilizeCostPerAcre);
  if (type === "rake") return Math.round(acres * gameConfig.forage.rakeCostPerAcre);
  if (type === "bale") return Math.round(acres * gameConfig.forage.baleCostPerAcre);
  return 0; // harvest: fuel/wages arrive with the cost-model slice (brief §8)
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
    if (!canPlow(eff)) throw new Error(`${field.id} can't be plowed (status: ${eff})`);
    // A harvested forage field owes a rake + bale first (unless a bale is
    // already queued, which pushes eff to "mulched" and clears this branch).
    if (eff === "harvested" && forageDue(save, field)) {
      throw new Error(`Rake & bale ${field.id} before plowing`);
    }
    if (!inPlowWindow(now)) throw new Error(`Plowing opens in winter — ground needs to rest until then`);
  }
  if (type === "plant") {
    if (!crop) throw new Error("Pick a crop to plant");
    if (eff !== "tilled") throw new Error(`Plow ${field.id} before planting (status: ${eff})`);
    if (!inPlantingWindow(crop, now)) {
      throw new Error(`${gameConfig.crops[crop].name} can't be planted this month`);
    }
  }
  if (type === "harvest" && eff !== "ready") {
    throw new Error(`${field.id} isn't ready to harvest yet`);
  }
  if (type === "weed") {
    if (!hasStandingCrop(field.status)) throw new Error(`${field.id} has nothing to weed (status: ${field.status})`);
    if (!inWeedingWindow(now)) throw new Error(`Weeding opens in June`);
  }
  if (type === "fertilize") {
    if (!hasStandingCrop(field.status)) throw new Error(`${field.id} has nothing to fertilize (status: ${field.status})`);
    if (!canFertilizeNow(field, now)) throw new Error(`Fertilizing opens the month after planting`);
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
    if (!field.windrowed && tasksFor(save, field.id, "rake").length === 0) {
      throw new Error(`Rake ${field.id} first — the baler follows the rake`);
    }
  }
  const cost = taskCost(field, type, crop);
  if (cost > save.money) {
    throw new Error(`That costs $${cost.toLocaleString()} — not enough cash`);
  }
  save.money -= cost;
  recordCash(save, "fieldExpenses", FIELD_EXPENSE_ITEM[type] ?? "Other", -cost);
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
  if (task.type === "unloadHarvester") return 0;
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

/** Is this queued task startable given the field's CURRENT state? (A plant task
 * queued behind a plow task waits until the ground is actually tilled.) */
function isStartable(task: FarmTask, field: Field): boolean {
  // System-generated — always startable once queued; it just needs its
  // fieldId to still resolve (for display), not any particular field status.
  if (task.type === "unloadHarvester") return true;
  if (task.type === "plow") return canPlow(field.status);
  if (task.type === "plant") return field.status === "tilled";
  if (task.type === "weed" || task.type === "fertilize") return hasStandingCrop(field.status);
  if (task.type === "rake") return field.status === "harvested" && !!field.forageReady;
  // Baler follows the rake: startable once raking has begun (windrowed) and the
  // field hasn't been baled yet (still "harvested").
  if (task.type === "bale") return field.status === "harvested" && !!field.windrowed;
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
// Baler-only runtime: how many bales this task has dropped so far, and the
// sim-minutes left in the current "tie a bale" pause (undefined = not tying).
const baleDropped = new Map<string, number>();
const baleTieRemaining = new Map<string, number>();
// The last on-field spot the baler occupied — bales are dropped HERE so they
// never land in a concave notch the coverage path cuts across (farmstead, yard).
const baleLastInside = new Map<string, Meters>();
// ±10% jitter on the CURRENT pending bale's spacing, so bales don't land on an
// obvious grid. Rolled once per bale, held until it drops, then re-rolled.
const baleJitter = new Map<string, number>();

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
    path = buildCoveragePath(field.boundary, taskSwathMeters(save, task, agent));
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
  baleDropped.delete(taskId);
  baleTieRemaining.delete(taskId);
  baleLastInside.delete(taskId);
  baleJitter.delete(taskId);
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

/**
 * Drive `agent` toward `target` for up to `budget` sim-minutes at `speed`
 * (m/min), following roads when the network serves the trip (leave the field
 * to the nearest road, drive the roads, leave the road at the point nearest
 * the destination), else straight. Returns the unused budget; `agent.pos`
 * equals `target` exactly on arrival (same contract as the old inline code).
 */
function driveToward(agent: Agent, target: Meters, speed: number, budget: number): number {
  let route = agentRoutes.get(agent.id);
  // Replan when the destination moved meaningfully (a combine still cutting
  // creeps along its lanes — don't re-run A* every tick chasing half-meter
  // drift; the final approach closes the gap as a short straight hop).
  // A rejected plan is cached as pts=null so the straight-line drive doesn't
  // re-run snapping + A* every tick until arrival.
  if (!route || Math.hypot(route.target[0] - target[0], route.target[1] - target[1]) > 25) {
    const pts = roadNet ? planRoute(roadNet, agent.pos, target) : null;
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
function ensureUnloadTask(save: SaveState, harvester: Agent, fieldId: string, crop: CropId): void {
  if (save.tasks.some((t) => t.type === "unloadHarvester" && t.harvesterAgentId === harvester.id)) return;
  save.tasks.push({
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
  });
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
        if (crop) ensureUnloadTask(save, agent, agent.lastFieldId ?? "", crop);
      }
      // Pick the first queued task of this agent's kind that's startable now.
      // Plow/plant also need the tractor to have (or be able to hitch) the
      // matching implement.
      const next = save.tasks.find(
        (t) =>
          t.status === "queued" &&
          TASK_AGENT_KIND[t.type] === agent.kind &&
          (!TASK_IMPLEMENT[t.type] || tractorCanUse(save, agent, TASK_IMPLEMENT[t.type]!)) &&
          // unloadHarvester's fieldId is display-only (may be a legacy/
          // unknown "" for a recovered leftover hopper) — doesn't need the
          // field to actually exist, unlike every other task type.
          (t.type === "unloadHarvester" || save.fields.some((f) => f.id === t.fieldId && isStartable(t, f))),
      );
      if (!next) {
        // No work queued — drive home (Tractor Barn with room, else Farm
        // Yard) if the farm's built somewhere for it to park; otherwise
        // stay exactly where it stopped (pre-buildings behavior).
        const home = homeTargetFor(save, agent);
        if (home && !samePos(agent.pos, home)) {
          const speed = (gameConfig.work.travelSpeedKmh * 1000) / 60; // meters per sim-minute
          agent.state = "traveling";
          budget = driveToward(agent, home, speed, budget);
          continue;
        }
        agent.state = "idle";
        return;
      }
      // Auto-hitch the needed implement if the tractor isn't already carrying
      // it — swapping off whatever else it's carrying (one implement at a time).
      const needKind = TASK_IMPLEMENT[next.type];
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
      if (next.type === "rake") {
        const f = save.fields.find((ff) => ff.id === next.fieldId);
        if (f) f.windrowed = true;
      }
      events.push({ kind: "started", task: next, agent });
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
        task.unloadPhase = "toSilo";
        continue;
      }

      if (task.unloadPhase === "toSilo") {
        const crop = trailer.cargoCrop;
        const silo = crop ? nearestSiloForCrop(save, crop, agent.pos) : undefined;
        if (!silo) {
          // No silo assigned to this crop yet — sit tight (⚠️ surfaced in the UI).
          task.waitingForSilo = true;
          agent.state = "working";
          budget = 0;
          continue;
        }
        if (!samePos(agent.pos, silo.pos)) {
          task.waitingForSilo = false;
          agent.state = "traveling";
          budget = driveToward(agent, silo.pos, speed, budget);
          continue;
        }
        // Arrived — dump only if the crop's pooled silo capacity has room.
        const room = siloCapacityForCrop(save, crop!) - save.grain[crop!];
        if (room <= 1e-9) {
          task.waitingForSilo = true;
          agent.state = "working";
          budget = 0;
          continue;
        }
        task.waitingForSilo = false;
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
        const room = Math.max(0, siloCapacityForCrop(save, crop) - save.grain[crop]);
        const amount = Math.min(room, trailer.cargoTons ?? 0);
        save.grain[crop] += amount;
        trailer.cargoTons = (trailer.cargoTons ?? 0) - amount;
        if ((trailer.cargoTons ?? 0) > 1e-9) {
          // Silo filled up mid-dump — go back to waiting for more room.
          task.unloadPhase = "toSilo";
          task.waitingForSilo = true;
          continue;
        }
        trailer.cargoTons = 0;
        trailer.cargoCrop = undefined;
        task.waitingForSilo = false;
        events.push({ kind: "finished", task, agent });
        save.tasks.splice(save.tasks.indexOf(task), 1);
        agent.taskId = undefined;
      clearAgentRoute(agent.id);
        agent.state = "idle";
        continue;
      }

      // Default / "toHarvester": drive to the combine's current spot (it's
      // stationary while full — see the harvest-pause block below).
      {
        const target = harvester.pos;
        agent.state = "traveling";
        if (!samePos(agent.pos, target)) {
          budget = driveToward(agent, target, speed, budget);
          continue;
        }
        task.unloadPhase = "onloading";
        task.phaseTimer = gameConfig.hauling.loadMinutes;
        agent.state = "working";
        continue;
      }
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
      budget = driveToward(agent, target, speed, budget);
      if (samePos(agent.pos, target)) agent.state = "working";
      continue;
    }

    // Baling is special: the baler collects forage as it drives, and every time
    // it's gathered a bale's worth it STOPS to tie & eject the bale (dropped at
    // its current spot), then carries on. So it's a drive → pause → drop loop,
    // not a smooth sweep.
    if (task.type === "bale") {
      const path = getActivePath(save, task, field, agent);
      const speed = (taskFieldSpeedKmh("bale") * 1000) / 60; // meters per sim-minute
      const balesPerAcre = gameConfig.forage.balesPerAcre;
      const totalBales = Math.max(1, Math.round(task.totalAcres * balesPerAcre));
      // Space bales by WORK DISTANCE along the actual driven path, not by field
      // AREA. A concave notch (farmstead/yard) makes the coverage path over-sweep
      // — its `totalWork` exceeds the true polygon area — so area-based spacing
      // would drop every bale in the first stretch and leave the far lanes bare.
      // Work-distance spacing keeps them evenly spread over the WHOLE field while
      // the count stays round(acres × balesPerAcre).
      const workPerBale = path.totalWork / totalBales; // metres of in-field work per bale

      let dist = pathDistRuntime.get(task.id);
      if (dist === undefined) dist = distanceAtWork(path, (task.doneAcres * ACRE_M2) / path.swath);
      let dropped = baleDropped.get(task.id);
      if (dropped === undefined) {
        // Re-derive on first tick / after a reload from how much work is done.
        dropped = Math.min(totalBales, Math.floor(workDoneAt(path, dist) / workPerBale));
        baleDropped.set(task.id, dropped);
      }

      // Mid-tie? Burn budget standing still; when the timer runs out, drop the bale.
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
        baleJitter.delete(task.id); // re-roll spacing for the next bale
        // Drop ON the field: use the current spot if it's inside, else the last
        // on-field position (the baler may have stopped over a concave notch the
        // path cut across — a bale must never land off the field).
        const inside = pointInPolygon(agent.pos, field.boundary);
        const drop = inside ? agent.pos : (baleLastInside.get(task.id) ?? agent.pos);
        (field.baleLocations ??= []).push([drop[0], drop[1]]);
        baleDropped.set(task.id, dropped + 1);
        continue;
      }

      // Not tying: drive to the next bale threshold (or the field's end), stopping
      // exactly there so the bale drops where a bale's worth was gathered.
      // Jitter this bale's spacing ±10% (of work-metres) so drops don't fall on an
      // exact grid. Rolled once per pending bale (held across ticks until it
      // drops). The nominal `(dropped+1)*workPerBale` still anchors the count, so
      // the total number of bales is unchanged — only where each lands shifts.
      let jitter = 0;
      if (dropped < totalBales) {
        jitter = baleJitter.get(task.id) ?? workPerBale * (rand() * 0.2 - 0.1);
        baleJitter.set(task.id, jitter);
      }
      const targetWork = dropped >= totalBales
        ? path.totalWork
        : Math.min(path.totalWork, (dropped + 1) * workPerBale + jitter);
      const targetDist = dropped >= totalBales
        ? path.total
        : Math.min(path.total, distanceAtWork(path, targetWork));
      const timeNeeded = Math.max(0, (targetDist - dist) / speed);
      const timeUsed = Math.min(timeNeeded, budget);
      dist = Math.min(path.total, dist + speed * timeUsed);
      budget -= timeUsed;
      pathDistRuntime.set(task.id, dist);
      task.doneAcres = Math.min(task.totalAcres, (workDoneAt(path, dist) * path.swath) / ACRE_M2);
      const s = sampleAt(path, dist);
      agent.pos = s.pos;
      agent.heading = s.heading;
      if (pointInPolygon(agent.pos, field.boundary)) baleLastInside.set(task.id, agent.pos);

      if (dist >= targetDist - 1e-6 && dropped < totalBales) {
        // Gathered a bale's worth — stop and tie it.
        baleTieRemaining.set(task.id, gameConfig.forage.baleTieMinutes);
        continue;
      }
      if (dist >= path.total - 1e-6 && dropped >= totalBales) {
        task.doneAcres = task.totalAcres;
        completeTask(task, field, now, rand);
        changed.push(field);
        events.push({ kind: "finished", task, agent });
        clearTaskRuntime(task.id);
        save.tasks.splice(save.tasks.indexOf(task), 1);
        agent.taskId = undefined;
      clearAgentRoute(agent.id);
        agent.state = "idle";
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
      if (agent.grainOnboard > 1e-9) ensureUnloadTask(save, agent, field.id, field.crop);
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
    let target = path.total;
    if (task.type === "harvest" && field.trueYieldTonsPerAcre) {
      const capacity = harvesterCapacityTons(agent.size ?? "medium");
      const room = Math.max(0, capacity - (agent.grainOnboard ?? 0));
      const roomAcres = room / field.trueYieldTonsPerAcre;
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

    if (task.type === "harvest" && field.crop && field.trueYieldTonsPerAcre !== undefined) {
      // Grain banks into the combine's own hopper (not the farm bin directly
      // anymore) — a Grain Trailer carries it the rest of the way. NOT
      // clamped to capacity here: the distance-target clamp above keeps this
      // close to capacity, but `distanceAtWork`/`workDoneAt` aren't exact
      // inverses of each other across a coverage path's headland turns, so a
      // tick can still bank a hair over the target (bug found in testing —
      // clamping here silently discarded that sliver of grain every fill
      // cycle instead of letting the hopper run fractionally over).
      agent.grainOnboard = (agent.grainOnboard ?? 0) + (task.doneAcres - prevAcres) * field.trueYieldTonsPerAcre;
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
      if (agent.grainOnboard > 1e-9) ensureUnloadTask(save, agent, field.id, field.crop);
    }

    if (dist >= path.total - 1e-6) {
      task.doneAcres = task.totalAcres;
      completeTask(task, field, now, rand);
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
        ensureUnloadTask(save, agent, agent.lastFieldId ?? field.id, agent.lastCrop);
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
      // No persistent field effect yet — a fertility system to hook into is
      // still out of scope; it's a time/cost sink for now.
      break;
  }
}

/** The mutually-exclusive field-lifecycle task types (§10): only one of these
 * should ever be pending on a field at a time. Weed/fertilize are deliberately
 * NOT here — they're independent side-tasks (brief request, 2026-07-11) and
 * must never block the lifecycle from advancing, including while stuck queued
 * for lack of a sprayer. */
const LIFECYCLE_TASKS: ReadonlySet<TaskType> = new Set(["plow", "plant", "harvest", "rake", "bale"]);

/** The config's first crop — the fallback when an auto-managed field has no plans. */
function defaultCrop(): CropId {
  return (Object.keys(gameConfig.crops) as CropId[])[0]!;
}

/** A sensible default plan for an auto-managed field with none defined yet. */
export function defaultPlan(): FieldPlan {
  return { crop: defaultCrop(), bale: true };
}

/** The rotation plan active for `field` at `now`: `plans[(year-1) % len]`, since
 * plans advance one per campaign year and loop after the last (maintainer design,
 * 2026-07-12). Falls back to a single default plan when none are set. */
export function activePlan(field: Field, now: SimTime): FieldPlan {
  const plans = field.plans && field.plans.length > 0 ? field.plans : [defaultPlan()];
  return plans[(dateOf(now).year - 1) % plans.length]!;
}

/**
 * Idle-game auto-management (player-requested, brief §7-adjacent): drive the
 * field's lifecycle against its active rotation plan (`activePlan`) — plow →
 * plant the plan's crop → (weed / fertilize if the plan folds them in) → harvest
 * → rake+bale or plow-under per the plan — looping year to year. Failures (can't
 * afford it, out of season) are silently retried next tick.
 */
export function autoManageField(save: SaveState, field: Field, now: SimTime): void {
  const plan = activePlan(field, now);

  // Optional side-tasks first — independent of the lifecycle, once per crop.
  if (plan.weed && !field.autoWeedDone && hasStandingCrop(field.status) && inWeedingWindow(now)) {
    try {
      enqueueTask(save, field, "weed", now);
      field.autoWeedDone = true;
    } catch {
      /* no sprayer / cash yet — retry next tick */
    }
  }
  if (plan.fertilize && !field.autoFertDone && hasStandingCrop(field.status) && canFertilizeNow(field, now)) {
    try {
      enqueueTask(save, field, "fertilize", now);
      field.autoFertDone = true;
    } catch {
      /* no sprayer / cash yet — retry next tick */
    }
  }

  const lifecycleBusy = save.tasks.some((t) => t.fieldId === field.id && LIFECYCLE_TASKS.has(t.type));
  if (lifecycleBusy) return; // a plow/plant/harvest/rake/bale step is already lined up
  switch (field.status) {
    case "stubble":
    case "mulched":
      try {
        enqueueTask(save, field, "plow", now);
      } catch {
        /* can't afford it yet, or out of the plow window — retry next tick */
      }
      break;
    case "harvested":
      if (forageDue(save, field) && plan.bale) {
        // The forage loop: rake then bale (queued together — the baler waits in
        // the queue until the rake has started). Once baled the field is
        // "mulched" and comes back around to plowing.
        try {
          enqueueTask(save, field, "rake", now);
        } catch {
          /* can't afford it yet — retry next tick */
        }
        try {
          enqueueTask(save, field, "bale", now);
        } catch {
          /* rake not queued yet / unaffordable — retry next tick */
        }
      } else {
        // Plow under — discard any un-baled forage so the plow isn't gated on it
        // (the plan opted out of baling, or there's no gear for it).
        if (field.forageReady) field.forageReady = undefined;
        try {
          enqueueTask(save, field, "plow", now);
        } catch {
          /* can't afford it yet, or out of the plow window — retry next tick */
        }
      }
      break;
    case "tilled":
      try {
        enqueueTask(save, field, "plant", now, plan.crop);
      } catch {
        /* window closed or unaffordable — retry next tick */
      }
      break;
    case "ready":
      try {
        enqueueTask(save, field, "harvest", now);
      } catch {
        /* a harvest task already exists or similar — wait */
      }
      break;
  }
}

/** Run auto-management for every flagged field (call once per tick, before
 * tickTasks so freshly queued work can start the same tick). */
export function autoManageAll(save: SaveState, now: SimTime): void {
  for (const field of save.fields) {
    if (field.autoManage) autoManageField(save, field, now);
  }
}
