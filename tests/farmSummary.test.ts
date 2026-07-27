import { describe, it, expect } from "vitest";
import { farmSummaryLine } from "../src/state/farmSummary";
import { newGame } from "../src/state/saveState";
import { MINUTES_PER_DAY } from "../src/sim/calendar";

describe("farmSummaryLine (extracted from main.ts, 2026-07-26)", () => {
  it("labels a never-saved farm", () => {
    expect(farmSummaryLine(null)).toBe("Not started yet");
  });

  it("formats year, cash and acreage from the save itself", () => {
    const save = newGame();
    save.money = 250_000;
    expect(farmSummaryLine({ save, clockNow: 0 })).toBe("Year 1 · $250,000 · 0 ac");
  });

  it("uses the SAVE'S daysPerMonth, not the live calendar global", () => {
    const save = newGame();
    save.money = 0;
    // 11 months of sim time at 10 days/month: Mar (start) + 11 → next year.
    const elevenMonths = 11 * 10 * MINUTES_PER_DAY;
    expect(farmSummaryLine({ save, clockNow: elevenMonths, daysPerMonth: 10 })).toContain("Year 2");
    // The same clock reading at the default 30 days/month is still year 1.
    expect(farmSummaryLine({ save, clockNow: elevenMonths })).toContain("Year 1");
  });
});
