import { describe, it, expect } from "vitest";
import {
  projectRotation, nextOccurrence, prevOccurrence, absMonthOf, splitAbs,
} from "../src/sim/rotationTimeline";
import { minutesPerMonth, START_MONTH } from "../src/sim/calendar";
import type { Field, FieldPlan } from "../src/state/saveState";

/**
 * The Schedule tab's rotation TIMELINE (2026-07-31 rework).
 *
 * The layout is something only the maintainer can eyeball, but the arithmetic
 * under it doesn't have to be taken on trust — and it's the arithmetic that
 * carries the two cases the old per-crop calendars couldn't express: a crop
 * that overwinters, and a double crop.
 */

const M = minutesPerMonth();
/**
 * SimTime for a given campaign year/month.
 *
 * NOTE the START_MONTH offset: SimTime 0 is NOT January, it's March (the
 * campaign opens in spring). The absolute-month axis still counts from Jan Y1
 * = 0, so converting the other way has to subtract the start offset — getting
 * this backwards made every projection test fail by exactly 2.
 */
const at = (year: number, month: number): number => (((year - 1) * 12 + month) - START_MONTH) * M;

function field(plans: FieldPlan[], over: Partial<Field> = {}): Field {
  return {
    id: "f1", parcelId: "p1", boundary: [[0, 0], [100, 0], [100, 100], [0, 100]],
    status: "stubble", plans, rotationIndex: 0, ...over,
  } as Field;
}

describe("absolute month axis", () => {
  it("puts Jan of year 1 at zero and counts up forever", () => {
    expect(absMonthOf(at(1, 0))).toBe(0);
    expect(absMonthOf(at(1, 8))).toBe(8);   // Sep Y1
    expect(absMonthOf(at(2, 5))).toBe(17);  // Jun Y2
    expect(absMonthOf(at(3, 0))).toBe(24);
  });

  it("round-trips through splitAbs", () => {
    for (const abs of [0, 5, 11, 12, 17, 32, 100]) {
      const { year, month } = splitAbs(abs);
      expect((year - 1) * 12 + month).toBe(abs);
    }
  });
});

describe("nextOccurrence — the whole trick", () => {
  it("returns the SAME month when it already matches (delta 0)", () => {
    // This is what makes a double crop expressible at all. If this were
    // "strictly after", wheat→beans would silently slip a full year.
    expect(nextOccurrence(17, 5)).toBe(17); // abs 17 IS June
  });

  it("walks forward within the year", () => {
    expect(nextOccurrence(17, 8)).toBe(20); // Jun → Sep, +3
  });

  it("wraps into next year when the month has passed", () => {
    expect(nextOccurrence(21, 8)).toBe(32); // Oct Y2 → Sep Y3, +11
  });

  it("never goes backwards", () => {
    for (let from = 0; from < 40; from++) {
      for (let moy = 0; moy < 12; moy++) {
        const got = nextOccurrence(from, moy);
        expect(got).toBeGreaterThanOrEqual(from);
        expect(got - from).toBeLessThan(12);
        expect(splitAbs(got).month).toBe(moy);
      }
    }
  });
});

describe("prevOccurrence — where the plow goes", () => {
  it("returns the same month on a match, else steps back inside a year", () => {
    expect(prevOccurrence(27, 3)).toBe(27);  // Apr Y3 is already Apr
    expect(prevOccurrence(27, 0)).toBe(24);  // Apr Y3 → Jan Y3
    expect(prevOccurrence(24, 8)).toBe(20);  // Jan Y3 → Sep Y2
  });

  it("never goes forwards", () => {
    for (let from = 12; from < 40; from++) {
      for (let moy = 0; moy < 12; moy++) {
        const got = prevOccurrence(from, moy);
        expect(got).toBeLessThanOrEqual(from);
        expect(from - got).toBeLessThan(12);
        expect(splitAbs(got).month).toBe(moy);
      }
    }
  });
});

describe("chaining a rotation", () => {
  it("anchors the head to the crop ACTUALLY in the ground", () => {
    const f = field([{ crop: "corn" }], { crop: "corn", plantedAt: at(1, 3) });
    const t = projectRotation(f, at(1, 6));
    expect(t.bands[0]!.plantAbs).toBe(3);   // April Y1, where it really went in
    expect(t.bands[0]!.planted).toBe(true);
    expect(t.bands[0]!.current).toBe(true);
  });

  it("projects from today when nothing is planted yet", () => {
    const f = field([{ crop: "corn" }]); // corn plants Apr–May
    const t = projectRotation(f, at(1, 0)); // January
    expect(t.bands[0]!.plantAbs).toBe(3);   // next April
    expect(t.bands[0]!.planted).toBe(false);
  });

  it("harvest lands growMonths after planting", () => {
    const f = field([{ crop: "corn" }], { crop: "corn", plantedAt: at(1, 3) });
    const b = projectRotation(f, at(1, 3)).bands[0]!;
    expect(b.harvestAbs).toBe(3 + 4); // corn: 4 grow months → August
  });

  it("WINTER WHEAT spans the year boundary with no special case", () => {
    const f = field([{ crop: "wheat" }], { crop: "wheat", plantedAt: at(1, 8) });
    const b = projectRotation(f, at(1, 8)).bands[0]!;
    expect(b.plantAbs).toBe(8);        // Sep Y1
    expect(b.harvestAbs).toBe(8 + 9);  // abs 17 = Jun Y2
    expect(splitAbs(b.harvestAbs)).toEqual({ year: 2, month: 5 });
  });

  it("DOUBLE CROP: beans go in the same month the wheat comes off", () => {
    const f = field(
      [{ crop: "wheat" }, { crop: "soybeans", schedule: { plant: 5 } }], // beans in June
      { crop: "wheat", plantedAt: at(1, 8) },
    );
    const t = projectRotation(f, at(1, 8));
    const [wheat, beans] = t.bands;
    expect(wheat!.harvestAbs).toBe(17);  // Jun Y2
    expect(beans!.plantAbs).toBe(17);    // …the very same month
    expect(beans!.harvestAbs).toBe(21);  // Oct Y2
  });

  it("and the loop back to wheat then leaves a visible fallow winter", () => {
    const f = field(
      [{ crop: "wheat" }, { crop: "soybeans", schedule: { plant: 5 } }],
      { crop: "wheat", plantedAt: at(1, 8) },
    );
    const t = projectRotation(f, at(1, 8), { maxBands: 3 });
    const third = t.bands[2]!;
    expect(third.crop).toBe("wheat");
    expect(third.plantAbs).toBe(32);  // Sep Y3 — 11 months after Oct beans
    expect(third.cycle).toBe(1);      // second time round the rotation
  });

  it("a step never starts before the previous one is off the ground", () => {
    const f = field([{ crop: "corn" }, { crop: "soybeans" }, { crop: "wheat" }],
      { crop: "corn", plantedAt: at(1, 3) });
    const t = projectRotation(f, at(1, 3), { maxBands: 6 });
    for (let i = 1; i < t.bands.length; i++) {
      expect(t.bands[i]!.plantAbs).toBeGreaterThanOrEqual(t.bands[i - 1]!.harvestAbs);
    }
  });

  it("walks the sequence in order and loops", () => {
    const f = field([{ crop: "corn" }, { crop: "soybeans" }]);
    const t = projectRotation(f, at(1, 0), { maxBands: 4 });
    expect(t.bands.map((b) => b.crop)).toEqual(["corn", "soybeans", "corn", "soybeans"]);
    expect(t.bands.map((b) => b.planIdx)).toEqual([0, 1, 0, 1]);
  });

  it("starts at the step the field is actually ON, not always plans[0]", () => {
    const f = field([{ crop: "corn" }, { crop: "soybeans" }], { rotationIndex: 1 });
    expect(projectRotation(f, at(1, 0)).bands[0]!.crop).toBe("soybeans");
  });

  it("DEFAULTS to one full cycle — one band per step, no repeats", () => {
    // Regression (maintainer, 2026-07-31): a one-crop field drew "Corn /
    // Corn +1 / Corn +2 / Corn +3". The rotation loops; saying so four times
    // is noise, and on a narrow panel it's four wasted rows.
    expect(projectRotation(field([{ crop: "corn" }]), at(1, 0)).bands).toHaveLength(1);
    expect(projectRotation(field([{ crop: "corn" }, { crop: "soybeans" }]), at(1, 0)).bands).toHaveLength(2);
    expect(projectRotation(
      field([{ crop: "corn" }, { crop: "soybeans" }, { crop: "wheat" }]), at(1, 0),
    ).bands).toHaveLength(3);
  });

  it("every band in the default view is the FIRST pass — cycle 0", () => {
    const t = projectRotation(field([{ crop: "corn" }, { crop: "soybeans" }]), at(1, 0));
    expect(t.bands.every((b) => b.cycle === 0)).toBe(true);
  });

  it("terminates — respects maxBands and the month horizon", () => {
    const f = field([{ crop: "corn" }, { crop: "soybeans" }]);
    expect(projectRotation(f, at(1, 0), { maxBands: 3 }).bands).toHaveLength(3);
    const short = projectRotation(f, at(1, 0), { maxBands: 50, maxMonths: 12 });
    expect(short.bands.length).toBeLessThan(50);
  });
});

describe("task placement on the axis", () => {
  const cornBand = () => {
    const f = field([{ crop: "corn", fertilize: true, weed: true }], { crop: "corn", plantedAt: at(1, 3) });
    return projectRotation(f, at(1, 3)).bands[0]!;
  };

  it("plant sits at the band's start", () => {
    const b = cornBand();
    expect(b.tasks.find((t) => t.kind === "plant")!.at[0]).toBe(b.plantAbs);
  });

  it("in-season tasks land inside the band, never a year late", () => {
    const b = cornBand();
    for (const kind of ["fertilize", "weed", "harvest"] as const) {
      const task = b.tasks.find((t) => t.kind === kind);
      if (!task) continue;
      expect(task.at[0], kind).toBeGreaterThanOrEqual(b.plantAbs);
      expect(task.at[0], kind).toBeLessThanOrEqual(b.harvestAbs + 2);
    }
  });

  it("PLOW sits BEFORE the crop it prepares for, not a year after it", () => {
    // The bug this guards: plow's legal window wraps back to January, so
    // placing it with nextOccurrence would fling it ~9 months past harvest
    // instead of into the fallow gap where the player actually sees it.
    const b = cornBand();
    const plow = b.tasks.find((t) => t.kind === "plow");
    expect(plow).toBeDefined();
    expect(plow!.at[0]).toBeLessThanOrEqual(b.plantAbs);
    expect(b.plantAbs - plow!.at[0]).toBeLessThan(12);
  });

  it("legal drop targets are absolute months, and dragging maps back to a month-of-year", () => {
    const b = cornBand();
    const harvest = b.tasks.find((t) => t.kind === "harvest")!;
    expect(harvest.legal.length).toBeGreaterThan(0);
    // Sorted, and each is a real month on the axis — the renderer turns an
    // absolute drop back into an override with `abs % 12`.
    for (let i = 1; i < harvest.legal.length; i++) {
      expect(harvest.legal[i]!).toBeGreaterThan(harvest.legal[i - 1]!);
    }
    expect(harvest.at.every((a) => harvest.legal.includes(a))).toBe(true);
  });

  it("fixed-timing follow-ons carry no legal months to drag to", () => {
    const f = field([{ crop: "wheat", bale: true }], { crop: "wheat", plantedAt: at(1, 8) });
    const bale = projectRotation(f, at(1, 8)).bands[0]!.tasks.find((t) => t.kind === "bale")!;
    expect(bale.legal).toEqual([]);
    expect(bale.on).toBe(true);
  });

  it("an optional task that's OFF is still reported, so it can be drawn hollow", () => {
    const f = field([{ crop: "corn", weed: false }], { crop: "corn", plantedAt: at(1, 3) });
    const weed = projectRotation(f, at(1, 3)).bands[0]!.tasks.find((t) => t.kind === "weed")!;
    expect(weed.on).toBe(false);
    expect(weed.at.length).toBe(1); // positioned, just not enabled
  });

  it("no Weed row on a cover crop — it's never weeded", () => {
    const f = field([{ crop: "wheat" }], { crop: "wheat", plantedAt: at(1, 8) });
    const b = projectRotation(f, at(1, 8)).bands[0]!;
    expect(b.tasks.some((t) => t.kind === "weed")).toBe(false);
  });

  it("Forage's harvest-time band shows as \"silage\", not \"harvest\" (2026-08-12)", () => {
    // Forage is chop-only — it never sees a combine — so the timeline should
    // relabel its harvest-time step for display, while it's still the SAME
    // draggable step underneath (scheduleType stays "harvest").
    const f = field([{ crop: "forage" }], { crop: "forage", plantedAt: at(1, 3) });
    const b = projectRotation(f, at(1, 3)).bands[0]!;
    expect(b.tasks.some((t) => t.kind === "harvest")).toBe(false);
    const silage = b.tasks.find((t) => t.kind === "silage");
    expect(silage).toBeDefined();
    expect(silage!.scheduleType).toBe("harvest");
    expect(silage!.on).toBe(true); // no toggle — the crop choice already made it
  });

  it("Corn's harvest-time band stays plain \"harvest\" — it has no silage route any more", () => {
    const b = cornBand();
    expect(b.tasks.some((t) => t.kind === "harvest")).toBe(true);
    expect(b.tasks.some((t) => t.kind === "silage")).toBe(false);
  });
});

describe("perennials don't chain", () => {
  it("draw one long stand with repeating cuttings instead of a rotation walk", () => {
    const f = field([{ crop: "alfalfa", bale: true }], { crop: "alfalfa", plantedAt: at(1, 2) });
    const t = projectRotation(f, at(1, 4), { perennialYears: 3 });
    expect(t.bands).toHaveLength(1);
    const b = t.bands[0]!;
    expect(b.perennial).toBe(true);
    const mow = b.tasks.find((x) => x.kind === "mow")!;
    // alfalfa cuts in May/Jul/Sep — three a year, three years.
    expect(mow.at).toHaveLength(9);
    expect(splitAbs(mow.at[0]!).month).toBe(4);
  });

  it("cuttings run forward in time and never before the stand went in", () => {
    const f = field([{ crop: "grass" }], { crop: "grass", plantedAt: at(2, 6) });
    const b = projectRotation(f, at(2, 6), { perennialYears: 2 }).bands[0]!;
    const mow = b.tasks.find((x) => x.kind === "mow")!;
    for (const a of mow.at) expect(a).toBeGreaterThanOrEqual(b.plantAbs);
    for (let i = 1; i < mow.at.length; i++) expect(mow.at[i]!).toBeGreaterThan(mow.at[i - 1]!);
  });

  it("stops the chain rather than drawing a lie when a perennial follows an annual", () => {
    // A perennial never clears, so nothing after it in the sequence has a
    // truthful start month. Better to end the projection than invent one.
    const f = field([{ crop: "corn" }, { crop: "alfalfa" }, { crop: "soybeans" }],
      { crop: "corn", plantedAt: at(1, 3) });
    const t = projectRotation(f, at(1, 3), { maxBands: 6 });
    expect(t.bands.map((b) => b.crop)).toEqual(["corn"]);
  });
});

describe("the drawn window", () => {
  it("always contains today, even for a rotation projected far ahead", () => {
    const f = field([{ crop: "corn" }], { crop: "corn", plantedAt: at(1, 3) });
    const t = projectRotation(f, at(1, 3));
    expect(t.startAbs).toBeLessThanOrEqual(t.todayAbs);
    expect(t.endAbs).toBeGreaterThanOrEqual(t.todayAbs);
  });

  it("reaches back far enough to show the leading plow", () => {
    const f = field([{ crop: "corn" }], { crop: "corn", plantedAt: at(2, 3) });
    const t = projectRotation(f, at(2, 3));
    const plow = t.bands[0]!.tasks.find((x) => x.kind === "plow")!;
    expect(t.startAbs).toBeLessThanOrEqual(plow.at[0]!);
  });

  it("survives a field with no plans at all", () => {
    const t = projectRotation(field([]), at(1, 5));
    expect(t.bands).toEqual([]);
    expect(t.endAbs).toBeGreaterThan(t.startAbs);
  });
});
