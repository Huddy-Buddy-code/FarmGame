import { describe, it, expect } from "vitest";
import type { FeatureCollection } from "geojson";
import type { Meters, LngLat } from "../src/geo/coords";
import { buildRoadNetwork, planRoute, nearestRoadPoint, polylineLength } from "../src/sim/roadNet";
import { setRoadNetwork, ensureAgents, enqueueTask, tickTasks } from "../src/sim/tasks";
import { tickFarming } from "../src/sim/farming";
import { newGame } from "../src/state/saveState";
import type { Field, SaveState } from "../src/state/saveState";
import { minutesPerMonth } from "../src/sim/calendar";
import { setProjection } from "../src/geo/coords";
import { beforeAll, afterEach } from "vitest";

beforeAll(() => setProjection(15, "N"));
afterEach(() => setRoadNetwork(null)); // never leak a network into other suites

/** Tests feed coordinates already in meters; identity "projection". */
const identity = (p: LngLat): Meters => [p[0], p[1]];

/** An L-shaped road: west–east along y=0 from x=0..2000, then north up
 * x=2000 from y=0..2000. */
const L_ROADS: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[0, 0], [1000, 0], [2000, 0]] } },
    { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[2000, 0], [2000, 1000], [2000, 2000]] } },
  ],
};

describe("road network graph", () => {
  it("connects separately-drawn ways that share an endpoint", () => {
    const net = buildRoadNetwork(L_ROADS, identity);
    // From near the west end to near the north end — only reachable if the
    // two LineStrings merged at [2000, 0].
    const route = planRoute(net, [100, 300], [1900, 1900]);
    expect(route).not.toBeNull();
    // The route should pass close to the corner at [2000, 0].
    const nearCorner = route!.some((p) => Math.hypot(p[0] - 2000, p[1] - 0) < 1);
    expect(nearCorner).toBe(true);
  });

  it("snaps to the nearest point ON a segment, not just to node vertices", () => {
    const net = buildRoadNetwork(L_ROADS, identity);
    const snap = nearestRoadPoint(net, [500, 300])!;
    expect(snap.point[0]).toBeCloseTo(500, 0);
    expect(snap.point[1]).toBeCloseTo(0, 0);
  });

  it("skips roads for short hops and absurd detours", () => {
    const net = buildRoadNetwork(L_ROADS, identity);
    // Short hop: 50 m apart — no road trip.
    expect(planRoute(net, [100, 300], [100, 350])).toBeNull();
    // Detour test: two points far from the road but near each other relative
    // to the road detour — getting on/off costs more than driving direct.
    expect(planRoute(net, [500, 1500], [900, 1500])).toBeNull();
  });

  it("route length beats or explains the straight line sensibly", () => {
    const net = buildRoadNetwork(L_ROADS, identity);
    const from: Meters = [0, 100], to: Meters = [2000, 100];
    const route = planRoute(net, from, to)!;
    expect(route).not.toBeNull();
    const len = polylineLength(route);
    const straight = Math.hypot(to[0] - from[0], to[1] - from[1]);
    expect(len).toBeGreaterThanOrEqual(straight);
    expect(len).toBeLessThanOrEqual(straight * 3.5);
    // Starts and ends exactly at the endpoints.
    expect(route[0]).toEqual(from);
    expect(route[route.length - 1]).toEqual(to);
  });
});

describe("agents drive the roads (tasks.ts integration)", () => {
  const WINTER_1 = 9 * minutesPerMonth();
  const side = Math.sqrt(20 * 4046.8564224);
  // Field sits north of the east–west road; tractor starts at the west end.
  const boundary: Meters[] = [[1600, 400], [1600 + side, 400], [1600 + side, 400 + side], [1600, 400 + side]];

  function runUntil(save: SaveState, from: number, done: () => boolean, capMinutes = 200_000, step = 10): number {
    let now = from;
    while (!done() && now - from < capMinutes) {
      now += step;
      tickFarming(save, now);
      tickTasks(save, now, step, () => 0.5);
    }
    return now;
  }

  it("a tractor travels via the road: it visibly touches the road line en route", () => {
    const net = buildRoadNetwork(L_ROADS, identity);
    setRoadNetwork(net);
    const save = newGame();
    ensureAgents(save, [0, 200]); // 200 m north of the road's west end
    const field: Field = { id: "field-1", parcelId: "parcel-1", boundary, status: "stubble" };
    save.fields.push(field);
    const tractor = save.agents.find((a) => a.kind === "tractor")!;

    let onRoad = false;
    let now = WINTER_1;
    enqueueTask(save, field, "plow", now);
    while (field.status !== "tilled" && now < WINTER_1 + 200_000) {
      now += 5;
      tickFarming(save, now);
      tickTasks(save, now, 5, () => 0.5);
      // "On the road" = within 2 m of the y=0 line while traveling.
      if (tractor.state === "traveling" && Math.abs(tractor.pos[1]) < 2 && tractor.pos[0] > 50) onRoad = true;
    }
    expect(field.status).toBe("tilled");
    expect(onRoad).toBe(true);
  });

  it("without a network the same trip still completes (straight-line fallback)", () => {
    setRoadNetwork(null);
    const save = newGame();
    ensureAgents(save, [0, 200]);
    const field: Field = { id: "field-1", parcelId: "parcel-1", boundary, status: "stubble" };
    save.fields.push(field);
    let now = WINTER_1;
    enqueueTask(save, field, "plow", now);
    now = runUntil(save, now, () => field.status === "tilled");
    expect(field.status).toBe("tilled");
  });
});
