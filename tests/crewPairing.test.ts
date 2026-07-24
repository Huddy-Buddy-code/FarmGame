/**
 * Crews spread across the fleet before they deepen on one job (maintainer
 * requests, 2026-07-24):
 *
 *   "Multi Grain Carts per task: Make sure each harvest has at least one
 *    trailer assigned before adding multiple"
 *   "Make sure a bale trailer hauling task is prioritized over an additional
 *    Hay Spike task. Look to pair hay spike and trailer first, if that is
 *    satisfied, then start another hay spike task"
 *
 * Both crew-growth rules previously only looked at the ONE job they were
 * growing, so a spare tractor went to whichever job asked first. A second cart
 * alongside a combine that already has one is worth far less than the first
 * cart alongside a combine that has none — and a Bale Trailer paired with the
 * hay-spikes rig already in the field beats a second spikes tractor, because
 * the trailer is what stops the first one shuttling to storage one bale at a
 * time.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { setProjection } from "../src/geo/coords";
import type { Meters } from "../src/geo/coords";
import { newGame } from "../src/state/saveState";
import type { Field, SaveState } from "../src/state/saveState";
import { tickFarming } from "../src/sim/farming";
import { buyAgent, buyImplement, enqueueTask, tickTasks, queueHaulBales } from "../src/sim/tasks";
import { buyBuildingAt, assignSiloCrop } from "../src/sim/buildings";
import { minutesPerMonth } from "../src/sim/calendar";
import { gameConfig } from "../src/config/gameConfig";

beforeAll(() => setProjection(15, "N"));

const side = Math.sqrt(100 * 4046.8564224); // 100 acres
const boundary: Meters[] = [[0, 0], [side, 0], [side, side], [0, side]];
const APRIL_1 = minutesPerMonth();

function run(save: SaveState, from: number, done: () => boolean, cap = 200_000, step = 60): void {
  let now = from;
  while (!done() && now - from < cap) {
    now += step;
    tickFarming(save, now);
    tickTasks(save, now, step, () => 0.5);
  }
}

function readyCornField(id: string, offset: number): Field {
  return {
    id, parcelId: "p",
    boundary: boundary.map(([x, y]) => [x + offset, y] as Meters),
    status: "ready", crop: "corn", trueYieldTonsPerAcre: 6,
    plantedAt: APRIL_1 - gameConfig.crops.corn.growMonths * minutesPerMonth(),
  };
}

describe("every combine gets a cart before any combine gets a second", () => {
  /**
   * Two combines, both sitting on grain. The first already has a cart; the
   * second has none. Exactly one spare cart-capable tractor is free.
   *
   * Built by hand rather than run out of a live harvest, because who asks
   * first is a matter of drive distances and tick boundaries — the RULE is
   * what's being pinned, not one emergent ordering. (In a live two-field
   * harvest the starvation is easy to see: the near combine reaches two crewed
   * carts while the far one sits with a full tank and none.)
   */
  function twoLoadedCombines(): SaveState {
    const save = newGame();
    save.money = 20_000_000;
    const silo = buyBuildingAt(save, "silo", [-400, -400], "large");
    assignSiloCrop(save, silo.id, "corn");
    const field = readyCornField("field-1", 0);
    save.fields.push(field);

    const first = buyAgent(save, "harvester", "medium", [0, 0]);
    const second = buyAgent(save, "harvester", "medium", [0, 0]);
    for (const c of [first, second]) {
      c.grainOnboard = 20;
      c.lastFieldId = field.id;
      c.lastCrop = "corn";
    }
    // T1 is already committed to the first combine's trip; T2 is the one free
    // rig everything below is competing for.
    const t1 = buyAgent(save, "tractor", "medium", [0, 0]);
    buyAgent(save, "tractor", "medium", [0, 0]);
    buyImplement(save, "grainTrailer", "medium").attachedTo = t1.id;
    buyImplement(save, "grainTrailer", "medium");
    save.tasks.push({
      id: "trip-1", type: "unloadHarvester", fieldId: field.id, crop: "corn",
      totalAcres: 1, doneAcres: 0, status: "active", costPaid: 0,
      harvesterAgentId: first.id, agentId: t1.id, unloadPhase: "toHarvester",
    });
    t1.taskId = "trip-1";
    t1.state = "traveling";
    return save;
  }

  it("the spare cart goes to the un-serviced combine, not to a second trip", () => {
    const save = twoLoadedCombines();
    const [first, second] = save.agents.filter((a) => a.kind === "harvester");
    // A TINY tick. The moment being observed is crew growth, and a cart can be
    // dispatched, complete a round trip and retire its task inside a single
    // 60-minute tick — which puts the board back to looking correct and hides
    // the misallocation entirely.
    tickTasks(save, APRIL_1, 0.01, () => 0.5);

    const trips = (id: string) => save.tasks.filter((t) => t.type === "unloadHarvester" && t.harvesterAgentId === id);
    expect(trips(second!.id).length, "the starved combine gets a trip").toBe(1);
    expect(trips(first!.id).length, "the already-served combine must not double up").toBe(1);
  });

  it("two simultaneous harvests both get served to completion", () => {
    // End-to-end cover for the same rule. The near field's combine used to
    // take the whole crew cap while the far one stood loaded and idle; with
    // carts spread across the fleet, both fields come off.
    //
    // (Deliberately NOT asserting a per-tick invariant like "no combine ever
    // has zero trips while another has two" — a trip is created, crewed and
    // retired inside a single tick, so sampling at tick boundaries measures
    // scheduling artifacts rather than the rule.)
    const save = newGame();
    save.money = 20_000_000;
    const silo = buyBuildingAt(save, "silo", [-400, -400], "large");
    assignSiloCrop(save, silo.id, "corn");
    buyAgent(save, "harvester", "medium", [0, 0]);
    buyAgent(save, "harvester", "medium", [0, 0]);
    // A combine can't cut without a header (2026-07-24) — one each.
    buyImplement(save, "cornHeader", "medium");
    buyImplement(save, "cornHeader", "medium");
    for (let i = 0; i < gameConfig.hauling.maxCrewSize + 1; i++) {
      buyAgent(save, "tractor", "medium", [0, 0]);
      buyImplement(save, "grainTrailer", "medium");
    }
    const a = readyCornField("field-1", 0);
    const b = readyCornField("field-2", side * 25); // a long drive away
    save.fields.push(a, b);
    enqueueTask(save, a, "harvest", APRIL_1);
    enqueueTask(save, b, "harvest", APRIL_1);

    run(save, APRIL_1, () => a.status === "harvested" && b.status === "harvested", 400_000);

    expect(a.status, "near field").toBe("harvested");
    expect(b.status, "far field").toBe("harvested");
  });

  it("still doubles up when there IS only one combine to serve", () => {
    // The rule must not stop a lone combine building a full crew.
    const save = newGame();
    save.money = 20_000_000;
    const silo = buyBuildingAt(save, "silo", [-400, -400], "large");
    assignSiloCrop(save, silo.id, "corn");
    buyAgent(save, "harvester", "medium", [0, 0]);
    buyImplement(save, "cornHeader", "medium");
    for (let i = 0; i < 4; i++) {
      buyAgent(save, "tractor", "medium", [0, 0]);
      buyImplement(save, "grainTrailer", "medium");
    }
    const field = readyCornField("field-1", 0);
    save.fields.push(field);
    enqueueTask(save, field, "harvest", APRIL_1);

    let peak = 0;
    run(save, APRIL_1, () => {
      peak = Math.max(peak, save.tasks.filter((t) => t.type === "unloadHarvester").length);
      return peak >= 2;
    }, 120_000);
    expect(peak).toBeGreaterThan(1);
  });
});

describe("a bale trailer joins the rig in the field before a second one goes out", () => {
  /** A field full of bales, one hay-spikes rig already hauling, and one spare
   * tractor that could take EITHER a Bale Trailer or a second set of spikes. */
  function baleField(): { save: SaveState; field: Field } {
    const save = newGame();
    save.money = 20_000_000;
    buyBuildingAt(save, "baleArea", [-400, -400]);
    const field: Field = {
      id: "field-1", parcelId: "p", boundary, status: "mulched", baleProduct: "straw",
      baleLocations: Array.from({ length: 30 }, (_, i) => [i * 10, i * 10] as Meters),
    };
    save.fields.push(field);
    return { save, field };
  }

  it("declines a second haul task while the first has no trailer and one could join", () => {
    const { save, field } = baleField();
    buyAgent(save, "tractor", "medium", [0, 0]);
    buyAgent(save, "tractor", "medium", [0, 0]);
    buyImplement(save, "haySpikes", "medium");
    buyImplement(save, "haySpikes", "medium");
    buyImplement(save, "baleTrailer", "medium"); // the spare rig's better job

    const first = queueHaulBales(save, field.id)!;
    expect(first).toBeTruthy();
    first.agentId = save.agents[0]!.id; // crewed, but no trailer paired yet

    // The spare tractor's time is better spent on the trailer half of the
    // relay than on a second collector.
    expect(queueHaulBales(save, field.id)).toBeUndefined();
  });

  it("allows a second haul task once the first is fully paired", () => {
    const { save, field } = baleField();
    for (let i = 0; i < 3; i++) buyAgent(save, "tractor", "medium", [0, 0]);
    buyImplement(save, "haySpikes", "medium");
    buyImplement(save, "haySpikes", "medium");
    buyImplement(save, "baleTrailer", "medium");

    const first = queueHaulBales(save, field.id)!;
    first.agentId = save.agents[0]!.id;
    first.trailerAgentId = save.agents[1]!.id; // spikes + trailer, a complete relay
    expect(queueHaulBales(save, field.id)).toBeTruthy();
  });

  it("allows a second haul task when the farm owns no bale trailer at all", () => {
    // Nothing to pair with — waiting for a trailer that will never come would
    // just stall the field.
    const { save, field } = baleField();
    for (let i = 0; i < 3; i++) buyAgent(save, "tractor", "medium", [0, 0]);
    buyImplement(save, "haySpikes", "medium");
    buyImplement(save, "haySpikes", "medium");

    const first = queueHaulBales(save, field.id)!;
    first.agentId = save.agents[0]!.id;
    expect(queueHaulBales(save, field.id)).toBeTruthy();
  });
});
