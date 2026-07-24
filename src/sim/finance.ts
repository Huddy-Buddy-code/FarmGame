/**
 * Loans (brief §8, "loan interest, the difficulty dial"). v1 is deliberately
 * simple: a single fixed-rate, fixed-15-year-term amortized loan PER CAMPAIGN
 * YEAR the player borrows in (maintainer design, 2026-07-11).
 *
 * How it works: the player dials in how much to borrow this year with +/-
 * button clicks on an OPEN (not-yet-amortizing) balance — cash moves
 * immediately on each click. The moment the campaign year turns, that open
 * balance LOCKS IN as its own `Loan`: 5% annual rate, 180-month amortization,
 * a fixed monthly payment computed once at lock-in. A fresh, empty open
 * balance then starts accumulating for the new year. Loans from different
 * years are independent — pay any of them down whenever, in $50k bites or a
 * final smaller bite that finishes it off.
 *
 * Extra principal payments do NOT change the monthly payment (maintainer
 * choice) — they just retire the loan sooner, since the fixed payment now
 * covers a bigger share of principal each month as the balance shrinks.
 *
 * Refinancing resets a locked loan's amortization to a fresh 15 years (new
 * monthly payment) for a flat fee added to the loan's PRINCIPAL, not charged
 * in cash.
 *
 * Pure logic on the save-state: no map, no DOM, unit-testable like
 * farming.ts/tasks.ts.
 */

import { gameConfig } from "../config/gameConfig";
import type { SaveState, Loan } from "../state/saveState";
import type { SimTime } from "./clock";
import { dateOf, minutesPerMonth } from "./calendar";
import { recordCash } from "./ledger";

/** The fixed monthly payment for a standard fixed-rate amortized loan. */
export function monthlyPaymentFor(principal: number, ratePercent: number, termMonths: number): number {
  const r = ratePercent / 100 / 12;
  if (r === 0) return principal / termMonths;
  const factor = Math.pow(1 + r, termMonths);
  return (principal * r * factor) / (factor - 1);
}

/** Borrow against this year's OPEN (not-yet-locked) balance — cash in hand
 * right away; the amortization terms aren't set until the year turns. */
export function borrowOpen(save: SaveState, amount: number): void {
  if (amount <= 0) return;
  save.finance.pendingPrincipal += amount;
  save.money += amount;
  // Borrowing is real cash IN and was previously invisible to the cashflow
  // ledger — only scheduled interest/principal ever booked, so the Loan
  // Expenses row showed the repayments with no sign of the money that created
  // them, and the Net column silently disagreed with the actual bank balance
  // (maintainer request, 2026-07-23).
  recordCash(save, "loanExpenses", "Loans taken", amount);
}

/** Pay down this year's OPEN balance before it locks in (changed your mind
 * about how much to borrow) — hands the cash back. Clamped to what's pending
 * and to what's affordable. */
export function paydownOpen(save: SaveState, amount: number): void {
  const pay = Math.min(amount, save.finance.pendingPrincipal);
  if (pay <= 0) return;
  if (pay > save.money) {
    throw new Error(`That's $${Math.round(pay).toLocaleString()} — not enough cash`);
  }
  save.finance.pendingPrincipal -= pay;
  save.money -= pay;
  recordCash(save, "loanExpenses", "Loans repaid", -pay);
}

/** Pay down a LOCKED loan's principal directly. Doesn't touch the monthly
 * payment — just retires the loan sooner. Clamped to the remaining balance;
 * paying it off in full removes the loan. */
export function paydownLoan(save: SaveState, loanId: string, amount: number): void {
  const loan = save.finance.loans.find((l) => l.id === loanId);
  if (!loan) throw new Error(`Loan ${loanId} not found`);
  const pay = Math.min(amount, loan.principal);
  if (pay <= 0) return;
  if (pay > save.money) {
    throw new Error(`That's $${Math.round(pay).toLocaleString()} — not enough cash`);
  }
  save.money -= pay;
  recordCash(save, "loanExpenses", "Loans repaid", -pay);
  loan.principal -= pay;
  if (loan.principal <= 0.01) {
    save.finance.loans.splice(save.finance.loans.indexOf(loan), 1);
  }
}

/** Refinance a locked loan: resets its amortization to a fresh 15-year term
 * (monthly payment recalculated from the new balance) for a flat fee added
 * to the PRINCIPAL — not charged in cash. */
export function refinanceLoan(save: SaveState, loanId: string): void {
  const loan = save.finance.loans.find((l) => l.id === loanId);
  if (!loan) throw new Error(`Loan ${loanId} not found`);
  loan.principal += gameConfig.loan.refinanceFee;
  loan.monthlyPayment = monthlyPaymentFor(loan.principal, loan.ratePercent, gameConfig.loan.termMonths);
  loan.refinancedCount = (loan.refinancedCount ?? 0) + 1;
}

/**
 * Advance loans by calendar time: lock in any campaign year(s) that turned
 * over since the last tick, then charge every scheduled monthly payment up to
 * `now`. Handles multiple years/months elapsing in one call (time-
 * compression, "skip month") the same way `tickTasks`/`tickFarming` do.
 */
export function tickLoans(save: SaveState, now: SimTime): void {
  const year = dateOf(now).year;
  while (save.finance.openYear < year) {
    if (save.finance.pendingPrincipal > 0) {
      const principal = save.finance.pendingPrincipal;
      const loan: Loan = {
        id: `loan-${save.finance.openYear}`,
        originYear: save.finance.openYear,
        principal,
        ratePercent: gameConfig.loan.ratePercent,
        monthlyPayment: monthlyPaymentFor(principal, gameConfig.loan.ratePercent, gameConfig.loan.termMonths),
        nextPaymentAt: now + minutesPerMonth(),
      };
      save.finance.loans.push(loan);
    }
    save.finance.pendingPrincipal = 0;
    save.finance.openYear++;
  }

  for (const loan of [...save.finance.loans]) {
    while (loan.nextPaymentAt <= now) {
      const interest = (loan.principal * loan.ratePercent) / 100 / 12;
      const principalPortion = Math.min(loan.monthlyPayment - interest, loan.principal);
      save.money -= interest + principalPortion;
      recordCash(save, "loanExpenses", "Interest", -interest);
      recordCash(save, "loanExpenses", "Principal (scheduled)", -principalPortion);
      loan.principal -= principalPortion;
      loan.nextPaymentAt += minutesPerMonth();
      if (loan.principal <= 0.01) {
        save.finance.loans.splice(save.finance.loans.indexOf(loan), 1);
        break;
      }
    }
  }
}
