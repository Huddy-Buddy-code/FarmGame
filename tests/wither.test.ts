import { describe, it, expect, beforeAll } from "vitest";
import { setProjection } from "../src/geo/coords";
import type { Meters } from "../src/geo/coords";
import { newGame } from "../src/state/saveState";
import type { Field, SaveState } from "../src/state/saveState";
import {
  tickFarming, harvestWindowClosed, applyWither, canPlow, productivityMultiplier, harvestMonthsRemaining,
} from "../src/sim/farming";
import {
  ensureAgents, enqueueTask, tickTasks, autoManageAll, canMulch, buyImplement,
} from "../src/sim/tasks";
import { buyBuildingAt, assignSiloCrop } from "../src/sim/buildings";
import { minutesPerMonth } from "../src/sim/calendar";
import { gameConfig } from "../src/config/gameConfig";

beforeAll(() => setProjection(15, "N"));

const side = Math.sqrt(100 * 4046.8564224); // 100 acres
const boundary: Meters[] = [[0, 0], [side, 0], [side, side], [0, side]];
const APRIL_1 = minutesPerMonth();
const MPM = minutesPerMonth();

/** Corn planted at the start of April: ripe in August (growMonths 4), withered
 * once the 2-month window closes at the start of October. */
function cornField(over: Partial<Field> = {}): Field {
  return {
    id: "field-1", parcelId: "p", boundary, status: "growing",
    crop: "corn", plantedAt: APRIL_1, trueYieldTonsPerAcre: 5, ...over,
  };
}

/** `now` at N whole months past the planting month's start. */
function monthsAfterPlanting(n: number): number {
  return APRIL_1 + n * MPM;
}

describe("harvestWindowClosed — the window boundary", () => {
  const f = () => cornField();
  const grow = gameConfig.crops.corn.growMonths; // 4
  const win = gameConfig.harvestWindowMonths; // 2

  it("is open the month the crop ripens", () => {
    expect(harvestWindowClosed(f(), monthsAfterPlanting(grow))).toBe(false);
  });

  it("is still open on the window's last month", () => {
    expect(harvestWindowClosed(f(), monthsAfterPlanting(grow + win - 1))).toBe(false);
  });

  it("closes exactly when the window runs out", () => {
    expect(harvestWindowClosed(f(), monthsAfterPlanting(grow + win))).toBe(true);
  });

  it("is never closed while the crop is still growing", () => {
    expect(harvestWindowClosed(f(), monthsAfterPlanting(grow - 1))).toBe(false);
  });

  it("never closes on a perennial — a missed cutting is just skipped", () => {
    const stand = cornField({ crop: "grass", status: "growing" });
    expect(harvestWindowClosed(stand, monthsAfterPlanting(40))).toBe(false);
  });

  it("never closes on a field with no crop", () => {
    expect(harvestWindowClosed(cornField({ crop: undefined }), monthsAfterPlanting(40))).toBe(false);
  });
});

describe("harvestMonthsRemaining — the player's only warning", () => {
  const grow = gameConfig.crops.corn.growMonths;

  it("is null while the crop is still growing", () => {
    expect(harvestMonthsRemaining(cornField(), monthsAfterPlanting(grow - 1))).toBeNull();
  });

  it("counts down across the window and hits 0 on the final month", () => {
    // Window is 2 months: 1 month left when it ripens, 0 the month after.
    expect(harvestMonthsRemaining(cornField(), monthsAfterPlanting(grow))).toBe(1);
    expect(harvestMonthsRemaining(cornField(), monthsAfterPlanting(grow + 1))).toBe(0);
  });

  it("reaches 0 before harvestWindowClosed ever goes true — the warning always precedes the loss", () => {
    const f = cornField();
    let sawZero = false;
    // Step a third of a month at a time through the whole window.
    for (let m = grow; m < grow + gameConfig.harvestWindowMonths; m += 1 / 3) {
      const now = APRIL_1 + m * MPM;
      expect(harvestWindowClosed(f, now)).toBe(false); // still safe...
      if (harvestMonthsRemaining(f, now) === 0) sawZero = true; // ...and warned
    }
    expect(sawZero).toBe(true);
  });

  it("is null for a perennial stand", () => {
    expect(harvestMonthsRemaining(cornField({ crop: "grass" }), monthsAfterPlanting(grow + 1))).toBeNull();
  });
});

describe("applyWither — a total loss", () => {
  it("destroys the crop and leaves the field withered", () => {
    const field = cornField({ status: "ready" });
    applyWither(field);
    expect(field.status).toBe("withered");
    expect(field.crop).toBeUndefined();
    expect(field.trueYieldTonsPerAcre).toBeUndefined();
    expect(field.plantedAt).toBeUndefined();
  });

  it("still records lastCrop, so the next planting earns its rotation bonus", () => {
    const field = cornField({ status: "ready" });
    applyWither(field);
    expect(field.lastCrop).toBe("corn");
  });

  it("leaves no balable residue — dead growth isn't worth baling", () => {
    const field = cornField({ status: "ready" });
    applyWither(field);
    expect(field.forageReady).toBeFalsy();
  });

  it("consumes a mulch bonus that was riding on the dead crop", () => {
    const field = cornField({ status: "ready", residueMulched: true, residueBaled: true });
    applyWither(field);
    expect(field.residueMulched).toBeUndefined();
    expect(field.residueBaled).toBeUndefined();
  });
});

describe("withering through tickFarming", () => {
  function saveWithCorn(over: Partial<Field> = {}): { save: SaveState; field: Field } {
    const save = newGame();
    const field = cornField(over);
    save.fields.push(field);
    return { save, field };
  }

  it("a ripe crop left standing withers when the window closes", () => {
    const { save, field } = saveWithCorn();
    tickFarming(save, monthsAfterPlanting(4)); // ripe
    expect(field.status).toBe("ready");
    tickFarming(save, monthsAfterPlanting(6)); // window closed
    expect(field.status).toBe("withered");
  });

  it("stays withered on later ticks rather than flickering back", () => {
    const { save, field } = saveWithCorn();
    tickFarming(save, monthsAfterPlanting(6));
    tickFarming(save, monthsAfterPlanting(9));
    expect(field.status).toBe("withered");
  });

  it("does NOT cut off a combine that's mid-harvest", () => {
    const save = newGame();
    ensureAgents(save, [0, 0]);
    const silo = buyBuildingAt(save, "silo", [-50, -50], "large");
    assignSiloCrop(save, silo.id, "corn");
    const field = cornField({ status: "ready" });
    save.fields.push(field);
    enqueueTask(save, field, "harvest", monthsAfterPlanting(4));

    // Let the combine actually pick the job up...
    let now = monthsAfterPlanting(4);
    for (let i = 0; i < 40 && !save.tasks.some((t) => t.type === "harvest" && t.status === "active"); i++) {
      now += 60;
      tickFarming(save, now);
      tickTasks(save, now, 60, () => 0.5);
    }
    expect(save.tasks.some((t) => t.type === "harvest" && t.status === "active")).toBe(true);

    // ...then jump well past the window's close while it's still working.
    tickFarming(save, monthsAfterPlanting(8));
    expect(field.status).not.toBe("withered");
  });

  it("cancels a stranded QUEUED harvest and refunds it", () => {
    const save = newGame();
    ensureAgents(save, [0, 0]);
    const field = cornField({ status: "ready" });
    save.fields.push(field);
    const before = save.money;
    const task = enqueueTask(save, field, "harvest", monthsAfterPlanting(4));
    expect(save.money).toBeLessThan(before);

    // Wither the field without ever letting an agent start the task.
    applyWither(field);
    tickTasks(save, monthsAfterPlanting(6), 60, () => 0.5);

    expect(save.tasks.find((t) => t.id === task.id)).toBeUndefined();
    expect(save.money).toBe(before); // fully refunded — no work was ever done
  });
});

describe("clearing a withered field", () => {
  it("can be plowed", () => {
    expect(canPlow("withered")).toBe(true);
  });

  it("can be mulched, and mulching it earns the FULL residue bonus", () => {
    const save = newGame();
    const field = cornField({ status: "withered", crop: undefined, lastCrop: "corn" });
    save.fields.push(field);
    expect(canMulch(save, field)).toBe(true);
    // A whole lost crop goes back in, so it isn't the reduced "baled" rate.
    expect(field.residueBaled).toBeFalsy();
  });

  it("a mulch pass clears it back to stubble and sets the bonus", () => {
    const save = newGame();
    ensureAgents(save, [0, 0]);
    buyImplement(save, "mulcher", "medium");
    const field = cornField({ status: "withered", crop: undefined, lastCrop: "corn" });
    save.fields.push(field);
    enqueueTask(save, field, "mulch", monthsAfterPlanting(6));

    let now = monthsAfterPlanting(6);
    for (let i = 0; i < 4000 && field.status !== "stubble"; i++) {
      now += 60;
      tickFarming(save, now);
      tickTasks(save, now, 60, () => 0.5);
    }
    expect(field.status).toBe("stubble");
    expect(field.residueMulched).toBe(true);

    // That bonus is worth the full rate on the next crop.
    field.crop = "soybeans";
    field.lastCrop = "soybeans"; // neutralize the rotation bonus for a clean read
    expect(productivityMultiplier(field, now)).toBeCloseTo(1 + gameConfig.mulchBonusPct, 6);
  });

  it("cannot be planted into directly — it has to be cleared first", () => {
    const save = newGame();
    const field = cornField({ status: "withered", crop: undefined, lastCrop: "corn" });
    save.fields.push(field);
    expect(() => enqueueTask(save, field, "plant", APRIL_1, "corn")).toThrow();
  });

  it("auto-manage clears a withered field instead of stalling on it", () => {
    const save = newGame();
    ensureAgents(save, [0, 0]);
    buyImplement(save, "mulcher", "medium");
    const field = cornField({
      status: "withered", crop: undefined, lastCrop: "corn", autoManage: true,
      plans: [{ crop: "corn", mulch: true }],
    });
    save.fields.push(field);

    // September — after the window closed, before the December plow window.
    let now = 6 * MPM;
    for (let i = 0; i < 200 && !save.tasks.some((t) => t.type === "mulch"); i++) {
      now += 60;
      autoManageAll(save, now);
      tickTasks(save, now, 60, () => 0.5);
    }
    expect(save.tasks.some((t) => t.type === "mulch")).toBe(true);
  });
});
