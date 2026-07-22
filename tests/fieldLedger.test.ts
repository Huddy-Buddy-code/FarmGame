import { describe, it, expect, beforeAll } from "vitest";
import { setProjection } from "../src/geo/coords";
import type { Meters } from "../src/geo/coords";
import { newGame } from "../src/state/saveState";
import type { Field, SaveState } from "../src/state/saveState";
import {
  recordFieldCash, recordFieldCrop, fieldCategoryTotal, fieldNetCashflow, fieldLedgerYears,
} from "../src/sim/fieldLedger";
import { sellGrain, sellBales } from "../src/sim/economy";
import { ensureAgents, enqueueTask, cancelTask, tickTasks, buyImplement } from "../src/sim/tasks";
import { applyPlant, tickFarming } from "../src/sim/farming";
import { buyBuildingAt, assignSiloCrop } from "../src/sim/buildings";
import { minutesPerMonth, setDaysPerMonth } from "../src/sim/calendar";
import { gameConfig } from "../src/config/gameConfig";

beforeAll(() => setProjection(15, "N"));
setDaysPerMonth(30);

const APRIL_1 = minutesPerMonth();

const side100 = Math.sqrt(100 * 4046.8564224);
const boundary100: Meters[] = [[0, 0], [side100, 0], [side100, side100], [0, side100]];
const side30 = Math.sqrt(30 * 4046.8564224);
const boundary30: Meters[] = [[0, 0], [side30, 0], [side30, side30], [0, side30]];

function freshField(id: string, boundary: Meters[], status: Field["status"] = "tilled"): Field {
  return { id, parcelId: `${id}-parcel`, boundary, status };
}

function gameWithAgents(): SaveState {
  const save = newGame();
  ensureAgents(save, [0, 0]);
  return save;
}

function giveHaulingGear(save: SaveState): void {
  save.money += 1_000_000;
  const silo = buyBuildingAt(save, "silo", [-50, -50], "large");
  assignSiloCrop(save, silo.id, "corn");
  buyImplement(save, "grainTrailer", "medium");
}

function runUntil(save: SaveState, from: number, done: () => boolean, capMinutes = 200_000, step = 120): number {
  let now = from;
  while (!done() && now - from < capMinutes) {
    now += step;
    tickFarming(save, now);
    tickTasks(save, now, step, () => 0.5);
  }
  return now;
}

describe("recordFieldCash / fieldCategoryTotal / fieldNetCashflow / fieldLedgerYears", () => {
  it("books an expense under one field, net-of-refund, without touching another field's bucket", () => {
    const save = newGame();
    recordFieldCash(save, "field-1", "expenses", "Plowing", -500);
    recordFieldCash(save, "field-2", "expenses", "Plowing", -700);
    const y1 = save.fieldLedger!["field-1"]![save.finance.openYear]!;
    const y2 = save.fieldLedger!["field-2"]![save.finance.openYear]!;
    expect(fieldCategoryTotal(y1, "expenses")).toBe(-500);
    expect(fieldCategoryTotal(y2, "expenses")).toBe(-700);
    // A refund (positive) nets against the same item, same field only.
    recordFieldCash(save, "field-1", "expenses", "Plowing", 500);
    expect(fieldCategoryTotal(y1, "expenses")).toBe(0);
    expect(fieldCategoryTotal(y2, "expenses")).toBe(-700); // untouched
  });

  it("net cashflow is expenses + revenue for one field-year", () => {
    const save = newGame();
    recordFieldCash(save, "field-1", "expenses", "Plowing", -200);
    recordFieldCash(save, "field-1", "revenue", "Corn", 900);
    const y = save.fieldLedger!["field-1"]![save.finance.openYear]!;
    expect(fieldNetCashflow(y)).toBe(700);
  });

  it("keeps only the most recent five years PER FIELD, current year always listed first", () => {
    const save = newGame();
    for (let year = 1; year <= 8; year++) {
      save.finance.openYear = year;
      recordFieldCash(save, "field-1", "expenses", "Plowing", -100);
    }
    const years = fieldLedgerYears(save, "field-1");
    expect(years).toEqual([8, 7, 6, 5, 4]);
    expect(save.fieldLedger!["field-1"]![1]).toBeUndefined();
    expect(save.fieldLedger!["field-1"]![3]).toBeUndefined();
  });

  it("current year appears even with nothing booked for that field", () => {
    const save = newGame();
    expect(fieldLedgerYears(save, "field-1")).toEqual([1]);
  });

  it("no-ops on a zero amount", () => {
    const save = newGame();
    recordFieldCash(save, "field-1", "expenses", "Plowing", 0);
    expect(save.fieldLedger?.["field-1"]).toBeUndefined();
  });

  it("recordFieldCrop stamps the year's crop (for the Finances tab's crop icon)", () => {
    const save = newGame();
    recordFieldCrop(save, "field-1", "corn");
    expect(save.fieldLedger!["field-1"]![save.finance.openYear]!.crop).toBe("corn");
  });
});

describe("field-scoped booking at real call sites (integration)", () => {
  it("enqueueTask/cancelTask book+refund the task cost to the FIELD's own ledger bucket", () => {
    const save = gameWithAgents();
    save.money += 1_000_000;
    const fieldA = freshField("field-a", boundary100, "stubble");
    const fieldB = freshField("field-b", boundary100, "stubble");
    save.fields.push(fieldA, fieldB);

    const winterNow = 9 * minutesPerMonth(); // Dec — plow window
    const taskA = enqueueTask(save, fieldA, "plow", winterNow);
    enqueueTask(save, fieldB, "plow", winterNow);

    const yA = save.fieldLedger!["field-a"]![save.finance.openYear]!;
    const yB = save.fieldLedger!["field-b"]![save.finance.openYear]!;
    expect(fieldCategoryTotal(yA, "expenses")).toBe(-taskA.costPaid);
    expect(fieldCategoryTotal(yB, "expenses")).toBe(-taskA.costPaid); // same acreage, same cost
    expect(fieldCategoryTotal(yA, "expenses")).not.toBe(0);

    // Canceling refunds — nets THIS field's bucket back to zero, leaves the
    // other field's completely untouched.
    cancelTask(save, taskA.id);
    expect(fieldCategoryTotal(yA, "expenses")).toBe(0);
    expect(fieldCategoryTotal(yB, "expenses")).not.toBe(0);
  });

  it("grain revenue is booked at HARVEST time at the base config price", () => {
    const save = gameWithAgents();
    giveHaulingGear(save);
    const field = freshField("field-1", boundary100);
    save.fields.push(field);
    applyPlant(field, "corn", APRIL_1, () => 0.5); // fixes trueYield == base exactly

    const ready = APRIL_1 + gameConfig.crops.corn.growMonths * minutesPerMonth();
    tickFarming(save, ready); // jump straight to ready (no weed flush in between)
    enqueueTask(save, field, "harvest", ready);
    runUntil(save, ready, () => field.status === "harvested");

    // The moment the crop comes off: tons x base sellPricePerTon, no sale needed.
    const expected = Math.round(100 * gameConfig.crops.corn.baseYieldTonsPerAcre * gameConfig.crops.corn.sellPricePerTon);
    const y = save.fieldLedger!["field-1"]![save.finance.openYear]!;
    expect(fieldCategoryTotal(y, "revenue")).toBeCloseTo(expected, -1);
    expect(Object.keys(y.revenue ?? {})).toEqual([gameConfig.crops.corn.name]);

    // A later sale of the pooled grain books NO additional field revenue.
    const before = fieldCategoryTotal(y, "revenue");
    runUntil(save, ready, () => save.grain.corn >= 100 * gameConfig.crops.corn.baseYieldTonsPerAcre - 0.5);
    sellGrain(save, "corn", Infinity, 9 * minutesPerMonth());
    expect(fieldCategoryTotal(y, "revenue")).toBe(before);
  });

  it("the plant task stamps the year's crop on the field ledger (Finances crop icon)", () => {
    const save = gameWithAgents();
    save.money += 1_000_000;
    const field = freshField("field-1", boundary100, "tilled");
    save.fields.push(field);
    enqueueTask(save, field, "plant", APRIL_1, "corn"); // April = corn's planting window
    expect(save.fieldLedger!["field-1"]![save.finance.openYear]!.crop).toBe("corn");
  });

  it("bale revenue is booked at BALE time at the base per-bale price", () => {
    const save = gameWithAgents();
    buyImplement(save, "mower", "medium");
    buyImplement(save, "rake", "small");
    buyImplement(save, "bailer", "medium");
    const field = freshField("field-1", boundary30, "tilled");
    save.fields.push(field);
    applyPlant(field, "grass", 0, () => 0.5); // planted in March (grass's window)

    const MAY = 2 * minutesPerMonth();
    tickFarming(save, MAY);
    expect(field.status).toBe("ready");
    enqueueTask(save, field, "mow", MAY);
    let now = runUntil(save, MAY, () => field.status === "harvested" && !!field.forageReady);
    enqueueTask(save, field, "rake", now);
    enqueueTask(save, field, "bale", now);
    now = runUntil(save, now, () => field.status === "growing"); // applyBaleDone's perennial settle

    // Bale-run completion books bales x base pricePerBale — no sale needed.
    const baleCount = field.baleLocations!.length;
    expect(baleCount).toBeGreaterThan(0);
    const y = save.fieldLedger!["field-1"]![save.finance.openYear]!;
    expect(Object.keys(y.revenue ?? {})).toEqual([`${gameConfig.baleProducts.hay.name} bales`]);
    expect(fieldCategoryTotal(y, "revenue")).toBe(Math.round(baleCount * gameConfig.baleProducts.hay.pricePerBale));

    // Selling the bales later books NO additional field revenue.
    const before = fieldCategoryTotal(y, "revenue");
    sellBales(save, field, 10 * minutesPerMonth());
    expect(fieldCategoryTotal(y, "revenue")).toBe(before);
  });
});
