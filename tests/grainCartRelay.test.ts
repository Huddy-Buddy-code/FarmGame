/**
 * Grain-cart logistics, reworked 2026-07-24 on two maintainer requests:
 *
 *   "The second cart should always wait at field entrance until the first is
 *    full."
 *   "Try and get the grain carts to fill from the harvester while it is moving,
 *    like it does in real life. When the harvester is 85% full, call the cart
 *    and start filling it on the move."
 *
 * Both matter far more than they used to. Tanks are bushels now, so a combine
 * fills many times per field; under the old rules it stopped dead at every
 * tankful and waited for a cart to drive over, and a second cart would pile in
 * alongside the first.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { setProjection } from "../src/geo/coords";
import type { Meters } from "../src/geo/coords";
import { newGame } from "../src/state/saveState";
import type { Field, FarmTask, SaveState } from "../src/state/saveState";
import { tickFarming } from "../src/sim/farming";
import {
  buyAgent, buyImplement, enqueueTask, tickTasks, harvesterCapacityTons,
  grainDumpMinutes, grainTrailerCapacityTons,
} from "../src/sim/tasks";
import { buyBuildingAt, assignSiloCrop } from "../src/sim/buildings";
import { minutesPerMonth } from "../src/sim/calendar";
import { gameConfig } from "../src/config/gameConfig";

beforeAll(() => setProjection(15, "N"));

const APRIL_1 = minutesPerMonth();

/** A ready corn field with real gates, so carts have an entrance to wait at. */
function cornField(acres: number): Field {
  const side = Math.sqrt(acres * 4046.8564224);
  return {
    id: "field-1", parcelId: "p",
    boundary: [[0, 0], [side, 0], [side, side], [0, side]] as Meters[],
    accessPoints: [[side / 2, 0], [side / 2, side]] as Meters[],
    status: "ready", crop: "corn", trueYieldTonsPerAcre: 6,
    plantedAt: APRIL_1 - gameConfig.crops.corn.growMonths * minutesPerMonth(),
  };
}

/** A combine + `carts` cart-capable rigs + a silo, mid-harvest. */
function harvestFarm(carts: number, acres = 30): { save: SaveState; field: Field } {
  const save = newGame();
  save.money = 40_000_000;
  const silo = buyBuildingAt(save, "silo", [-900, -900], "large");
  assignSiloCrop(save, silo.id, "corn");
  buyAgent(save, "harvester", "medium", [0, 0]);
  buyImplement(save, "cornHeader", "medium");
  for (let i = 0; i < carts; i++) {
    buyAgent(save, "tractor", "medium", [0, 0]);
    buyImplement(save, "grainTrailer", "medium");
  }
  const field = cornField(acres);
  save.fields.push(field);
  enqueueTask(save, field, "harvest", APRIL_1);
  return { save, field };
}

const unloads = (save: SaveState) => save.tasks.filter((t) => t.type === "unloadHarvester");
const atCombine = (t: FarmTask) => t.unloadPhase === "toHarvester" || t.unloadPhase === "onloading";

/**
 * Emptying at the silo is RATE-based (2026-07-25 realism pass), not a flat
 * `hauling.dumpMinutes`.
 *
 * It used to take ~10 sim-seconds to empty a cart however much was aboard — so
 * a 1500 bu load unhooked as fast as an almost-empty one. That handed the
 * hauling loop a free pass at precisely the end that's meant to be the
 * bottleneck of harvest season.
 */
describe("the silo leg costs time in proportion to the load", () => {
  it("scales with tonnage, and keeps a hook-up floor", () => {
    const rate = gameConfig.hauling.dumpTonsPerMinute;
    expect(grainDumpMinutes(40)).toBeCloseTo(40 / rate, 9);
    expect(grainDumpMinutes(80)).toBeCloseTo(2 * grainDumpMinutes(40), 9);
    // A near-empty cart still pauses to hook up rather than teleporting through.
    expect(grainDumpMinutes(0)).toBe(gameConfig.hauling.dumpMinutes);
    expect(grainDumpMinutes(0.001)).toBe(gameConfig.hauling.dumpMinutes);
  });

  it("a full Medium cart takes over a sim-minute, not ten seconds", () => {
    const tons = grainTrailerCapacityTons("medium", "corn");
    expect(grainDumpMinutes(tons)).toBeGreaterThan(1);
    expect(grainDumpMinutes(tons)).toBeGreaterThan(gameConfig.hauling.dumpMinutes * 5);
  });

  it("the rate actually reaches the sim — dumps span multiple 1-minute ticks", () => {
    // The wiring half. Under the old flat 0.17 a dump always began AND ended
    // inside one tick, so an outside observer ticking at 1 minute never caught
    // a cart mid-dump. Now it does.
    const { save, field } = harvestFarm(1, 30);
    let ticksSeenDumping = 0;
    let now = APRIL_1;
    while (field.status !== "harvested" && now - APRIL_1 < 600_000) {
      now += 1;
      tickFarming(save, now);
      tickTasks(save, now, 1, () => 0.5);
      if (unloads(save).some((t) => t.unloadPhase === "dumping")) ticksSeenDumping++;
    }
    expect(field.status).toBe("harvested");
    expect(ticksSeenDumping).toBeGreaterThan(0);
  });
});

describe("one cart on the combine at a time", () => {
  it("never sends two carts to the combine at once", () => {
    const { save, field } = harvestFarm(3, 40);
    let maxAtCombine = 0;
    let now = APRIL_1;
    // 1-minute ticks: a cart can now pull alongside, fill on the move and set
    // off again inside a single 5-minute one, so a coarse sample sees nothing.
    while (field.status !== "harvested" && now - APRIL_1 < 600_000) {
      now += 1;
      tickFarming(save, now);
      tickTasks(save, now, 1, () => 0.5);
      maxAtCombine = Math.max(maxAtCombine, unloads(save).filter(atCombine).length);
    }
    expect(field.status).toBe("harvested");
    expect(maxAtCombine).toBe(1);
  });

  it("the waiting cart sits at a field gate, not out in the middle", () => {
    const { save, field } = harvestFarm(3, 40);
    const gates = field.accessPoints!;
    const atAGate = (p: Meters) => gates.some((g) => Math.hypot(p[0] - g[0], p[1] - g[1]) < 1);

    let sawSecondCartWaitingAtGate = false;
    let now = APRIL_1;
    while (field.status !== "harvested" && now - APRIL_1 < 600_000) {
      now += 1;
      tickFarming(save, now);
      tickTasks(save, now, 1, () => 0.5);
      const busy = unloads(save).filter(atCombine);
      const idleCrew = unloads(save).filter((t) => !atCombine(t) && t.unloadPhase === "staging");
      if (busy.length === 1 && idleCrew.length > 0) {
        for (const t of idleCrew) {
          const rig = save.agents.find((a) => a.id === t.agentId);
          // Only carts that have never loaded park at a gate — a part-loaded
          // one holds position where it last drained the combine.
          const cart = save.implements.find((i) => i.attachedTo === t.agentId && i.kind === "grainTrailer");
          if (rig && (cart?.cargoTons ?? 0) <= 1e-9 && atAGate(rig.pos)) sawSecondCartWaitingAtGate = true;
        }
      }
    }
    expect(sawSecondCartWaitingAtGate).toBe(true);
  });

  it("hands over to the next cart once the leader fills and leaves", () => {
    const { save, field } = harvestFarm(2, 40);
    const served = new Set<string>();
    let now = APRIL_1;
    while (field.status !== "harvested" && now - APRIL_1 < 600_000) {
      now += 1;
      tickFarming(save, now);
      tickTasks(save, now, 1, () => 0.5);
      for (const t of unloads(save)) if (atCombine(t) && t.agentId) served.add(t.agentId);
    }
    // Both rigs got a turn — the queue rotates rather than one cart doing
    // everything while the other idles forever.
    expect(served.size).toBeGreaterThan(1);
  });
});

describe("unloading on the move", () => {
  it("calls the cart at ~85%, not at a brim-full tank", () => {
    const { save, field } = harvestFarm(1, 60);
    const cap = harvesterCapacityTons("medium", "corn");
    const callAt = cap * gameConfig.hauling.callCartAtFraction;

    let onboardWhenCalled: number | null = null;
    let now = APRIL_1;
    while (onboardWhenCalled === null && now - APRIL_1 < 600_000) {
      now += 1;
      tickFarming(save, now);
      tickTasks(save, now, 1, () => 0.5);
      const combine = save.agents.find((a) => a.kind === "harvester")!;
      if (unloads(save).some(atCombine)) onboardWhenCalled = combine.grainOnboard ?? 0;
    }
    expect(onboardWhenCalled).not.toBeNull();
    // Called before the tank was full, and not absurdly early either.
    expect(onboardWhenCalled!).toBeLessThan(cap - 1e-9);
    expect(onboardWhenCalled!).toBeGreaterThanOrEqual(callAt - 0.5);
    expect(field.status).not.toBe("harvested"); // still cutting when the call went out
  });

  it("the combine keeps CUTTING while the cart draws grain off it", () => {
    const { save, field } = harvestFarm(1, 60);
    let cutWhileUnloading = false;
    let prevAcres = 0;
    let now = APRIL_1;
    while (field.status !== "harvested" && now - APRIL_1 < 600_000) {
      now += 5;
      tickFarming(save, now);
      tickTasks(save, now, 5, () => 0.5);
      const harvest = save.tasks.find((t) => t.type === "harvest");
      const transferring = unloads(save).some((t) => t.unloadPhase === "onloading");
      if (harvest && transferring && harvest.doneAcres > prevAcres + 1e-9) cutWhileUnloading = true;
      if (harvest) prevAcres = harvest.doneAcres;
    }
    expect(cutWhileUnloading).toBe(true);
  });

  it("grain crosses gradually, not in one instant jump", () => {
    // A rate, not a teleport: the pair should be seen mid-transfer with the
    // cart part-loaded and the combine still holding some.
    const { save, field } = harvestFarm(1, 60);
    let sawBothPartLoaded = false;
    let now = APRIL_1;
    while (field.status !== "harvested" && now - APRIL_1 < 600_000) {
      now += 1;
      tickFarming(save, now);
      tickTasks(save, now, 1, () => 0.5);
      const combine = save.agents.find((a) => a.kind === "harvester")!;
      const cart = save.implements.find((i) => i.kind === "grainTrailer")!;
      const transferring = unloads(save).some((t) => t.unloadPhase === "onloading");
      if (transferring && (combine.grainOnboard ?? 0) > 1e-9 && (cart.cargoTons ?? 0) > 1e-9) {
        sawBothPartLoaded = true;
      }
    }
    expect(sawBothPartLoaded).toBe(true);
  });

  it("still gets the whole crop into the silo", () => {
    // The point of all of the above is throughput, so the total must survive it.
    const { save, field } = harvestFarm(2, 30);
    let now = APRIL_1;
    while (now - APRIL_1 < 600_000 && !(field.status === "harvested" && unloads(save).length === 0)) {
      now += 5;
      tickFarming(save, now);
      tickTasks(save, now, 5, () => 0.5);
    }
    expect(field.status).toBe("harvested");
    expect(save.grain.corn).toBeCloseTo(30 * 6, 0);
  });
});
