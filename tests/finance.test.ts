import { describe, it, expect } from "vitest";
import { newGame } from "../src/state/saveState";
import {
  monthlyPaymentFor, borrowOpen, paydownOpen, paydownLoan, refinanceLoan, tickLoans,
} from "../src/sim/finance";
import { minutesPerMonth, dateOf } from "../src/sim/calendar";
import { gameConfig } from "../src/config/gameConfig";

describe("monthlyPaymentFor (standard fixed-rate amortization)", () => {
  it("matches the textbook formula", () => {
    const p = monthlyPaymentFor(100_000, 5, 180);
    // Known value for $100k @ 5%/15yr monthly: ~$790.79.
    expect(p).toBeCloseTo(790.79, 1);
  });

  it("scales linearly with principal", () => {
    const p1 = monthlyPaymentFor(50_000, 5, 180);
    const p2 = monthlyPaymentFor(100_000, 5, 180);
    expect(p2).toBeCloseTo(p1 * 2, 6);
  });
});

describe("open (pending) balance — borrow/paydown before lock-in", () => {
  it("borrowing adds cash immediately; paying down returns it", () => {
    const save = newGame();
    const cash = save.money;
    borrowOpen(save, 50_000);
    expect(save.money).toBe(cash + 50_000);
    expect(save.finance.pendingPrincipal).toBe(50_000);

    borrowOpen(save, 50_000);
    expect(save.finance.pendingPrincipal).toBe(100_000);

    paydownOpen(save, 30_000);
    expect(save.finance.pendingPrincipal).toBe(70_000);
    expect(save.money).toBe(cash + 70_000);
  });

  it("paydown clamps to what's pending, never goes negative", () => {
    const save = newGame();
    borrowOpen(save, 20_000);
    paydownOpen(save, 50_000); // more than pending
    expect(save.finance.pendingPrincipal).toBe(0);
    expect(save.money).toBe(gameConfig.startingMoney); // net zero, not overdrawn
  });

  it("paying down more than you can afford throws", () => {
    const save = newGame();
    borrowOpen(save, 500_000);
    save.money = 100; // spent it all elsewhere
    expect(() => paydownOpen(save, 500_000)).toThrow(/cash/);
  });
});

describe("lock-in: the open balance becomes a loan when the campaign year turns", () => {
  it("locks in exactly once the year rolls over, at the pending amount", () => {
    const save = newGame();
    borrowOpen(save, 150_000);
    expect(save.finance.loans).toHaveLength(0);

    const mpm = minutesPerMonth();
    // Still Year 1 partway through — no lock-in yet.
    tickLoans(save, 6 * mpm);
    expect(save.finance.loans).toHaveLength(0);
    expect(save.finance.pendingPrincipal).toBe(150_000);

    // 12 months after campaign start (Mar Yr1 -> Mar Yr2): year turns.
    tickLoans(save, 12 * mpm);
    expect(save.finance.loans).toHaveLength(1);
    const loan = save.finance.loans[0]!;
    expect(loan.originYear).toBe(1);
    expect(loan.principal).toBe(150_000);
    expect(loan.ratePercent).toBe(5);
    expect(loan.monthlyPayment).toBeCloseTo(monthlyPaymentFor(150_000, 5, 180), 6);

    // The open balance is reset and now belongs to Year 2.
    expect(save.finance.pendingPrincipal).toBe(0);
    expect(save.finance.openYear).toBe(2);
  });

  it("a year with nothing borrowed creates no loan — just rolls the open year forward", () => {
    const save = newGame();
    tickLoans(save, 12 * minutesPerMonth());
    expect(save.finance.loans).toHaveLength(0);
    expect(save.finance.openYear).toBe(2);
  });

  it("multiple years elapsing in one tick (e.g. a big time-skip) each lock in independently", () => {
    const save = newGame();
    const mpm = minutesPerMonth();
    borrowOpen(save, 100_000); // Year 1
    tickLoans(save, 12 * mpm); // locks Year 1, opens Year 2
    borrowOpen(save, 200_000); // Year 2
    // Jump straight to Year 4 in one call — Year 2 must still lock at 200k,
    // and Year 3 (nothing borrowed) must produce no loan.
    tickLoans(save, 36 * mpm);
    expect(save.finance.openYear).toBe(4);
    expect(save.finance.loans.map((l) => l.originYear)).toEqual([1, 2]);
    expect(save.finance.loans.find((l) => l.originYear === 2)!.principal).toBe(200_000);
  });
});

describe("monthly payments accrue on locked loans", () => {
  it("charges interest + principal each month, split by the standard formula", () => {
    const save = newGame();
    const mpm = minutesPerMonth();
    borrowOpen(save, 100_000);
    const lockTime = 12 * mpm;
    tickLoans(save, lockTime);
    const loan = save.finance.loans[0]!;
    const payment = loan.monthlyPayment;
    const cashBefore = save.money;

    // One month after lock-in, the first payment is due.
    tickLoans(save, lockTime + mpm);
    const expectedInterest = (100_000 * 5) / 100 / 12;
    const expectedPrincipal = payment - expectedInterest;
    expect(save.money).toBeCloseTo(cashBefore - payment, 4);
    expect(loan.principal).toBeCloseTo(100_000 - expectedPrincipal, 4);
  });

  it("a fully amortized loan pays itself off in exactly termMonths payments", () => {
    const save = newGame();
    const mpm = minutesPerMonth();
    borrowOpen(save, 50_000);
    tickLoans(save, 12 * mpm); // lock in at start of Year 2
    // Fast-forward exactly 180 months of payments.
    tickLoans(save, 12 * mpm + gameConfig.loan.termMonths * mpm);
    expect(save.finance.loans).toHaveLength(0); // paid off and removed
  });
});

describe("paying down a locked loan (brief request: payment stays fixed, payoff comes sooner)", () => {
  it("extra principal payments don't change the monthly payment", () => {
    const save = newGame();
    const mpm = minutesPerMonth();
    borrowOpen(save, 100_000);
    tickLoans(save, 12 * mpm);
    const loan = save.finance.loans[0]!;
    const paymentBefore = loan.monthlyPayment;

    paydownLoan(save, loan.id, 50_000);
    expect(loan.principal).toBe(50_000);
    expect(loan.monthlyPayment).toBe(paymentBefore); // unchanged

    // With the same payment against half the principal, it finishes MUCH
    // sooner than a fresh 180-month amortization would.
    tickLoans(save, 12 * mpm + 90 * mpm);
    expect(save.finance.loans).toHaveLength(0);
  });

  it("paying down more than the balance just pays it off and removes the loan", () => {
    const save = newGame();
    borrowOpen(save, 10_000);
    tickLoans(save, 12 * minutesPerMonth());
    const loan = save.finance.loans[0]!;
    const cash = save.money;
    paydownLoan(save, loan.id, 999_999);
    expect(save.finance.loans).toHaveLength(0);
    expect(save.money).toBe(cash - 10_000); // only the actual balance was charged
  });

  it("can't pay down more than you can afford", () => {
    const save = newGame();
    borrowOpen(save, 100_000);
    tickLoans(save, 12 * minutesPerMonth());
    const loan = save.finance.loans[0]!;
    save.money = 100;
    expect(() => paydownLoan(save, loan.id, 50_000)).toThrow(/cash/);
  });

  it("loans from different years are paid down independently", () => {
    const save = newGame();
    const mpm = minutesPerMonth();
    borrowOpen(save, 100_000);
    tickLoans(save, 12 * mpm); // Year 1 loan locked
    borrowOpen(save, 60_000);
    tickLoans(save, 24 * mpm); // Year 2 loan locked
    expect(save.finance.loans).toHaveLength(2);

    const y1 = save.finance.loans.find((l) => l.originYear === 1)!;
    const y2 = save.finance.loans.find((l) => l.originYear === 2)!;
    // Year 1's loan has already accrued a year of monthly payments by now, so
    // check the paydown reduces IT by exactly 50k, and leaves Year 2 alone.
    const y1Before = y1.principal;
    const y2Before = y2.principal;
    paydownLoan(save, y1.id, 50_000);
    expect(y1.principal).toBeCloseTo(y1Before - 50_000, 4);
    expect(y2.principal).toBeCloseTo(y2Before, 4); // untouched
  });
});

describe("refinance", () => {
  it("adds the flat fee to principal and resets the monthly payment to a fresh term", () => {
    const save = newGame();
    borrowOpen(save, 100_000);
    tickLoans(save, 12 * minutesPerMonth());
    const loan = save.finance.loans[0]!;
    const balanceBefore = loan.principal;

    refinanceLoan(save, loan.id);
    expect(loan.principal).toBe(balanceBefore + gameConfig.loan.refinanceFee);
    expect(loan.monthlyPayment).toBeCloseTo(
      monthlyPaymentFor(balanceBefore + gameConfig.loan.refinanceFee, 5, gameConfig.loan.termMonths),
      6,
    );
    expect(loan.refinancedCount).toBe(1);
  });

  it("the fee is added to principal, NOT charged in cash", () => {
    const save = newGame();
    borrowOpen(save, 100_000);
    tickLoans(save, 12 * minutesPerMonth());
    const loan = save.finance.loans[0]!;
    const cash = save.money;
    refinanceLoan(save, loan.id);
    expect(save.money).toBe(cash); // untouched
  });

  it("throws for an unknown loan id", () => {
    const save = newGame();
    expect(() => refinanceLoan(save, "loan-404")).toThrow(/not found/);
  });
});
