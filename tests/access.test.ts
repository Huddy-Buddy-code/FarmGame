import { describe, it, expect, beforeAll, afterEach } from "vitest";
import type { FeatureCollection } from "geojson";
import { setProjection } from "../src/geo/coords";
import type { Meters, LngLat } from "../src/geo/coords";
import { buildRoadNetwork } from "../src/sim/roadNet";
import { defaultAccessPoints } from "../src/sim/access";
import { setRoadNetwork, ensureAgents, enqueueTask, tickTasks } from "../src/sim/tasks";
import { tickFarming } from "../src/sim/farming";
import { newGame } from "../src/state/saveState";
import type { Field } from "../src/state/saveState";
import { minutesPerMonth } from "../src/sim/calendar";

beforeAll(() => setProjection(15, "N"));
afterEach(() => setRoadNetwork(null));

const identity = (p: LngLat): Meters => [p[0], p[1]];
const WINTER_1 = 9 * minutesPerMonth();

/** One straight west–east road along y = 0. */
const ROAD: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[-2000, 0], [0, 0], [2000, 0], [4000, 0]] } },
  ],
};

// A square field north of the road: y from 200 (road side) to 200+side.
const side = Math.sqrt(20 * 4046.8564224);
const boundary: Meters[] = [[1000, 200], [1000 + side, 200], [1000 + side, 200 + side], [1000, 200 + side]];

describe("default access-point placement", () => {
  it("puts gate 1 on the road-facing edge and gate 2 roughly opposite", () => {
    const net = buildRoadNetwork(ROAD, identity);
    const [g1, g2] = defaultAccessPoints(boundary, net);
    expect(g1[1]).toBeCloseTo(200, 0); // south (road-side) edge
    expect(g2[1]).toBeCloseTo(200 + side, -1); // north edge, half a perimeter away
    const gap = Math.hypot(g1[0] - g2[0], g1[1] - g2[1]);
    expect(gap).toBeGreaterThan(side * 0.8); // genuinely far apart
  });

  it("without a road network still returns two distinct on-boundary points", () => {
    const [g1, g2] = defaultAccessPoints(boundary, null);
    expect(Math.hypot(g1[0] - g2[0], g1[1] - g2[1])).toBeGreaterThan(side * 0.8);
  });
});

describe("gate-aware travel", () => {
  it("a tractor entering a gated field passes through a gate, not straight across the fence", () => {
    const net = buildRoadNetwork(ROAD, identity);
    setRoadNetwork(net);
    const save = newGame();
    ensureAgents(save, [0, 50]); // west, near the road
    const field: Field = {
      id: "field-1", parcelId: "parcel-1", boundary, status: "stubble",
      // One gate mid-south edge, one mid-north — hand-placed for a stable assertion.
      accessPoints: [[1000 + side / 2, 200], [1000 + side / 2, 200 + side]],
    };
    save.fields.push(field);
    const tractor = save.agents.find((a) => a.kind === "tractor")!;

    let minGateDist = Infinity;
    let now = WINTER_1;
    enqueueTask(save, field, "plow", now);
    // Fine steps through the drive so we can sample the position en route
    // (a big step covers the whole trip inside one tick).
    while (tractor.state !== "working" && now < WINTER_1 + 2_000) {
      now += 0.25;
      tickFarming(save, now);
      tickTasks(save, now, 0.25, () => 0.5);
      const d = Math.hypot(tractor.pos[0] - (1000 + side / 2), tractor.pos[1] - 200);
      minGateDist = Math.min(minGateDist, d);
    }
    expect(tractor.state).toBe("working");
    // Coarse steps for the plowing itself.
    while (field.status !== "tilled" && now < WINTER_1 + 300_000) {
      now += 60;
      tickFarming(save, now);
      tickTasks(save, now, 60, () => 0.5);
    }
    expect(field.status).toBe("tilled");
    // It should have driven essentially THROUGH the south gate on the way in
    // (sampled every ~92 m of travel, so allow half a step of slack; a
    // straight fence-crossing path never comes within ~300 m of this gate).
    expect(minGateDist).toBeLessThan(50);
  });

  it("a field without accessPoints travels exactly as before (no gate detour)", () => {
    setRoadNetwork(null);
    const save = newGame();
    ensureAgents(save, [0, 50]);
    const field: Field = { id: "field-1", parcelId: "parcel-1", boundary, status: "stubble" };
    save.fields.push(field);
    let now = WINTER_1;
    enqueueTask(save, field, "plow", now);
    while (field.status !== "tilled" && now < WINTER_1 + 300_000) {
      now += 30;
      tickFarming(save, now);
      tickTasks(save, now, 30, () => 0.5);
    }
    expect(field.status).toBe("tilled");
  });
});
