import { describe, it, expect, beforeAll } from "vitest";
import { setProjection } from "../src/geo/coords";
import type { Meters } from "../src/geo/coords";
import { newGame } from "../src/state/saveState";
import type { Field, SaveState } from "../src/state/saveState";
import type { BaleProduct } from "../src/config/gameConfig";
import {
  ensureAgents, tickTasks, enqueueTask, buyImplement, buyAgent,
  queueHaulBales, fieldHasLooseBales,
} from "../src/sim/tasks";
import { tickFarming } from "../src/sim/farming";
import { pointInPolygon } from "../src/geo/geometry";
import { buyBuildingAt, storedBalesTotal, assignBaleStorageProduct } from "../src/sim/buildings";
import { gameConfig } from "../src/config/gameConfig";
import { minutesPerMonth } from "../src/sim/calendar";

beforeAll(() => setProjection(15, "N"));

const APRIL_1 = minutesPerMonth();
const BARN_CAP = gameConfig.buildings.baleBarn.capacityBales;

function gameForHaul(): SaveState {
  const save = newGame();
  ensureAgents(save, [0, 0]); // medium tractor (+ plow) + medium combine
  return save;
}

/** A mulched field carrying `n` loose bales of `product`, with two gates. */
function baledField(save: SaveState, n: number, product: BaleProduct = "hay"): Field {
  const s = Math.sqrt(20 * 4046.8564224);
  const boundary: Meters[] = [[0, 0], [s, 0], [s, s], [0, s]];
  const baleLocations: Meters[] = [];
  for (let i = 0; i < n; i++) {
    baleLocations.push([s * 0.3 + (i % 4) * s * 0.1, s * 0.3 + Math.floor(i / 4) * s * 0.1]);
  }
  const field: Field = {
    id: "field-1", parcelId: "parcel-1", boundary,
    status: "mulched", baleProduct: product, baleLocations,
    accessPoints: [[s / 2, 0], [s / 2, s]],
  };
  save.fields.push(field);
  return field;
}

/** Tick only the task sim forward until `done()` (or a cap). */
function runTasks(save: SaveState, from: number, done: () => boolean, cap = 400_000, step = 30): number {
  let now = from;
  while (!done() && now - from < cap) {
    now += step;
    tickTasks(save, now, step, () => 0.5);
  }
  return now;
}

const noHaulLeft = (save: SaveState, field: Field) => () =>
  (field.baleLocations?.length ?? 0) === 0 && !save.tasks.some((t) => t.type === "haulBales");

describe("Bale hauling relay (maintainer request, 2026-07-17)", () => {
  it("direct haul: a lone Hay-Spikes tractor moves loose bales into storage, 1 load at a time", () => {
    const save = gameForHaul();
    buyImplement(save, "haySpikes", "small"); // 1 bale capacity
    const area = buyBuildingAt(save, "baleArea", [-300, -300]);
    const field = baledField(save, 3, "hay");

    expect(queueHaulBales(save, field.id)).toBeDefined();
    runTasks(save, APRIL_1, noHaulLeft(save, field));

    expect(field.baleLocations?.length ?? 0).toBe(0);
    expect(storedBalesTotal(area)).toBe(3);
    expect(area.storedBales?.hay).toBe(3);
  });

  it("auto-hitches the Hay Spikes onto the tractor (swapping off its plow)", () => {
    const save = gameForHaul();
    const spikes = buyImplement(save, "haySpikes", "small");
    buyBuildingAt(save, "baleArea", [-300, -300]);
    const field = baledField(save, 1, "hay");
    queueHaulBales(save, field.id);
    runTasks(save, APRIL_1, () => (spikes.cargoBales ?? 0) > 0 || (field.baleLocations?.length ?? 0) === 0);
    // At some point the spikes were hitched to the (only) tractor.
    const tractor = save.agents.find((a) => a.kind === "tractor")!;
    runTasks(save, APRIL_1, noHaulLeft(save, field));
    expect(save.buildings.some((b) => storedBalesTotal(b) === 1)).toBe(true);
    expect(spikes.attachedTo).toBe(tractor.id);
  });

  it("trailer relay (re-enabled 2026-07-20): an idle tractor+Bale Trailer is auto-recruited, the trailer carries the load, and the whole field is delivered", () => {
    const save = gameForHaul();
    buyImplement(save, "haySpikes", "small"); // 1 bale per shuttle
    buyImplement(save, "baleTrailer", "small"); // 10 bales — the relay hauler
    buyAgent(save, "tractor", "medium", [0, 0]); // idle spare to pull the trailer
    const area = buyBuildingAt(save, "baleArea", [-500, -500]);
    const field = baledField(save, 12, "hay");

    const task = queueHaulBales(save, field.id)!;
    let recruitedTrailer = false;
    let trailerCarried = false;
    runTasks(save, APRIL_1, () => {
      if (task.trailerAgentId) recruitedTrailer = true;
      const trailer = save.implements.find((i) => i.kind === "baleTrailer");
      if ((trailer?.cargoBales ?? 0) > 0) trailerCarried = true;
      return noHaulLeft(save, field)();
    });

    expect(recruitedTrailer).toBe(true); // the spare tractor was pulled in
    expect(trailerCarried).toBe(true); // the trailer actually hauled bales
    expect(storedBalesTotal(area)).toBe(12); // whole field delivered
    expect(save.agents.every((a) => a.taskId === undefined)).toBe(true); // both released
    expect(save.implements.find((i) => i.kind === "baleTrailer")?.cargoBales ?? 0).toBe(0);
    expect(save.implements.find((i) => i.kind === "haySpikes")?.cargoBales ?? 0).toBe(0);
  });

  it("the trailer parks at a bale INSIDE the field (not the edge gate) while waiting to load", () => {
    const save = gameForHaul();
    buyImplement(save, "haySpikes", "small");
    buyImplement(save, "baleTrailer", "medium"); // 20 cap — one trip, so it waits in-field a while
    buyAgent(save, "tractor", "medium", [0, 0]);
    buyBuildingAt(save, "baleArea", [-500, -500]);
    const field = baledField(save, 8, "hay");
    const task = queueHaulBales(save, field.id)!;

    // Sample finely; whenever the trailer is parked ("waiting"), it should be
    // INSIDE the field boundary — i.e. sitting at a bale — not out on an edge
    // gate (baledField's gates are on the boundary at [s/2,0] and [s/2,s]).
    let sawWaitingInField = false;
    runTasks(save, APRIL_1, () => {
      if (task.trailerPhase === "waiting" && task.trailerAgentId) {
        const t = save.agents.find((a) => a.id === task.trailerAgentId)!;
        if (pointInPolygon(t.pos, field.boundary)) sawWaitingInField = true;
      }
      return noHaulLeft(save, field)();
    }, 400_000, 0.1);

    expect(sawWaitingInField).toBe(true);
  });

  it("a trailer that frees up mid-job is pulled in for the rest of the haul", () => {
    const save = gameForHaul();
    buyImplement(save, "haySpikes", "small");
    const area = buyBuildingAt(save, "baleArea", [-500, -500]);
    const field = baledField(save, 12, "hay");
    const task = queueHaulBales(save, field.id)!;

    // Run with NO trailer available — the collector hauls direct for a while.
    const t1 = runTasks(save, APRIL_1, () => (field.baleLocations?.length ?? 0) <= 8, 200_000);
    expect(task.trailerAgentId).toBeUndefined(); // nothing to recruit yet
    expect(storedBalesTotal(area)).toBeGreaterThan(0); // some delivered direct

    // A tractor + Bale Trailer now become available mid-job.
    buyAgent(save, "tractor", "medium", [0, 0]);
    buyImplement(save, "baleTrailer", "small");

    // Step finely here: load/dump are ~10 s each, so a whole relay run would
    // otherwise complete inside a single coarse 30-min tick and we'd never
    // sample the trailer mid-haul.
    let trailerCarried = false;
    runTasks(save, t1, () => {
      const tr = save.implements.find((i) => i.kind === "baleTrailer");
      if ((tr?.cargoBales ?? 0) > 0) trailerCarried = true;
      return noHaulLeft(save, field)();
    }, 400_000, 0.1);

    expect(task.trailerAgentId).toBeDefined(); // joined the job mid-way
    expect(trailerCarried).toBe(true); // and actually hauled the rest itself
    expect(storedBalesTotal(area)).toBe(12); // whole field delivered
    expect(save.agents.every((a) => a.taskId === undefined)).toBe(true);
  });

  it("no spare tractor → the relay never engages and the Hay-Spikes tractor hauls direct", () => {
    const save = gameForHaul();
    buyImplement(save, "haySpikes", "small");
    buyImplement(save, "baleTrailer", "small"); // present, but no idle tractor to pull it
    const area = buyBuildingAt(save, "baleArea", [-500, -500]);
    const field = baledField(save, 4, "hay");

    const task = queueHaulBales(save, field.id)!;
    runTasks(save, APRIL_1, noHaulLeft(save, field));

    expect(task.trailerAgentId).toBeUndefined(); // nobody free to haul
    expect(storedBalesTotal(area)).toBe(4); // delivered direct anyway
  });

  it("a full Bale Barn blocks (waitingForStorage) until room is freed", () => {
    const save = gameForHaul();
    buyImplement(save, "haySpikes", "small");
    const barn = buyBuildingAt(save, "baleBarn", [-300, -300]);
    barn.storedBales = { hay: BARN_CAP - 1 }; // one slot left
    const field = baledField(save, 4, "hay");
    queueHaulBales(save, field.id);

    // Delivers 1 (fills the barn), then jams with nowhere to put the rest.
    const now = runTasks(save, APRIL_1, () => !!save.tasks.find((t) => t.type === "haulBales")?.waitingForStorage, 200_000);
    expect(save.tasks.find((t) => t.type === "haulBales")?.waitingForStorage).toBe(true);
    expect(storedBalesTotal(barn)).toBe(BARN_CAP);
    expect(field.baleLocations!.length).toBeGreaterThan(0); // bales still stranded

    // An unlimited outdoor Area unsticks it — the rest flow there.
    const area = buyBuildingAt(save, "baleArea", [-320, -320]);
    runTasks(save, now, noHaulLeft(save, field));
    expect(field.baleLocations?.length ?? 0).toBe(0);
    expect(storedBalesTotal(barn) + storedBalesTotal(area)).toBe(BARN_CAP - 1 + 4);
    expect(storedBalesTotal(area)).toBe(3); // the barn only took 1
  });

  it("an assigned store only accepts its product; an unassigned one takes the rest", () => {
    const save = gameForHaul();
    buyImplement(save, "haySpikes", "small");
    const alfalfaArea = buyBuildingAt(save, "baleArea", [-100, -100]);
    assignBaleStorageProduct(save, alfalfaArea.id, "alfalfaHay");
    const anyArea = buyBuildingAt(save, "baleArea", [-120, -120]);
    const field = baledField(save, 3, "hay");
    queueHaulBales(save, field.id);

    runTasks(save, APRIL_1, noHaulLeft(save, field));
    expect(alfalfaArea.storedBales?.hay ?? 0).toBe(0); // wrong product — refused
    expect(anyArea.storedBales?.hay ?? 0).toBe(3);
  });

  it("no bale storage at all → the haul waits (⚠️), then completes once a store is built", () => {
    const save = gameForHaul();
    buyImplement(save, "haySpikes", "small");
    const field = baledField(save, 2, "hay");
    queueHaulBales(save, field.id);

    const now = runTasks(save, APRIL_1, () => !!save.tasks.find((t) => t.type === "haulBales")?.waitingForStorage, 100_000);
    expect(save.tasks.find((t) => t.type === "haulBales")?.waitingForStorage).toBe(true);

    const area = buyBuildingAt(save, "baleArea", [-200, -200]);
    runTasks(save, now, noHaulLeft(save, field));
    expect(storedBalesTotal(area)).toBe(2);
  });

  it("Sell Point (maintainer request, 2026-07-17): storage preferred, sold on the spot when none exists", () => {
    const save = gameForHaul();
    buyImplement(save, "haySpikes", "small");
    buyBuildingAt(save, "sellPoint", [-200, -200]); // no storage anywhere
    const field = baledField(save, 3, "hay");
    const startMoney = save.money;

    queueHaulBales(save, field.id);
    runTasks(save, APRIL_1, noHaulLeft(save, field));

    const expectedRevenue = 3 * gameConfig.baleProducts.hay.pricePerBale;
    expect(save.money).toBeCloseTo(startMoney + expectedRevenue, 0);
    // Nothing "stored" anywhere — it was sold, not stashed.
    expect(save.buildings.every((b) => storedBalesTotal(b) === 0)).toBe(true);
    // Never blocked — a Sell Point always has "room".
    expect(save.tasks.find((t) => t.type === "haulBales")?.waitingForStorage).toBeFalsy();
  });

  it("Sell Point is a fallback, not a preference — storage wins when both exist", () => {
    const save = gameForHaul();
    buyImplement(save, "haySpikes", "small");
    const area = buyBuildingAt(save, "baleArea", [-100, -100]);
    buyBuildingAt(save, "sellPoint", [-100, -100]);
    const field = baledField(save, 3, "hay");
    const startMoney = save.money;

    queueHaulBales(save, field.id);
    runTasks(save, APRIL_1, noHaulLeft(save, field));

    expect(storedBalesTotal(area)).toBe(3); // went to storage
    expect(save.money).toBe(startMoney); // nothing sold
  });

  it("a full Bale Barn with a Sell Point built: overflow sells instead of jamming", () => {
    const save = gameForHaul();
    buyImplement(save, "haySpikes", "small");
    const barn = buyBuildingAt(save, "baleBarn", [-300, -300]);
    barn.storedBales = { hay: BARN_CAP - 1 }; // one slot left
    buyBuildingAt(save, "sellPoint", [-320, -320]);
    const field = baledField(save, 4, "hay");
    const startMoney = save.money;

    queueHaulBales(save, field.id);
    runTasks(save, APRIL_1, noHaulLeft(save, field));

    expect(storedBalesTotal(barn)).toBe(BARN_CAP); // took what it could
    const sold = 3; // the rest (4 - 1)
    expect(save.money).toBeCloseTo(startMoney + sold * gameConfig.baleProducts.hay.pricePerBale, 0);
    expect(save.tasks.find((t) => t.type === "haulBales")?.waitingForStorage).toBeFalsy();
  });

  it("a partial unload (storage fills mid-dump) reroutes the rest of that same load to the Sell Point", () => {
    const save = gameForHaul();
    buyImplement(save, "haySpikes", "medium"); // carries 2 bales per trip
    const barn = buyBuildingAt(save, "baleBarn", [-300, -300]);
    barn.storedBales = { hay: BARN_CAP - 1 }; // room for exactly 1 more
    buyBuildingAt(save, "sellPoint", [-320, -320]);
    const field = baledField(save, 2, "hay");
    const startMoney = save.money;

    queueHaulBales(save, field.id);
    runTasks(save, APRIL_1, noHaulLeft(save, field));

    // The barn took the 1 it had room for; the other bale from the SAME
    // load was rerouted to the Sell Point instead of stalling forever.
    expect(storedBalesTotal(barn)).toBe(BARN_CAP);
    expect(save.money).toBeCloseTo(startMoney + gameConfig.baleProducts.hay.pricePerBale, 0);
    const task = save.tasks.find((t) => t.type === "haulBales");
    expect(task?.waitingForStorage).toBeFalsy();
  });

  it("queueHaulBales / fieldHasLooseBales: no double-dispatch, and none when the field is empty", () => {
    const save = gameForHaul();
    buyImplement(save, "haySpikes", "small");
    buyBuildingAt(save, "baleArea", [-300, -300]);
    const field = baledField(save, 2, "hay");

    expect(fieldHasLooseBales(save, field.id)).toBe(true);
    expect(queueHaulBales(save, field.id)).toBeDefined();
    // A haul already covers it — no second one, and the button-gate reports false.
    expect(fieldHasLooseBales(save, field.id)).toBe(false);
    expect(queueHaulBales(save, field.id)).toBeUndefined();

    const bare: Field = { id: "bare", parcelId: "p", boundary: field.boundary, status: "mulched" };
    save.fields.push(bare);
    expect(queueHaulBales(save, bare.id)).toBeUndefined(); // no bales → nothing to do
  });

  it("bale drop spacing varies with rand and every bale lands on the field (no off-field scatter)", () => {
    // A tiny deterministic PRNG so the varied run is reproducible.
    const makeRand = (seed: number) => {
      let a = seed >>> 0;
      return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    };
    const runBaling = (rand: () => number): Meters[] => {
      const save = newGame();
      ensureAgents(save, [0, 0]);
      buyImplement(save, "rake", "small");
      buyImplement(save, "bailer", "medium");
      const s = Math.sqrt(10 * 4046.8564224);
      const boundary: Meters[] = [[0, 0], [s, 0], [s, s], [0, s]];
      const field: Field = {
        id: "field-1", parcelId: "p", boundary,
        status: "harvested", forageReady: true, crop: "corn", trueYieldTonsPerAcre: 5,
      };
      save.fields.push(field);
      enqueueTask(save, field, "rake", APRIL_1);
      enqueueTask(save, field, "bale", APRIL_1);
      let now = APRIL_1;
      while (save.tasks.some((t) => t.type === "bale") && now - APRIL_1 < 800_000) {
        now += 60;
        tickFarming(save, now);
        tickTasks(save, now, 60, rand);
      }
      return field.baleLocations ?? [];
    };

    const even = runBaling(() => 0.5); // rand 0.5 → every bale fills to baleTons: even spacing
    const varied = runBaling(makeRand(12345)); // ±30% fill distance: staggered spacing
    expect(even.length).toBeGreaterThan(3);
    expect(varied.length).toBeGreaterThan(3);

    // The variance is wired to rand: the two layouts differ (staggered spacing,
    // and possibly a slightly different count — the count is allowed to vary now).
    const sameLayout =
      varied.length === even.length &&
      varied.every((b, i) => Math.hypot(b[0] - even[i]![0], b[1] - even[i]![1]) < 0.5);
    expect(sameLayout).toBe(false);
    // …but it stays near the nominal count (no runaway drift).
    expect(Math.abs(varied.length - even.length)).toBeLessThanOrEqual(Math.ceil(even.length * 0.15));

    // Every bale — in BOTH runs — lands inside the field (on baled ground). The
    // old perpendicular jitter is gone, so nothing is flung off the field.
    const s = Math.sqrt(10 * 4046.8564224);
    const boundary: Meters[] = [[0, 0], [s, 0], [s, s], [0, s]];
    for (const b of [...even, ...varied]) expect(pointInPolygon(b, boundary)).toBe(true);
  });

  it("baling a field auto-dispatches a Haul Bales job (no player click needed)", () => {
    const save = newGame();
    ensureAgents(save, [0, 0]);
    buyImplement(save, "rake", "small");
    buyImplement(save, "bailer", "medium");
    buyImplement(save, "haySpikes", "small");
    const s = Math.sqrt(5 * 4046.8564224);
    const boundary: Meters[] = [[0, 0], [s, 0], [s, s], [0, s]];
    const field: Field = {
      id: "field-1", parcelId: "p", boundary,
      status: "harvested", forageReady: true, crop: "corn", trueYieldTonsPerAcre: 5,
    };
    save.fields.push(field);
    enqueueTask(save, field, "rake", APRIL_1);
    enqueueTask(save, field, "bale", APRIL_1);

    // Drive growth + tasks until the bale task is done (bales dropped on the field).
    let now = APRIL_1;
    while (save.tasks.some((t) => t.type === "bale") && now - APRIL_1 < 400_000) {
      now += 60;
      tickFarming(save, now);
      tickTasks(save, now, 60, () => 0.5);
    }
    expect(field.baleLocations?.length ?? 0).toBeGreaterThan(0);
    // The bale run auto-queued a Haul Bales job for those bales.
    expect(save.tasks.some((t) => t.type === "haulBales" && t.fieldId === field.id)).toBe(true);
  });
});
