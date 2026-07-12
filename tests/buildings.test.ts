import { describe, it, expect } from "vitest";
import { newGame } from "../src/state/saveState";
import { gameConfig } from "../src/config/gameConfig";
import {
  buyBuildingAt, sellBuilding, buildingPrice, buildingDisplayName, siloCapacityOf,
  siloCapacityTons, siloCapacityForCrop,
  assignSiloCrop, baleCapacity, barnSlotTotal, nearestFarmYard, nearestOfKind,
} from "../src/sim/buildings";

describe("buildings (maintainer request, 2026-07-12): placeable storage + rally point", () => {
  it("buys a building, deducts its price, and adds it to save.buildings", () => {
    const save = newGame();
    const before = save.money;
    const b = buyBuildingAt(save, "silo", [10, 20]);
    expect(save.money).toBe(before - buildingPrice("silo", "small"));
    expect(save.buildings).toContainEqual(b);
    expect(b.kind).toBe("silo");
    expect(b.pos).toEqual([10, 20]);
  });

  it("throws (and doesn't charge) when the farm can't afford it", () => {
    const save = newGame();
    save.money = 10;
    expect(() => buyBuildingAt(save, "silo", [0, 0])).toThrow(/cash|afford/);
    expect(save.buildings).toHaveLength(0);
    expect(save.money).toBe(10);
  });

  it("ids are unique and sequential per building, not shared across kinds", () => {
    const save = newGame();
    const a = buyBuildingAt(save, "silo", [0, 0]);
    const b = buyBuildingAt(save, "farmYard", [1, 1]);
    const c = buyBuildingAt(save, "silo", [2, 2]);
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
  });

  it("sells a building back for its full purchase price, same rule as land/equipment", () => {
    const save = newGame();
    const b = buyBuildingAt(save, "tractorBarn", [0, 0]);
    const moneyAfterBuy = save.money;
    const { refund } = sellBuilding(save, b.id);
    expect(refund).toBe(buildingPrice("tractorBarn"));
    expect(save.money).toBe(moneyAfterBuy + refund);
    expect(save.buildings).toHaveLength(0);
  });

  it("throws selling a building that doesn't exist", () => {
    const save = newGame();
    expect(() => sellBuilding(save, "bld-999")).toThrow(/not found/);
  });

  it("siloCapacityTons sums capacity across every owned silo, 0 with none", () => {
    const save = newGame();
    expect(siloCapacityTons(save)).toBe(0);
    buyBuildingAt(save, "silo", [0, 0]);
    expect(siloCapacityTons(save)).toBe(gameConfig.buildings.silo.small.capacityTons);
    buyBuildingAt(save, "silo", [1, 1]);
    expect(siloCapacityTons(save)).toBe(gameConfig.buildings.silo.small.capacityTons * 2);
  });

  it("baleCapacity sums Bale Barns and Bale Areas together", () => {
    const save = newGame();
    buyBuildingAt(save, "baleBarn", [0, 0]);
    buyBuildingAt(save, "baleArea", [1, 1]);
    expect(baleCapacity(save)).toBe(
      gameConfig.buildings.baleBarn.capacityBales + gameConfig.buildings.baleArea.capacityBales,
    );
  });

  it("barnSlotTotal sums slots for the given barn kind only", () => {
    const save = newGame();
    buyBuildingAt(save, "tractorBarn", [0, 0]);
    buyBuildingAt(save, "implementBarn", [1, 1]);
    expect(barnSlotTotal(save, "tractorBarn")).toBe(gameConfig.buildings.tractorBarn.slots);
    expect(barnSlotTotal(save, "implementBarn")).toBe(gameConfig.buildings.implementBarn.slots);
  });

  it("nearestOfKind / nearestFarmYard picks the closest building of that kind, ignores others", () => {
    const save = newGame();
    buyBuildingAt(save, "silo", [0, 0]);
    const far = buyBuildingAt(save, "farmYard", [1000, 0]);
    const near = buyBuildingAt(save, "farmYard", [5, 0]);
    const nearest = nearestFarmYard(save, [0, 0]);
    expect(nearest?.id).toBe(near.id);
    expect(nearest?.id).not.toBe(far.id);
    expect(nearestOfKind(save, "silo", [0, 0])).toBeDefined();
  });

  it("nearestFarmYard is undefined when none has been built", () => {
    const save = newGame();
    buyBuildingAt(save, "silo", [0, 0]);
    expect(nearestFarmYard(save, [0, 0])).toBeUndefined();
  });
});

describe("silo crop assignment (maintainer request, 2026-07-12)", () => {
  it("an unassigned silo contributes no capacity to any crop", () => {
    const save = newGame();
    buyBuildingAt(save, "silo", [0, 0]);
    expect(siloCapacityForCrop(save, "corn")).toBe(0);
    expect(siloCapacityForCrop(save, "soybeans")).toBe(0);
  });

  it("assigning a silo to a crop gives that crop (and only that crop) capacity", () => {
    const save = newGame();
    const silo = buyBuildingAt(save, "silo", [0, 0]);
    assignSiloCrop(save, silo.id, "corn");
    expect(siloCapacityForCrop(save, "corn")).toBe(gameConfig.buildings.silo.small.capacityTons);
    expect(siloCapacityForCrop(save, "soybeans")).toBe(0);
  });

  it("multiple silos assigned to the same crop stack their capacity", () => {
    const save = newGame();
    const a = buyBuildingAt(save, "silo", [0, 0]);
    const b = buyBuildingAt(save, "silo", [1, 1]);
    assignSiloCrop(save, a.id, "corn");
    assignSiloCrop(save, b.id, "corn");
    expect(siloCapacityForCrop(save, "corn")).toBe(gameConfig.buildings.silo.small.capacityTons * 2);
  });

  it("re-assigning moves a silo's capacity from the old crop to the new one", () => {
    const save = newGame();
    const silo = buyBuildingAt(save, "silo", [0, 0]);
    assignSiloCrop(save, silo.id, "corn");
    assignSiloCrop(save, silo.id, "soybeans");
    expect(siloCapacityForCrop(save, "corn")).toBe(0);
    expect(siloCapacityForCrop(save, "soybeans")).toBe(gameConfig.buildings.silo.small.capacityTons);
  });

  it("clearing an assignment (undefined) drops the silo's capacity from that crop", () => {
    const save = newGame();
    const silo = buyBuildingAt(save, "silo", [0, 0]);
    assignSiloCrop(save, silo.id, "corn");
    assignSiloCrop(save, silo.id, undefined);
    expect(siloCapacityForCrop(save, "corn")).toBe(0);
  });

  it("throws assigning a crop to a non-silo building", () => {
    const save = newGame();
    const yard = buyBuildingAt(save, "farmYard", [0, 0]);
    expect(() => assignSiloCrop(save, yard.id, "corn")).toThrow(/silo|can't/i);
  });

  it("throws assigning a crop to a building that doesn't exist", () => {
    const save = newGame();
    expect(() => assignSiloCrop(save, "bld-999", "corn")).toThrow(/not found/);
  });
});

describe("silo sizes: Small/Medium/Large (maintainer request, 2026-07-12)", () => {
  it("each size has its own price and capacity, larger tiers hold more", () => {
    expect(siloCapacityOf("small")).toBe(200);
    expect(siloCapacityOf("medium")).toBe(500);
    expect(siloCapacityOf("large")).toBe(1000);
    expect(buildingPrice("silo", "medium")).toBeGreaterThan(buildingPrice("silo", "small"));
    expect(buildingPrice("silo", "large")).toBeGreaterThan(buildingPrice("silo", "medium"));
  });

  it("defaults to Small when no size is given (buy, price, and display name)", () => {
    const save = newGame();
    const b = buyBuildingAt(save, "silo", [0, 0]);
    expect(b.size).toBe("small");
    expect(buildingDisplayName("silo", undefined)).toBe("Small Silo");
  });

  it("buying a sized silo charges that size's price and stores its size", () => {
    const save = newGame();
    const before = save.money;
    const b = buyBuildingAt(save, "silo", [0, 0], "large");
    expect(b.size).toBe("large");
    expect(save.money).toBe(before - buildingPrice("silo", "large"));
  });

  it("a Medium/Large silo's capacity reflects its own size once assigned", () => {
    const save = newGame();
    const small = buyBuildingAt(save, "silo", [0, 0], "small");
    const large = buyBuildingAt(save, "silo", [1, 1], "large");
    assignSiloCrop(save, small.id, "corn");
    assignSiloCrop(save, large.id, "corn");
    expect(siloCapacityForCrop(save, "corn")).toBe(siloCapacityOf("small") + siloCapacityOf("large"));
  });

  it("selling a sized silo refunds that size's price, not the default", () => {
    const save = newGame();
    const b = buyBuildingAt(save, "silo", [0, 0], "medium");
    const moneyAfterBuy = save.money;
    const { refund } = sellBuilding(save, b.id);
    expect(refund).toBe(buildingPrice("silo", "medium"));
    expect(save.money).toBe(moneyAfterBuy + refund);
  });

  it("buildingDisplayName includes the size tier for silos, not for other buildings", () => {
    expect(buildingDisplayName("silo", "medium")).toBe("Medium Silo");
    expect(buildingDisplayName("farmYard")).toBe("Farm Yard");
  });
});
