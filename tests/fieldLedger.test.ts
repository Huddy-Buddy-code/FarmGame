import { describe, it, expect, beforeAll } from "vitest";
import { setProjection } from "../src/geo/coords";
import type { Meters } from "../src/geo/coords";
import { newGame } from "../src/state/saveState";
import type { Field, SaveState } from "../src/state/saveState";
import {
  recordFieldCash, recordFieldCrop, fieldCategoryTotal, fieldNetCashflow, fieldLedgerYears,
} from "../src/sim/fieldLedger";
import {
  addProduce, grainUnitPrice, baleUnitPrice, seasonalMultiplier, monthOf,
} from "../src/sim/market";
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

  it("grain revenue is booked at SALE time & price, not at harvest", () => {
    const save = gameWithAgents();
    giveHaulingGear(save);
    const field = freshField("field-1", boundary100);
    save.fields.push(field);
    applyPlant(field, "corn", APRIL_1, () => 0.5); // fixes trueYield == base exactly

    const ready = APRIL_1 + gameConfig.crops.corn.growMonths * minutesPerMonth();
    tickFarming(save, ready); // jump straight to ready (no weed flush in between)
    enqueueTask(save, field, "harvest", ready);
    runUntil(save, ready, () => field.status === "harvested");
    runUntil(save, ready, () => save.grain.corn >= 100 * gameConfig.crops.corn.baseYieldTonsPerAcre - 0.5);

    // Harvest alone books NO field revenue — it just records provenance.
    expect(fieldCategoryTotal(save.fieldLedger!["field-1"]?.[save.finance.openYear], "revenue")).toBe(0);

    // Sell at the peak month (Dec = +25%); the whole pooled sale traces back to
    // this one field, so it gets full credit at the sale price.
    const dec = 9 * minutesPerMonth();
    expect(seasonalMultiplier("corn", monthOf(dec))).toBeCloseTo(1.25, 6);
    const banked = save.grain.corn;
    const { revenue } = sellGrain(save, "corn", Infinity, dec);
    const y = save.fieldLedger!["field-1"]![save.finance.openYear]!;
    expect(fieldCategoryTotal(y, "revenue")).toBeCloseTo(revenue, 0);
    expect(fieldCategoryTotal(y, "revenue")).toBeCloseTo(Math.round(banked * grainUnitPrice("corn", monthOf(dec))), 0);
  });

  it("a pooled grain sale splits revenue pro-rata across contributing fields", () => {
    const save = newGame();
    addProduce(save, "corn", "field-a", 60);
    addProduce(save, "corn", "field-b", 40);
    save.grain.corn = 100;
    const july = 4 * minutesPerMonth(); // base-price month
    const unit = grainUnitPrice("corn", monthOf(july));
    sellGrain(save, "corn", 100, july);
    const yA = save.fieldLedger!["field-a"]![save.finance.openYear]!;
    const yB = save.fieldLedger!["field-b"]![save.finance.openYear]!;
    expect(fieldCategoryTotal(yA, "revenue")).toBeCloseTo(Math.round(60 * unit), 0);
    expect(fieldCategoryTotal(yB, "revenue")).toBeCloseTo(Math.round(40 * unit), 0);
  });

  it("the plant task stamps the year's crop on the field ledger (Finances crop icon)", () => {
    const save = gameWithAgents();
    save.money += 1_000_000;
    const field = freshField("field-1", boundary100, "tilled");
    save.fields.push(field);
    enqueueTask(save, field, "plant", APRIL_1, "corn"); // April = corn's planting window
    expect(save.fieldLedger!["field-1"]![save.finance.openYear]!.crop).toBe("corn");
  });

  it("a field's own bale sale credits that field at the sale month's price (not at bale time)", () => {
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

    // Baling books NO field revenue yet — the bales sit unsold.
    expect(fieldCategoryTotal(save.fieldLedger!["field-1"]?.[save.finance.openYear], "revenue")).toBe(0);

    const baleCount = field.baleLocations!.length;
    const jan = 10 * minutesPerMonth(); // hay's peak too (+25%)
    const { revenue } = sellBales(save, field, jan);
    const y = save.fieldLedger!["field-1"]![save.finance.openYear]!;
    expect(Object.keys(y.revenue ?? {})).toEqual([`${gameConfig.baleProducts.hay.name} bales`]);
    expect(fieldCategoryTotal(y, "revenue")).toBeCloseTo(revenue, 0);
    expect(fieldCategoryTotal(y, "revenue")).toBeCloseTo(Math.round(baleCount * baleUnitPrice("hay", monthOf(jan))), 0);
  });
});
