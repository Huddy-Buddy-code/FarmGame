import { describe, it, expect, beforeAll } from "vitest";
import { setProjection } from "../src/geo/coords";
import type { Meters } from "../src/geo/coords";
import { newGame } from "../src/state/saveState";
import type { Field, SaveState } from "../src/state/saveState";
import {
  ensureAgents, tickTasks, enqueueTask, buyImplement, buyAgent, sellAgent, harvesterCapacityTons, setHarvesterCrop,
} from "../src/sim/tasks";
import { tickFarming } from "../src/sim/farming";
import { sellGrain } from "../src/sim/economy";
import { buyBuildingAt, assignSiloCrop } from "../src/sim/buildings";
import { gameConfig } from "../src/config/gameConfig";
import { minutesPerMonth } from "../src/sim/calendar";

beforeAll(() => setProjection(15, "N"));

const APRIL_1 = minutesPerMonth();

/** A small field, already "ready" with a known true yield — skips the grow
 * cycle so tests can drive straight into harvesting. `acres` sized per test
 * so the total potential yield lands where the test wants it relative to a
 * medium combine's 50t hopper. */
function readyField(acres: number, tonsPerAcre = 6): Field {
  const side = Math.sqrt(acres * 4046.8564224);
  const boundary: Meters[] = [[0, 0], [side, 0], [side, side], [0, side]];
  return {
    // plantedAt way in the past so tickFarming's growth-derived status (which
    // would otherwise overwrite "ready" back to "growing") clamps at ready.
    id: "field-1", parcelId: "parcel-1", boundary,
    status: "ready", crop: "corn", plantedAt: -1_000_000, trueYieldTonsPerAcre: tonsPerAcre,
  };
}

function gameWithAgents(): SaveState {
  const save = newGame();
  ensureAgents(save, [0, 0]); // medium tractor + medium combine (50t hopper)
  return save;
}

function samePos(a: Meters, b: Meters): boolean {
  return Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.5;
}

/** Run growth/tasks forward until `done()` or the cap, like main.ts's tick order. */
function runUntil(save: SaveState, from: number, done: () => boolean, capMinutes = 200_000, step = 60): number {
  let now = from;
  while (!done() && now - from < capMinutes) {
    now += step;
    tickFarming(save, now);
    tickTasks(save, now, step, () => 0.5);
  }
  return now;
}

function combineOf(save: SaveState) {
  return save.agents.find((a) => a.kind === "harvester")!;
}
function tractorOf(save: SaveState) {
  return save.agents.find((a) => a.kind === "tractor")!;
}
function unloadTaskFor(save: SaveState, harvesterId: string) {
  return save.tasks.find((t) => t.type === "unloadHarvester" && t.harvesterAgentId === harvesterId);
}

describe("harvester hopper + Grain Trailer hauling (maintainer request, 2026-07-12)", () => {
  it("banks into the combine's grainOnboard while cutting, not straight into save.grain", () => {
    const save = gameWithAgents();
    const field = readyField(10); // 10ac × 6t/ac = 60t potential — under way from full
    save.fields.push(field);
    enqueueTask(save, field, "harvest", APRIL_1);

    runUntil(save, APRIL_1, () => (combineOf(save).grainOnboard ?? 0) > 0, 500);
    expect(combineOf(save).grainOnboard).toBeGreaterThan(0);
    expect(save.grain.corn).toBe(0);
  });

  it("queues an Unload Harvester trip as soon as there's ANY grain onboard, not just once full (maintainer request, 2026-07-13)", () => {
    const save = gameWithAgents();
    const field = readyField(10); // 60t potential — well over the 50t hopper
    save.fields.push(field);
    enqueueTask(save, field, "harvest", APRIL_1);
    const cap = harvesterCapacityTons("medium");

    // Stop the instant the hopper has ANY grain at all — nowhere near full.
    // Fine step so we actually catch it early rather than overshooting to
    // capacity within one big tick.
    runUntil(save, APRIL_1, () => (combineOf(save).grainOnboard ?? 0) > 0, 500, 1);
    const onboard = combineOf(save).grainOnboard ?? 0;
    expect(onboard).toBeGreaterThan(0);
    expect(onboard).toBeLessThan(cap * 0.5); // nowhere close to full yet
    expect(unloadTaskFor(save, combineOf(save).id)).toBeDefined();
  });

  it("pauses at capacity (never exceeds it) and auto-queues an Unload Harvester task", () => {
    const save = gameWithAgents();
    const field = readyField(10); // 60t potential > 50t hopper — will fill
    save.fields.push(field);
    enqueueTask(save, field, "harvest", APRIL_1);
    const cap = harvesterCapacityTons("medium");

    runUntil(save, APRIL_1, () => (combineOf(save).grainOnboard ?? 0) >= cap - 1e-6, 5000);
    expect(combineOf(save).grainOnboard).toBeCloseTo(cap, 6);
    // Field isn't finished — plenty of acres left uncut.
    const task = save.tasks.find((t) => t.type === "harvest")!;
    expect(task.doneAcres).toBeLessThan(task.totalAcres);
    // No trailer owned yet, so it can't be relieved — hopper never overshoots.
    runUntil(save, APRIL_1, () => false, 2000);
    expect(combineOf(save).grainOnboard).toBeLessThanOrEqual(cap + 1e-6);
    expect(unloadTaskFor(save, combineOf(save).id)).toBeDefined();
  });

  it("the trailer STAGES at the field gate while the combine is still cutting, then moves in once it stops full (maintainer request, 2026-07-13)", () => {
    const save = gameWithAgents();
    // Big field + heavy yield: the 50t hopper fills long before the field ends.
    const field = readyField(40, 6);
    const side = Math.sqrt(40 * 4046.8564224);
    const gate: Meters = [side / 2, 0];
    field.accessPoints = [gate, [side / 2, side]];
    save.fields.push(field);
    buyImplement(save, "grainTrailer", "medium");
    const silo = buyBuildingAt(save, "silo", [-800, -800], "large");
    assignSiloCrop(save, silo.id, "corn");
    const combine = combineOf(save);
    const tractor = tractorOf(save);

    let now = APRIL_1;
    enqueueTask(save, field, "harvest", now);
    // Run until the trailer's trip exists and has parked (fine steps so we can
    // observe positions between phases).
    let stagedWhileCutting = false;
    let approachedWhileCutting = false;
    for (let i = 0; i < 400_000 && (combine.grainOnboard ?? 0) < harvesterCapacityTons("medium") - 1e-9; i++) {
      now += 1;
      tickFarming(save, now);
      tickTasks(save, now, 1, () => 0.5);
      const trip = unloadTaskFor(save, combine.id);
      if (!trip) continue;
      if (trip.unloadPhase === "staging" && samePos(tractor.pos, gate)) stagedWhileCutting = true;
      // "Approached" = tractor at the combine while it's still cutting UNDER capacity.
      if (samePos(tractor.pos, combine.pos) && (combine.grainOnboard ?? 0) < harvesterCapacityTons("medium") - 5) {
        approachedWhileCutting = true;
      }
    }
    expect(stagedWhileCutting).toBe(true); // parked at the gate during cutting
    expect(approachedWhileCutting).toBe(false); // never chased a moving combine
    // Hopper's full now — the trailer moves in and the cycle completes.
    now = runUntil(save, now, () => save.grain.corn > 0, 300_000, 5);
    expect(save.grain.corn).toBeGreaterThan(0);
  });

  it("the staging gate is LOCKED — the cart doesn't bounce between gates as the combine sweeps (maintainer report, 2026-07-13)", () => {
    const save = gameWithAgents();
    const field = readyField(40, 6);
    const side = Math.sqrt(40 * 4046.8564224);
    field.accessPoints = [[side / 2, 0], [side / 2, side]]; // south + north gates
    save.fields.push(field);
    buyImplement(save, "grainTrailer", "medium");
    const silo = buyBuildingAt(save, "silo", [-800, -800], "large");
    assignSiloCrop(save, silo.id, "corn");
    const combine = combineOf(save);
    const tractor = tractorOf(save);

    let now = APRIL_1;
    enqueueTask(save, field, "harvest", now);
    // Once the cart first parks at a gate, it must not move until the combine
    // is actually full — even as the combine's sweep flips which gate is nearer.
    let parkedAt: Meters | null = null;
    let moved = false;
    for (let i = 0; i < 400_000 && (combine.grainOnboard ?? 0) < harvesterCapacityTons("medium") - 1e-9; i++) {
      now += 1;
      tickFarming(save, now);
      tickTasks(save, now, 1, () => 0.5);
      const trip = unloadTaskFor(save, combine.id);
      if (trip?.unloadPhase !== "staging") continue;
      if (!parkedAt && tractor.state === "working") parkedAt = [tractor.pos[0], tractor.pos[1]];
      else if (parkedAt && !samePos(tractor.pos, parkedAt)) moved = true;
    }
    expect(parkedAt).not.toBeNull();
    expect(moved).toBe(false);
  });

  it("multi-load: a 100t cart drains the 50t combine, waits IN FIELD (in place, not at the gate), tops off, and dumps ~100t in one run", () => {
    const save = gameWithAgents(); // medium combine, 50t hopper
    const field = readyField(60, 6); // 360t total — several hopper fills
    const side = Math.sqrt(60 * 4046.8564224);
    const gates: Meters[] = [[side / 2, 0], [side / 2, side]];
    field.accessPoints = gates;
    save.fields.push(field);
    buyImplement(save, "grainTrailer", "large"); // 100t cart — 50t drain = 50% < 75%
    // A large tractor to pull the large cart (the starting medium can't).
    const hauler = buyAgent(save, "tractor", "large", [0, 0]);
    const silo = buyBuildingAt(save, "silo", [-800, -800], "large");
    assignSiloCrop(save, silo.id, "corn");
    const combine = combineOf(save);
    const tractor = hauler;

    let now = APRIL_1;
    enqueueTask(save, field, "harvest", now);
    // While the cart is staging WITH cargo (post-drain), it must be parked
    // where it drained the combine — never back at a gate.
    let waitedInPlaceWithCargo = false;
    let waitedAtGateWithCargo = false;
    while (save.grain.corn <= 0 && now < APRIL_1 + 400_000) {
      now += 1;
      tickFarming(save, now);
      tickTasks(save, now, 1, () => 0.5);
      const trip = unloadTaskFor(save, combine.id);
      const trailer = save.implements.find((i) => i.kind === "grainTrailer")!;
      if (trip?.unloadPhase === "staging" && (trailer.cargoTons ?? 0) > 1 && tractor.state === "working") {
        if (gates.some((g) => samePos(tractor.pos, g))) waitedAtGateWithCargo = true;
        else waitedInPlaceWithCargo = true;
      }
    }
    expect(waitedInPlaceWithCargo).toBe(true);
    expect(waitedAtGateWithCargo).toBe(false);
    // First silo delivery is a FULL cart (two 50t stops), not one drain's 50t.
    expect(save.grain.corn).toBeGreaterThan(95);
    expect(save.grain.corn).toBeLessThanOrEqual(100.5);
  });

  it("a cart ≥75% full after fully draining the combine makes a silo run instead of waiting in-field", () => {
    const save = gameWithAgents(); // medium combine, 50t hopper
    const field = readyField(40, 6);
    const side = Math.sqrt(40 * 4046.8564224);
    field.accessPoints = [[side / 2, 0], [side / 2, side]];
    save.fields.push(field);
    buyImplement(save, "grainTrailer", "medium"); // 60t: one 50t drain = 83% ≥ 75%
    const silo = buyBuildingAt(save, "silo", [-800, -800], "large");
    assignSiloCrop(save, silo.id, "corn");

    let now = APRIL_1;
    enqueueTask(save, field, "harvest", now);
    now = runUntil(save, now, () => save.grain.corn > 0, 400_000, 5);
    // Delivered the single 50t drain while the harvest was still running —
    // it did NOT sit in the field holding 83% of a cart.
    expect(save.grain.corn).toBeGreaterThan(45);
    expect(save.grain.corn).toBeLessThanOrEqual(50.5);
    expect(save.tasks.some((t) => t.type === "harvest")).toBe(true);
  });

  it("partial cart heads to the silo once the harvest is over and the combine is drained", () => {
    const save = gameWithAgents();
    // ~35t total: never fills the 50t hopper, so the ONLY stop is the end of
    // the field — and 35t is under 75% of the 60t cart, so no early silo run.
    const field = readyField(5.8, 6);
    const side = Math.sqrt(5.8 * 4046.8564224);
    field.accessPoints = [[side / 2, 0], [side / 2, side]];
    save.fields.push(field);
    buyImplement(save, "grainTrailer", "medium"); // 60t — never fills
    const silo = buyBuildingAt(save, "silo", [-800, -800], "large");
    assignSiloCrop(save, silo.id, "corn");

    let now = APRIL_1;
    enqueueTask(save, field, "harvest", now);
    // No mid-harvest silo run: grain stays at 0 until the harvest task is gone.
    while (save.tasks.some((t) => t.type === "harvest") && now < APRIL_1 + 400_000) {
      now += 5;
      tickFarming(save, now);
      tickTasks(save, now, 5, () => 0.5);
      expect(save.grain.corn).toBe(0);
    }
    // Then the whole crop arrives in one partial-cart delivery.
    const total = 5.8 * 6;
    now = runUntil(save, now, () => save.grain.corn > 0, 300_000, 5);
    expect(save.grain.corn).toBeGreaterThan(total * 0.95);
    expect(save.grain.corn).toBeLessThanOrEqual(total * 1.05);
  });

  it("a full haul cycle (toHarvester → onloading → toSilo → dumping) lands grain in the assigned silo's crop bin", () => {
    const save = gameWithAgents();
    const silo = buyBuildingAt(save, "silo", [-50, -50], "large");
    assignSiloCrop(save, silo.id, "corn");
    buyImplement(save, "grainTrailer", "medium"); // 60t — covers a 50t hopper in one trip
    const field = readyField(8, 6); // 48t potential — one fill, one clean haul
    save.fields.push(field);
    enqueueTask(save, field, "harvest", APRIL_1);

    const doneAt = runUntil(save, APRIL_1, () => field.status === "harvested", 50_000);
    runUntil(save, doneAt, () => save.grain.corn > 0, 5000);
    expect(save.grain.corn).toBeCloseTo(48, 0);
    expect(combineOf(save).grainOnboard ?? 0).toBeCloseTo(0, 6);
    const trailer = save.implements.find((i) => i.kind === "grainTrailer")!;
    expect(trailer.cargoTons ?? 0).toBe(0);
    expect(trailer.cargoCrop).toBeUndefined();
    expect(save.tasks.some((t) => t.type === "unloadHarvester")).toBe(false);
  });

  it("an undersized trailer only partially drains the hopper — a second trip follows automatically", () => {
    const save = gameWithAgents();
    const silo = buyBuildingAt(save, "silo", [-50, -50], "large");
    assignSiloCrop(save, silo.id, "corn");
    buyImplement(save, "grainTrailer", "small"); // 40t — can't empty a 50t-full hopper in one go
    const field = readyField(10, 6); // 60t potential, definitely fills the 50t hopper
    save.fields.push(field);
    enqueueTask(save, field, "harvest", APRIL_1);
    const cap = harvesterCapacityTons("medium");

    runUntil(save, APRIL_1, () => (combineOf(save).grainOnboard ?? 0) >= cap - 1e-6, 5000);
    // First trip: trailer (40t) takes what it can, not the full 50t hopper.
    runUntil(save, APRIL_1, () => save.grain.corn > 0, 5000);
    expect(save.grain.corn).toBeCloseTo(40, 0);
    // A fresh Unload Harvester task follows without any player action once
    // the hopper fills again — eventually the whole 60t potential lands.
    runUntil(save, APRIL_1, () => save.grain.corn >= 59, 10_000);
    expect(save.grain.corn).toBeCloseTo(60, 0);
  });

  it("no silo assigned to the crop → the trailer waits (⚠️) until one's assigned", () => {
    const save = gameWithAgents();
    buyImplement(save, "grainTrailer", "medium"); // no silo built/assigned at all
    const field = readyField(10, 6);
    save.fields.push(field);
    enqueueTask(save, field, "harvest", APRIL_1);
    const cap = harvesterCapacityTons("medium");

    runUntil(save, APRIL_1, () => (combineOf(save).grainOnboard ?? 0) >= cap - 1e-6, 5000);
    const now = runUntil(save, APRIL_1, () => !!unloadTaskFor(save, combineOf(save).id)?.waitingForSilo, 5000);
    expect(unloadTaskFor(save, combineOf(save).id)?.waitingForSilo).toBe(true);
    expect(save.grain.corn).toBe(0);

    // It stays stuck — this isn't a one-tick fluke.
    runUntil(save, now, () => false, 5000);
    expect(unloadTaskFor(save, combineOf(save).id)?.waitingForSilo).toBe(true);

    // Building/assigning a silo unsticks it without further player action.
    const silo = buyBuildingAt(save, "silo", [-50, -50], "large");
    assignSiloCrop(save, silo.id, "corn");
    runUntil(save, now, () => save.grain.corn > 0, 5000);
    expect(save.grain.corn).toBeGreaterThan(0);
  });

  it("a full-capacity silo → the trailer waits at it until sellGrain frees room", () => {
    const save = gameWithAgents();
    const silo = buyBuildingAt(save, "silo", [-50, -50], "small"); // 200t cap
    assignSiloCrop(save, silo.id, "corn");
    save.grain.corn = 200; // already at capacity
    buyImplement(save, "grainTrailer", "medium");
    // 8ac × 6t/ac = 48t — fits in one hopper load, so the field finishes
    // fully cut with nothing left to trigger a SECOND trip once this one
    // completes (keeps the "trip completed" assertion below unambiguous).
    const field = readyField(8, 6);
    save.fields.push(field);
    enqueueTask(save, field, "harvest", APRIL_1);

    runUntil(save, APRIL_1, () => (combineOf(save).grainOnboard ?? 0) >= 48 - 1e-6, 5000);
    const now = runUntil(save, APRIL_1, () => !!unloadTaskFor(save, combineOf(save).id)?.waitingForSilo, 5000);
    expect(unloadTaskFor(save, combineOf(save).id)?.waitingForSilo).toBe(true);
    expect(save.grain.corn).toBe(200); // untouched while waiting

    sellGrain(save, "corn", 200); // free up room
    runUntil(save, now, () => save.grain.corn > 0, 5000);
    expect(save.grain.corn).toBeGreaterThan(0);
    expect(unloadTaskFor(save, combineOf(save).id)).toBeUndefined(); // trip completed
  });

  it("sellAgent refuses to sell a harvester that still has grain onboard", () => {
    const save = gameWithAgents();
    const combine = combineOf(save);
    combine.grainOnboard = 12;
    expect(() => sellAgent(save, combine.id)).toThrow(/grain onboard/);
  });

  it("a full harvester doesn't home — it stays put even with a Farm Yard built", () => {
    const save = gameWithAgents();
    buyBuildingAt(save, "farmYard", [-1000, -1000]);
    const field = readyField(10, 6);
    save.fields.push(field);
    enqueueTask(save, field, "harvest", APRIL_1);
    const cap = harvesterCapacityTons("medium");

    runUntil(save, APRIL_1, () => (combineOf(save).grainOnboard ?? 0) >= cap - 1e-6, 5000);
    const posAtFull: Meters = [...combineOf(save).pos];
    runUntil(save, APRIL_1, () => false, 5000);
    expect(combineOf(save).pos).toEqual(posAtFull);
  });

  it("picking up an Unload Harvester task auto-hitches a Grain Trailer, same as a plow", () => {
    const save = gameWithAgents();
    const silo = buyBuildingAt(save, "silo", [-50, -50], "large");
    assignSiloCrop(save, silo.id, "corn");
    buyImplement(save, "grainTrailer", "medium");
    const field = readyField(10, 6);
    save.fields.push(field);
    enqueueTask(save, field, "harvest", APRIL_1);
    const cap = harvesterCapacityTons("medium");

    runUntil(save, APRIL_1, () => (combineOf(save).grainOnboard ?? 0) >= cap - 1e-6, 5000);
    runUntil(save, APRIL_1, () => tractorOf(save).taskId !== undefined, 5000);
    const trailer = save.implements.find((i) => i.kind === "grainTrailer")!;
    expect(trailer.attachedTo).toBe(tractorOf(save).id);
  });

  it("a full silo + a Sell Point → the cart diverts and sells its load instead of stalling (2026-07-20)", () => {
    const save = gameWithAgents();
    const silo = buyBuildingAt(save, "silo", [-50, -50], "small"); // 200t cap
    assignSiloCrop(save, silo.id, "corn");
    save.grain.corn = 199; // 1t of room — fills mid-dump, forcing the divert
    buyBuildingAt(save, "sellPoint", [-60, -60]);
    buyImplement(save, "grainTrailer", "medium");
    const field = readyField(8, 6); // 48t — one hopper load
    save.fields.push(field);
    enqueueTask(save, field, "harvest", APRIL_1);
    const startMoney = save.money;

    // The cart delivers what fits (fills the silo to 200), then diverts the rest
    // to the Sell Point and completes — never gets stuck waitingForSilo.
    runUntil(save, APRIL_1, () => !save.tasks.some((t) => t.type === "unloadHarvester") && field.status === "harvested", 300_000, 5);
    expect(save.grain.corn).toBe(200); // silo topped off
    expect(save.money).toBeGreaterThan(startMoney); // the rest was sold for cash
    const sale = save.completedTasks?.find((t) => t.type === "sellGrain");
    expect(sale?.crop).toBe("corn");
    expect((sale?.tons ?? 0)).toBeGreaterThan(40); // ~47t diverted to the Sell Point
    // Cart released, empty.
    expect(save.implements.find((i) => i.kind === "grainTrailer")?.cargoTons ?? 0).toBe(0);
  });

  it("proactively pulls a free tractor onto a waiting combine ahead of queued field work (2026-07-20)", () => {
    const save = gameWithAgents(); // 1 tractor (+plow) + combine
    const silo = buyBuildingAt(save, "silo", [-50, -50], "large");
    assignSiloCrop(save, silo.id, "corn");
    buyImplement(save, "grainTrailer", "medium"); // a loose cart the tractor can hitch
    const harvestField = readyField(10, 6);
    save.fields.push(harvestField);
    // A SEPARATE bare field with a plow queued FIRST — field work the lone
    // tractor could otherwise wander off to do while the combine cuts.
    const plowSide = Math.sqrt(10 * 4046.8564224);
    const plowField: Field = { id: "field-2", parcelId: "p2", boundary: [[5000, 0], [5000 + plowSide, 0], [5000 + plowSide, plowSide], [5000, plowSide]], status: "mulched" };
    save.fields.push(plowField);
    enqueueTask(save, plowField, "plow", APRIL_1);
    enqueueTask(save, harvestField, "harvest", APRIL_1);

    // The tractor is reserved for / crewed onto the combine's unload the whole
    // time it's cutting — the plow stays queued until the harvest's done.
    let plowStartedDuringHarvest = false;
    runUntil(save, APRIL_1, () => {
      const harvesting = save.tasks.some((t) => t.type === "harvest");
      const plow = save.tasks.find((t) => t.type === "plow");
      if (harvesting && plow?.status === "active") plowStartedDuringHarvest = true;
      return save.grain.corn > 0; // stop once the combine's grain has been delivered
    }, 60_000, 5);

    expect(save.grain.corn).toBeGreaterThan(0); // the combine got serviced
    expect(plowStartedDuringHarvest).toBe(false); // …and the plow waited its turn
  });
});

describe("self-healing: an idle harvester with leftover grain but no trip coming (maintainer request, 2026-07-13)", () => {
  it("keeps looking every tick — once a silo/trailer exist, it dispatches without any new harvest work", () => {
    const save = gameWithAgents();
    const combine = combineOf(save);
    // Simulate a field that finished harvesting back when no silo existed —
    // grain stuck onboard, and (as of this fix) the field/crop remembered.
    combine.grainOnboard = 22;
    combine.lastFieldId = "field-1";
    combine.lastCrop = "corn";
    combine.state = "idle";
    expect(unloadTaskFor(save, combine.id)).toBeUndefined(); // nothing coming yet

    // NOW the player builds a silo and buys a trailer.
    const silo = buyBuildingAt(save, "silo", [-50, -50], "large");
    assignSiloCrop(save, silo.id, "corn");
    buyImplement(save, "grainTrailer", "medium");

    runUntil(save, APRIL_1, () => save.grain.corn > 0, 5000);
    expect(save.grain.corn).toBeCloseTo(22, 0);
    expect(combine.grainOnboard ?? 0).toBeCloseTo(0, 6);
  });

  it("legacy save with no lastCrop tracked: guesses the crop when exactly one silo is assigned", () => {
    const save = gameWithAgents();
    const combine = combineOf(save);
    combine.grainOnboard = 15; // lastFieldId/lastCrop deliberately left unset
    combine.state = "idle";

    const silo = buyBuildingAt(save, "silo", [-50, -50], "large");
    assignSiloCrop(save, silo.id, "corn"); // the ONLY crop with a silo
    buyImplement(save, "grainTrailer", "medium");

    runUntil(save, APRIL_1, () => save.grain.corn > 0, 5000);
    expect(save.grain.corn).toBeCloseTo(15, 0);
  });

  it("legacy save with an AMBIGUOUS crop (two silos, two crops) doesn't guess wrong — stays put", () => {
    const save = gameWithAgents();
    const combine = combineOf(save);
    combine.grainOnboard = 15; // lastFieldId/lastCrop deliberately left unset

    const cornSilo = buyBuildingAt(save, "silo", [-50, -50], "large");
    assignSiloCrop(save, cornSilo.id, "corn");
    const soySilo = buyBuildingAt(save, "silo", [-50, -60], "large");
    assignSiloCrop(save, soySilo.id, "soybeans");
    buyImplement(save, "grainTrailer", "medium");

    runUntil(save, APRIL_1, () => false, 5000);
    expect(unloadTaskFor(save, combine.id)).toBeUndefined();
    expect(combine.grainOnboard).toBe(15); // untouched, not silently dropped either

    // Manual escape hatch: the player tells it what's onboard.
    setHarvesterCrop(save, combine.id, "corn");
    runUntil(save, APRIL_1, () => save.grain.corn > 0, 5000);
    expect(save.grain.corn).toBeCloseTo(15, 0);
  });

  it("setHarvesterCrop refuses an empty hopper or a non-harvester", () => {
    const save = gameWithAgents();
    const combine = combineOf(save);
    expect(() => setHarvesterCrop(save, combine.id, "corn")).toThrow(/no grain onboard/);
    combine.grainOnboard = 5;
    const tractor = save.agents.find((a) => a.kind === "tractor")!;
    expect(() => setHarvesterCrop(save, tractor.id, "corn")).toThrow(/no such combine/i);
  });

  it("a tail load left when the field finishes still gets fully delivered — no grain lost in transit", () => {
    // Silo + SMALL trailer set up BEFORE harvesting even starts, like a
    // normal playthrough — not recovered after the fact.
    const save = gameWithAgents();
    const silo = buyBuildingAt(save, "silo", [-50, -50], "large");
    assignSiloCrop(save, silo.id, "corn");
    buyImplement(save, "grainTrailer", "small"); // 40t — can't empty a 50t hopper in one go
    // 9ac × 6t/ac = 54t total.
    const field = readyField(9, 6);
    save.fields.push(field);
    enqueueTask(save, field, "harvest", APRIL_1);

    const doneAt = runUntil(save, APRIL_1, () => field.status === "harvested", 20_000, 1);
    expect(combineOf(save).lastCrop).toBe("corn");
    // Wait for EVERYTHING to actually land: hopper empty, trailer empty, no
    // trip still in flight — not just "hopper reads 0" (a still-loaded
    // trailer clears the hopper a tick or two before it finishes delivering).
    const trailer = save.implements.find((i) => i.kind === "grainTrailer")!;
    runUntil(
      save, doneAt,
      () => (combineOf(save).grainOnboard ?? 0) < 1e-6 && (trailer.cargoTons ?? 0) < 1e-6 && !unloadTaskFor(save, combineOf(save).id),
      40_000, 1,
    );
    expect(save.grain.corn).toBeCloseTo(54, 0); // every ton accounted for
    expect(combineOf(save).grainOnboard ?? 0).toBeCloseTo(0, 6);
  });
});
