import { describe, it, expect, beforeAll } from "vitest";
import { setProjection } from "../src/geo/coords";
import { newGame } from "../src/state/saveState";
import type { Field, SaveState } from "../src/state/saveState";
import {
  tickFarming, growthProgress, yieldRange, deriveStatus, applyPlant,
} from "../src/sim/farming";
import {
  ensureAgents, enqueueTask, cancelTask, tickTasks, autoManageAll,
  effectiveStatus, isFieldHarvesting, taskCost, buyAgent, sellAgent,
  buyImplement, sellImplement, attachImplement, detachImplement,
  agentPrice, implementPrice, canPull,
} from "../src/sim/tasks";
import { sellGrain } from "../src/sim/economy";
import {
  dateOf, formatDate, nextMonthStart, MINUTES_PER_DAY, minutesPerMonth,
  getDaysPerMonth, setDaysPerMonth,
} from "../src/sim/calendar";
import { gameConfig } from "../src/config/gameConfig";
import { boundsOf } from "../src/geo/geometry";
import type { Meters } from "../src/geo/coords";

beforeAll(() => setProjection(15, "N"));

// A 100-acre-ish square field: 636 m sides ≈ 404,686 m² ≈ 100 ac.
const side = Math.sqrt(100 * 4046.8564224);
const boundary: Meters[] = [[0, 0], [side, 0], [side, side], [0, side]];

/** Most tests want ready-to-plant ground; the plow tests ask for raw stubble. */
function freshField(status: Field["status"] = "tilled"): Field {
  return { id: "field-1", parcelId: "parcel-1", boundary, status };
}

/** A game with the starting fleet parked at the origin (next to the field). */
function gameWithAgents(): SaveState {
  const save = newGame();
  ensureAgents(save, [0, 0]);
  return save;
}

/** Run the world forward `minutes` from `from` in `step`-minute ticks (growth +
 * auto-manage + agents), the same order main.ts ticks in. Returns the end time. */
function runWorld(save: SaveState, from: number, minutes: number, step = 60): number {
  let now = from;
  const end = from + minutes;
  while (now < end) {
    const dt = Math.min(step, end - now);
    now += dt;
    tickFarming(save, now);
    autoManageAll(save, now);
    tickTasks(save, now, dt, () => 0.5);
  }
  return now;
}

/** Drive the world from `from` in `step`-minute ticks until `done()` or the cap.
 * Used for the PHYSICAL work model where a job's duration emerges from field
 * size × implement width rather than a known acres/hour rate. */
function runUntil(save: SaveState, from: number, done: () => boolean, capMinutes = 200_000, step = 120): number {
  let now = from;
  while (!done() && now - from < capMinutes) {
    now += step;
    tickFarming(save, now);
    autoManageAll(save, now);
    tickTasks(save, now, step, () => 0.5);
  }
  return now;
}

/** Campaign starts Mar 1 Yr 1; sim-time of April 1 Yr 1 (one month in). */
const APRIL_1 = minutesPerMonth();

describe("calendar", () => {
  it("starts on March 1, Year 1", () => {
    expect(formatDate(0)).toBe("Mar 1, Year 1");
  });

  it("rolls months and years on 30-day months", () => {
    expect(dateOf(minutesPerMonth()).month).toBe(3); // April
    expect(dateOf(10 * minutesPerMonth())).toMatchObject({ year: 2, month: 0 }); // Jan Yr 2
  });

  it("nextMonthStart lands on the 1st, strictly in the future", () => {
    const t = 5 * MINUTES_PER_DAY; // Mar 6
    const april = nextMonthStart(t, 3);
    expect(dateOf(april)).toMatchObject({ month: 3, day: 1, year: 1 });
    // Asking for the CURRENT month gives next year's.
    const march = nextMonthStart(t, 2);
    expect(dateOf(march)).toMatchObject({ month: 2, day: 1, year: 2 });
  });

  it("days-per-month is adjustable and reshapes month length live", () => {
    expect(getDaysPerMonth()).toBe(30);
    setDaysPerMonth(5);
    try {
      expect(minutesPerMonth()).toBe(5 * MINUTES_PER_DAY);
      // Same absolute sim-time, shorter month -> lands further into the calendar.
      expect(dateOf(minutesPerMonth())).toMatchObject({ month: 3, day: 1 }); // April 1
      expect(dateOf(2 * MINUTES_PER_DAY)).toMatchObject({ month: 2, day: 3 }); // Mar 3
      expect(() => setDaysPerMonth(0)).toThrow(/>= 1/);
    } finally {
      setDaysPerMonth(30); // don't leak state into other tests
    }
  });
});

describe("task queue + agents (brief §9, §10): plow → plant → grow → harvest", () => {
  it("queueing a plow pays on queue; canceling a queued task refunds in full", () => {
    const save = gameWithAgents();
    const field = freshField("stubble");
    save.fields.push(field);
    const cash = save.money;
    const cost = taskCost(field, "plow");
    const task = enqueueTask(save, field, "plow", 0);
    expect(cash - save.money).toBe(cost);
    expect(cost).toBe(Math.round(100 * gameConfig.plowCostPerAcre));
    // Can't queue plowing twice.
    expect(() => enqueueTask(save, field, "plow", 0)).toThrow(/already/);
    cancelTask(save, task.id);
    expect(save.money).toBe(cash);
    expect(save.tasks).toHaveLength(0);
  });

  it("refuses to queue what the (effective) field state doesn't allow", () => {
    const save = gameWithAgents();
    const field = freshField("stubble");
    save.fields.push(field);
    // Can't plant unplowed ground, can't harvest bare ground.
    expect(() => enqueueTask(save, field, "plant", APRIL_1, "corn")).toThrow(/[Pp]low/);
    expect(() => enqueueTask(save, field, "harvest", APRIL_1)).toThrow(/ready/);
    // But with a plow QUEUED, planting can chain behind it.
    enqueueTask(save, field, "plow", APRIL_1);
    expect(effectiveStatus(save, field)).toBe("tilled");
    expect(() => enqueueTask(save, field, "plant", APRIL_1, "corn")).not.toThrow();
  });

  it("rejects planting outside the window and unaffordable work", () => {
    const save = gameWithAgents();
    const field = freshField();
    save.fields.push(field);
    expect(() => enqueueTask(save, field, "plant", 0, "soybeans")).toThrow(/month/); // March: soy is May–Jun
    save.money = 0;
    expect(() => enqueueTask(save, field, "plant", APRIL_1, "corn")).toThrow(/cash/);
  });

  it("the tractor drives out and plows over sim-time (physical: drives the field)", () => {
    const save = gameWithAgents();
    const field = freshField("stubble");
    save.fields.push(field);
    enqueueTask(save, field, "plow", 0);

    // A couple of sim-hours in: driving/working, nowhere near done (a 100-ac
    // field at a 10-ft swath is a long route). The tractor should be moving.
    runWorld(save, 0, 120, 30);
    const tractor = save.agents.find((a) => a.kind === "tractor")!;
    expect(field.status).toBe("stubble");
    expect(tractor.state === "working" || tractor.state === "traveling").toBe(true);
    // Drive to completion.
    runUntil(save, 120, () => field.status === "tilled");
    expect(field.status).toBe("tilled");
    expect(save.tasks).toHaveLength(0);
    expect(tractor.state).toBe("idle");
  });

  it("a queued plant waits for the plow, then the tractor does both in order", () => {
    const save = gameWithAgents();
    const field = freshField("stubble");
    save.fields.push(field);
    enqueueTask(save, field, "plow", APRIL_1);
    enqueueTask(save, field, "plant", APRIL_1, "corn");

    runUntil(save, APRIL_1, () => field.status === "planted");
    expect(field.status).toBe("planted");
    expect(field.crop).toBe("corn");
    const cfg = gameConfig.crops.corn;
    const t = field.trueYieldTonsPerAcre!;
    expect(t).toBeGreaterThanOrEqual(cfg.baseYieldTonsPerAcre * (1 - cfg.yieldUncertainty));
    expect(t).toBeLessThanOrEqual(cfg.baseYieldTonsPerAcre * (1 + cfg.yieldUncertainty));
  });

  it("the combine harvests a ready field over sim-hours and banks acres × true yield", () => {
    const save = gameWithAgents();
    const field = freshField();
    save.fields.push(field);
    applyPlant(field, "corn", APRIL_1, () => 0.5);
    const truth = field.trueYieldTonsPerAcre!;

    const ready = APRIL_1 + gameConfig.crops.corn.growMonths * minutesPerMonth();
    expect(growthProgress(field, ready)).toBe(1);
    expect(deriveStatus(field, ready)).toBe("ready");
    tickFarming(save, ready);
    enqueueTask(save, field, "harvest", ready);

    // Partway: harvesting, grain banking but not yet complete.
    runWorld(save, ready, 120, 30);
    expect(isFieldHarvesting(save, field.id)).toBe(true);
    expect(save.grain.corn).toBeGreaterThan(0);
    expect(save.grain.corn).toBeLessThan(100 * truth);
    runUntil(save, ready + 120, () => field.status === "harvested");
    expect(field.status).toBe("harvested");
    expect(field.crop).toBeUndefined();
    expect(save.grain.corn).toBeCloseTo(100 * truth, 0);
  });

  it("visible yield range narrows over the season and always contains the truth", () => {
    const field = freshField();
    applyPlant(field, "corn", APRIL_1, () => 0.9); // high roll, off-center
    const truth = field.trueYieldTonsPerAcre!;
    const growMin = gameConfig.crops.corn.growMonths * minutesPerMonth();
    let prevWidth = Infinity;
    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
      const r = yieldRange(field, APRIL_1 + p * growMin)!;
      expect(r.low).toBeLessThanOrEqual(truth);
      expect(r.high).toBeGreaterThanOrEqual(truth);
      const width = r.high - r.low;
      expect(width).toBeLessThanOrEqual(prevWidth + 1e-9);
      prevWidth = width;
    }
    // By ready, the band is much tighter than at planting.
    const atPlant = yieldRange(field, APRIL_1)!;
    expect(prevWidth).toBeLessThan((atPlant.high - atPlant.low) * 0.3);
  });

  it("ripens on the 1st of the month regardless of which day it was seeded", () => {
    const field = freshField();
    // Seed mid-April (day 15) — the day shouldn't matter.
    applyPlant(field, "corn", minutesPerMonth() + 14 * MINUTES_PER_DAY, () => 0.5);
    const grow = gameConfig.crops.corn.growMonths; // whole months
    const readyTime = minutesPerMonth() * (1 + grow); // start of April + grow months
    expect(dateOf(readyTime)).toMatchObject({ month: 7, day: 1 }); // Aug 1
    // A day before the boundary it isn't ready; on the boundary it is.
    expect(growthProgress(field, readyTime - MINUTES_PER_DAY)).toBeLessThan(1);
    expect(deriveStatus(field, readyTime - MINUTES_PER_DAY)).not.toBe("ready");
    expect(growthProgress(field, readyTime)).toBeGreaterThanOrEqual(1);
    expect(deriveStatus(field, readyTime)).toBe("ready");
  });

  it("growth is keyed to MONTHS: a crop ripens in the same season at any pace", () => {
    const grow = gameConfig.crops.corn.growMonths;
    const readyMonths = new Set<number>();
    for (const dpm of [30, 10, 5]) {
      setDaysPerMonth(dpm);
      try {
        const field = freshField();
        const plantedAt = minutesPerMonth(); // April 1 at this pace
        applyPlant(field, "corn", plantedAt, () => 0.5);
        const ready = plantedAt + grow * minutesPerMonth();
        expect(growthProgress(field, ready)).toBeCloseTo(1, 6);
        expect(growthProgress(field, plantedAt + 0.5 * grow * minutesPerMonth())).toBeCloseTo(0.5, 6);
        readyMonths.add(dateOf(ready).month);
      } finally {
        setDaysPerMonth(30);
      }
    }
    expect(readyMonths.size).toBe(1); // same calendar month whatever the pace
  });

  it("sells grain from the bin at the flat price, clamped to what's stored", () => {
    const save = newGame();
    save.grain.corn = 50;
    const cash = save.money;
    const r = sellGrain(save, "corn", Infinity);
    expect(r.tons).toBe(50);
    expect(r.revenue).toBe(Math.round(50 * gameConfig.crops.corn.sellPricePerTon));
    expect(save.money).toBe(cash + r.revenue);
    expect(save.grain.corn).toBe(0);
    // Selling from an empty bin is a no-op.
    expect(sellGrain(save, "corn", 10)).toEqual({ tons: 0, revenue: 0 });
  });
});

describe("equipment: sizes, implements, buy/sell/attach (brief §8 capital)", () => {
  it("the starting fleet is a medium tractor + medium combine + medium plow hitched", () => {
    const save = gameWithAgents();
    const tractor = save.agents.find((a) => a.kind === "tractor")!;
    const combine = save.agents.find((a) => a.kind === "harvester")!;
    expect(tractor.size).toBe("medium");
    expect(combine.size).toBe("medium");
    const plow = save.implements.find((i) => i.kind === "plow")!;
    expect(plow.size).toBe("medium");
    expect(plow.attachedTo).toBe(tractor.id); // ready to plow out of the box
  });

  it("buying charges the size price; a second tractor gets a numbered, sized name", () => {
    const save = gameWithAgents();
    const cash = save.money;
    const t2 = buyAgent(save, "tractor", "large", [0, 0]);
    expect(save.money).toBe(cash - agentPrice("tractor", "large"));
    expect(t2.name).toBe("Large Tractor");
    expect(t2.size).toBe("large");
    save.money = 0;
    expect(() => buyAgent(save, "harvester", "medium", [0, 0])).toThrow(/cash/);
  });

  it("pull-size rule: a tractor pulls its own class or smaller", () => {
    expect(canPull("large", "small")).toBe(true);
    expect(canPull("medium", "medium")).toBe(true);
    expect(canPull("small", "medium")).toBe(false);

    const save = gameWithAgents();
    const small = buyAgent(save, "tractor", "small", [0, 0]);
    const bigPlow = buyImplement(save, "plow", "large");
    expect(() => attachImplement(save, small.id, bigPlow.id)).toThrow(/can't pull/);
    const smallPlow = buyImplement(save, "plow", "small");
    expect(() => attachImplement(save, small.id, smallPlow.id)).not.toThrow();
    expect(smallPlow.attachedTo).toBe(small.id);
  });

  it("plowing needs a plow: with none available, the task waits", () => {
    const save = gameWithAgents();
    // Remove the seeded plow entirely.
    const plow = save.implements.find((i) => i.kind === "plow")!;
    detachImplement(save, plow.id);
    sellImplement(save, plow.id);
    const field = freshField("stubble");
    save.fields.push(field);
    enqueueTask(save, field, "plow", 0);
    runWorld(save, 0, 600, 60);
    // No plow anywhere → the tractor never starts; the field stays stubble.
    expect(field.status).toBe("stubble");
    expect(save.tasks[0]!.status).toBe("queued");
  });

  it("buys a second plow and auto-hitches it so two tractors plow in parallel", () => {
    const save = gameWithAgents();
    buyAgent(save, "tractor", "medium", [0, 0]); // tractor-2, bare
    buyImplement(save, "plow", "medium"); // a second, unattached plow
    const f1 = freshField("stubble");
    const f2: Field = { id: "field-2", parcelId: "parcel-2", boundary, status: "stubble" };
    save.fields.push(f1, f2);
    enqueueTask(save, f1, "plow", 0);
    enqueueTask(save, f2, "plow", 0);
    tickTasks(save, 30, 30);
    const working = save.tasks.filter((t) => t.status === "active");
    expect(working).toHaveLength(2);
    expect(new Set(working.map((t) => t.agentId)).size).toBe(2); // two different tractors
  });

  it("selling refunds the purchase price; refuses mid-job or the last of its kind with work", () => {
    const save = gameWithAgents();
    const field = freshField("stubble");
    save.fields.push(field);
    enqueueTask(save, field, "plow", 0);
    runWorld(save, 0, 60, 30); // tractor picks it up and starts
    const tractor = save.agents.find((a) => a.kind === "tractor")!;
    expect(() => sellAgent(save, tractor.id)).toThrow(/mid-job/);

    // An idle combine with no harvest work sells fine, at its purchase price.
    const combine = save.agents.find((a) => a.kind === "harvester")!;
    const cash = save.money;
    const { refund } = sellAgent(save, combine.id);
    expect(refund).toBe(agentPrice("harvester", "medium"));
    expect(save.money).toBe(cash + refund);
    expect(save.agents.some((a) => a.kind === "harvester")).toBe(false);

    // Can't sell the only tractor while plow jobs still queue for it.
    const save2 = gameWithAgents();
    const f2 = freshField("stubble");
    save2.fields.push(f2);
    enqueueTask(save2, f2, "plow", 0);
    const t = save2.agents.find((a) => a.kind === "tractor")!;
    expect(() => sellAgent(save2, t.id)).toThrow(/only tractor/);
  });

  it("the working tractor drives a serpentine across the field (the visual sweep)", () => {
    const save = gameWithAgents();
    const field = freshField("stubble");
    save.fields.push(field);
    enqueueTask(save, field, "plow", 0);
    const tractor = save.agents.find((a) => a.kind === "tractor")!;

    const xs: number[] = [];
    let now = 0;
    for (let i = 0; i < 600 && field.status !== "tilled"; i++) {
      now += 30;
      tickFarming(save, now);
      tickTasks(save, now, 30, () => 0.5);
      if (tractor.state === "working") {
        xs.push(tractor.pos[0]);
        expect(tractor.heading).toBeDefined(); // faces its driving direction
      }
    }
    expect(field.status).toBe("tilled");
    // Back-and-forth: the along-lane coordinate both increases and decreases.
    let up = false;
    let down = false;
    for (let i = 1; i < xs.length; i++) {
      if (xs[i]! > xs[i - 1]! + 0.01) up = true;
      if (xs[i]! < xs[i - 1]! - 0.01) down = true;
    }
    expect(up && down).toBe(true);
    // And it stayed within the field (plus a small turn-headland margin).
    const [minE, , maxE] = boundsOf(boundary);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(minE - 15);
    expect(Math.max(...xs)).toBeLessThanOrEqual(maxE + 15);
  });

  it("selling a tractor drops its implement back to the yard (kept, not sold)", () => {
    const save = gameWithAgents();
    const tractor = save.agents.find((a) => a.kind === "tractor")!;
    const plow = save.implements.find((i) => i.kind === "plow")!;
    expect(plow.attachedTo).toBe(tractor.id);
    sellAgent(save, tractor.id);
    expect(save.implements.some((i) => i.id === plow.id)).toBe(true);
    expect(plow.attachedTo).toBeUndefined();
    expect(implementPrice("plow", "medium")).toBeGreaterThan(0);
  });
});

describe("auto-manage (idle mode, player-requested)", () => {
  it("queues plow, plant, and harvest itself with no manual calls, then loops", () => {
    const save = gameWithAgents();
    const field = freshField("stubble");
    field.autoManage = true;
    save.fields.push(field);

    // March: auto-manage queues the plow (no season restriction); drive until tilled.
    let now = runUntil(save, 0, () => field.status === "tilled", 5 * MINUTES_PER_DAY);
    expect(field.status).toBe("tilled");

    // Still March: no planting window yet, so nothing plants.
    now = runWorld(save, now, Math.max(0, APRIL_1 - MINUTES_PER_DAY - now), MINUTES_PER_DAY);
    expect(field.crop).toBeUndefined();

    // April: window opens — auto-manage plants corn; drive until it's in the ground.
    now = runUntil(save, now, () => field.crop === "corn", 10 * MINUTES_PER_DAY);
    expect(field.crop).toBe("corn");

    // Let it ripen, auto-harvest, and re-plow for next season.
    const grow = gameConfig.crops.corn.growMonths * minutesPerMonth();
    runUntil(save, now, () => save.grain.corn > 0 && field.status === "tilled", grow + 30 * MINUTES_PER_DAY);
    expect(save.grain.corn).toBeGreaterThan(0);
    expect(field.status).toBe("tilled"); // re-plowed itself for the next cycle
  });

  it("silently waits (doesn't throw) when a step isn't affordable or in season", () => {
    const save = gameWithAgents();
    save.money = 0; // can't afford plowing
    const field = freshField("stubble");
    field.autoManage = true;
    save.fields.push(field);
    expect(() => runWorld(save, 0, 60, 60)).not.toThrow();
    expect(field.status).toBe("stubble"); // still waiting, no crash
    expect(save.tasks).toHaveLength(0);
  });
});
