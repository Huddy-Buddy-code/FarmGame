import { describe, it, expect, beforeAll } from "vitest";
import { setProjection } from "../src/geo/coords";
import type { Meters } from "../src/geo/coords";
import { newGame } from "../src/state/saveState";
import type { SaveState } from "../src/state/saveState";
import {
  ensureAgents, buyAgent, buyImplement, tickTasks, queueSellRun, sellableStock,
} from "../src/sim/tasks";
import { buyBuildingAt, assignSiloCrop, storeSilage } from "../src/sim/buildings";
import { sellGrain, sellStoredBalesFrom, sellAllOfProduct } from "../src/sim/economy";
import {
  grainUnitPrice, grainInstantPrice, baleInstantPrice, baleUnitPrice, silageUnitPrice, silageInstantPrice,
  monthOf, peakSaleMonth,
} from "../src/sim/market";
import { minutesPerMonth } from "../src/sim/calendar";
import { gameConfig } from "../src/config/gameConfig";

beforeAll(() => setProjection(15, "N"));

const DEC = 9 * minutesPerMonth(); // an absolute-month that lands in December

function run(save: SaveState, from: number, done: () => boolean, cap = 400_000, step = 60): number {
  let now = from;
  while (!done() && now - from < cap) {
    now += step;
    tickTasks(save, now, step, () => 0.5);
  }
  return now;
}

/** Farm with a tractor + grain trailer, a corn silo, and a Sell Point. */
function grainFarm(tons = 40): SaveState {
  const save = newGame();
  ensureAgents(save, [0, 0]);
  buyImplement(save, "grainTrailer", "medium");
  const silo = buyBuildingAt(save, "silo", [-100, -100], "large");
  assignSiloCrop(save, silo.id, "corn");
  buyBuildingAt(save, "sellPoint", [300, 300]);
  save.grain.corn = tons;
  return save;
}

describe("instant vs delivered pricing", () => {
  it("selling from the panel forgoes the seasonal premium AND pays a pickup fee", () => {
    const base = gameConfig.crops.corn.sellPricePerTon;
    expect(grainInstantPrice("corn")).toBeCloseTo(base * (1 - gameConfig.market.instantSellPenaltyPct), 6);
    // Even at the peak, the instant price is unmoved — no seasonal premium.
    expect(grainInstantPrice("corn")).toBeLessThan(grainUnitPrice("corn", peakSaleMonth()));
  });

  it("hauling to market is worth meaningfully more at the peak", () => {
    // The gap narrowed in the 2026-07-25 realism pass: the seasonal premium
    // went from +25% to a realistic +12%, so hauling is worth ~24% over
    // clicking sell rather than ~39%. Still the reason the Sell task exists.
    const hauled = grainUnitPrice("corn", peakSaleMonth());
    const instant = grainInstantPrice("corn");
    expect(hauled / instant).toBeGreaterThan(1.2); // ~1.24 at +12% vs −10%
  });

  it("applies to bales the same way", () => {
    const base = gameConfig.baleProducts.hay.pricePerBale;
    expect(baleInstantPrice("hay")).toBeCloseTo(base * 0.9, 6);
    expect(baleInstantPrice("hay")).toBeLessThan(baleUnitPrice("hay", peakSaleMonth()));
  });
});

describe("queueSellRun — when a run is worth making", () => {
  it("refuses with no Sell Point to haul to", () => {
    const save = newGame();
    ensureAgents(save, [0, 0]);
    buyImplement(save, "grainTrailer", "medium");
    save.grain.corn = 50;
    expect(queueSellRun(save, "corn")).toBeUndefined();
  });

  it("refuses with nothing in storage", () => {
    const save = grainFarm(0);
    expect(queueSellRun(save, "corn")).toBeUndefined();
  });

  it("queues a run when there's stock and somewhere to take it", () => {
    const save = grainFarm();
    const task = queueSellRun(save, "corn");
    expect(task).toBeTruthy();
    expect(task!.type).toBe("sell");
    expect(task!.sellProduct).toBe("corn");
  });

  it("won't stack an uncrewed second run", () => {
    const save = grainFarm();
    expect(queueSellRun(save, "corn")).toBeTruthy();
    expect(queueSellRun(save, "corn")).toBeUndefined(); // first one isn't crewed yet
  });

  it("caps the crew at maxCrewSize", () => {
    const save = grainFarm(5000);
    save.money = 10_000_000;
    for (let i = 0; i < 6; i++) {
      buyAgent(save, "tractor", "medium", [0, 0]);
      buyImplement(save, "grainTrailer", "medium");
    }
    for (let i = 0; i < 10; i++) {
      const t = queueSellRun(save, "corn");
      if (t) t.agentId = save.agents[i % save.agents.length]!.id;
    }
    expect(save.tasks.filter((t) => t.type === "sell").length).toBe(gameConfig.hauling.maxCrewSize);
  });
});

describe("a static sell backlog grows its own crew, live (2026-08-15 fix)", () => {
  // The bug this guards: `queueSellRun`'s crew-growth logic (crew cap,
  // "every existing hauler already crewed", a free tractor+trailer
  // available) was only ever CALLED at one-off trigger moments (the
  // Inventory tab's Haul button, `tickAutoSell`'s scheduled month) — every
  // test above proves the function's own gates are correct, but all of
  // them call it directly. In real play, once the first sell task is
  // running and nothing new triggers a fresh call, a second tractor+
  // trailer never joined no matter how large the backlog was. Live
  // `tickTasks` simulation, no manual `queueSellRun` calls after the
  // first — proves the periodic re-check (added to the "sell" tick block
  // itself) actually closes that gap end to end. Mirrors
  // crewPairing.test.ts's "a static bale backlog grows its own crew, live".
  it("adds a second grain-cart rig to the sell run, with no further queueSellRun calls after the seed", () => {
    const save = grainFarm(5000); // a large static backlog — plenty of time for a second rig to join
    save.money = 10_000_000;
    buyAgent(save, "tractor", "medium", [0, 0]); // rig 2's tractor
    buyImplement(save, "grainTrailer", "medium"); // rig 2's trailer

    expect(queueSellRun(save, "corn")).toBeTruthy();

    run(save, 0, () =>
      save.tasks.filter((t) => t.type === "sell" && t.sellProduct === "corn").length >= 2
      && save.tasks.filter((t) => t.type === "sell" && t.sellProduct === "corn").every((t) => !!t.agentId),
    );

    const runs = save.tasks.filter((t) => t.type === "sell" && t.sellProduct === "corn");
    expect(runs.length).toBeGreaterThanOrEqual(2);
    expect(runs.every((t) => !!t.agentId)).toBe(true);
    // Two DISTINCT tractors, each running its own leg in parallel — not
    // both somehow sharing one.
    const agentIds = new Set(runs.map((t) => t.agentId));
    expect(agentIds.size).toBe(2);
  });
});

describe("sellableStock", () => {
  it("counts grain in the bin", () => {
    const save = grainFarm(37);
    expect(sellableStock(save, "corn")).toBe(37);
  });

  it("counts bales across every storage building, but NOT loose ones in fields", () => {
    const save = newGame();
    const barn = buyBuildingAt(save, "baleArea", [0, 0]);
    barn.storedBales = { hay: 12 };
    const barn2 = buyBuildingAt(save, "baleArea", [50, 0]);
    barn2.storedBales = { hay: 8 };
    save.fields.push({
      id: "f", parcelId: "p", boundary: [[0, 0], [10, 0], [10, 10], [0, 10]] as Meters[],
      status: "mulched", baleProduct: "hay", baleLocations: [[1, 1], [2, 2]],
    });
    // Loose field bales are the bale-HAUL job's business, not the sell run's.
    expect(sellableStock(save, "hay")).toBe(20);
  });
});

describe("a sell run end to end", () => {
  it("hauls grain to the Sell Point and pays the FULL seasonal price on arrival", () => {
    const save = grainFarm(40);
    const before = save.money;
    queueSellRun(save, "corn");

    run(save, DEC, () => !save.tasks.some((t) => t.type === "sell"));

    expect(save.grain.corn).toBe(0);
    expect(save.tasks.filter((t) => t.type === "sell")).toHaveLength(0);
    // Delivered price, not the instant one.
    const expected = Math.round(40 * grainUnitPrice("corn", monthOf(DEC)));
    expect(save.money - before).toBe(expected);
    expect(save.money - before).toBeGreaterThan(Math.round(40 * grainInstantPrice("corn")));
  });

  it("makes repeat trips when the load exceeds one trailer", () => {
    // Medium trailer holds 60 t; 150 t needs three runs.
    const save = grainFarm(150);
    const before = save.money;
    queueSellRun(save, "corn");
    run(save, DEC, () => !save.tasks.some((t) => t.type === "sell"));
    expect(save.grain.corn).toBe(0);
    expect(save.money - before).toBe(Math.round(150 * grainUnitPrice("corn", monthOf(DEC))));
  });

  it("releases the tractor when it's done", () => {
    const save = grainFarm(20);
    queueSellRun(save, "corn");
    run(save, DEC, () => !save.tasks.some((t) => t.type === "sell"));
    const tractor = save.agents.find((a) => a.kind === "tractor")!;
    expect(tractor.taskId).toBeUndefined();
    expect(tractor.state).toBe("idle");
  });

  it("empties the trailer after each delivery — no phantom cargo", () => {
    const save = grainFarm(40);
    queueSellRun(save, "corn");
    run(save, DEC, () => !save.tasks.some((t) => t.type === "sell"));
    const trailer = save.implements.find((i) => i.kind === "grainTrailer")!;
    expect(trailer.cargoTons ?? 0).toBe(0);
    expect(trailer.cargoCrop).toBeUndefined();
  });

  it("hauls BALES out of storage the same way", () => {
    const save = newGame();
    ensureAgents(save, [0, 0]);
    buyImplement(save, "baleTrailer", "medium"); // 20 bales
    const store = buyBuildingAt(save, "baleArea", [-100, -100]);
    store.storedBales = { hay: 15 };
    buyBuildingAt(save, "sellPoint", [300, 300]);
    const before = save.money;

    queueSellRun(save, "hay");
    run(save, DEC, () => !save.tasks.some((t) => t.type === "sell"));

    expect(store.storedBales!.hay).toBe(0);
    expect(save.money - before).toBe(Math.round(15 * baleUnitPrice("hay", monthOf(DEC))));
  });

  it("gives up gracefully if the stock is sold out from under it mid-run", () => {
    const save = grainFarm(40);
    queueSellRun(save, "corn");
    // Let it get underway, then sell the bin out from under the run.
    run(save, DEC, () => save.tasks.some((t) => t.type === "sell" && !!t.agentId), 5000);
    sellGrain(save, "corn", Infinity);
    run(save, DEC, () => !save.tasks.some((t) => t.type === "sell"));

    expect(save.tasks.filter((t) => t.type === "sell")).toHaveLength(0);
    const tractor = save.agents.find((a) => a.kind === "tractor")!;
    expect(tractor.state).toBe("idle");
  });

  it("logs the delivery to the Completed feed", () => {
    const save = grainFarm(30);
    queueSellRun(save, "corn");
    run(save, DEC, () => !save.tasks.some((t) => t.type === "sell"));
    expect(save.completedTasks!.some((c) => c.type === "sellGrain" && c.crop === "corn")).toBe(true);
  });

  it("a three-trip run logs ONE Completed row carrying the whole total", () => {
    // 150 t through a 60 t trailer = three deliveries. Each used to log its own
    // near-identical row (maintainer request, 2026-07-23).
    const save = grainFarm(150);
    queueSellRun(save, "corn");
    run(save, DEC, () => !save.tasks.some((t) => t.type === "sell"));

    const rows = save.completedTasks!.filter((c) => c.type === "sellGrain" && c.crop === "corn");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tons).toBeCloseTo(150, 6);
    expect(rows[0]!.revenue).toBe(Math.round(150 * grainUnitPrice("corn", monthOf(DEC))));
  });

  it("an instant sale folds into the same row as a hauled one", () => {
    const save = grainFarm(40);
    queueSellRun(save, "corn");
    run(save, DEC, () => !save.tasks.some((t) => t.type === "sell"));
    // Then top the bin up and sell the rest straight from the panel.
    save.grain.corn = 10;
    sellAllOfProduct(save, "corn", DEC);

    const rows = save.completedTasks!.filter((c) => c.type === "sellGrain" && c.crop === "corn");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tons).toBeCloseTo(50, 6);
  });
});

describe("Sell Point is free", () => {
  it("costs nothing to build, so hauling is never gated behind cash", () => {
    expect(gameConfig.buildings.sellPoint.price).toBe(0);
    const save = newGame();
    const before = save.money;
    buyBuildingAt(save, "sellPoint", [10, 10]);
    expect(save.money).toBe(before);
  });
});

describe("storage sell helpers still work for the instant path", () => {
  it("sellStoredBalesFrom empties one building at the instant price", () => {
    const save = newGame();
    const store = buyBuildingAt(save, "baleArea", [0, 0]);
    store.storedBales = { straw: 10 };
    const before = save.money;
    const r = sellStoredBalesFrom(save, store, "straw");
    expect(r.bales).toBe(10);
    expect(save.money - before).toBe(Math.round(10 * baleInstantPrice("straw")));
    expect(store.storedBales.straw).toBe(0);
  });
});

/** Farm with a tractor + Forage Wagon, a bunker, and a Sell Point — the
 * silage counterpart of `grainFarm`. */
function silageFarmWithStock(tons = 40): SaveState {
  const save = newGame();
  ensureAgents(save, [0, 0]);
  buyImplement(save, "forageWagon", "medium");
  buyBuildingAt(save, "silageBunker", [-100, -100], "medium");
  buyBuildingAt(save, "sellPoint", [300, 300]);
  storeSilage(save, "cornSilage", tons);
  return save;
}

describe("bunker silage joins the sell system (2026-08-15)", () => {
  it("prices the same way grain and bales do: instant forgoes the season AND pays a pickup fee", () => {
    const base = gameConfig.silageProducts.cornSilage.pricePerTon;
    expect(silageInstantPrice("cornSilage")).toBeCloseTo(base * (1 - gameConfig.market.instantSellPenaltyPct), 6);
    expect(silageInstantPrice("cornSilage")).toBeLessThan(silageUnitPrice("cornSilage", peakSaleMonth()));
  });

  it("sellableStock reads the pooled bunker balance", () => {
    const save = silageFarmWithStock(75);
    expect(sellableStock(save, "cornSilage")).toBe(75);
  });

  it("queueSellRun refuses with nothing in the bunkers", () => {
    const save = silageFarmWithStock(0);
    expect(queueSellRun(save, "cornSilage")).toBeUndefined();
  });

  it("queueSellRun refuses with no Sell Point to haul to", () => {
    const save = newGame();
    ensureAgents(save, [0, 0]);
    buyImplement(save, "forageWagon", "medium");
    buyBuildingAt(save, "silageBunker", [-100, -100], "medium");
    storeSilage(save, "cornSilage", 40);
    expect(queueSellRun(save, "cornSilage")).toBeUndefined();
  });

  it("hauls silage out of the bunker to the Sell Point for the FULL seasonal price, using the Forage Wagon", () => {
    const save = silageFarmWithStock(40);
    const before = save.money;

    queueSellRun(save, "cornSilage");
    run(save, DEC, () => !save.tasks.some((t) => t.type === "sell"));

    expect(silageRoomOf(save)).toBe(0); // bunker drained
    const expected = Math.round(40 * silageUnitPrice("cornSilage", monthOf(DEC)));
    expect(save.money - before).toBe(expected);
    expect(save.money - before).toBeGreaterThan(Math.round(40 * silageInstantPrice("cornSilage")));

    // Same Forage Wagon the chop relay uses — no new implement kind needed.
    const wagon = save.implements.find((i) => i.kind === "forageWagon")!;
    expect(wagon.cargoTons ?? 0).toBe(0);
    expect(wagon.cargoSilage).toBeUndefined();
  });

  function silageRoomOf(save: SaveState): number {
    return save.silage?.cornSilage ?? 0;
  }

  it("releases the tractor when it's done", () => {
    const save = silageFarmWithStock(20);
    queueSellRun(save, "cornSilage");
    run(save, DEC, () => !save.tasks.some((t) => t.type === "sell"));
    const tractor = save.agents.find((a) => a.kind === "tractor")!;
    expect(tractor.taskId).toBeUndefined();
    expect(tractor.state).toBe("idle");
  });
});
