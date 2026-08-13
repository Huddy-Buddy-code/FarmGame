import { describe, it, expect, beforeAll } from "vitest";
import { setProjection } from "../src/geo/coords";
import type { Meters } from "../src/geo/coords";
import { newGame } from "../src/state/saveState";
import type { Field, SaveState } from "../src/state/saveState";
import {
  ensureAgents, tickTasks, enqueueTask, buyImplement, buyAgent, canChopField, chopHeadKind, blockedWork,
  estimateTaskHours,
} from "../src/sim/tasks";
import {
  applyChopDone, silageProductForField, silageTonsPerAcreFor, cropMakesSilage,
} from "../src/sim/farming";
import {
  buyBuildingAt, silageCapacityTons, silageStoredTons, silageRoomTons, storeSilage, bunkerCapacityOf,
} from "../src/sim/buildings";
import { sellSilage, silageInventory } from "../src/sim/economy";
import { gameConfig } from "../src/config/gameConfig";

beforeAll(() => setProjection(15, "N"));

const ACRE_M2 = 4046.8564224;

// Forage (2026-08-12) is the chop-only twin of Corn — its own crop, chosen at
// planting, never combined. It's the default test subject here since this
// file is about the chop/silage system; override `crop` for the handful of
// tests that specifically want a non-silage or perennial field.
function fieldOf(save: SaveState, acres: number, over: Partial<Field> = {}): Field {
  const s = Math.sqrt(acres * ACRE_M2);
  const field: Field = {
    id: "field-1", parcelId: "parcel-1",
    boundary: [[0, 0], [s, 0], [s, s], [0, s]] as Meters[],
    status: "ready", crop: "forage", trueYieldTonsPerAcre: 5.5,
    accessPoints: [[s / 2, 0], [s / 2, s]],
    ...over,
  } as Field;
  save.fields.push(field);
  return field;
}

/** A farm fully kitted for corn silage: chopper, row-crop head, wagon, bunker. */
function silageFarm(): SaveState {
  const save = newGame();
  ensureAgents(save, [0, 0]);
  buyAgent(save, "forageHarvester", "medium", [0, 0]);
  buyImplement(save, "rowCropHead", "medium");
  buyImplement(save, "forageWagon", "medium");
  buyBuildingAt(save, "silageBunker", [50, 50], "medium");
  return save;
}

function runTasks(save: SaveState, from: number, done: () => boolean, cap = 900_000, step = 30): number {
  let now = from;
  while (!done() && now - from < cap) {
    now += step;
    tickTasks(save, now, step, () => 0.5);
  }
  return now;
}

describe("which crops make silage", () => {
  it("forage and the two perennials do; grain crops (including corn) don't", () => {
    expect(cropMakesSilage("forage")).toBe(true);
    expect(cropMakesSilage("grass")).toBe(true);
    expect(cropMakesSilage("alfalfa")).toBe(true);
    // Corn moved OFF the silage route entirely (2026-08-12) — chopping it for
    // silage is now a different crop (Forage), not a toggle on this one.
    for (const c of ["corn", "soybeans", "wheat", "canola", "sunflowers"] as const) {
      expect(cropMakesSilage(c), c).toBe(false);
    }
  });

  it("maps each to its own product", () => {
    const save = newGame();
    expect(silageProductForField(fieldOf(save, 10, { id: "a", crop: "forage" }))).toBe("cornSilage");
    expect(silageProductForField(fieldOf(save, 10, { id: "b", crop: "grass" }))).toBe("haylage");
    expect(silageProductForField(fieldOf(save, 10, { id: "c", crop: "alfalfa" }))).toBe("alfalfaHaylage");
    expect(silageProductForField(fieldOf(save, 10, { id: "d", crop: "soybeans" }))).toBeUndefined();
  });

  it("picks the head from the crop — row-crop for standing corn/forage, pickup for a windrow", () => {
    expect(chopHeadKind("forage")).toBe("rowCropHead");
    // Corn keeps the row-crop mapping too, even though it has no chop route
    // any more — chopHeadKind is a crop-shape lookup, not silage-gated.
    expect(chopHeadKind("corn")).toBe("rowCropHead");
    expect(chopHeadKind("grass")).toBe("pickupHead");
    expect(chopHeadKind("alfalfa")).toBe("pickupHead");
  });
});

describe("silage yield", () => {
  it("is the WHOLE-PLANT tonnage, far above corn's own grain yield", () => {
    const save = newGame();
    const f = fieldOf(save, 10, { crop: "forage" });
    // 20 t/ac as fed vs corn's 5.5 t/ac of grain — it's mostly water and
    // stalk, and Forage is corn genetics that's simply never combined.
    expect(silageTonsPerAcreFor(f, 0)).toBeCloseTo(20, 3);
    expect(silageTonsPerAcreFor(f, 0)).toBeGreaterThan(gameConfig.crops.corn.baseYieldTonsPerAcre * 3);
  });

  it("ignores the field's rolled GRAIN yield — the two aren't convertible", () => {
    const save = newGame();
    const lucky = fieldOf(save, 10, { id: "a", crop: "forage", trueYieldTonsPerAcre: 9 });
    const poor = fieldOf(save, 10, { id: "b", crop: "forage", trueYieldTonsPerAcre: 2 });
    expect(silageTonsPerAcreFor(lucky, 0)).toBe(silageTonsPerAcreFor(poor, 0));
  });

  it("is zero for a crop with no silage route", () => {
    const save = newGame();
    expect(silageTonsPerAcreFor(fieldOf(save, 10, { crop: "soybeans" }), 0)).toBe(0);
  });
});

describe("chopping settles the field", () => {
  it("forage: crop cleared AND no residue left — the whole plant went", () => {
    const save = newGame();
    const f = fieldOf(save, 10, { crop: "forage", forageReady: true });
    applyChopDone(f);
    expect(f.crop).toBeUndefined();
    expect(f.lastCrop).toBe("forage");
    expect(f.status).toBe("stubble");
    // Nothing to rake, bale or mulch — that's the difference from a combine.
    expect(f.forageReady).toBeUndefined();
    expect(f.residueBaled).toBe(true);
  });

  it("a perennial simply regrows, exactly as after baling", () => {
    const save = newGame();
    const f = fieldOf(save, 10, { crop: "grass", status: "harvested", forageReady: true, windrowed: true });
    applyChopDone(f);
    expect(f.crop).toBe("grass"); // stand persists
    expect(f.status).toBe("growing");
    expect(f.forageReady).toBeUndefined();
  });
});

describe("the bunker", () => {
  it("pools capacity across every bunker, tons", () => {
    const save = newGame();
    buyBuildingAt(save, "silageBunker", [0, 0], "small");
    buyBuildingAt(save, "silageBunker", [10, 10], "large");
    expect(silageCapacityTons(save)).toBe(bunkerCapacityOf("small") + bunkerCapacityOf("large"));
  });

  it("takes ANY silage product — no assignment needed", () => {
    const save = newGame();
    buyBuildingAt(save, "silageBunker", [0, 0], "medium");
    expect(storeSilage(save, "cornSilage", 100)).toBe(100);
    expect(storeSilage(save, "haylage", 50)).toBe(50);
    expect(silageStoredTons(save)).toBe(150);
  });

  it("accepts only what fits, so a caller can reroute the rest", () => {
    const save = newGame();
    buyBuildingAt(save, "silageBunker", [0, 0], "small");
    const cap = bunkerCapacityOf("small");
    expect(storeSilage(save, "cornSilage", cap + 500)).toBe(cap);
    expect(silageRoomTons(save)).toBe(0);
    expect(storeSilage(save, "haylage", 10)).toBe(0);
  });

  it("stores nothing with no bunker built", () => {
    const save = newGame();
    expect(silageCapacityTons(save)).toBe(0);
    expect(storeSilage(save, "cornSilage", 100)).toBe(0);
  });

  it("does NOT spoil — a bunker is assumed sealed (maintainer scope call)", () => {
    // Phase 2 deliberately has no cover/feed-out mechanic. If that ever
    // changes, this test should fail and be rewritten, not deleted.
    expect(gameConfig.buildings.silageBunker.medium).not.toHaveProperty("spoilPctPerMonth");
  });
});

describe("selling silage", () => {
  it("pays the per-ton price and empties the store", () => {
    const save = newGame();
    buyBuildingAt(save, "silageBunker", [0, 0], "medium");
    storeSilage(save, "cornSilage", 200);
    const before = save.money;
    const r = sellSilage(save, "cornSilage", 200, 0);
    expect(r.tons).toBe(200);
    expect(r.revenue).toBe(200 * gameConfig.silageProducts.cornSilage.pricePerTon);
    expect(save.money).toBe(before + r.revenue);
    expect(silageStoredTons(save)).toBe(0);
  });

  it("clamps to what's actually stored", () => {
    const save = newGame();
    buyBuildingAt(save, "silageBunker", [0, 0], "medium");
    storeSilage(save, "haylage", 30);
    expect(sellSilage(save, "haylage", 999, 0).tons).toBe(30);
    expect(sellSilage(save, "haylage", 10, 0).tons).toBe(0);
  });

  it("lists only products actually held", () => {
    const save = newGame();
    buyBuildingAt(save, "silageBunker", [0, 0], "medium");
    storeSilage(save, "alfalfaHaylage", 40);
    const rows = silageInventory(save);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.product).toBe("alfalfaHaylage");
    expect(rows[0]!.tons).toBe(40);
  });
});

describe("THE CHOPPER CANNOT WORK WITHOUT A WAGON", () => {
  it("refuses to queue a chop when the farm owns no forage wagon", () => {
    const save = newGame();
    ensureAgents(save, [0, 0]);
    buyAgent(save, "forageHarvester", "medium", [0, 0]);
    buyImplement(save, "rowCropHead", "medium");
    const field = fieldOf(save, 20);
    expect(() => enqueueTask(save, field, "chop", 0)).toThrow(/Forage Wagon/i);
  });

  it("says so in blocked work, in plain language", () => {
    const save = silageFarm();
    const field = fieldOf(save, 20);
    enqueueTask(save, field, "chop", 0);
    // Remove the wagon after queueing — the task is now unrunnable.
    save.implements = save.implements.filter((i) => i.kind !== "forageWagon");
    const blocked = blockedWork(save);
    expect(blocked.some((b) => /Forage Wagon/i.test(b.reason))).toBe(true);
  });

  it("reports a missing chopper too", () => {
    const save = newGame();
    ensureAgents(save, [0, 0]);
    buyImplement(save, "forageWagon", "medium");
    buyImplement(save, "rowCropHead", "medium");
    const field = fieldOf(save, 20);
    enqueueTask(save, field, "chop", 0);
    expect(blockedWork(save).some((b) => /forage harvester/i.test(b.reason))).toBe(true);
  });
});

describe("estimateTaskHours on a QUEUED chop (2026-08-12 regression)", () => {
  // `TASK_IMPLEMENT["chop"]` is deliberately undefined (the head is
  // crop-dependent — see chopHeadKind), the same as "harvest". Unlike
  // "harvest", the width lookup had no special case for "chop" and fell
  // through to `IMPLEMENT_CONFIG[undefined].medium`, throwing
  // "Cannot read properties of undefined (reading 'medium')" — but only
  // while the task is still QUEUED (no agent yet); once active it took the
  // early-return path via the real coverage path and never hit the bug,
  // which is exactly why it went unnoticed. Reproduced live: queueing a chop
  // from the field panel crashed `refreshQueuePanel` before an agent ever
  // picked the job up.
  it("doesn't throw, and returns a sane positive estimate", () => {
    const save = silageFarm();
    const field = fieldOf(save, 20);
    const task = enqueueTask(save, field, "chop", 0);
    expect(task.status).toBe("queued");
    let hours = NaN;
    expect(() => { hours = estimateTaskHours(save, task); }).not.toThrow();
    expect(hours).toBeGreaterThan(0);
    expect(Number.isFinite(hours)).toBe(true);
  });

  it("still works if the farm hasn't bought the row-crop head yet — falls back sanely", () => {
    const save = newGame();
    ensureAgents(save, [0, 0]);
    buyAgent(save, "forageHarvester", "medium", [0, 0]);
    buyImplement(save, "forageWagon", "medium");
    const field = fieldOf(save, 20);
    const task = enqueueTask(save, field, "chop", 0);
    let hours = NaN;
    expect(() => { hours = estimateTaskHours(save, task); }).not.toThrow();
    expect(hours).toBeGreaterThan(0);
  });
});

describe("chopping end to end", () => {
  it("fills the bunker and clears the field", () => {
    const save = silageFarm();
    const field = fieldOf(save, 20);
    enqueueTask(save, field, "chop", 0);
    runTasks(save, 0, () => field.status === "stubble");
    expect(field.status).toBe("stubble");
    // 20 ac x 20 t/ac = 400 t, less whatever is still in transit on a wagon.
    expect(silageStoredTons(save)).toBeGreaterThan(300);
    expect(save.silage!.cornSilage).toBeGreaterThan(300);
  });

  it("banks NO grain — chopping and combining are exclusive", () => {
    const save = silageFarm();
    const field = fieldOf(save, 20);
    const grainBefore = save.grain.corn;
    enqueueTask(save, field, "chop", 0);
    runTasks(save, 0, () => field.status === "stubble");
    expect(save.grain.corn).toBe(grainBefore);
  });

  it("spawns a wagon relay that actually crews", () => {
    const save = silageFarm();
    const field = fieldOf(save, 20);
    enqueueTask(save, field, "chop", 0);
    runTasks(save, 0, () => save.tasks.some((t) => t.type === "unloadHarvester" && !!t.agentId), 200_000);
    const relay = save.tasks.find((t) => t.type === "unloadHarvester");
    expect(relay?.cargoKind).toBe("silage");
    expect(relay?.silageProduct).toBe("cornSilage");
  });

  it("STALLS when the wagon is taken away mid-job — no tank means no work", () => {
    const save = silageFarm();
    const field = fieldOf(save, 20);
    enqueueTask(save, field, "chop", 0);
    // Let it get going and fill its little buffer.
    let now = runTasks(save, 0, () => (save.agents.find((a) => a.kind === "forageHarvester")?.grainOnboard ?? 0) > 0.1, 100_000);
    // Strip every wagon and cancel the relay; the chopper should make no
    // further progress with its buffer full and nowhere to put material.
    save.implements = save.implements.filter((i) => i.kind !== "forageWagon");
    save.tasks = save.tasks.filter((t) => t.type !== "unloadHarvester");
    for (const a of save.agents) if (a.kind === "tractor") { a.taskId = undefined; a.state = "idle"; }
    const chopTask = save.tasks.find((t) => t.type === "chop")!;
    const doneBefore = chopTask.doneAcres;
    for (let i = 0; i < 400; i++) { now += 30; tickTasks(save, now, 30, () => 0.5); }
    const stillThere = save.tasks.find((t) => t.type === "chop");
    expect(stillThere, "chop task should still be unfinished").toBeDefined();
    expect(stillThere!.doneAcres - doneBefore).toBeLessThan(0.5);
  });

  it("diverts to a Sell Point when there's no bunker room, rather than stalling", () => {
    const save = newGame();
    ensureAgents(save, [0, 0]);
    buyAgent(save, "forageHarvester", "medium", [0, 0]);
    buyImplement(save, "rowCropHead", "medium");
    buyImplement(save, "forageWagon", "medium");
    buyBuildingAt(save, "sellPoint", [80, 80]); // no bunker at all
    const field = fieldOf(save, 20);
    const before = save.money;
    enqueueTask(save, field, "chop", 0);
    runTasks(save, 0, () => field.status === "stubble");
    // Sold on the spot instead of piling up nowhere.
    expect(save.money).toBeGreaterThan(before);
  });
});

describe("haylage: chopping a perennial", () => {
  it("chops the windrow and leaves the stand regrowing", () => {
    const save = newGame();
    ensureAgents(save, [0, 0]);
    buyAgent(save, "forageHarvester", "medium", [0, 0]);
    buyImplement(save, "pickupHead", "medium");
    buyImplement(save, "forageWagon", "medium");
    buyBuildingAt(save, "silageBunker", [50, 50], "medium");
    const field = fieldOf(save, 20, {
      crop: "grass", status: "harvested", forageReady: true, windrowed: true, windrowWidthM: 7.6,
    });
    enqueueTask(save, field, "chop", 0);
    runTasks(save, 0, () => field.status === "growing");
    expect(field.status).toBe("growing");
    expect(field.crop).toBe("grass");
    expect(save.silage!.haylage).toBeGreaterThan(40); // 20 ac x 3.2 t/ac = 64 t
  });

  it("refuses to chop a perennial that hasn't been mowed", () => {
    const save = newGame();
    ensureAgents(save, [0, 0]);
    buyAgent(save, "forageHarvester", "medium", [0, 0]);
    buyImplement(save, "pickupHead", "medium");
    buyImplement(save, "forageWagon", "medium");
    const field = fieldOf(save, 20, { crop: "grass", status: "growing" });
    expect(() => enqueueTask(save, field, "chop", 0)).toThrow(/Mow/i);
  });
});

describe("canChopField: Forage chops once equipped — no in-season toggle (2026-08-12)", () => {
  // Silage used to be a `plan.silage` toggle a player flipped on a ripe Corn
  // field. Now the route is decided at PLANTING (Corn vs Forage), so a Forage
  // field just chops once the farm is equipped — no toggle to check at all.
  it("chops a Forage field once fully equipped", () => {
    const save = silageFarm();
    const field = fieldOf(save, 20);
    expect(canChopField(save, field)).toBe(true);
  });

  it("isn't chop-eligible with any one piece of gear missing", () => {
    // Auto-manage must never trap a ripe field on a MISSING toggle any more —
    // but it still has to wait for equipment, the same rule the baler follows
    // when the farm owns no baler (see `autoManageField`'s `"ready"` case,
    // which skips the "harvest" fallback for a chop-only crop).
    for (const strip of ["forageHarvester", "rowCropHead", "forageWagon"] as const) {
      const save = silageFarm();
      const field = fieldOf(save, 20);
      if (strip === "forageHarvester") save.agents = save.agents.filter((a) => a.kind !== "forageHarvester");
      else save.implements = save.implements.filter((i) => i.kind !== strip);
      expect(canChopField(save, field), strip).toBe(false);
    }
  });

  it("corn is never chop-eligible any more — it has no silage route left", () => {
    const save = silageFarm();
    const field = fieldOf(save, 20, { crop: "corn" });
    expect(canChopField(save, field)).toBe(false);
  });

  it("never chops a crop with no silage route at all (soybeans)", () => {
    const save = silageFarm();
    const field = fieldOf(save, 20, { crop: "soybeans" });
    expect(canChopField(save, field)).toBe(false);
  });
});

describe("Forage has no combine route", () => {
  it("enqueueTask refuses \"harvest\" on a ready Forage field", () => {
    const save = silageFarm();
    const field = fieldOf(save, 20);
    expect(() => enqueueTask(save, field, "harvest", 0)).toThrow(/can't be combined/i);
  });
});

describe("silage balance", () => {
  it("forage grosses near grain corn — a real choice, not a free upgrade", () => {
    const grain = gameConfig.crops.corn.baseYieldTonsPerAcre * gameConfig.crops.corn.sellPricePerTon;
    const silage = gameConfig.crops.forage.silageTonsPerAcre! * gameConfig.silageProducts.cornSilage.pricePerTon;
    expect(silage).toBeGreaterThan(grain);        // more tonnage off the acre…
    expect(silage).toBeLessThan(grain * 1.3);     // …but not a landslide
  });

  it("chopping costs far more per acre than combining — that's what closes the gap", () => {
    expect(gameConfig.forage.chopCostPerAcre).toBeGreaterThan(gameConfig.harvestCostPerAcre * 2);
  });

  it("haylage lands beside hay and baleage per acre, so the routes compete", () => {
    const hay = gameConfig.baleProducts.hay.pricePerBale * gameConfig.baleProducts.hay.balesPerAcre;
    const haylage = gameConfig.crops.grass.silageTonsPerAcre! * gameConfig.silageProducts.haylage.pricePerTon;
    expect(haylage).toBeGreaterThan(hay * 0.85);
    expect(haylage).toBeLessThan(hay * 1.15);
  });

  it("a forage wagon out-carries a grain trailer at EVERY tier (maintainer request)", () => {
    // Compared in tons of CORN, since a grain trailer is rated by volume.
    // This matters more than it does for grain: the chopper stops dead
    // whenever no wagon is taking material, so wagon capacity sets the tempo
    // of the entire silage harvest.
    for (const s of ["small", "medium", "large"] as const) {
      const grainTons = gameConfig.equipment.grainTrailer[s].capacityBushels * 0.0254;
      expect(gameConfig.equipment.forageWagon[s].capacityTons, s).toBeGreaterThan(grainTons);
    }
  });

  it("the chopper's buffer is tiny — it is not a tank", () => {
    for (const s of ["small", "medium", "large"] as const) {
      expect(gameConfig.equipment.forageHarvester[s].capacityTons).toBeLessThan(5);
    }
  });
});
