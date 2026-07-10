import { describe, it, expect, beforeAll } from "vitest";
import type { Map as MlMap } from "maplibre-gl";

import { setProjection } from "../src/geo/coords";
import type { Meters } from "../src/geo/coords";
import { areaAcres } from "../src/geo/geometry";
import { newGame } from "../src/state/saveState";
import type { Field } from "../src/state/saveState";
import { gameConfig } from "../src/config/gameConfig";
import { sellField } from "../src/field/fields";
import type { OverlayEngine } from "../src/map/overlay";
import { ensureAgents, enqueueTask, tickTasks } from "../src/sim/tasks";

beforeAll(() => setProjection(15, "N"));

// A 100-acre-ish square field, same shape used across the other test files.
const side = Math.sqrt(100 * 4046.8564224);
const boundary: Meters[] = [[0, 0], [side, 0], [side, side], [0, side]];

/** sellField only touches the map/overlay via removeFieldRender's two calls
 * (map.getSource, overlay.remove) — fakes stand in so this stays a pure test. */
function fakeMap(): MlMap {
  return { getSource: () => undefined } as unknown as MlMap;
}
function fakeOverlay(): OverlayEngine {
  return { remove: () => undefined } as unknown as OverlayEngine;
}

describe("sellField (maintainer request: sell back for the purchase price)", () => {
  it("refunds exactly what was paid, not a recomputed rate", () => {
    const save = newGame();
    const field: Field = {
      id: "field-1", parcelId: "parcel-1", boundary, status: "stubble", purchaseCost: 12_345,
    };
    save.fields.push(field);
    save.parcels.push({ id: "parcel-1", boundary, owned: true });
    const cash = save.money;

    const { refund } = sellField(fakeMap(), fakeOverlay(), save, "field-1");
    expect(refund).toBe(12_345);
    expect(save.money).toBe(cash + 12_345);
    expect(save.fields).toHaveLength(0);
    expect(save.parcels).toHaveLength(0);
  });

  it("falls back to acres × current land price when purchaseCost is missing (pre-upgrade saves)", () => {
    const save = newGame();
    const field: Field = { id: "field-1", parcelId: "parcel-1", boundary, status: "stubble" };
    save.fields.push(field);
    const { refund } = sellField(fakeMap(), fakeOverlay(), save, "field-1");
    expect(refund).toBe(Math.round(areaAcres(boundary) * gameConfig.landPricePerAcre));
  });

  it("refuses to sell a field a machine is actively working, but refunds queued work", () => {
    const save = newGame();
    ensureAgents(save, [0, 0]);
    const field: Field = {
      id: "field-1", parcelId: "parcel-1", boundary, status: "ready",
      crop: "corn", plantedAt: 0, trueYieldTonsPerAcre: 5, harvestedAcres: 0,
    };
    save.fields.push(field);
    enqueueTask(save, field, "harvest", 0);
    // Tick long enough for the combine to arrive and start cutting.
    tickTasks(save, 60, 60);
    expect(() => sellField(fakeMap(), fakeOverlay(), save, "field-1")).toThrow(/working/);

    // A merely QUEUED plow on another field cancels + refunds on sale.
    const f2: Field = { id: "field-2", parcelId: "parcel-2", boundary, status: "stubble", purchaseCost: 1000 };
    save.fields.push(f2);
    save.parcels.push({ id: "parcel-2", boundary, owned: true });
    const cashBefore = save.money;
    const task = enqueueTask(save, f2, "plow", 0);
    expect(save.money).toBe(cashBefore - task.costPaid);
    sellField(fakeMap(), fakeOverlay(), save, "field-2");
    expect(save.money).toBe(cashBefore + 1000); // plow refunded + land refunded
  });

  it("throws for an id that isn't an owned field", () => {
    const save = newGame();
    expect(() => sellField(fakeMap(), fakeOverlay(), save, "field-404")).toThrow(/not found/);
  });
});
