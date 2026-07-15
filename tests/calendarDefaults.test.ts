import { describe, it, expect } from "vitest";
import { MINUTES_PER_DAY, getDaysPerMonth } from "../src/sim/calendar";

// A dedicated, untouched file (no other test here mutates daysPerMonth) so
// these see the calendar module's real production defaults, unlike
// farming.test.ts which deliberately pins daysPerMonth=30 for its own fixtures.
describe("calendar production defaults (maintainer request, 2026-07-14 — 12hr workday, 3-day months)", () => {
  it("a game day is the 12-hour workday (6am–6pm), not 24 hours", () => {
    expect(MINUTES_PER_DAY).toBe(12 * 60);
  });

  it("a fresh game starts at 3 days per month", () => {
    expect(getDaysPerMonth()).toBe(3);
  });
});
