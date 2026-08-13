import { describe, it, expect } from "vitest";
import {
  lngLatTo3857, tilesForLngLatBbox, tilesNearPoints, countyPrefetchPlan, runPrefetch,
  viewportPrefetchPlan, COUNTY_ZOOMS, ASSET_ZOOMS, ASSET_RADIUS_M, MAX_PLAN_TILES,
  VIEWPORT_MIN_ZOOM, VIEWPORT_PLAN_CAP,
} from "../src/map/naipPrefetch";
import { configureNaipCache, memoryTileStore, tileKey, TILE_MAXZOOM } from "../src/map/tileCache";

// Story County-ish extents.
const storyBbox: [number, number, number, number] = [-93.7, 41.86, -93.23, 42.21];
const ames: [number, number] = [-93.62, 42.03];

function countingFetch(ok = true): { fetchFn: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchFn = (async (url: string) => {
    calls.push(url);
    return { ok, status: ok ? 200 : 500, arrayBuffer: async () => new ArrayBuffer(8) };
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe("prefetch tile enumeration", () => {
  it("projects lng/lat to EPSG:3857 (origin fixed point)", () => {
    const [x, y] = lngLatTo3857(0, 0);
    expect(x).toBeCloseTo(0, 6);
    expect(y).toBeCloseTo(0, 6);
  });

  it("the whole world is 1 tile at z0, 4 at z1", () => {
    const world: [number, number, number, number] = [-179.9, -84, 179.9, 84];
    expect(tilesForLngLatBbox(world, 0)).toHaveLength(1);
    expect(tilesForLngLatBbox(world, 1)).toHaveLength(4);
  });

  it("a county-sized bbox stays a modest tile count at browse zooms", () => {
    let total = 0;
    for (const z of COUNTY_ZOOMS) total += tilesForLngLatBbox(storyBbox, z).length;
    // ~40 km county: single digits at z10 growing to dozens at z13.
    expect(total).toBeGreaterThan(10);
    expect(total).toBeLessThan(300);
  });

  it("tile counts quadruple-ish per zoom step", () => {
    const z12 = tilesForLngLatBbox(storyBbox, 12).length;
    const z13 = tilesForLngLatBbox(storyBbox, 13).length;
    expect(z13).toBeGreaterThan(z12 * 2);
    expect(z13).toBeLessThan(z12 * 6);
  });

  it("tilesNearPoints covers the radius and dedupes overlapping points", () => {
    const solo = tilesNearPoints([ames], ASSET_RADIUS_M, 15);
    expect(solo.length).toBeGreaterThanOrEqual(4);
    // A second point on top of the first adds nothing.
    const duo = tilesNearPoints([ames, ames], ASSET_RADIUS_M, 15);
    expect(duo).toHaveLength(solo.length);
    // No duplicates in the output.
    expect(new Set(duo.map(tileKey)).size).toBe(duo.length);
  });

  it("ASSET_ZOOMS is contiguous 14..TILE_MAXZOOM — no gap if TILE_MAXZOOM changes", () => {
    // Regression: a hardcoded [14, 15, 16, TILE_MAXZOOM] silently skipped z17
    // once TILE_MAXZOOM moved from 17 to 18 (2026-08-12) — nothing would have
    // caught that but this test.
    expect(ASSET_ZOOMS).toEqual(
      Array.from({ length: TILE_MAXZOOM - 13 }, (_, i) => 14 + i),
    );
    expect(ASSET_ZOOMS[ASSET_ZOOMS.length - 1]).toBe(TILE_MAXZOOM);
  });
});

describe("countyPrefetchPlan", () => {
  it("orders county browse zooms before near-asset high-res, deduped", () => {
    const plan = countyPrefetchPlan(storyBbox, [ames]);
    expect(plan[0]!.z).toBe(COUNTY_ZOOMS[0]);
    const firstAssetIdx = plan.findIndex((t) => t.z === ASSET_ZOOMS[0] || t.z > 13);
    // Everything before the first asset tile is a county browse tile.
    for (const t of plan.slice(0, firstAssetIdx)) expect(COUNTY_ZOOMS).toContain(t.z);
    expect(new Set(plan.map(tileKey)).size).toBe(plan.length);
  });

  it("caps a runaway plan (sprawling county + big farm)", () => {
    const huge: [number, number, number, number] = [-104, 37, -94, 41]; // ~Kansas
    const manyAssets: [number, number][] = Array.from({ length: 200 }, (_, i) => [-100 + i * 0.02, 39]);
    const plan = countyPrefetchPlan(huge, manyAssets);
    expect(plan.length).toBeLessThanOrEqual(MAX_PLAN_TILES);
  });

  it("no assets → county browse tiles only", () => {
    const plan = countyPrefetchPlan(storyBbox, []);
    for (const t of plan) expect(COUNTY_ZOOMS).toContain(t.z);
  });
});

describe("runPrefetch", () => {
  it("fetches every planned tile once; a re-run is all warm hits", async () => {
    const { fetchFn, calls } = countingFetch();
    configureNaipCache({ fetchFn, store: memoryTileStore() });
    const tiles = tilesForLngLatBbox(storyBbox, 11);
    const first = await runPrefetch(tiles, { concurrency: 3 });
    expect(first.fetched).toBe(tiles.length);
    expect(first.failed).toBe(0);
    expect(calls).toHaveLength(tiles.length);

    const second = await runPrefetch(tiles, { concurrency: 3 });
    expect(second.cached).toBe(tiles.length);
    expect(second.fetched).toBe(0);
    expect(calls).toHaveLength(tiles.length); // no new network
  });

  it("counts failures instead of throwing (a miss stays a live fetch later)", async () => {
    const { fetchFn } = countingFetch(false);
    configureNaipCache({ fetchFn, store: memoryTileStore() });
    const tiles = tilesForLngLatBbox(storyBbox, 10);
    const res = await runPrefetch(tiles);
    expect(res.failed).toBe(tiles.length);
    expect(res.fetched).toBe(0);
  });

  it("reports progress up to the total", async () => {
    const { fetchFn } = countingFetch();
    configureNaipCache({ fetchFn, store: memoryTileStore() });
    const tiles = tilesForLngLatBbox(storyBbox, 11);
    const seen: number[] = [];
    await runPrefetch(tiles, { concurrency: 2, onProgress: (done) => seen.push(done) });
    expect(seen).toHaveLength(tiles.length);
    expect(seen[seen.length - 1]).toBe(tiles.length);
  });

  it("a re-run under a different provider re-fetches instead of false-hitting the other provider's cache", async () => {
    const { fetchFn, calls } = countingFetch();
    configureNaipCache({ fetchFn, store: memoryTileStore() });
    const tiles = tilesForLngLatBbox(storyBbox, 12);
    const first = await runPrefetch(tiles, { provider: "usda-apfo" });
    expect(first.fetched).toBe(tiles.length);
    const second = await runPrefetch(tiles, { provider: "usgs-naip" });
    expect(second.fetched).toBe(tiles.length); // NOT cached — different provider, different bytes
    expect(second.cached).toBe(0);
    expect(calls).toHaveLength(tiles.length * 2);
  });
});

describe("viewportPrefetchPlan", () => {
  const smallView: [number, number, number, number] = [-93.63, 42.02, -93.61, 42.04]; // ~2km around Ames

  it("no-ops below VIEWPORT_MIN_ZOOM — county-wide prefetch already covers those zooms", () => {
    expect(viewportPrefetchPlan(smallView, VIEWPORT_MIN_ZOOM - 1)).toEqual([]);
  });

  it("covers MORE than the bare viewport — buffered so cache stays ahead of a continuing pan", () => {
    const bare = tilesForLngLatBbox(smallView, VIEWPORT_MIN_ZOOM);
    const buffered = viewportPrefetchPlan(smallView, VIEWPORT_MIN_ZOOM);
    for (const t of bare) expect(buffered.map(tileKey)).toContain(tileKey(t));
    expect(buffered.length).toBeGreaterThan(bare.length);
  });

  it("clamps a fractional/over-max zoom to an integer at most TILE_MAXZOOM", () => {
    const overzoomed = viewportPrefetchPlan(smallView, TILE_MAXZOOM + 5.7);
    const atCeiling = viewportPrefetchPlan(smallView, TILE_MAXZOOM);
    expect(overzoomed).toEqual(atCeiling);
  });

  it("caps at VIEWPORT_PLAN_CAP even for a wide viewport", () => {
    const wide: [number, number, number, number] = [-93.9, 41.8, -93.0, 42.3];
    expect(viewportPrefetchPlan(wide, TILE_MAXZOOM).length).toBeLessThanOrEqual(VIEWPORT_PLAN_CAP);
  });
});
