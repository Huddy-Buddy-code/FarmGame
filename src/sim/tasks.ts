/**
 * The work queue + agents (brief §9, §10) — plowing, planting, and harvesting
 * are TASKS that queue up, and discrete machines work through them one after
 * another. Machines drive a back-and-forth COVERAGE PATH across the field (see
 * `coverage.ts`) at a physical field speed, so a job's duration EMERGES from the
 * field's size and the implement's working width — no abstract acres/hour rate.
 *
 * Equipment model: a TRACTOR is a power unit that attaches an IMPLEMENT (a plow
 * now; planters/etc. reuse this later). A tractor pulls implements of its own
 * size class or smaller. Plowing needs a tractor WITH a plow. The COMBINE is
 * self-contained (integral header). Each machine is the brief's §9 state machine:
 * idle → drive to field → work the coverage path → next task.
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
import type { SaveState, Field, FieldStatus, FarmTask, Agent, Implement, TaskType } from "../state/saveState";
import { areaAcres } from "../geo/geometry";
import type { Meters } from "../geo/coords";
import { inPlantingWindow, canPlow, applyPlow, applyPlant, applyHarvestDone } from "./farming";
import { buildCoveragePath, sampleAt, workDoneAt, distanceAtWork } from "./coverage";
import type { CoveragePath } from "./coverage";

const ACRE_M2 = 4046.8564224;

/** Which agent kind performs each task type. */
export const TASK_AGENT_KIND: Record<TaskType, Agent["kind"]> = {
  plow: "tractor",
  plant: "tractor",
  harvest: "harvester",
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
/** Buyable implements (a plow now; more reuse this system later). */
export type ImplementKind = "plow";

const EQUIPMENT_NAME: Record<EquipmentKind, string> = { tractor: "Tractor", harvester: "Combine" };
const IMPLEMENT_NAME: Record<ImplementKind, string> = { plow: "Plow" };
const SIZE_LABEL: Record<EquipmentSize, string> = { small: "Small", medium: "Medium", large: "Large" };

/** Price of a power unit at a given size. */
export function agentPrice(kind: EquipmentKind, size: EquipmentSize): number {
  return kind === "harvester" ? gameConfig.equipment.harvester.price : gameConfig.equipment.tractor[size].price;
}

/** Price of an implement at a given size. */
export function implementPrice(kind: ImplementKind, size: EquipmentSize): number {
  return gameConfig.equipment[kind][size].price;
}

/** Working width (meters) of an implement. */
export function implementWidthM(impl: Implement): number {
  return gameConfig.equipment[impl.kind][impl.size].widthFt * FEET_TO_METERS;
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

/** The plow currently hitched to `tractor`, if any. */
function attachedPlow(save: SaveState, tractorId: string): Implement | undefined {
  return save.implements.find((i) => i.attachedTo === tractorId && i.kind === "plow");
}

/** An idle, unattached plow this tractor could hitch (largest that fits first). */
function availablePlowFor(save: SaveState, tractor: Agent): Implement | undefined {
  return save.implements
    .filter((i) => i.kind === "plow" && !i.attachedTo && tractor.size && canPull(tractor.size, i.size))
    .sort((a, b) => SIZE_RANK[b.size] - SIZE_RANK[a.size])[0];
}

/** Can this tractor take a plow task right now — does it have (or can it hitch) a
 * plow? Used both for task assignment and UI hints. */
export function tractorCanPlow(save: SaveState, tractor: Agent): boolean {
  return !!attachedPlow(save, tractor.id) || !!availablePlowFor(save, tractor);
}

/** All not-yet-finished tasks for a field (optionally of one type). */
export function tasksFor(save: SaveState, fieldId: string, type?: TaskType): FarmTask[] {
  return save.tasks.filter((t) => t.fieldId === fieldId && (!type || t.type === type));
}

/** Is an agent actively harvesting this field right now? */
export function isFieldHarvesting(save: SaveState, fieldId: string): boolean {
  return save.tasks.some((t) => t.fieldId === fieldId && t.type === "harvest" && t.status === "active");
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
    else status = "harvested";
  }
  return status;
}

/** What queueing this task would charge right now, for button labels. */
export function taskCost(field: Field, type: TaskType, crop?: CropId): number {
  const acres = areaAcres(field.boundary);
  if (type === "plow") return Math.round(acres * gameConfig.plowCostPerAcre);
  if (type === "plant") return Math.round(acres * gameConfig.crops[crop!].inputCostPerAcre);
  return 0; // harvest: fuel/wages arrive with the cost-model slice (brief §8)
}

/**
 * Queue a task (pay-on-queue). Validates against the field's EFFECTIVE status so
 * chains like plow→plant queue together. Throws player-facing messages.
 */
export function enqueueTask(save: SaveState, field: Field, type: TaskType, now: SimTime, crop?: CropId): FarmTask {
  if (tasksFor(save, field.id, type).length > 0) {
    throw new Error(`${field.id} already has a ${type} task queued`);
  }
  const eff = effectiveStatus(save, field);
  if (type === "plow" && !canPlow(eff)) {
    throw new Error(`${field.id} can't be plowed (status: ${eff})`);
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
  const cost = taskCost(field, type, crop);
  if (cost > save.money) {
    throw new Error(`That costs $${cost.toLocaleString()} — not enough cash`);
  }
  save.money -= cost;
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
  return task;
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
  if (task.type === "plow") return canPlow(field.status);
  if (task.type === "plant") return field.status === "tilled";
  return field.status === "ready";
}

// --- coverage-path runtime (not persisted; rebuilt from doneAcres on reload) ---
const pathCache = new Map<string, CoveragePath>();
const pathDistRuntime = new Map<string, number>();

/** Working width (meters) for a task: from the attached plow, or the config
 * planter/header width for plant/harvest. */
function taskSwathMeters(save: SaveState, task: FarmTask, agent: Agent): number {
  if (task.type === "harvest") return gameConfig.equipment.harvester.widthFt * FEET_TO_METERS;
  if (task.type === "plant") return gameConfig.equipment.planterWidthFt * FEET_TO_METERS;
  const plow = attachedPlow(save, agent.id);
  return (plow ? implementWidthM(plow) : gameConfig.equipment.plow.medium.widthFt * FEET_TO_METERS);
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
  for (const agent of save.agents) {
    tickAgent(save, agent, now, dtMinutes, changed, events, rand);
  }
  return { changed, events };
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
      // Pick the first queued task of this agent's kind that's startable now.
      // Plowing also needs the tractor to have (or be able to hitch) a plow.
      const next = save.tasks.find(
        (t) =>
          t.status === "queued" &&
          TASK_AGENT_KIND[t.type] === agent.kind &&
          (t.type !== "plow" || tractorCanPlow(save, agent)) &&
          save.fields.some((f) => f.id === t.fieldId && isStartable(t, f)),
      );
      if (!next) {
        agent.state = "idle";
        return;
      }
      // Auto-hitch a plow for a plow task if the tractor is bare.
      if (next.type === "plow" && !attachedPlow(save, agent.id)) {
        const p = availablePlowFor(save, agent);
        if (p) p.attachedTo = agent.id;
      }
      next.status = "active";
      next.agentId = agent.id;
      agent.taskId = next.id;
      agent.state = "traveling";
      events.push({ kind: "started", task: next, agent });
      continue;
    }

    const field = save.fields.find((f) => f.id === task.fieldId);
    if (!field) {
      // Field vanished mid-task (sold) — drop the job.
      save.tasks.splice(save.tasks.indexOf(task), 1);
      agent.taskId = undefined;
      agent.state = "idle";
      continue;
    }

    if (agent.state === "traveling") {
      // Drive to the field's coverage-path START (not the centroid), so work
      // begins exactly where the first lane does.
      const path = getActivePath(save, task, field, agent);
      const target = path.pts[0]!;
      const dx = target[0] - agent.pos[0];
      const dy = target[1] - agent.pos[1];
      const dist = Math.hypot(dx, dy);
      const speed = (gameConfig.work.travelSpeedKmh * 1000) / 60; // meters per sim-minute
      if (dist > 1e-6) agent.heading = Math.atan2(dy, dx);
      const timeNeeded = dist / speed;
      if (timeNeeded <= budget) {
        agent.pos = target;
        budget -= timeNeeded;
        agent.state = "working";
      } else {
        const f = (budget * speed) / dist;
        agent.pos = [agent.pos[0] + dx * f, agent.pos[1] + dy * f];
        budget = 0;
      }
      continue;
    }

    // Working: drive the coverage path at field speed; swept in-field distance ×
    // swath = area worked, which is where doneAcres comes from (physical model).
    const path = getActivePath(save, task, field, agent);
    const speed = (gameConfig.work.fieldSpeedKmh * 1000) / 60; // meters per sim-minute
    let dist = pathDistRuntime.get(task.id);
    if (dist === undefined) dist = distanceAtWork(path, (task.doneAcres * ACRE_M2) / path.swath);
    const timeNeeded = (path.total - dist) / speed;
    const timeUsed = Math.min(timeNeeded, budget);
    dist = Math.min(path.total, dist + speed * timeUsed);
    budget -= timeUsed;
    pathDistRuntime.set(task.id, dist);

    const prevAcres = task.doneAcres;
    const workLen = workDoneAt(path, dist);
    task.doneAcres = Math.min(task.totalAcres, (workLen * path.swath) / ACRE_M2);
    const s = sampleAt(path, dist);
    agent.pos = s.pos;
    agent.heading = s.heading;

    if (task.type === "harvest" && field.crop && field.trueYieldTonsPerAcre !== undefined) {
      // Grain banks continuously as the combine works, like real cart loads.
      save.grain[field.crop] += (task.doneAcres - prevAcres) * field.trueYieldTonsPerAcre;
      field.harvestedAcres = task.doneAcres;
    }

    if (dist >= path.total - 1e-6) {
      task.doneAcres = task.totalAcres;
      completeTask(task, field, now, rand);
      changed.push(field);
      events.push({ kind: "finished", task, agent });
      clearTaskRuntime(task.id);
      save.tasks.splice(save.tasks.indexOf(task), 1);
      agent.taskId = undefined;
      agent.state = "idle";
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
  }
}

/**
 * Idle-game auto-management (player-requested, brief §7-adjacent): queue the
 * next lifecycle task the moment it's possible, so a player can walk away and
 * the agents keep the farm running. Failures (can't afford it, no planting
 * window open) are silently retried next tick.
 */
export function autoManageField(save: SaveState, field: Field, now: SimTime): void {
  if (tasksFor(save, field.id).length > 0) return; // work already lined up
  switch (field.status) {
    case "stubble":
    case "harvested":
      try {
        enqueueTask(save, field, "plow", now);
      } catch {
        /* can't afford it yet — retry next tick */
      }
      break;
    case "tilled":
      // Policy: plant the first crop (config order) whose window is open and
      // affordable. Placeholder — real crop/contract strategy is a later layer.
      for (const cropId of Object.keys(gameConfig.crops) as CropId[]) {
        try {
          enqueueTask(save, field, "plant", now, cropId);
          break;
        } catch {
          /* window closed or unaffordable — try the next crop */
        }
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
