import { describe, it, expect, beforeAll } from "vitest";
import { setProjection } from "../src/geo/coords";
import type { Meters } from "../src/geo/coords";
import { areaAcres } from "../src/geo/geometry";
import { newGame } from "../src/state/saveState";
import type { Field } from "../src/state/saveState";
import { gameConfig } from "../src/config/gameConfig";
import { netWorth } from "../src/sim/economy";
import { ensureAgents, agentPrice, implementPrice, buyAgent, buyImplement, sellAgent } from "../src/sim/tasks";
import { borrowOpen, tickLoans } from "../src/sim/finance";
import { minutesPerMonth } from "../src/sim/calendar";

beforeAll(() => setProjection(15, "N"));

const side = Math.sqrt(100 * 4046.8564224); // ~100-acre square, same shape as other tests
const boundary: Meters[] = [[0, 0], [side, 0], [side, side], [0, side]];

describe("netWorth (maintainer spec, 2026-07-11: cash + land value + equipment value)", () => {
  it("a fresh game is just starting cash — no land, no equipment", () => {
    const save = newGame();
    const nw = netWorth(save);
    expect(nw.cash).toBe(gameConfig.startingMoney);
    expect(nw.landValue).toBe(0);
    expect(nw.equipmentValue).toBe(0);
    expect(nw.total).toBe(gameConfig.startingMoney);
  });

  it("land is valued at what was actually paid (mirrors sellField's refund), not a recomputed rate", () => {
    const save = newGame();
    const field: Field = { id: "field-1", parcelId: "parcel-1", boundary, status: "stubble", purchaseCost: 12_345 };
    save.fields.push(field);
    expect(netWorth(save).landValue).toBe(12_345);
  });

  it("falls back to acres × current land price when purchaseCost is missing (pre-upgrade saves)", () => {
    const save = newGame();
    const field: Field = { id: "field-1", parcelId: "parcel-1", boundary, status: "stubble" };
    save.fields.push(field);
    expect(netWorth(save).landValue).toBe(Math.round(areaAcres(boundary) * gameConfig.landPricePerAcre));
  });

  it("equipment value sums every owned machine and implement at their purchase price", () => {
    const save = newGame();
    ensureAgents(save, [0, 0]); // medium tractor + medium combine + medium plow + medium planter
    const expected =
      agentPrice("tractor", "medium") + agentPrice("harvester", "medium") +
      implementPrice("plow", "medium") + implementPrice("planter", "medium");
    expect(netWorth(save).equipmentValue).toBe(expected);

    const extraTractor = buyAgent(save, "tractor", "large", [0, 0]);
    const extraPlow = buyImplement(save, "plow", "small");
    expect(netWorth(save).equipmentValue).toBe(
      expected + agentPrice("tractor", "large") + implementPrice("plow", "small"),
    );

    // Selling refunds the purchase price 1:1, so net worth is unchanged by a sale
    // (cash goes up exactly as equipment value goes down).
    const before = netWorth(save).total;
    sellAgent(save, extraTractor.id);
    expect(netWorth(save).total).toBe(before);
    void extraPlow;
  });

  it("total is cash + land + equipment − debt", () => {
    const save = newGame();
    ensureAgents(save, [0, 0]);
    const field: Field = { id: "field-1", parcelId: "parcel-1", boundary, status: "stubble", purchaseCost: 50_000 };
    save.fields.push(field);
    const nw = netWorth(save);
    expect(nw.total).toBe(nw.cash + nw.landValue + nw.equipmentValue - nw.debt);
  });

  it("borrowing shows up as debt and cancels out — net worth doesn't change just from taking a loan", () => {
    const save = newGame();
    const before = netWorth(save).total;
    borrowOpen(save, 50_000); // cash +50k, but pendingPrincipal (debt) +50k too
    const nw = netWorth(save);
    expect(nw.cash).toBe(before + 50_000);
    expect(nw.debt).toBe(50_000);
    expect(nw.total).toBe(before); // the borrowed cash is exactly offset by owing it back
  });

  it("a locked-in loan still counts as debt, and shrinks as it's paid down", () => {
    const save = newGame();
    borrowOpen(save, 100_000);
    tickLoans(save, 12 * minutesPerMonth()); // locks in as a Year 1 loan
    expect(save.finance.loans).toHaveLength(1);
    expect(netWorth(save).debt).toBeCloseTo(100_000, 4);

    // A scheduled monthly payment reduces both cash and the loan balance —
    // debt tracks the loan's remaining principal live.
    tickLoans(save, 13 * minutesPerMonth());
    const loan = save.finance.loans[0]!;
    expect(netWorth(save).debt).toBeCloseTo(loan.principal, 6);
    expect(netWorth(save).debt).toBeLessThan(100_000);
  });
});
