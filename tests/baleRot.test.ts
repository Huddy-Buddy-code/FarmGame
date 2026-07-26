/**
 * BALE ROT (maintainer request, 2026-07-25) — stored bales decay over time,
 * fast out in the weather and slowly under cover.
 *
 * Two things ride on this, so both are pinned here:
 *
 *  1. It is the ONLY mechanical difference between the $70k Bale Barn and the
 *     $25k Bale Area. Before it, the two were identical and the game was asking
 *     players to pay nearly 3x for nothing.
 *  2. It's half of alfalfa's rebalance (the other half being a flat −15% on its
 *     yield). Hay's real downside is that it doesn't keep, and hay is what gets
 *     stored as bales — so the tax lands on the crop that was out of line.
 *
 * The fiddly part is that loss is a PERCENTAGE of a pile of whole objects.
 * `storedBales` has to stay integral (a bale gets hauled, sold and drawn on the
 * map), so the sub-bale remainder accrues in `spoilAccrued` and a bale comes off
 * each time it crosses 1. Most of what's below is about that seam.
 */

import { describe, it, expect } from "vitest";
import { newGame } from "../src/state/saveState";
import type { SaveState } from "../src/state/saveState";
import { gameConfig } from "../src/config/gameConfig";
import { buyBuildingAt, tickBaleSpoilage, baleSpoilRateOf, storedBalesTotal } from "../src/sim/buildings";
import { minutesPerMonth } from "../src/sim/calendar";

const MONTH = minutesPerMonth();

function storeWith(kind: "baleBarn" | "baleArea", bales: number, save: SaveState = newGame()) {
  save.money = 10_000_000;
  const b = buyBuildingAt(save, kind, [0, 0]);
  b.storedBales = { alfalfaHay: bales };
  return { save, b };
}

describe("the Barn is finally worth more than the Area", () => {
  it("outdoor storage rots several times faster than indoor", () => {
    expect(baleSpoilRateOf("baleArea")).toBeGreaterThan(baleSpoilRateOf("baleBarn"));
    expect(baleSpoilRateOf("baleBarn")).toBeGreaterThan(0); // even a barn isn't free
  });

  it("over a winter, the same load loses far more outside than in", () => {
    const outside = storeWith("baleArea", 800);
    const inside = storeWith("baleBarn", 800);
    for (let m = 0; m < 6; m++) {
      tickBaleSpoilage(outside.save, MONTH);
      tickBaleSpoilage(inside.save, MONTH);
    }
    const lostOut = 800 - storedBalesTotal(outside.b);
    const lostIn = 800 - storedBalesTotal(inside.b);
    expect(lostOut).toBeGreaterThan(lostIn * 3);
    // Real six-month dry-matter loss: 5–20% out in the weather, 2–5% covered.
    expect(lostOut / 800).toBeGreaterThan(0.05);
    expect(lostOut / 800).toBeLessThan(0.2);
    expect(lostIn / 800).toBeLessThan(0.05);
  });
});

describe("bales stay whole objects", () => {
  it("a month's loss on a big pile is the configured fraction", () => {
    const { save, b } = storeWith("baleArea", 1000);
    tickBaleSpoilage(save, MONTH);
    expect(b.storedBales!.alfalfaHay).toBe(1000 - Math.floor(1000 * baleSpoilRateOf("baleArea")));
  });

  it("compounds — the second month costs less than the first, off a smaller pile", () => {
    const { save, b } = storeWith("baleArea", 1000);
    tickBaleSpoilage(save, MONTH);
    const afterOne = b.storedBales!.alfalfaHay!;
    tickBaleSpoilage(save, MONTH);
    const afterTwo = b.storedBales!.alfalfaHay!;
    expect(1000 - afterOne).toBeGreaterThan(afterOne - afterTwo);
  });

  it("never leaves a fractional bale in storage", () => {
    const { save, b } = storeWith("baleArea", 137);
    for (let i = 0; i < 40; i++) {
      tickBaleSpoilage(save, MONTH / 3);
      const n = b.storedBales?.alfalfaHay;
      if (n !== undefined) expect(Number.isInteger(n)).toBe(true);
    }
  });

  it("a small pile still rots — the remainder accrues instead of rounding to nothing", () => {
    // 4 bales x 2.5%/mo = 0.1 of a bale a month: every individual month floors
    // to zero. Without the accumulator a small store would be immortal.
    const { save, b } = storeWith("baleArea", 4);
    tickBaleSpoilage(save, MONTH);
    expect(b.storedBales!.alfalfaHay).toBe(4); // nothing lost yet...
    expect(b.spoilAccrued!.alfalfaHay).toBeGreaterThan(0); // ...but the debt is recorded
    for (let m = 0; m < 11; m++) tickBaleSpoilage(save, MONTH);
    expect(b.storedBales!.alfalfaHay).toBeLessThan(4); // and it eventually lands
  });

  it("costs the same however the span is chopped up", () => {
    // Matters because a reload advances the clock in ONE jump while normal play
    // dribbles it out. Decay is exponential for exactly this reason: a flat
    // percentage of the starting count compounds when ticked finely and doesn't
    // when ticked coarsely, so six months would cost more or less depending on
    // frame rate. (Caught by this test — the first cut of the code was flat.)
    const oneJump = storeWith("baleArea", 500);
    tickBaleSpoilage(oneJump.save, 6 * MONTH);

    const monthly = storeWith("baleArea", 500);
    for (let m = 0; m < 6; m++) tickBaleSpoilage(monthly.save, MONTH);

    const drip = storeWith("baleArea", 500);
    for (let i = 0; i < 6 * 30; i++) tickBaleSpoilage(drip.save, MONTH / 30);

    // Within a bale of each other — the accumulator's flooring is the only
    // slack, and it can only ever differ by the one bale in flight.
    expect(Math.abs(storedBalesTotal(oneJump.b) - storedBalesTotal(monthly.b))).toBeLessThanOrEqual(1);
    expect(Math.abs(storedBalesTotal(oneJump.b) - storedBalesTotal(drip.b))).toBeLessThanOrEqual(1);
  });
});

describe("edges", () => {
  it("an empty store, a zero dt and a rot-free kind are all no-ops", () => {
    const { save, b } = storeWith("baleArea", 50);
    tickBaleSpoilage(save, 0);
    expect(b.storedBales!.alfalfaHay).toBe(50);
    const empty = newGame();
    empty.money = 10_000_000;
    buyBuildingAt(empty, "baleArea", [0, 0]);
    expect(() => tickBaleSpoilage(empty, MONTH)).not.toThrow();
  });

  it("never goes negative, and clears the product out once it's gone", () => {
    // Exponential decay is asymptotic, so an abandoned pile doesn't vanish in
    // one tick however long that tick is — it just gets very small. What has to
    // hold is that it never goes NEGATIVE and does eventually clear.
    const { save, b } = storeWith("baleArea", 3);
    for (let i = 0; i < 5; i++) {
      tickBaleSpoilage(save, 500 * MONTH); // absurd spans — abandon it entirely
      expect(storedBalesTotal(b)).toBeGreaterThanOrEqual(0);
    }
    expect(storedBalesTotal(b)).toBe(0);
    expect(b.storedBales!.alfalfaHay).toBeUndefined();
    expect(b.spoilAccrued?.alfalfaHay).toBeUndefined();
  });

  it("carries at most one bale of pending rot into a later delivery", () => {
    // The remainder is meant to carry (that's what stops a small pile being
    // immortal), so a refill CAN pay off up to one bale of the previous load's
    // rot. What mustn't happen is unbounded debt piling up to eat a new load.
    const { save, b } = storeWith("baleArea", 3);
    for (let i = 0; i < 4; i++) tickBaleSpoilage(save, 500 * MONTH);
    expect(b.spoilAccrued?.alfalfaHay ?? 0).toBeLessThan(1);
    b.storedBales = { alfalfaHay: 100 };
    tickBaleSpoilage(save, MONTH / 100); // a sliver of time
    expect(b.storedBales.alfalfaHay).toBeGreaterThanOrEqual(99);
  });

  it("rots each product in a mixed store on its own count", () => {
    const save = newGame();
    save.money = 10_000_000;
    const b = buyBuildingAt(save, "baleArea", [0, 0]);
    b.storedBales = { alfalfaHay: 400, straw: 200 };
    tickBaleSpoilage(save, 4 * MONTH);
    const survives = Math.pow(1 - baleSpoilRateOf("baleArea"), 4);
    expect(b.storedBales.alfalfaHay).toBe(400 - Math.floor(400 * (1 - survives)));
    expect(b.storedBales.straw).toBe(200 - Math.floor(200 * (1 - survives)));
    // The bigger pile loses more bales, but the same FRACTION.
    expect(400 - b.storedBales.alfalfaHay!).toBeGreaterThan(200 - b.storedBales.straw!);
  });
});

describe("alfalfa's yield cut (maintainer decision, 2026-07-25)", () => {
  it("is 15% off the pre-cut figures, round and square alike", () => {
    expect(gameConfig.baleProducts.alfalfaHay.balesPerAcre).toBeCloseTo(2.13 * 0.85, 2);
    expect(gameConfig.baleProducts.alfalfaHaySquare.balesPerAcre).toBeCloseTo(1.78 * 0.85, 2);
  });

  it("leaves the PRICE at true market — the cut is yield, not value", () => {
    const p = gameConfig.baleProducts.alfalfaHay;
    expect(p.pricePerBale / p.tonsPerBale).toBeCloseTo(200, 0);
  });

  it("keeps round and square alfalfa yielding the same tonnage per acre", () => {
    const r = gameConfig.baleProducts.alfalfaHay;
    const q = gameConfig.baleProducts.alfalfaHaySquare;
    expect(q.balesPerAcre * q.tonsPerBale).toBeCloseTo(r.balesPerAcre * r.tonsPerBale, 2);
  });

  it("still yields a realistic 4-ish tons an acre a year over three cuttings", () => {
    const cuts = gameConfig.crops.alfalfa.harvestMonths!.length;
    const perYear = gameConfig.baleProducts.alfalfaHay.balesPerAcre * gameConfig.baleProducts.alfalfaHay.tonsPerBale * cuts;
    expect(perYear).toBeGreaterThan(3.5); // real alfalfa is 4–6 t/ac/yr
    expect(perYear).toBeLessThan(5);
  });
});
