import { describe, it, expect, beforeAll } from "vitest";
import { setProjection } from "../src/geo/coords";
import type { Meters } from "../src/geo/coords";
import { newGame } from "../src/state/saveState";
import type { Field, SaveState } from "../src/state/saveState";
import { tickFarming } from "../src/sim/farming";
import {
  ensureAgents, buyAgent, buyImplement, enqueueTask, tickTasks, autoManageAll,
  queueHaulBales, fieldHasLooseBales, blockedWork, InsufficientFundsError,
} from "../src/sim/tasks";
import { buyBuildingAt, assignSiloCrop } from "../src/sim/buildings";
import { minutesPerMonth } from "../src/sim/calendar";
import { gameConfig } from "../src/config/gameConfig";

beforeAll(() => setProjection(15, "N"));

const side = Math.sqrt(100 * 4046.8564224); // 100 acres
const boundary: Meters[] = [[0, 0], [side, 0], [side, side], [0, side]];
const APRIL_1 = minutesPerMonth();

function run(save: SaveState, from: number, done: () => boolean, cap = 200_000, step = 60): number {
  let now = from;
  while (!done() && now - from < cap) {
    now += step;
    tickFarming(save, now);
    tickTasks(save, now, step, () => 0.5);
  }
  return now;
}

// ---------------------------------------------------------------------------
// Machine selection: biggest implement, smallest tractor that can pull it
// ---------------------------------------------------------------------------
describe("rig selection — largest implement, smallest capable tractor", () => {
  /** A farm with small+large tractors and small+large plows, and one field
   * that needs plowing. */
  function farm(): { save: SaveState; field: Field } {
    const save = newGame();
    buyAgent(save, "tractor", "small", [0, 0]);
    buyAgent(save, "tractor", "large", [0, 0]);
    buyImplement(save, "plow", "small");
    buyImplement(save, "plow", "large");
    const field: Field = { id: "field-1", parcelId: "p", boundary, status: "stubble" };
    save.fields.push(field);
    return { save, field };
  }

  it("uses the LARGE plow, not the small one the small tractor could manage", () => {
    const { save, field } = farm();
    enqueueTask(save, field, "plow", APRIL_1);
    run(save, APRIL_1, () => save.tasks.some((t) => t.status === "active"), 5000);

    const task = save.tasks.find((t) => t.type === "plow")!;
    const impl = save.implements.find((i) => i.attachedTo === task.agentId);
    expect(impl?.kind).toBe("plow");
    expect(impl?.size).toBe("large");
  });

  it("puts the SMALLEST tractor that can pull it on the job", () => {
    const save = newGame();
    // Medium and large tractors; the biggest plow is medium, so the MEDIUM
    // tractor should take it and leave the large one free.
    buyAgent(save, "tractor", "medium", [0, 0]);
    buyAgent(save, "tractor", "large", [0, 0]);
    buyImplement(save, "plow", "medium");
    const field: Field = { id: "field-1", parcelId: "p", boundary, status: "stubble" };
    save.fields.push(field);
    enqueueTask(save, field, "plow", APRIL_1);
    run(save, APRIL_1, () => save.tasks.some((t) => t.status === "active"), 5000);

    const task = save.tasks.find((t) => t.type === "plow")!;
    const chosen = save.agents.find((a) => a.id === task.agentId)!;
    expect(chosen.size).toBe("medium");
  });

  it("still gets the job done when only a small tractor can pull anything", () => {
    const save = newGame();
    buyAgent(save, "tractor", "small", [0, 0]);
    buyImplement(save, "plow", "small");
    const field: Field = { id: "field-1", parcelId: "p", boundary, status: "stubble" };
    save.fields.push(field);
    enqueueTask(save, field, "plow", APRIL_1);
    run(save, APRIL_1, () => field.status === "tilled");
    expect(field.status).toBe("tilled");
  });

  it("never deadlocks when the only implement is too big for the only tractor", () => {
    const save = newGame();
    buyAgent(save, "tractor", "small", [0, 0]);
    buyImplement(save, "plow", "large"); // unpullable
    const field: Field = { id: "field-1", parcelId: "p", boundary, status: "stubble" };
    save.fields.push(field);
    enqueueTask(save, field, "plow", APRIL_1);
    run(save, APRIL_1, () => false, 20_000);
    // Nothing can happen — but it must be REPORTED, not silently stuck.
    expect(field.status).toBe("stubble");
    expect(blockedWork(save).some((b) => /big enough/.test(b.reason))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Crews
// ---------------------------------------------------------------------------
describe("hauling crews", () => {
  it("puts several grain carts on one combine, capped at maxCrewSize", () => {
    const save = newGame();
    ensureAgents(save, [0, 0]);
    const silo = buyBuildingAt(save, "silo", [-400, -400], "large");
    assignSiloCrop(save, silo.id, "corn");
    // Plenty of cart-capable rigs (starting cash only stretches so far).
    save.money = 10_000_000;
    for (let i = 0; i < 5; i++) {
      buyAgent(save, "tractor", "medium", [0, 0]);
      buyImplement(save, "grainTrailer", "medium");
    }
    const field: Field = {
      id: "field-1", parcelId: "p", boundary, status: "ready", crop: "corn",
      trueYieldTonsPerAcre: 6, plantedAt: APRIL_1 - gameConfig.crops.corn.growMonths * minutesPerMonth(),
    };
    save.fields.push(field);
    enqueueTask(save, field, "harvest", APRIL_1);

    let peak = 0;
    run(save, APRIL_1, () => {
      peak = Math.max(peak, save.tasks.filter((t) => t.type === "unloadHarvester").length);
      return peak >= 2;
    }, 60_000);

    expect(peak).toBeGreaterThan(1); // a crew, not a single cart
    expect(peak).toBeLessThanOrEqual(gameConfig.hauling.maxCrewSize);
  });

  it("never spawns an uncrewed second cart — one trailer means one trip", () => {
    const save = newGame();
    ensureAgents(save, [0, 0]); // one tractor, one combine
    const silo = buyBuildingAt(save, "silo", [-400, -400], "large");
    assignSiloCrop(save, silo.id, "corn");
    buyImplement(save, "grainTrailer", "medium");
    const field: Field = {
      id: "field-1", parcelId: "p", boundary, status: "ready", crop: "corn",
      trueYieldTonsPerAcre: 6, plantedAt: APRIL_1 - gameConfig.crops.corn.growMonths * minutesPerMonth(),
    };
    save.fields.push(field);
    enqueueTask(save, field, "harvest", APRIL_1);

    let peak = 0;
    run(save, APRIL_1, () => {
      peak = Math.max(peak, save.tasks.filter((t) => t.type === "unloadHarvester").length);
      return false;
    }, 30_000);
    expect(peak).toBe(1);
  });

  it("adds a second bale hauler only when there are bales for it", () => {
    const save = newGame();
    save.money = 10_000_000;
    for (let i = 0; i < 3; i++) {
      buyAgent(save, "tractor", "medium", [0, 0]);
      buyImplement(save, "haySpikes", "medium");
    }
    buyBuildingAt(save, "baleArea", [-200, -200]);
    const field: Field = {
      id: "field-1", parcelId: "p", boundary, status: "mulched",
      baleProduct: "straw", baleLocations: [[10, 10]], // ONE bale
    };
    save.fields.push(field);

    expect(queueHaulBales(save, field.id)).toBeTruthy();
    const first = save.tasks.find((t) => t.type === "haulBales")!;
    first.agentId = save.agents[0]!.id; // pretend it's crewed
    // One bale, one hauler already on it — a second would have nothing to do.
    expect(queueHaulBales(save, field.id)).toBeUndefined();
    expect(fieldHasLooseBales(save, field.id)).toBe(false);

    // More bales down: now a second hauler earns its keep.
    field.baleLocations = [[10, 10], [20, 20], [30, 30]];
    expect(fieldHasLooseBales(save, field.id)).toBe(true);
    expect(queueHaulBales(save, field.id)).toBeTruthy();
  });

  it("caps the bale-haul crew at maxCrewSize", () => {
    const save = newGame();
    save.money = 10_000_000;
    for (let i = 0; i < 6; i++) buyAgent(save, "tractor", "medium", [0, 0]);
    const field: Field = {
      id: "field-1", parcelId: "p", boundary, status: "mulched", baleProduct: "straw",
      baleLocations: Array.from({ length: 40 }, (_, i) => [i * 5, i * 5] as Meters),
    };
    save.fields.push(field);
    for (let i = 0; i < 10; i++) {
      const t = queueHaulBales(save, field.id);
      if (t) t.agentId = save.agents[i % save.agents.length]!.id;
    }
    expect(save.tasks.filter((t) => t.type === "haulBales").length).toBe(gameConfig.hauling.maxCrewSize);
  });
});

// ---------------------------------------------------------------------------
// Blocked work
// ---------------------------------------------------------------------------
describe("blockedWork — only what the player can act on", () => {
  function fieldNeedingMulch(save: SaveState): Field {
    const field: Field = {
      id: "field-1", parcelId: "p", boundary, status: "harvested", lastCrop: "corn",
    };
    save.fields.push(field);
    return field;
  }

  it("reports a queued task with no implement for it", () => {
    const save = newGame();
    ensureAgents(save, [0, 0]); // tractor + combine, but no mulcher
    const field = fieldNeedingMulch(save);
    enqueueTask(save, field, "mulch", APRIL_1);
    const blocked = blockedWork(save);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.type).toBe("mulch");
    expect(blocked[0]!.reason).toMatch(/Mulcher/i);
  });

  it("says nothing once the implement is bought", () => {
    const save = newGame();
    ensureAgents(save, [0, 0]);
    buyImplement(save, "mulcher", "medium");
    const field = fieldNeedingMulch(save);
    enqueueTask(save, field, "mulch", APRIL_1);
    expect(blockedWork(save)).toHaveLength(0);
  });

  it("reports auto-manage failing on cash, with the shortfall", () => {
    const save = newGame();
    ensureAgents(save, [0, 0]);
    buyImplement(save, "mulcher", "medium");
    const field: Field = {
      id: "field-1", parcelId: "p", boundary, status: "harvested", lastCrop: "corn",
      autoManage: true, plans: [{ crop: "corn", mulch: true }],
    };
    save.fields.push(field);
    save.money = 10; // can't afford the mulch pass

    autoManageAll(save, 6 * minutesPerMonth()); // September — mulch window, pre-plow
    const blocked = blockedWork(save);
    expect(blocked.some((b) => b.type === "mulch" && /Needs \$/.test(b.reason))).toBe(true);
  });

  it("stays SILENT about out-of-season work — that resolves itself", () => {
    const save = newGame();
    ensureAgents(save, [0, 0]);
    const field: Field = {
      id: "field-1", parcelId: "p", boundary, status: "tilled",
      autoManage: true, plans: [{ crop: "corn" }],
    };
    save.fields.push(field);
    // December: corn's planting window (Apr–May) is long shut.
    autoManageAll(save, 9 * minutesPerMonth());
    expect(blockedWork(save)).toHaveLength(0);
  });

  it("clears a cash block once the money is there", () => {
    const save = newGame();
    ensureAgents(save, [0, 0]);
    buyImplement(save, "mulcher", "medium");
    const field: Field = {
      id: "field-1", parcelId: "p", boundary, status: "harvested", lastCrop: "corn",
      autoManage: true, plans: [{ crop: "corn", mulch: true }],
    };
    save.fields.push(field);
    save.money = 10;
    autoManageAll(save, 6 * minutesPerMonth());
    expect(blockedWork(save).length).toBeGreaterThan(0);

    save.money = 100_000;
    autoManageAll(save, 6 * minutesPerMonth());
    expect(blockedWork(save).filter((b) => /Needs \$/.test(b.reason))).toHaveLength(0);
  });

  it("a failed enqueue leaves the pass RETRYABLE rather than marking it done", () => {
    const save = newGame();
    ensureAgents(save, [0, 0]);
    buyImplement(save, "mulcher", "medium");
    const field: Field = {
      id: "field-1", parcelId: "p", boundary, status: "harvested", lastCrop: "corn",
      autoManage: true, plans: [{ crop: "corn", mulch: true }],
    };
    save.fields.push(field);

    save.money = 10;
    autoManageAll(save, 6 * minutesPerMonth());
    expect(field.autoMulchDone).toBeFalsy(); // NOT consumed by the failure
    expect(save.tasks).toHaveLength(0);

    save.money = 100_000;
    autoManageAll(save, 6 * minutesPerMonth());
    expect(save.tasks.some((t) => t.type === "mulch")).toBe(true);
  });
});

describe("InsufficientFundsError", () => {
  it("carries the cost and what was available, and still reads as a message", () => {
    const save = newGame();
    const field: Field = { id: "field-1", parcelId: "p", boundary, status: "stubble" };
    save.fields.push(field);
    save.money = 5;
    try {
      enqueueTask(save, field, "plow", APRIL_1);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(InsufficientFundsError);
      const e = err as InsufficientFundsError;
      expect(e.cost).toBe(100 * gameConfig.plowCostPerAcre);
      expect(e.available).toBe(5);
      expect(e.message).toMatch(/not enough cash/);
    }
  });
});
