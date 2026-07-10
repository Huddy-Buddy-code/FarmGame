/**
 * The work queue + agents (brief §9, §10) — plowing, planting, and harvesting
 * are TASKS that queue up, and discrete agents work through them one after
 * another at realistic rates (task duration = acres ÷ acres-per-hour, all
 * tunable in gameConfig.work).
 *
 * v1 agents: one TRACTOR (plow + plant) and one COMBINE harvester (harvest).
 * Each is the brief's §9 state machine: idle → drive to field → work → next
 * task. Driving is straight-line at a config speed for now; real-road routing
 * plugs in later. Positions are UTM meters like everything else (brief §3).
 *
 * Money: costs are paid ON QUEUE (design decision 2026-07-10) — queueing a plow
 * or plant task charges immediately, and canceling a still-queued task refunds
 * in full. This keeps "can I afford it" at the moment of the player's decision.
 *
 * Pure logic on the save-state (agents + tasks are persisted in it): no map, no
 * DOM, so it's unit-testable like farming.ts.
 */

import { gameConfig } from "../config/gameConfig";
import type { CropId } from "../config/gameConfig";
import type { SimTime } from "./clock";
import type { SaveState, Field, FieldStatus, FarmTask, Agent, TaskType } from "../state/saveState";
import { areaAcres, centroidOf } from "../geo/geometry";
import type { Meters } from "../geo/coords";
import { inPlantingWindow, canPlow, applyPlow, applyPlant, applyHarvestDone } from "./farming";

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

/** Kinds of machine the player can own/buy. */
export type EquipmentKind = "tractor" | "harvester";

const EQUIPMENT_NAME: Record<EquipmentKind, string> = { tractor: "Tractor", harvester: "Combine" };

/** Make sure the starting fleet exists (also upgrades pre-agent saves).
 * `home` is where new machines park — the farmstead-to-be (county center v1). */
export function ensureAgents(save: SaveState, home: Meters): void {
  for (const kind of ["tractor", "harvester"] as const) {
    if (!save.agents.some((a) => a.kind === kind)) {
      save.agents.push(makeAgent(save, kind, home));
    }
  }
  // Older saves' agents predate purchaseCost — treat them like the starting
  // fleet (sell-back at config price).
  for (const a of save.agents) a.purchaseCost ??= gameConfig.equipmentPrices[a.kind as EquipmentKind] ?? 0;
}

function makeAgent(save: SaveState, kind: EquipmentKind, pos: Meters): Agent {
  let n = 1;
  while (save.agents.some((a) => a.id === `${kind}-${n}`)) n++;
  return {
    id: `${kind}-${n}`,
    kind,
    name: n === 1 ? EQUIPMENT_NAME[kind] : `${EQUIPMENT_NAME[kind]} ${n}`,
    pos,
    state: "idle",
    purchaseCost: gameConfig.equipmentPrices[kind],
  };
}

/** Buy a new machine (brief §8 capital). It parks at `home` and starts pulling
 * from the queue immediately. Throws if unaffordable. */
export function buyAgent(save: SaveState, kind: EquipmentKind, home: Meters): Agent {
  const price = gameConfig.equipmentPrices[kind];
  if (price > save.money) {
    throw new Error(`A ${EQUIPMENT_NAME[kind].toLowerCase()} costs $${price.toLocaleString()} — not enough cash`);
  }
  save.money -= price;
  const agent = makeAgent(save, kind, home);
  save.agents.push(agent);
  return agent;
}

/**
 * Sell a machine back for exactly what it cost (same rule as land). Refuses if
 * it's mid-job, or if it's the last machine of its kind while jobs that need it
 * are still queued (they'd wait forever).
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
  const refund = agent.purchaseCost ?? gameConfig.equipmentPrices[agent.kind as EquipmentKind] ?? 0;
  save.agents.splice(idx, 1);
  save.money += refund;
  return { agent, refund };
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
      const next = save.tasks.find(
        (t) =>
          t.status === "queued" &&
          TASK_AGENT_KIND[t.type] === agent.kind &&
          save.fields.some((f) => f.id === t.fieldId && isStartable(t, f)),
      );
      if (!next) {
        agent.state = "idle";
        return;
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
      const target = centroidOf(field.boundary);
      const dx = target[0] - agent.pos[0];
      const dy = target[1] - agent.pos[1];
      const dist = Math.hypot(dx, dy);
      const speed = (gameConfig.work.travelSpeedKmh * 1000) / 60; // meters per sim-minute
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

    // Working.
    const rate = workRatePerMinute(task.type); // acres per sim-minute
    const remaining = task.totalAcres - task.doneAcres;
    const timeNeeded = remaining / rate;
    const timeUsed = Math.min(timeNeeded, budget);
    const cut = rate * timeUsed;
    task.doneAcres += cut;
    budget -= timeUsed;

    if (task.type === "harvest" && field.crop && field.trueYieldTonsPerAcre !== undefined) {
      // Grain banks continuously as the combine works, like real cart loads.
      save.grain[field.crop] += cut * field.trueYieldTonsPerAcre;
      field.harvestedAcres = task.doneAcres;
    }

    if (task.doneAcres >= task.totalAcres - 1e-9) {
      completeTask(task, field, now, rand);
      changed.push(field);
      events.push({ kind: "finished", task, agent });
      save.tasks.splice(save.tasks.indexOf(task), 1);
      agent.taskId = undefined;
      agent.state = "idle";
    }
  }
}

function workRatePerMinute(type: TaskType): number {
  const w = gameConfig.work;
  const perHour = type === "plow" ? w.plowAcresPerHour : type === "plant" ? w.seedAcresPerHour : w.harvestAcresPerHour;
  return perHour / 60;
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
