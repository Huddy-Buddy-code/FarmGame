import { describe, it, expect, beforeAll } from "vitest";
import { setProjection } from "../src/geo/coords";
import type { Meters } from "../src/geo/coords";
import { newGame } from "../src/state/saveState";
import type { Field, SaveState } from "../src/state/saveState";
import { ensureAgents, enqueueTask, tickTasks, buyImplement } from "../src/sim/tasks";
import { tickFarming, applyPlant, applyHarvestDone, productivityMultiplier, growthProgress, deriveStatus } from "../src/sim/farming";
import { buyBuildingAt, assignSiloCrop } from "../src/sim/buildings";
import { areaAcres } from "../src/geo/geometry";
import { minutesPerMonth, setDaysPerMonth } from "../src/sim/calendar";
import { gameConfig } from "../src/config/gameConfig";

beforeAll(() => setProjection(15, "N"));
setDaysPerMonth(30);

const APRIL_1 = minutesPerMonth();

const side100 = Math.sqrt(100 * 4046.8564224);
const boundary100: Meters[] = [[0, 0], [side100, 0], [side100, side100], [0, side100]];

const ACRES30 = 30;
const side30 = Math.sqrt(ACRES30 * 4046.8564224);
const boundary30: Meters[] = [[0, 0], [side30, 0], [side30, side30], [0, side30]];

function freshField(boundary: Meters[], status: Field["status"] = "tilled"): Field {
  return { id: "field-1", parcelId: "parcel-1", boundary, status };
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

function runWorld(save: SaveState, from: number, minutes: number, step = 60): number {
  let now = from;
  const end = from + minutes;
  while (now < end) {
    const dt = Math.min(step, end - now);
    now += dt;
    tickFarming(save, now);
    tickTasks(save, now, dt, () => 0.5);
  }
  return now;
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

describe("productivityMultiplier (maintainer request, 2026-07-16)", () => {
  it("defaults to 100% with no weeds and no fertilizing", () => {
    const field = freshField(boundary100, "growing");
    field.crop = "corn";
    expect(productivityMultiplier(field, 0)).toBeCloseTo(1, 6);
  });

  it("weeds cost a flat -10%", () => {
    const field = freshField(boundary100, "growing");
    field.crop = "corn";
    field.weedy = true;
    expect(productivityMultiplier(field, 0)).toBeCloseTo(0.9, 6);
  });

  it("fertilizing an annual crop adds a flat +30%", () => {
    const field = freshField(boundary100, "growing");
    field.crop = "corn";
    field.fertilized = true;
    expect(productivityMultiplier(field, 0)).toBeCloseTo(1.3, 6);
  });

  it("weeds and fertilizing stack (both apply at once)", () => {
    const field = freshField(boundary100, "growing");
    field.crop = "corn";
    field.weedy = true;
    field.fertilized = true;
    expect(productivityMultiplier(field, 0)).toBeCloseTo(1.2, 6);
  });

  it("a perennial's fertilize boost tapers 130% → 120% → 110% → 100% across the year's 3 cuttings", () => {
    const field = freshField(boundary100, "growing");
    field.crop = "grass"; // 3 cuttings/year (May/Jul/Sep)
    field.fertilized = true;
    field.cutYear = 1;
    field.cutsThisYear = 0;
    expect(productivityMultiplier(field, 0)).toBeCloseTo(1.3, 6); // before the 1st cut
    field.cutsThisYear = 1;
    expect(productivityMultiplier(field, 0)).toBeCloseTo(1.2, 6); // after the 1st cut
    field.cutsThisYear = 2;
    expect(productivityMultiplier(field, 0)).toBeCloseTo(1.1, 6); // after the 2nd cut
    field.cutsThisYear = 3;
    expect(productivityMultiplier(field, 0)).toBeCloseTo(1.0, 6); // after the 3rd (final) cut
  });

  it("an un-fertilized perennial never gets the taper boost", () => {
    const field = freshField(boundary100, "growing");
    field.crop = "alfalfa";
    field.cutYear = 1;
    field.cutsThisYear = 0;
    expect(productivityMultiplier(field, 0)).toBeCloseTo(1, 6);
  });

  it("crop rotation adds +10% when the current crop differs from last year's", () => {
    const field = freshField(boundary100, "growing");
    field.crop = "soybeans";
    field.lastCrop = "corn";
    expect(productivityMultiplier(field, 0)).toBeCloseTo(1.1, 6);
  });

  it("no rotation bonus for replanting the same crop as last year", () => {
    const field = freshField(boundary100, "growing");
    field.crop = "corn";
    field.lastCrop = "corn";
    expect(productivityMultiplier(field, 0)).toBeCloseTo(1, 6);
  });

  it("no rotation bonus on a field's first-ever crop (no lastCrop recorded)", () => {
    const field = freshField(boundary100, "growing");
    field.crop = "corn";
    expect(field.lastCrop).toBeUndefined();
    expect(productivityMultiplier(field, 0)).toBeCloseTo(1, 6);
  });

  it("rotation bonus stacks with weeds and fertilizing", () => {
    const field = freshField(boundary100, "growing");
    field.crop = "soybeans";
    field.lastCrop = "corn";
    field.fertilized = true;
    field.weedy = true;
    expect(productivityMultiplier(field, 0)).toBeCloseTo(1.3, 6); // 100 - 10 + 30 + 10
  });

  it("applyHarvestDone records the outgoing crop as lastCrop", () => {
    const field = freshField(boundary100, "growing");
    field.crop = "corn";
    applyHarvestDone(field);
    expect(field.lastCrop).toBe("corn");
    expect(field.crop).toBeUndefined();
  });
});

describe("productivity affects real output (integration)", () => {
  it("a fertilized corn field harvests 30% more grain than an identical un-fertilized one", () => {
    const plain = gameWithAgents();
    giveHaulingGear(plain);
    const plainField = freshField(boundary100);
    plain.fields.push(plainField);
    applyPlant(plainField, "corn", APRIL_1, () => 0.5); // fixes trueYield == base exactly

    const fert = gameWithAgents();
    giveHaulingGear(fert);
    const fertField = freshField(boundary100);
    fert.fields.push(fertField);
    applyPlant(fertField, "corn", APRIL_1, () => 0.5);
    fertField.fertilized = true;

    const ready = APRIL_1 + gameConfig.crops.corn.growMonths * minutesPerMonth();
    expect(growthProgress(plainField, ready)).toBe(1);
    expect(deriveStatus(plainField, ready)).toBe("ready");

    tickFarming(plain, ready);
    enqueueTask(plain, plainField, "harvest", ready);
    tickFarming(fert, ready);
    enqueueTask(fert, fertField, "harvest", ready);

    runUntil(plain, ready, () => plainField.status === "harvested");
    runUntil(plain, ready, () => plain.grain.corn >= 100 * gameConfig.crops.corn.baseYieldTonsPerAcre - 0.5);
    runUntil(fert, ready, () => fertField.status === "harvested");
    runUntil(fert, ready, () => fert.grain.corn >= 130 * gameConfig.crops.corn.baseYieldTonsPerAcre - 0.5);

    expect(plain.grain.corn).toBeCloseTo(100 * gameConfig.crops.corn.baseYieldTonsPerAcre, 0);
    expect(fert.grain.corn).toBeCloseTo(plain.grain.corn * 1.3, 0);
  });

  it("a rotated field (different crop than last year) harvests 10% more than a repeat-cropped one", () => {
    const rotated = gameWithAgents();
    giveHaulingGear(rotated);
    const rotatedField = freshField(boundary100);
    rotatedField.lastCrop = "soybeans";
    rotated.fields.push(rotatedField);
    applyPlant(rotatedField, "corn", APRIL_1, () => 0.5); // fixes trueYield == base exactly

    const repeat = gameWithAgents();
    giveHaulingGear(repeat);
    const repeatField = freshField(boundary100);
    repeatField.lastCrop = "corn";
    repeat.fields.push(repeatField);
    applyPlant(repeatField, "corn", APRIL_1, () => 0.5);

    const ready = APRIL_1 + gameConfig.crops.corn.growMonths * minutesPerMonth();
    tickFarming(rotated, ready);
    enqueueTask(rotated, rotatedField, "harvest", ready);
    tickFarming(repeat, ready);
    enqueueTask(repeat, repeatField, "harvest", ready);

    runUntil(repeat, ready, () => repeatField.status === "harvested");
    runUntil(repeat, ready, () => repeat.grain.corn >= 100 * gameConfig.crops.corn.baseYieldTonsPerAcre - 0.5);
    runUntil(rotated, ready, () => rotatedField.status === "harvested");
    runUntil(rotated, ready, () => rotated.grain.corn >= 110 * gameConfig.crops.corn.baseYieldTonsPerAcre - 0.5);

    expect(repeat.grain.corn).toBeCloseTo(100 * gameConfig.crops.corn.baseYieldTonsPerAcre, 0);
    expect(rotated.grain.corn).toBeCloseTo(repeat.grain.corn * 1.1, 0);
  });

  it("weeds cost 10% of the harvest", () => {
    const save = gameWithAgents();
    giveHaulingGear(save);
    const field = freshField(boundary100);
    save.fields.push(field);
    applyPlant(field, "corn", APRIL_1, () => 0.5);
    field.weedy = true;

    const ready = APRIL_1 + gameConfig.crops.corn.growMonths * minutesPerMonth();
    tickFarming(save, ready);
    enqueueTask(save, field, "harvest", ready);
    runUntil(save, ready, () => field.status === "harvested");
    runUntil(save, ready, () => save.grain.corn >= 90 * gameConfig.crops.corn.baseYieldTonsPerAcre - 0.5);
    expect(save.grain.corn).toBeCloseTo(90 * gameConfig.crops.corn.baseYieldTonsPerAcre, 0);
  });

  it("the fertilize task actually sets field.fertilized (wiring check)", () => {
    const save = gameWithAgents();
    buyImplement(save, "sprayer", "medium");
    const field = freshField(boundary100);
    save.fields.push(field);
    applyPlant(field, "corn", APRIL_1, () => 0.5);
    const mayStart = APRIL_1 + minutesPerMonth();
    tickFarming(save, mayStart);
    expect(field.status).toBe("growing");
    enqueueTask(save, field, "fertilize", mayStart);
    runWorld(save, mayStart, 5 * 24 * 60, 60);
    expect(field.fertilized).toBe(true);
  });

  it("a fertilized perennial's first cut bales ~130%, dropping toward 100% by the last cut", () => {
    const save = gameWithAgents();
    buyImplement(save, "mower", "medium");
    buyImplement(save, "rake", "small");
    buyImplement(save, "bailer", "medium");
    const field = freshField(boundary30, "tilled");
    save.fields.push(field);
    applyPlant(field, "grass", 0, () => 0.5); // planted in March (grass's window)
    field.fertilized = true;

    const MAY = 2 * minutesPerMonth();
    tickFarming(save, MAY);
    expect(field.status).toBe("ready");
    enqueueTask(save, field, "mow", MAY);
    let now = runUntil(save, MAY, () => field.status === "harvested" && !!field.forageReady);
    // First cut: fertilized, none taken yet — full +30%.
    enqueueTask(save, field, "rake", now);
    enqueueTask(save, field, "bale", now);
    now = runUntil(save, now, () => field.status === "growing"); // applyBaleDone's perennial settle status — baling is done
    // Use the field's own computed acreage (matches what the game itself bales
    // off of) rather than the nominal 30 — a sqrt/square roundtrip can land a
    // hair under, which the game's own Math.round already absorbs identically.
    const expectedFirst = Math.max(1, Math.round(areaAcres(boundary30) * gameConfig.baleProducts.hay.balesPerAcre * 1.3));
    expect(field.baleLocations!.length).toBe(expectedFirst);
  });
});
