import { describe, it, expect, beforeAll } from "vitest";
import { setProjection } from "../src/geo/coords";
import type { Meters } from "../src/geo/coords";
import { newGame } from "../src/state/saveState";
import type { Field, SaveState } from "../src/state/saveState";
import {
  ensureAgents, tickTasks, enqueueTask, buyImplement, buyAgent, canChopField, chopHeadKind, blockedWork,
  estimateTaskHours, canMulch, forageDue,
} from "../src/sim/tasks";
import {
  applyChopDone, silageProductForField, silageTonsPerAcreFor, cropMakesSilage, canPlow,
} from "../src/sim/farming";
import {
  buyBuildingAt, silageCapacityTons, silageStoredTons, silageRoomTons, storeSilage, bunkerCapacityOf,
  tickSilageAging, assignSilageBunkerProduct, silageBunkerAccepts, storedSilageTotal,
  nearestSilageBunkerFor, migrateLegacySilage,
} from "../src/sim/buildings";
import { sellSilage, silageInventory } from "../src/sim/economy";
import { silageInstantPrice } from "../src/sim/market";
import { gameConfig } from "../src/config/gameConfig";
import { minutesPerMonth } from "../src/sim/calendar";

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
  it("only Forage does — bunker silage is exclusive to it now", () => {
    expect(cropMakesSilage("forage")).toBe(true);
    // Corn moved OFF the silage route entirely (2026-08-12) — chopping it for
    // silage is now a different crop (Forage), not a toggle on this one.
    // Grass/Alfalfa (and their Silage twins) lost the bunker-chop route
    // entirely (2026-08-13) — their "silage" is wrapped BALES now, made by
    // baling + wrapping, not chopping. See `cropProducesWrappedBale`.
    for (const c of [
      "corn", "soybeans", "wheat", "canola", "sunflowers", "grass", "alfalfa", "grassSilage", "alfalfaSilage",
    ] as const) {
      expect(cropMakesSilage(c), c).toBe(false);
    }
  });

  it("maps forage to its product; nothing else has one any more", () => {
    const save = newGame();
    expect(silageProductForField(fieldOf(save, 10, { id: "a", crop: "forage" }))).toBe("cornForage");
    expect(silageProductForField(fieldOf(save, 10, { id: "b", crop: "grassSilage" }))).toBeUndefined();
    expect(silageProductForField(fieldOf(save, 10, { id: "c", crop: "alfalfaSilage" }))).toBeUndefined();
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
    // Settles to "harvested" (2026-08-14, maintainer request) — same texture
    // a combine-harvested Corn field shows, just a month earlier while still
    // green. Nothing to rake or bale either way (whole plant's gone); an
    // optional Mulch pass is still available from "harvested" even with
    // forageReady unset (see `canMulch`), it just earns no residue bonus.
    expect(f.status).toBe("harvested");
    expect(f.forageReady).toBeUndefined();
    expect(f.residueBaled).toBe(true);
  });

  it("a chopped field can still take an optional Mulch pass, and doesn't owe one before plowing", () => {
    const save = newGame();
    const f = fieldOf(save, 10, { crop: "forage", forageReady: true });
    applyChopDone(f);
    // No rake/bale owed (nothing to gather), so plowing is free to skip
    // mulching entirely — matches a Corn field that was never baled either.
    expect(forageDue(save, f)).toBe(false);
    expect(canPlow(f.status)).toBe(true);
    // But Mulch is still offered, same as it would be on a harvested Corn
    // field — `canMulch` only checks status + `!residueMulched`.
    expect(canMulch(save, f)).toBe(true);
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
    expect(storeSilage(save, "cornForage", 100)).toBe(100);
    expect(storeSilage(save, "cornSilage", 50)).toBe(50);
    expect(silageStoredTons(save)).toBe(150);
  });

  it("accepts only what fits, so a caller can reroute the rest", () => {
    const save = newGame();
    buyBuildingAt(save, "silageBunker", [0, 0], "small");
    const cap = bunkerCapacityOf("small");
    expect(storeSilage(save, "cornForage", cap + 500)).toBe(cap);
    expect(silageRoomTons(save)).toBe(0);
    expect(storeSilage(save, "cornSilage", 10)).toBe(0);
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

describe("per-bunker product assignment is a REAL restriction (2026-08-15)", () => {
  // Maintainer request: bunkers moved off one farm-wide pool to real
  // per-building storage specifically so "dedicate this bunker to one
  // product" could gate capacity for real, the way Bale Storage already
  // does — not just a cosmetic label. Mirrors baleHaul.test.ts's "an
  // assigned store only accepts its product" coverage for bales.
  it("an assigned bunker refuses a different product outright", () => {
    const save = newGame();
    const bunker = buyBuildingAt(save, "silageBunker", [0, 0], "medium");
    assignSilageBunkerProduct(save, bunker.id, "cornSilage");
    expect(silageBunkerAccepts(bunker, "cornSilage")).toBe(true);
    expect(silageBunkerAccepts(bunker, "cornForage")).toBe(false);
    // haulSilageInto itself only enforces ROOM, trusting its caller already
    // picked an eligible bunker (same contract as `haulBalesInto`) — the
    // real refusal happens one level up, in `storeSilage`'s own filter.
    expect(storeSilage(save, "cornForage", 50)).toBe(0);
    expect(storedSilageTotal(bunker)).toBe(0);
  });

  it("storeSilage spreads across eligible bunkers, skipping ones assigned to something else", () => {
    const save = newGame();
    const forageOnly = buyBuildingAt(save, "silageBunker", [-100, -100], "small");
    assignSilageBunkerProduct(save, forageOnly.id, "cornForage");
    const anyBunker = buyBuildingAt(save, "silageBunker", [-120, -120], "small");

    expect(storeSilage(save, "cornSilage", 100)).toBe(100);
    expect(forageOnly.storedSilage?.cornSilage ?? 0).toBe(0); // wrong product — refused
    expect(anyBunker.storedSilage?.cornSilage ?? 0).toBe(100);
  });

  it("an unassigned bunker keeps accepting anything (today's default, unchanged)", () => {
    const save = newGame();
    const bunker = buyBuildingAt(save, "silageBunker", [0, 0], "medium");
    expect(silageBunkerAccepts(bunker, "cornSilage")).toBe(true);
    expect(silageBunkerAccepts(bunker, "cornForage")).toBe(true);
  });

  it("nearestSilageBunkerFor skips a full or ineligible bunker for a farther eligible one", () => {
    const save = newGame();
    const near = buyBuildingAt(save, "silageBunker", [0, 0], "small");
    assignSilageBunkerProduct(save, near.id, "cornForage"); // ineligible for cornSilage
    const far = buyBuildingAt(save, "silageBunker", [10_000, 10_000], "small");
    const picked = nearestSilageBunkerFor(save, "cornSilage", [0, 0]);
    expect(picked?.id).toBe(far.id);
  });

  it("the chop relay routes to the assigned bunker, not just the nearest one", () => {
    // End-to-end: a Forage Row-Crop Header + chopper + wagon relay should
    // fill the ASSIGNED bunker even though an unassigned (or wrong-product)
    // one sits closer to the field. The relay carries the FRESH product
    // (cornForage) — see `chooseRelayDest`.
    const save = silageFarm();
    const wrongNearby = save.buildings.find((b) => b.kind === "silageBunker")!;
    assignSilageBunkerProduct(save, wrongNearby.id, "cornSilage"); // the one silageFarm() already built, right by the field — wrong product
    const correctFarther = buyBuildingAt(save, "silageBunker", [2000, 2000], "medium");
    const field = fieldOf(save, 10);
    enqueueTask(save, field, "chop", 0);
    runTasks(save, 0, () => field.status === "harvested");
    expect(wrongNearby.storedSilage?.cornForage ?? 0).toBe(0);
    expect(correctFarther.storedSilage?.cornForage ?? 0).toBeGreaterThan(0);
  });
});

describe("migrateLegacySilage (2026-08-15)", () => {
  it("folds a pre-per-bunker save's pooled silage into the first bunker", () => {
    const save = newGame();
    const bunker = buyBuildingAt(save, "silageBunker", [0, 0], "large");
    // Simulate a save written before this session's change (already on the
    // current cornForage/cornSilage ids — the separate id-rename migration,
    // `migrateLegacySilageProductNames`, runs before this one).
    save.silage = { cornForage: 50, cornSilage: 300 };
    migrateLegacySilage(save);
    expect(bunker.storedSilage?.cornForage).toBe(50);
    expect(bunker.storedSilage?.cornSilage).toBe(300);
    expect(save.silage).toBeUndefined();
  });

  it("is a safe no-op on a save with nothing legacy to migrate", () => {
    const save = newGame();
    buyBuildingAt(save, "silageBunker", [0, 0], "medium");
    expect(() => migrateLegacySilage(save)).not.toThrow();
    expect(silageStoredTons(save)).toBe(0);
  });

  it("doesn't lose stock that doesn't fit in one bunker — spreads across all of them", () => {
    const save = newGame();
    const a = buyBuildingAt(save, "silageBunker", [0, 0], "small");
    const b = buyBuildingAt(save, "silageBunker", [10, 10], "small");
    const total = bunkerCapacityOf("small") * 2;
    save.silage = { cornForage: 0, cornSilage: total };
    migrateLegacySilage(save);
    expect(storedSilageTotal(a) + storedSilageTotal(b)).toBe(total);
  });
});

describe("selling silage", () => {
  it("pays the INSTANT price (no season, pickup fee) and empties the store (2026-08-15)", () => {
    // Was a flat config-listed price with no discount at all — repriced to
    // match grain/bales' instant-vs-hauled structure now that silage has
    // its own full Sell/Haul/Auto system (see `queueSellRun` for the hauled,
    // full-seasonal-price alternative).
    const save = newGame();
    buyBuildingAt(save, "silageBunker", [0, 0], "medium");
    storeSilage(save, "cornSilage", 200);
    const before = save.money;
    const r = sellSilage(save, "cornSilage", 200, 0);
    expect(r.tons).toBe(200);
    expect(r.revenue).toBe(Math.round(200 * silageInstantPrice("cornSilage")));
    expect(r.revenue).toBeLessThan(200 * gameConfig.silageProducts.cornSilage.pricePerTon);
    expect(save.money).toBe(before + r.revenue);
    expect(silageStoredTons(save)).toBe(0);
  });

  it("clamps to what's actually stored", () => {
    const save = newGame();
    buyBuildingAt(save, "silageBunker", [0, 0], "medium");
    storeSilage(save, "cornForage", 30);
    expect(sellSilage(save, "cornForage", 999, 0).tons).toBe(30);
    expect(sellSilage(save, "cornForage", 10, 0).tons).toBe(0);
  });

  it("lists only products actually held", () => {
    const save = newGame();
    buyBuildingAt(save, "silageBunker", [0, 0], "medium");
    storeSilage(save, "cornForage", 40);
    const rows = silageInventory(save);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.product).toBe("cornForage");
    expect(rows[0]!.tons).toBe(40);
  });
});

describe("tickSilageAging: Corn Forage ages into Corn Silage (2026-08-15)", () => {
  const MONTH = minutesPerMonth();

  it("does nothing before the aging window has passed", () => {
    const save = newGame();
    const bunker = buyBuildingAt(save, "silageBunker", [0, 0], "medium");
    storeSilage(save, "cornForage", 100);
    tickSilageAging(save, 0); // first tick just starts the clock
    tickSilageAging(save, MONTH * (gameConfig.forage.silageAgingMonths - 0.1));
    expect(bunker.storedSilage!.cornForage).toBe(100);
    expect(bunker.storedSilage!.cornSilage ?? 0).toBe(0);
  });

  it("folds the whole balance into Corn Silage once the window passes", () => {
    const save = newGame();
    const bunker = buyBuildingAt(save, "silageBunker", [0, 0], "medium");
    storeSilage(save, "cornForage", 100);
    tickSilageAging(save, 0); // starts the clock
    tickSilageAging(save, MONTH * gameConfig.forage.silageAgingMonths);
    expect(bunker.storedSilage!.cornForage ?? 0).toBe(0);
    expect(bunker.storedSilage!.cornSilage).toBe(100);
  });

  it("restarts the clock for silage that arrives after a conversion", () => {
    const save = newGame();
    const bunker = buyBuildingAt(save, "silageBunker", [0, 0], "large");
    storeSilage(save, "cornForage", 100);
    tickSilageAging(save, 0);
    tickSilageAging(save, MONTH * gameConfig.forage.silageAgingMonths); // converts the first 100
    storeSilage(save, "cornForage", 50); // a fresh batch arrives
    tickSilageAging(save, MONTH * gameConfig.forage.silageAgingMonths); // starts the fresh clock, doesn't convert yet
    expect(bunker.storedSilage!.cornForage).toBe(50);
    expect(bunker.storedSilage!.cornSilage).toBe(100);
    tickSilageAging(save, MONTH * gameConfig.forage.silageAgingMonths * 2);
    expect(bunker.storedSilage!.cornForage ?? 0).toBe(0);
    expect(bunker.storedSilage!.cornSilage).toBe(150);
  });

  it("clears the clock once a product sells down to zero — no stale aging on the next arrival", () => {
    const save = newGame();
    const bunker = buyBuildingAt(save, "silageBunker", [0, 0], "medium");
    storeSilage(save, "cornForage", 10);
    tickSilageAging(save, 0);
    bunker.storedSilage!.cornForage = 0; // sold off entirely
    tickSilageAging(save, MONTH * 0.5);
    storeSilage(save, "cornForage", 10); // a fresh delivery
    tickSilageAging(save, MONTH * 0.5); // starts a FRESH clock, not the old one
    tickSilageAging(save, MONTH * (gameConfig.forage.silageAgingMonths - 0.1)); // still under the window since the restart
    expect(bunker.storedSilage!.cornForage).toBe(10);
    expect(bunker.storedSilage!.cornSilage ?? 0).toBe(0);
  });

  it("Corn Forage is the fresh product's display name; Corn Silage is the aged one (2026-08-15 id/name fix)", () => {
    expect(gameConfig.silageProducts.cornForage.name).toBe("Corn Forage");
    expect(gameConfig.silageProducts.cornSilage.name).toBe("Corn Silage");
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

  it("refuses to queue a chop when the farm owns no forage harvester (2026-08-13)", () => {
    // Used to queue silently and just sit unrunnable forever — enqueueTask
    // didn't check the harvester or the head at all, only the wagon. A
    // player with everything but ONE piece of chop equipment got no
    // explanation at all (maintainer report: "I can't harvest this crop").
    const save = newGame();
    ensureAgents(save, [0, 0]);
    buyImplement(save, "forageWagon", "medium");
    buyImplement(save, "rowCropHead", "medium");
    const field = fieldOf(save, 20);
    expect(() => enqueueTask(save, field, "chop", 0)).toThrow(/forage harvester/i);
  });

  it("refuses to queue a chop when the farm owns no row-crop head (2026-08-13)", () => {
    const save = newGame();
    ensureAgents(save, [0, 0]);
    buyAgent(save, "forageHarvester", "medium", [0, 0]);
    buyImplement(save, "forageWagon", "medium");
    const field = fieldOf(save, 20);
    expect(() => enqueueTask(save, field, "chop", 0)).toThrow(/row-crop head/i);
  });

  it("still reports a missing chopper in blocked work if one's SOLD after queueing", () => {
    const save = silageFarm();
    const field = fieldOf(save, 20);
    enqueueTask(save, field, "chop", 0);
    // Sell the harvester after queueing — the task is now unrunnable.
    save.agents = save.agents.filter((a) => a.kind !== "forageHarvester");
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

  it("still works if the row-crop head is sold out from under a queued chop — falls back sanely", () => {
    // enqueueTask requires the head up front now (2026-08-13), so this can no
    // longer happen at QUEUE time — but the head can still vanish afterward
    // (sold, or reassigned) while the task sits queued with no agent yet,
    // which is the actual shape the original regression needs: a queued task
    // with no head implement anywhere on the farm.
    const save = silageFarm();
    const field = fieldOf(save, 20);
    const task = enqueueTask(save, field, "chop", 0);
    save.implements = save.implements.filter((i) => i.kind !== "rowCropHead");
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
    runTasks(save, 0, () => field.status === "harvested");
    expect(field.status).toBe("harvested"); // 2026-08-14: settles like a combine harvest now, not straight to stubble
    // 20 ac x 20 t/ac = 400 t, less whatever is still in transit on a wagon.
    expect(silageStoredTons(save)).toBeGreaterThan(300);
    const bunker = save.buildings.find((b) => b.kind === "silageBunker")!;
    expect(bunker.storedSilage!.cornForage).toBeGreaterThan(300);
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
    expect(relay?.silageProduct).toBe("cornForage");
  });

  it("the wagon trails BEHIND the chopper while onloading, not beside it (2026-08-13)", () => {
    // The chopper keeps moving every tick while the wagon reacts a tick
    // behind, so any SINGLE snapshot's exact offset is noisy (the harvester
    // can easily cover tens of meters in one tick, same order of magnitude as
    // `chopperTrailMeters`). Sample across the whole run instead and check
    // the wagon is on the trailing side far more often than not — the
    // qualitative behavior the maintainer asked for, not a precise geometry.
    const save = silageFarm();
    const field = fieldOf(save, 20);
    enqueueTask(save, field, "chop", 0);
    let behind = 0;
    let beside = 0;
    let now = 0;
    while (field.status !== "stubble" && now < 400_000) {
      now += 1;
      tickTasks(save, now, 1, () => 0.5);
      const relay = save.tasks.find((t) => t.type === "unloadHarvester");
      const harvester = save.agents.find((a) => a.kind === "forageHarvester");
      const wagonAgent = relay ? save.agents.find((a) => a.id === relay.agentId) : undefined;
      if (relay?.unloadPhase !== "onloading" || wagonAgent?.state !== "working" || harvester?.heading === undefined) continue;
      const dx = wagonAgent.pos[0] - harvester.pos[0];
      const dy = wagonAgent.pos[1] - harvester.pos[1];
      const behindComponent = -(dx * Math.cos(harvester.heading) + dy * Math.sin(harvester.heading));
      if (behindComponent > 0) behind++; else beside++;
    }
    expect(behind + beside).toBeGreaterThan(5); // sanity: enough samples to mean something
    expect(behind).toBeGreaterThan(beside * 4); // overwhelmingly trailing, not beside
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

describe("grass/alfalfa: no bunker-chop route any more (2026-08-13)", () => {
  it("refuses to chop grass or alfalfa (or their Silage twins) — chopping is Forage-only", () => {
    const save = newGame();
    ensureAgents(save, [0, 0]);
    buyAgent(save, "forageHarvester", "medium", [0, 0]);
    buyImplement(save, "pickupHead", "medium");
    buyImplement(save, "forageWagon", "medium");
    buyBuildingAt(save, "silageBunker", [50, 50], "medium");
    for (const crop of ["grass", "alfalfa", "grassSilage", "alfalfaSilage"] as const) {
      const field = fieldOf(save, 20, {
        id: `f-${crop}`, crop, status: "harvested", forageReady: true, windrowed: true, windrowWidthM: 7.6,
      });
      expect(() => enqueueTask(save, field, "chop", 0), crop).toThrow();
    }
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
    const silage = gameConfig.crops.forage.silageTonsPerAcre! * gameConfig.silageProducts.cornForage.pricePerTon;
    expect(silage).toBeGreaterThan(grain);        // more tonnage off the acre…
    expect(silage).toBeLessThan(grain * 1.3);     // …but not a landslide
  });

  it("chopping costs far more per acre than combining — that's what closes the gap", () => {
    expect(gameConfig.forage.chopCostPerAcre).toBeGreaterThan(gameConfig.harvestCostPerAcre * 2);
  });

  // Haylage (bunker silage from grass/alfalfa) was removed 2026-08-13 — see
  // `tests/baleage.test.ts` "grosses within ~15% of dry hay per acre" for the
  // equivalent balance check on their replacement, wrapped baleage bales.

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

  it("the chopper's buffer is small — it is not a tank", () => {
    // Flat 5t at every size (2026-08-14, was 1.5/2/2.5 tiered) — still a
    // fraction of even the smallest Forage Wagon (36t), just enough slack
    // that the relay doesn't stall dead the instant a wagon's briefly out
    // of position.
    for (const s of ["small", "medium", "large"] as const) {
      expect(gameConfig.equipment.forageHarvester[s].capacityTons).toBe(5);
      expect(gameConfig.equipment.forageHarvester[s].capacityTons).toBeLessThan(gameConfig.equipment.forageWagon[s].capacityTons / 5);
    }
  });
});
