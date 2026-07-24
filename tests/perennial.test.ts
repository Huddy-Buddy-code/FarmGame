import { describe, it, expect, beforeAll } from "vitest";
import { setProjection } from "../src/geo/coords";
import type { Meters } from "../src/geo/coords";
import { newGame } from "../src/state/saveState";
import type { Field, SaveState } from "../src/state/saveState";
import {
  ensureAgents, enqueueTask, tickTasks, buyImplement, autoManageAll,
} from "../src/sim/tasks";
import {
  tickFarming, applyPlant, deriveStatus, isPerennial, canSeedPerennial,
  balesPerAcreForField, isPerennialDormant,
} from "../src/sim/farming";
import { sellBales } from "../src/sim/economy";
import { minutesPerMonth } from "../src/sim/calendar";
import { baleInstantPrice } from "../src/sim/market";
import { gameConfig } from "../src/config/gameConfig";

beforeAll(() => setProjection(15, "N"));

// sim time 0 = March 1 (month index 2). Month M (0-based) is (M-2) months in.
const MARCH = 0;
const APRIL = 1 * minutesPerMonth();
const MAY = 2 * minutesPerMonth();
const JULY = 4 * minutesPerMonth();
const SEPTEMBER = 6 * minutesPerMonth();
const OCTOBER = 7 * minutesPerMonth();

const ACRES = 30;
const side = Math.sqrt(ACRES * 4046.8564224);
const boundary: Meters[] = [[0, 0], [side, 0], [side, side], [0, side]];

function freshField(): Field {
  return { id: "field-1", parcelId: "parcel-1", boundary, status: "stubble" };
}

/** Farm with a tractor + the full forage kit (mower, rake, baler). */
function forageGame(): SaveState {
  const save = newGame();
  ensureAgents(save, [0, 0]); // medium tractor + plow + planter + medium combine
  buyImplement(save, "mower", "medium");
  buyImplement(save, "rake", "small");
  buyImplement(save, "bailer", "medium");
  return save;
}

function runUntil(save: SaveState, from: number, done: () => boolean, capMinutes = 300_000, step = 30): number {
  let now = from;
  while (!done() && now - from < capMinutes) {
    now += step;
    tickFarming(save, now);
    autoManageAll(save, now);
    tickTasks(save, now, step, () => 0.5);
  }
  return now;
}

/** Plant a perennial as an established stand (bypasses the plow + plant tasks —
 * ground is pre-tilled since establishing now requires it, same as an annual). */
function establish(save: SaveState, crop: "grass" | "alfalfa"): Field {
  const field = freshField();
  field.status = "tilled";
  save.fields.push(field);
  applyPlant(field, crop, MARCH, () => 0.5);
  return field;
}

describe("perennial forage crops — grass & alfalfa (maintainer request, 2026-07-13)", () => {
  it("are flagged perennial and need tilled ground, same as an annual", () => {
    expect(isPerennial("grass")).toBe(true);
    expect(isPerennial("alfalfa")).toBe(true);
    expect(isPerennial("corn")).toBe(false);
    expect(canSeedPerennial("tilled")).toBe(true);
    expect(canSeedPerennial("stubble")).toBe(false);
    expect(canSeedPerennial("mulched")).toBe(false);
    expect(canSeedPerennial("growing")).toBe(false);

    const save = newGame();
    ensureAgents(save, [0, 0]);
    const field = freshField();
    field.status = "tilled";
    save.fields.push(field);
    // Planting is accepted on tilled ground in the March window.
    const task = enqueueTask(save, field, "plant", MARCH, "grass");
    expect(task.crop).toBe("grass");

    // Bare stubble is refused until it's plowed.
    const bare = freshField();
    bare.id = "field-2";
    save.fields.push(bare);
    expect(() => enqueueTask(save, bare, "plant", MARCH, "grass")).toThrow(/seeded/);
  });

  it("refuses to be plowed (a perennial stand persists — never plowed under)", () => {
    const save = forageGame();
    const field = establish(save, "grass");
    expect(() => enqueueTask(save, field, "plow", 11 * minutesPerMonth())).toThrow(/perennial/i);
  });

  it("becomes ready to cut in May/Jul/Sep, growing in the month between each", () => {
    const save = forageGame();
    const field = establish(save, "grass");
    // April: establishing, not yet a cutting window.
    tickFarming(save, APRIL);
    expect(field.status).toBe("growing");
    // May: first cutting window opens.
    tickFarming(save, MAY);
    expect(deriveStatus(field, MAY)).toBe("ready");
    // June is a GROWING month between cuttings (no window opens there), but
    // May's window is still un-cut, so the field stays mowable until cut.
    expect((gameConfig.crops.grass.harvestMonths ?? []).includes(5)).toBe(false);
    // Jul & Sep are the other two windows.
    expect(deriveStatus(field, JULY)).toBe("ready");
    expect(deriveStatus(field, SEPTEMBER)).toBe("ready");
  });

  it("runs a full cut → rake → bale cycle: forage becomes HAY, the stand regrows, crop persists", () => {
    const save = forageGame();
    const field = establish(save, "grass");
    tickFarming(save, MAY);
    expect(field.status).toBe("ready");

    // Cut (mow) — the perennial "harvest".
    enqueueTask(save, field, "mow", MAY);
    let now = runUntil(save, MAY, () => field.status === "harvested" && !!field.forageReady);
    expect(field.crop).toBe("grass"); // stand untouched by cutting
    expect(field.cutsThisYear).toBe(1);

    // Rake then bale.
    enqueueTask(save, field, "rake", now);
    enqueueTask(save, field, "bale", now);
    now = runUntil(save, now, () => field.status === "growing" && (field.baleLocations?.length ?? 0) > 0);
    expect(field.baleProduct).toBe("hay");
    expect(field.crop).toBe("grass"); // still the same perennial stand
    // Bale count follows the hay density (1.5/ac), not corn's 2.5.
    expect(field.baleLocations!.length).toBe(Math.round(ACRES * gameConfig.baleProducts.hay.balesPerAcre));
  });

  it("is cut 3× a year then stops; the next year it cuts again with no replanting", () => {
    const save = forageGame();
    const field = establish(save, "grass");
    const windows = [MAY, JULY, SEPTEMBER];
    for (const w of windows) {
      const before = field.cutsThisYear ?? 0;
      tickFarming(save, w);
      expect(field.status).toBe("ready");
      enqueueTask(save, field, "mow", w);
      runUntil(save, w, () => (field.cutsThisYear ?? 0) === before + 1);
      // Clear the cut forage so it regrows for the next window (skip rake/bale here).
      field.forageReady = undefined;
      tickFarming(save, w + minutesPerMonth() / 2);
    }
    expect(field.cutsThisYear).toBe(3);
    // October: no fourth cutting — the field just regrows.
    tickFarming(save, OCTOBER);
    expect(field.status).toBe("growing");

    // Next spring: the counter resets and it's ready again — same crop, no replant.
    const NEXT_MAY = 12 * minutesPerMonth() + MAY;
    tickFarming(save, NEXT_MAY);
    expect(field.crop).toBe("grass");
    expect(field.cutsThisYear).toBe(0);
    expect(field.status).toBe("ready");
  });

  it("alfalfa bales are a distinct, pricier product than grass hay", () => {
    // Grass hay bales.
    const g = forageGame();
    const grass = establish(g, "grass");
    grass.baleLocations = [[1, 1], [2, 2], [3, 3]];
    grass.baleProduct = "hay";
    const grassSale = sellBales(g, grass, 4 * minutesPerMonth());
    expect(grassSale.revenue).toBe(Math.round(3 * baleInstantPrice("hay")));

    // Alfalfa bales — same crop machinery, higher value + its own product.
    const a = forageGame();
    const alfalfa = establish(a, "alfalfa");
    expect(balesPerAcreForField(alfalfa)).toBe(gameConfig.baleProducts.alfalfaHay.balesPerAcre);
    alfalfa.baleLocations = [[1, 1], [2, 2], [3, 3]];
    alfalfa.baleProduct = "alfalfaHay";
    const alfalfaSale = sellBales(a, alfalfa, 4 * minutesPerMonth());
    expect(alfalfaSale.revenue).toBe(Math.round(3 * baleInstantPrice("alfalfaHay")));
    expect(gameConfig.baleProducts.alfalfaHay.pricePerBale).toBeGreaterThan(gameConfig.baleProducts.hay.pricePerBale);
  });

  it("the baler gathers forage into a hopper and clears it when the job is done", () => {
    const save = forageGame();
    const field = establish(save, "grass");
    tickFarming(save, MAY);
    enqueueTask(save, field, "mow", MAY);
    let now = runUntil(save, MAY, () => field.status === "harvested" && !!field.forageReady);
    enqueueTask(save, field, "rake", now);
    enqueueTask(save, field, "bale", now);
    const baler = save.implements.find((i) => i.kind === "bailer")!;

    let sawHopperFill = false;
    while (field.status !== "growing" && now < MAY + 400_000) {
      now += 2;
      tickFarming(save, now);
      tickTasks(save, now, 2, () => 0.5);
      if ((baler.cargoTons ?? 0) > 0.05) sawHopperFill = true;
    }
    expect(sawHopperFill).toBe(true); // the hopper filled with forage as it ran
    expect(baler.cargoTons ?? 0).toBe(0); // ...and was cleared at the end
    // Bale count is unchanged (round of acres × density).
    expect(field.baleLocations!.length).toBe(Math.round(ACRES * gameConfig.baleProducts.hay.balesPerAcre));
  });

  it("a perennial stand shows dormant (browns off) in winter, green the rest of the year", () => {
    const save = forageGame();
    const field = establish(save, "grass");
    const DEC = 9 * minutesPerMonth(); // month 11
    const JAN = 10 * minutesPerMonth(); // month 0 (next campaign year)
    expect(isPerennialDormant(field, MAY)).toBe(false);
    expect(isPerennialDormant(field, DEC)).toBe(true);
    expect(isPerennialDormant(field, JAN)).toBe(true);
    // An annual crop never gets the dormant browning.
    const corn: Field = { id: "f2", parcelId: "p2", boundary, status: "growing", crop: "corn", plantedAt: 0 };
    expect(isPerennialDormant(corn, DEC)).toBe(false);
  });

  it("auto-manage establishes the stand (plow once, then plant), then cuts+rakes+bales each window, never replanting", () => {
    const save = forageGame();
    // Ground needs plowing first, same as an annual (maintainer request,
    // 2026-07-16) — start already tilled so this test can focus on the
    // establish → cut → rake → bale cycle without waiting out a full winter.
    const field = freshField();
    field.status = "tilled";
    field.autoManage = true;
    field.plans = [{ crop: "grass", fertilize: true, bale: true }];
    save.fields.push(field);

    let plantCount = 0;
    let plowCount = 0;
    let now = MARCH;
    for (let i = 0; i < 20000 && now < JULY + minutesPerMonth(); i++) {
      now += 30;
      tickFarming(save, now);
      autoManageAll(save, now);
      const res = tickTasks(save, now, 30, () => 0.5);
      for (const ev of res.events) {
        if (ev.kind === "started" && ev.task.type === "plant") plantCount++;
        if (ev.kind === "started" && ev.task.type === "plow") plowCount++;
      }
    }
    expect(field.crop).toBe("grass");
    expect(plowCount).toBe(0); // ground was already tilled — no re-plow needed
    expect(plantCount).toBe(1); // established exactly once
    // It got cut at least once and produced hay bales.
    expect(field.baleProduct).toBe("hay");
  });

  it("auto-manage plows stubble ground first (winter only), then plants once tilled", () => {
    const save = forageGame();
    const field = freshField(); // bare stubble
    field.autoManage = true;
    field.plans = [{ crop: "alfalfa", fertilize: false, bale: false }];
    save.fields.push(field);

    const WINTER = 9 * minutesPerMonth(); // Dec 1 — plow window opens
    // Before winter: nothing happens, same as an annual crop on fresh ground.
    runUntil(save, MARCH, () => false, WINTER - MARCH, 30);
    expect(field.status).toBe("stubble");
    expect(field.crop).toBeUndefined();

    // Winter opens: auto-manage queues + finishes the plow.
    let now = runUntil(save, WINTER, () => field.status === "tilled");
    expect(field.crop).toBeUndefined(); // not planted yet — outside alfalfa's March window

    // The following March, it establishes the stand.
    now = runUntil(save, now, () => field.crop === "alfalfa", 5 * minutesPerMonth());
    expect(field.crop).toBe("alfalfa");
  });
});
