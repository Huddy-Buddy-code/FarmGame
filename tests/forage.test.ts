import { describe, it, expect, beforeAll } from "vitest";
import { setProjection } from "../src/geo/coords";
import type { Meters } from "../src/geo/coords";
import { newGame } from "../src/state/saveState";
import type { Field, SaveState } from "../src/state/saveState";
import { applyHarvestDone, applyBaleDone } from "../src/sim/farming";
import {
  ensureAgents, enqueueTask, buyImplement, buyAgent, tickTasks, autoManageAll,
  forageEquipped, forageDue, effectiveStatus,
} from "../src/sim/tasks";
import { tickFarming } from "../src/sim/farming";
import { sellBales } from "../src/sim/economy";
import { minutesPerMonth } from "../src/sim/calendar";
import { gameConfig } from "../src/config/gameConfig";
import { areaAcres, pointInPolygon } from "../src/geo/geometry";

beforeAll(() => setProjection(15, "N"));

const side = Math.sqrt(100 * 4046.8564224); // ~100-acre square
const boundary: Meters[] = [[0, 0], [side, 0], [side, side], [0, side]];
const ACRES = areaAcres(boundary);
const EXPECTED_BALES = Math.round(ACRES * gameConfig.forage.balesPerAcre);

const APRIL_1 = minutesPerMonth();
const WINTER_1 = 9 * minutesPerMonth(); // Dec 1 — plow window opens (winter only)

/** A game with the starting fleet PLUS a rake and a baler (so baling is possible). */
function gameWithForageGear(): SaveState {
  const save = newGame();
  ensureAgents(save, [0, 0]);
  buyImplement(save, "rake", "small");
  buyImplement(save, "bailer", "medium");
  return save;
}

function harvestedCornField(save: SaveState): Field {
  const field: Field = { id: "field-1", parcelId: "parcel-1", boundary, status: "harvested", forageReady: true };
  save.fields.push(field);
  return field;
}

/** Drive growth + auto-manage + agents until `done()` (or a cap), like main.ts. */
function runUntil(save: SaveState, from: number, done: () => boolean, cap = 400_000, step = 120): number {
  let now = from;
  while (!done() && now - from < cap) {
    now += step;
    tickFarming(save, now);
    autoManageAll(save, now);
    tickTasks(save, now, step, () => 0.5);
  }
  return now;
}

describe("forage flags on the field lifecycle", () => {
  it("harvesting a forage crop (corn) flags the field for rake + bale", () => {
    const field: Field = { id: "f", parcelId: "p", boundary, status: "ready", crop: "corn", trueYieldTonsPerAcre: 5 };
    applyHarvestDone(field);
    expect(field.status).toBe("harvested");
    expect(field.forageReady).toBe(true);
  });

  it("harvesting a NON-forage crop (soybeans) leaves no forage to bale", () => {
    const field: Field = { id: "f", parcelId: "p", boundary, status: "ready", crop: "soybeans", trueYieldTonsPerAcre: 1.5 };
    applyHarvestDone(field);
    expect(field.status).toBe("harvested");
    expect(field.forageReady).toBeFalsy();
  });

  it("finishing baling clears the forage flags and marks the field mulched", () => {
    // The bales themselves are dropped by the baler as it works (into
    // baleLocations); applyBaleDone only settles the field status/flags.
    const field: Field = { id: "f", parcelId: "p", boundary, status: "harvested", forageReady: true, windrowed: true };
    applyBaleDone(field);
    expect(field.status).toBe("mulched");
    expect(field.forageReady).toBeFalsy();
    expect(field.windrowed).toBeFalsy();
  });
});

describe("enqueue validation — rake before bale, bale drops physical bales", () => {
  it("rake needs a freshly harvested forage field", () => {
    const save = gameWithForageGear();
    const field = harvestedCornField(save);
    expect(() => enqueueTask(save, field, "rake", APRIL_1)).not.toThrow();
  });

  it("the baler can't start before a rake is at least queued", () => {
    const save = gameWithForageGear();
    const field = harvestedCornField(save);
    expect(() => enqueueTask(save, field, "bale", APRIL_1)).toThrow(/rake/i);
  });

  it("once a rake is queued, the baler can be queued behind it", () => {
    const save = gameWithForageGear();
    const field = harvestedCornField(save);
    enqueueTask(save, field, "rake", APRIL_1);
    expect(() => enqueueTask(save, field, "bale", APRIL_1)).not.toThrow();
    // A queued bale makes the field EFFECTIVELY mulched (its lifecycle end-state).
    expect(effectiveStatus(save, field)).toBe("mulched");
  });
});

describe("plow gating around the forage loop", () => {
  it("a harvested forage field owes a rake + bale before it can plow (when geared up)", () => {
    const save = gameWithForageGear();
    const field = harvestedCornField(save);
    expect(forageEquipped(save)).toBe(true);
    expect(forageDue(save, field)).toBe(true);
    expect(() => enqueueTask(save, field, "plow", WINTER_1)).toThrow(/rake & bale/i);
  });

  it("without baling gear, the residue is just plowed under (no trap)", () => {
    const save = newGame();
    ensureAgents(save, [0, 0]); // no rake/baler bought
    const field = harvestedCornField(save);
    expect(forageEquipped(save)).toBe(false);
    expect(forageDue(save, field)).toBe(false);
    expect(() => enqueueTask(save, field, "plow", WINTER_1)).not.toThrow();
  });
});

describe("selling bales from the field", () => {
  it("pays the flat per-bale price and empties the field", () => {
    const save = newGame();
    const locs: Meters[] = Array.from({ length: 10 }, (_, i) => [i, i] as Meters);
    const field: Field = { id: "f", parcelId: "p", boundary, status: "mulched", baleLocations: locs };
    save.fields.push(field);
    const before = save.money;
    const { bales, revenue } = sellBales(save, field);
    expect(bales).toBe(10);
    expect(revenue).toBe(10 * gameConfig.forage.balePricePerBale);
    expect(save.money).toBe(before + revenue);
    expect(field.baleLocations).toHaveLength(0);
    // Nothing to sell the second time.
    expect(sellBales(save, field).bales).toBe(0);
  });
});

describe("smallest capable tractor is chosen first", () => {
  it("a small tractor takes the rake job over a larger idle tractor", () => {
    const save = gameWithForageGear(); // medium tractor + combine + small rake + medium baler
    const small = buyAgent(save, "tractor", "small", [0, 0]);
    const field = harvestedCornField(save);
    enqueueTask(save, field, "rake", APRIL_1);

    tickTasks(save, APRIL_1 + 30, 30, () => 0.5);

    const rake = save.tasks.find((t) => t.type === "rake")!;
    expect(rake.status).toBe("active");
    expect(rake.agentId).toBe(small.id); // the small tractor, not the medium
  });
});

describe("the baler drops bales as it works", () => {
  it("accumulates bales one at a time (not all at completion)", () => {
    const save = gameWithForageGear();
    const field = harvestedCornField(save);
    enqueueTask(save, field, "rake", APRIL_1);
    enqueueTask(save, field, "bale", APRIL_1);
    const totalBales = Math.round(ACRES * gameConfig.forage.balesPerAcre);

    // Step finely so we can catch the field partway baled.
    let now = APRIL_1;
    let sawPartial = false;
    while (now - APRIL_1 < 400_000 && field.status !== "mulched") {
      now += 30;
      tickFarming(save, now);
      tickTasks(save, now, 30, () => 0.5);
      const n = field.baleLocations?.length ?? 0;
      if (n > 0 && n < totalBales) sawPartial = true;
    }
    expect(sawPartial).toBe(true); // bales appeared mid-task, not in one lump
    expect(field.status).toBe("mulched");
    expect(field.baleLocations).toHaveLength(totalBales);
  });

  it("keeps the exact bale count even with ±10% spacing jitter", () => {
    const save = gameWithForageGear();
    const field = harvestedCornField(save);
    enqueueTask(save, field, "rake", APRIL_1);
    enqueueTask(save, field, "bale", APRIL_1);
    // A varying RNG (not the flat 0.5 that zeroes the jitter) so spacing actually
    // wobbles — the total count must still land on the nominal grid.
    let a = 1234567;
    const rng = () => ((a = (a * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    let now = APRIL_1;
    while (now - APRIL_1 < 400_000 && field.status !== "mulched") {
      now += 60;
      tickFarming(save, now);
      tickTasks(save, now, 60, rng);
    }
    expect(field.status).toBe("mulched");
    expect(field.baleLocations).toHaveLength(Math.round(ACRES * gameConfig.forage.balesPerAcre));
  });

  it("never drops a bale off the field, even with a concave boundary (farmstead notch)", () => {
    // A ~100-acre rectangle with a rectangular bite cut out of the top-center —
    // the kind of notch a farmstead/yard makes. The coverage path can cut across
    // the notch, but a bale must never land inside it (off the field).
    const notched: Meters[] = [
      [0, 0], [900, 0], [900, 450], [540, 450], [540, 315], [360, 315], [360, 450], [0, 450],
    ];
    const save = gameWithForageGear();
    const field: Field = { id: "field-1", parcelId: "p", boundary: notched, status: "harvested", forageReady: true };
    save.fields.push(field);
    enqueueTask(save, field, "rake", APRIL_1);
    enqueueTask(save, field, "bale", APRIL_1);

    runUntil(save, APRIL_1, () => field.status === "mulched");
    expect(field.status).toBe("mulched");
    expect(field.baleLocations?.length ?? 0).toBeGreaterThan(0);
    for (const p of field.baleLocations!) expect(pointInPolygon(p, notched)).toBe(true);
  });

  it("spreads bales over the WHOLE concave field — they don't stop early at the notch", () => {
    // Lanes run along the long (x) edge and advance in y (0→450). The notch
    // over-covers the path; area-based bale spacing used to exhaust the bales in
    // the first band of lanes, leaving the far lanes bare. Work-distance spacing
    // must spread them across the full y-extent.
    const notched: Meters[] = [
      [0, 0], [900, 0], [900, 450], [540, 450], [540, 315], [360, 315], [360, 450], [0, 450],
    ];
    const save = gameWithForageGear();
    const field: Field = { id: "field-1", parcelId: "p", boundary: notched, status: "harvested", forageReady: true };
    save.fields.push(field);
    enqueueTask(save, field, "rake", APRIL_1);
    enqueueTask(save, field, "bale", APRIL_1);

    runUntil(save, APRIL_1, () => field.status === "mulched");
    const ys = field.baleLocations!.map((p) => p[1]);
    const spread = Math.max(...ys) - Math.min(...ys);
    expect(spread).toBeGreaterThan(0.85 * 450); // bales reach both the near and far lanes
  });
});

describe("auto-managed forage loop end to end", () => {
  it("a geared, auto-managed corn field harvests → rakes → bales → mulched → re-plows in winter", () => {
    const save = gameWithForageGear();
    const field: Field = { id: "field-1", parcelId: "parcel-1", boundary, status: "tilled", autoManage: true };
    save.fields.push(field);

    // Auto-manage plants corn in the April window, grows it, harvests it, then
    // runs the forage loop. Drive until the field is baled/mulched.
    runUntil(save, APRIL_1, () => field.status === "mulched");
    expect(field.status).toBe("mulched");
    expect(field.baleLocations).toHaveLength(EXPECTED_BALES);
    expect(field.forageReady).toBeFalsy();
    // Every bale sits on a real point inside the field (dropped along the path).
    for (const p of field.baleLocations!) expect(pointInPolygon(p, boundary)).toBe(true);

    // Bales persist as long as they're unsold; the mulched field then re-plows
    // once the winter plow window opens.
    const end = runUntil(save, WINTER_1, () => field.status === "tilled");
    expect(field.status).toBe("tilled");
    expect(field.baleLocations).toHaveLength(EXPECTED_BALES); // plowing under doesn't clear dropped bales
    void end;
  });
});
