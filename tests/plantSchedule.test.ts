/**
 * Planting has a SOFT RETRY, like every other scheduled step (maintainer bug
 * report, 2026-07-24: "Check Winter Wheat again. Not Working. Not planting when
 * scheduled. If the Field is plowed, it should plant.").
 *
 * Auto-manage's other gates all fire "at or after the chosen month" — `plowDueAt`
 * walks an ordered window and compares indices, so a month missed because the
 * farm was broke, or because the only tractor was tied up on another field, is
 * picked up by the next legal month. Planting alone used a bare month EQUALITY
 * (`monthMatches`), so a plow that landed one month late meant the seed didn't
 * go in for a WHOLE YEAR — the field just sat there tilled.
 *
 * Winter Wheat shows it worst: its window is only Sep-Oct, it's the crop most
 * likely to have a plow queued behind the autumn rush, and a missed year of a
 * cover crop is very visible.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { setProjection } from "../src/geo/coords";
import type { Meters } from "../src/geo/coords";
import { newGame } from "../src/state/saveState";
import type { Field, FieldPlan, SaveState } from "../src/state/saveState";
import { tickFarming } from "../src/sim/farming";
import { ensureAgents, tickTasks, autoManageAll } from "../src/sim/tasks";
import { minutesPerMonth, MONTHS_PER_YEAR, START_MONTH } from "../src/sim/calendar";

beforeAll(() => setProjection(15, "N"));

const side = Math.sqrt(20 * 4046.8564224);
const boundary: Meters[] = [[0, 0], [side, 0], [side, side], [0, side]];

function timeForMonth(m: number): number {
  return ((((m - START_MONTH) % MONTHS_PER_YEAR) + MONTHS_PER_YEAR) % MONTHS_PER_YEAR) * minutesPerMonth();
}

/** A field already plowed and waiting, on a one-step rotation. */
function tilledField(save: SaveState, plan: FieldPlan): Field {
  const field: Field = {
    id: "field-1", parcelId: "p", boundary,
    status: "tilled", autoManage: true, plans: [plan], rotationIndex: 0,
  };
  save.fields.push(field);
  return field;
}

function farm(): SaveState {
  const save = newGame();
  save.money = 5_000_000;
  ensureAgents(save, [0, 0]);
  return save;
}

/** Run from `from` for `months`, returning the crop the field ended up with. */
function runMonths(save: SaveState, field: Field, from: number, months: number): void {
  const step = 60;
  const end = from + minutesPerMonth() * months;
  for (let now = from; now < end && !field.crop; now += step) {
    tickFarming(save, now);
    autoManageAll(save, now);
    tickTasks(save, now, step, () => 0.5);
  }
}

const SEP = 8;
const OCT = 9;
const DEC = 11;

describe("a tilled field plants as soon as it can, not only on the exact month", () => {
  it("Winter Wheat scheduled for September still goes in during October", () => {
    // The plow ran a month late — the tractor was on another field. October is
    // squarely inside wheat's Sep-Oct window, so the seed should go in now.
    // This used to wait until the FOLLOWING September.
    const save = farm();
    const field = tilledField(save, { crop: "wheat", mulch: false, bale: false, schedule: { plant: SEP } });
    runMonths(save, field, timeForMonth(OCT), 1);
    expect(field.crop).toBe("wheat");
  });

  it("the same holds with no override at all", () => {
    const save = farm();
    const field = tilledField(save, { crop: "wheat", mulch: false, bale: false });
    runMonths(save, field, timeForMonth(OCT), 1);
    expect(field.crop).toBe("wheat");
  });

  it("does NOT jump the gun — a later scheduled month is still respected", () => {
    // Scheduled for October, ground ready in September: wait. The override is a
    // real choice (later planting, later harvest), not just a hint.
    const save = farm();
    const field = tilledField(save, { crop: "wheat", mulch: false, bale: false, schedule: { plant: OCT } });
    runMonths(save, field, timeForMonth(SEP), 1);
    expect(field.crop).toBeUndefined();
  });

  it("does NOT plant outside the crop's own window", () => {
    // December is past wheat entirely. Slipping is forgiven within the window;
    // sowing winter wheat in December is not.
    const save = farm();
    const field = tilledField(save, { crop: "wheat", mulch: false, bale: false, schedule: { plant: SEP } });
    runMonths(save, field, timeForMonth(DEC), 2);
    expect(field.crop).toBeUndefined();
  });

  it("a slipped corn planting is caught by the next month too", () => {
    // Not a wheat quirk — corn's window is Apr-May, so a plow that finished in
    // May still gets planted in May.
    const save = farm();
    const field = tilledField(save, { crop: "corn", mulch: false, bale: false, schedule: { plant: 3 } });
    runMonths(save, field, timeForMonth(4), 1);
    expect(field.crop).toBe("corn");
  });
});

describe("perennials get the same soft retry", () => {
  it("grass scheduled for March is still established in March's window", () => {
    // Perennials have a single-month window (March), so there's nothing to slip
    // INTO — this just pins that the shared gate didn't break establishing a stand.
    const save = farm();
    const field = tilledField(save, { crop: "grass", mulch: false, bale: false, schedule: { plant: 2 } });
    runMonths(save, field, timeForMonth(2), 1);
    expect(field.crop).toBe("grass");
  });
});
