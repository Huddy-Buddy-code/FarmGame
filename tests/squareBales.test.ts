/**
 * Square bales (maintainer decision, 2026-07-24): "The baler, but storage
 * counts them the same."
 *
 * Shape is the implement KIND. It was briefly a size tier (the Large baler WAS
 * the square baler) — that fell over later the same day when the baler lost its
 * working width: a baler clears whatever the windrow is wide, so the size tiers
 * had nothing left to express, and the maintainer asked for "just a Medium
 * Round Baler and Medium Square Baler". Both being Medium is only expressible
 * with shape as the kind.
 *
 * A square bale is its round twin at 1.5x the weight: fewer per acre, more per
 * bale, plus ~10% per ton because squares stack tight. Storage counts a bale as
 * a bale either way, per the maintainer's call.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { setProjection } from "../src/geo/coords";
import type { Meters } from "../src/geo/coords";
import { newGame } from "../src/state/saveState";
import type { Field, SaveState } from "../src/state/saveState";
import { tickFarming, baleProductForField, balesPerAcreForField, baleTonsOf } from "../src/sim/farming";
import { buyAgent, buyImplement, enqueueTask, tickTasks } from "../src/sim/tasks";
import { buyBuildingAt } from "../src/sim/buildings";
import { SELLABLE_BALES } from "../src/sim/market";
import { baleIconSvg, squareBaleIconSvg } from "../src/ui/icons";
import { minutesPerMonth } from "../src/sim/calendar";
import { gameConfig } from "../src/config/gameConfig";
import type { BaleProduct } from "../src/config/gameConfig";

beforeAll(() => setProjection(15, "N"));

const side = Math.sqrt(40 * 4046.8564224);
const boundary: Meters[] = [[0, 0], [side, 0], [side, side], [0, side]];
const APRIL_1 = minutesPerMonth();

const ROUND_TO_SQUARE: Array<[BaleProduct, BaleProduct]> = [
  ["hay", "haySquare"],
  ["alfalfaHay", "alfalfaHaySquare"],
  ["straw", "strawSquare"],
];

describe("shape is the baler KIND, not a size tier", () => {
  // Shape WAS the Large size tier when square bales landed earlier the same
  // day. Once the baler lost its working width (it clears the windrow, whatever
  // laid it) the size tiers had nothing left to express, and the maintainer
  // asked for "just a Medium Round Baler and Medium Square Baler" — which only
  // works if shape is the kind.
  it("neither baler carries a working width of its own", () => {
    expect(gameConfig.equipment.bailer.medium.widthFt).toBe(0);
    expect(gameConfig.equipment.squareBaler.medium.widthFt).toBe(0);
  });

  it("the square baler costs more than the round one", () => {
    expect(gameConfig.equipment.squareBaler.medium.price)
      .toBeGreaterThan(gameConfig.equipment.bailer.medium.price);
  });
});

describe("a square bale is its round twin, heavier", () => {
  for (const [round, square] of ROUND_TO_SQUARE) {
    it(`${square} weighs more, comes off thinner, and is worth more than ${round}`, () => {
      const r = gameConfig.baleProducts[round];
      const q = gameConfig.baleProducts[square];
      expect(q.square).toBe(true);
      expect(q.tonsPerBale).toBeGreaterThan(r.tonsPerBale);
      expect(q.balesPerAcre).toBeLessThan(r.balesPerAcre);
      expect(q.pricePerBale).toBeGreaterThan(r.pricePerBale);
      // Roughly the same TONNAGE comes off the acre either way — the shape
      // changes how it's packaged, not how much grew.
      expect(q.balesPerAcre * q.tonsPerBale).toBeCloseTo(r.balesPerAcre * r.tonsPerBale, 1);
      // ...but a ton of it is worth a little more, because squares stack.
      const perTonRound = r.pricePerBale / r.tonsPerBale;
      const perTonSquare = q.pricePerBale / q.tonsPerBale;
      expect(perTonSquare).toBeGreaterThan(perTonRound);
      expect(perTonSquare).toBeLessThan(perTonRound * 1.25); // a premium, not a different economy
    });
  }

  it("every square product is sellable", () => {
    for (const [, square] of ROUND_TO_SQUARE) expect(SELLABLE_BALES).toContain(square);
  });
});

describe("which product a field ends up with", () => {
  const grassField: Field = { id: "f", parcelId: "p", boundary, status: "harvested", crop: "grass" };

  it("follows the baler, not the crop alone", () => {
    expect(baleProductForField(grassField, false)).toBe("hay");
    expect(baleProductForField(grassField, true)).toBe("haySquare");
  });

  it("falls back to the round product where no square twin exists", () => {
    // Corn stover is legacy — nothing makes it any more — so a square baler on
    // one has nothing to promote it to.
    const cornField: Field = { id: "f", parcelId: "p", boundary, status: "harvested", lastCrop: "corn" };
    expect(baleProductForField(cornField, true)).toBe("cornStover");
  });

  it("thins the bales per acre when squares are made", () => {
    expect(balesPerAcreForField(grassField, true)).toBeLessThan(balesPerAcreForField(grassField, false));
  });
});

describe("baling a field for real", () => {
  function baleWith(kind: "bailer" | "squareBaler"): { save: SaveState; field: Field } {
    const save = newGame();
    save.money = 20_000_000;
    buyBuildingAt(save, "baleArea", [-400, -400]);
    buyAgent(save, "tractor", "large", [0, 0]);
    buyImplement(save, kind, "medium");
    const field: Field = {
      id: "field-1", parcelId: "p", boundary, status: "harvested",
      lastCrop: "wheat", forageReady: true, windrowed: true,
    };
    save.fields.push(field);
    enqueueTask(save, field, "bale", APRIL_1);

    let now = APRIL_1;
    while (save.tasks.some((t) => t.type === "bale") && now - APRIL_1 < 200_000) {
      now += 30;
      tickFarming(save, now);
      tickTasks(save, now, 30, () => 0.5);
    }
    return { save, field };
  }

  it("a round baler leaves round straw", () => {
    const { field } = baleWith("bailer");
    expect(field.baleProduct).toBe("straw");
  });

  it("a square baler leaves SQUARE straw, and fewer of them", () => {
    const round = baleWith("bailer");
    const square = baleWith("squareBaler");
    expect(square.field.baleProduct).toBe("strawSquare");
    expect(square.field.baleLocations?.length ?? 0).toBeGreaterThan(0);
    expect(square.field.baleLocations!.length).toBeLessThan(round.field.baleLocations!.length);
  });

  it("...carrying about the same tonnage off the field either way", () => {
    const round = baleWith("bailer");
    const square = baleWith("squareBaler");
    const tons = (f: Field) => (f.baleLocations?.length ?? 0) * baleTonsOf(f.baleProduct!);
    // Same grass grew; only the packaging changed. Loose tolerance: bale counts
    // are whole numbers and the last partial bale is discarded.
    expect(tons(square.field)).toBeGreaterThan(tons(round.field) * 0.8);
    expect(tons(square.field)).toBeLessThan(tons(round.field) * 1.2);
  });
});

describe("square bales look square", () => {
  // Maintainer request, 2026-07-24: "make sure the Square Bales have an icon on
  // the Field and Inventory for a rectangular hay, straw, or alfalfa bale."
  // main.ts routes every bale drawn — map markers, Market rows, storage chips,
  // the field panel — through one `baleIconFor(product)` that reads this flag,
  // so the flag is what's worth pinning here; the SVGs themselves are checked
  // for being genuinely different shapes.
  it("every square product is flagged square, and every round one isn't", () => {
    for (const [round, square] of ROUND_TO_SQUARE) {
      expect(gameConfig.baleProducts[square].square, square).toBe(true);
      expect(gameConfig.baleProducts[round].square, round).toBeFalsy();
    }
    expect(gameConfig.baleProducts.cornStover.square).toBeFalsy();
  });

  it("the round icon is drawn with ellipses and the square one with rects", () => {
    const round = baleIconSvg(14, "hay");
    const square = squareBaleIconSvg(14, "hay");
    expect(round).toContain("<ellipse");
    expect(round).not.toContain("<rect");
    expect(square).toContain("<rect");
    expect(square).not.toContain("<ellipse");
    expect(square).not.toBe(round);
  });

  it("both shapes keep the product's tint, so colour still reads the crop", () => {
    // Shape says round-or-square; colour still has to say hay-or-alfalfa.
    expect(squareBaleIconSvg(14, "alfalfa")).not.toBe(squareBaleIconSvg(14, "hay"));
    // ...and alfalfa's square icon shares its tint with alfalfa's round one.
    const alfalfaTint = /fill="(#[0-9a-fA-F]+)"/.exec(baleIconSvg(14, "alfalfa"))?.[1];
    expect(alfalfaTint).toBeTruthy();
    expect(squareBaleIconSvg(14, "alfalfa")).toContain(alfalfaTint!);
  });
});

describe("storage counts a bale as a bale", () => {
  it("a square bale takes exactly one slot, same as a round one", () => {
    // The maintainer's explicit call — the weighted-capacity alternative was
    // declined, so nothing in the storage math may look at tonsPerBale.
    const save = newGame();
    save.money = 10_000_000;
    const area = buyBuildingAt(save, "baleArea", [0, 0]);
    area.storedBales = { straw: 10, strawSquare: 10 };
    const total = Object.values(area.storedBales).reduce((a, b) => a + b, 0);
    expect(total).toBe(20);
  });
});
