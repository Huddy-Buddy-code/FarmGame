import { describe, it, expect, beforeAll } from "vitest";
import { setProjection } from "../src/geo/coords";
import { newGame } from "../src/state/saveState";
import { recordCash, categoryTotal, netCashflow, ledgerYears } from "../src/sim/ledger";
import { buyAgent, sellAgent, buyImplement, ensureAgents } from "../src/sim/tasks";
import { buyBuildingAt, sellBuilding } from "../src/sim/buildings";
import { sellGrain } from "../src/sim/economy";
import { borrowOpen, paydownOpen, tickLoans } from "../src/sim/finance";
import { minutesPerMonth, MONTHS_PER_YEAR } from "../src/sim/calendar";
import { gameConfig } from "../src/config/gameConfig";

beforeAll(() => setProjection(15, "N"));

describe("cashflow ledger (maintainer request, 2026-07-12)", () => {
  it("books equipment purchases and sales net under Land & Equipment", () => {
    const save = newGame();
    ensureAgents(save, [0, 0]);
    save.ledger = {}; // ignore the starting-fleet seeding for a clean read
    const tractor = buyAgent(save, "tractor", "small", [0, 0]);
    buyImplement(save, "plow", "small");
    const y = save.ledger[save.finance.openYear]!;
    expect(y.landEquipment?.["Tractors"]).toBe(-gameConfig.equipment.tractor.small.price);
    expect(y.landEquipment?.["Plows"]).toBe(-gameConfig.equipment.plow.small.price);
    sellAgent(save, tractor.id);
    expect(y.landEquipment?.["Tractors"]).toBe(0); // refund nets out
  });

  it("books buildings, crop sales, and loan payments to their categories", () => {
    const save = newGame();
    const silo = buyBuildingAt(save, "silo", [0, 0], "small");
    sellBuilding(save, silo.id);
    save.grain.corn = 100;
    sellGrain(save, "corn", 50, 4 * minutesPerMonth());

    borrowOpen(save, 100_000);
    // Turn the year + let one monthly payment fall due.
    const yearMinutes = MONTHS_PER_YEAR * minutesPerMonth();
    tickLoans(save, yearMinutes + 1); // year turns — loan locks, 1st payment scheduled
    tickLoans(save, yearMinutes + minutesPerMonth() + 2); // first payment falls due

    const y1 = save.ledger![1]!;
    expect(categoryTotal(y1, "landEquipment")).toBe(0); // silo bought + sold back
    expect(y1.cropRevenue?.["Corn"]).toBe(Math.round(50 * gameConfig.crops.corn.sellPricePerTon));

    // Borrowing books as money IN under Loan Expenses (2026-07-23) — before
    // this, the ledger showed repayments with no sign of the money that
    // created them, so the Net column disagreed with the actual bank balance.
    expect(y1.loanExpenses?.["Loans taken"]).toBe(100_000);

    const y2 = save.ledger![2]!;
    expect(y2.loanExpenses?.["Interest"]).toBeLessThan(0);
    expect(y2.loanExpenses?.["Principal (scheduled)"]).toBeLessThan(0);
    expect(netCashflow(y2)).toBeCloseTo(categoryTotal(y2, "loanExpenses"), 6);
  });

  it("loans taken are positive, loans repaid negative, and they net out", () => {
    const save = newGame();
    borrowOpen(save, 80_000);
    paydownOpen(save, 30_000);
    const y1 = save.ledger![1]!;
    expect(y1.loanExpenses?.["Loans taken"]).toBe(80_000);
    expect(y1.loanExpenses?.["Loans repaid"]).toBe(-30_000);
    expect(categoryTotal(y1, "loanExpenses")).toBe(50_000); // matches the cash actually kept
  });

  it("the ledger's loan total tracks the real change in cash", () => {
    const save = newGame();
    const before = save.money;
    borrowOpen(save, 120_000);
    paydownOpen(save, 45_000);
    expect(save.money - before).toBe(categoryTotal(save.ledger![1]!, "loanExpenses"));
  });

  it("keeps only the most recent five years, current year always listed first", () => {
    const save = newGame();
    for (let year = 1; year <= 8; year++) {
      save.finance.openYear = year;
      recordCash(save, "fieldExpenses", "Plowing", -100);
    }
    const years = ledgerYears(save);
    expect(years).toEqual([8, 7, 6, 5, 4]);
    expect(save.ledger![1]).toBeUndefined();
    expect(save.ledger![3]).toBeUndefined();
  });

  it("current year appears in ledgerYears even with nothing booked", () => {
    const save = newGame();
    expect(ledgerYears(save)).toEqual([1]);
  });
});
