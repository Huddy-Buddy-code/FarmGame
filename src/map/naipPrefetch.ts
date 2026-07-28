/**
 * Background NAIP prefetch (2026-07-28) — fills the persistent tile cache
 * (tileCache.ts) so panning and zooming hit warm cache instead of live
 * exportImage renders.
 *
 * Two-part plan, ordered cheap-and-wide → dear-and-narrow:
 *   1. WHOLE COUNTY at browse zooms (z10-13): a few hundred tiles, ~10-30 MB —
 *      zoomed-out panning becomes instant everywhere, forever.
 *   2. HIGH-RES (z14-TILE_MAXZOOM) only NEAR PLAYER ASSETS (fields, buildings,
 *      farmstead): the whole county at z17 would be thousands of tiles /
 *      hundreds of MB, but the ~1 km around assets is where the player
 *      actually zooms in. Re-run per new purchase (main.ts).
 *
 * Runs throttled (few concurrent fetches) a few seconds after boot so it never
 * competes with the initial view's own tile loads. Failures are counted, not
 * thrown — a miss just stays a live fetch like today.
 */

import { TILE_MAXZOOM, WORLD_3857, hasTile, loadTile, tileKey, type TileId } from "./tileCache";

/** lng/lat → EPSG:3857 meters. */
export function lngLatTo3857(lng: number, lat: number): [number, number] {
  const x = (lng / 180) * WORLD_3857;
  const clamped = Math.max(-85.051129, Math.min(85.051129, lat));
  const y = (Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360)) / Math.PI) * WORLD_3857;
  return [x, y];
}

/** All tiles at zoom `z` intersecting an EPSG:3857 bbox. */
export function tilesForBbox3857(
  [minX, minY, maxX, maxY]: [number, number, number, number],
  z: number,
): TileId[] {
  const n = Math.pow(2, z);
  const size = (2 * WORLD_3857) / n;
  const clampIdx = (i: number): number => Math.max(0, Math.min(n - 1, i));
  const x0 = clampIdx(Math.floor((minX + WORLD_3857) / size));
  const x1 = clampIdx(Math.floor((maxX + WORLD_3857) / size));
  const y0 = clampIdx(Math.floor((WORLD_3857 - maxY) / size));
  const y1 = clampIdx(Math.floor((WORLD_3857 - minY) / size));
  const out: TileId[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) out.push({ z, x, y });
  }
  return out;
}

/** Tiles at zoom `z` intersecting a lng/lat bbox [w, s, e, n]. */
export function tilesForLngLatBbox(bbox: [number, number, number, number], z: number): TileId[] {
  const [minX, minY] = lngLatTo3857(bbox[0], bbox[1]);
  const [maxX, maxY] = lngLatTo3857(bbox[2], bbox[3]);
  return tilesForBbox3857([minX, minY, maxX, maxY], z);
}

/** County-wide browse zooms (part 1 of the plan). */
export const COUNTY_ZOOMS: readonly number[] = [10, 11, 12, 13];
/** Near-asset high-res zooms (part 2). */
export const ASSET_ZOOMS: readonly number[] = [14, 15, 16, TILE_MAXZOOM];
/** Ground radius around an asset to keep sharp, meters. */
export const ASSET_RADIUS_M = 1200;
/** Safety valve: a plan never exceeds this many tiles (a sprawling western
 * county plus a big farm could otherwise queue tens of thousands). County
 * tiles come first in the plan, so truncation sheds the priciest z17 edges. */
export const MAX_PLAN_TILES = 3000;

/** Tiles at zoom `z` within `radiusM` GROUND meters of any point. Mercator
 * meters inflate by 1/cos(lat) — scale so the ground radius holds. */
export function tilesNearPoints(points: [number, number][], radiusM: number, z: number): TileId[] {
  const seen = new Set<string>();
  const out: TileId[] = [];
  for (const [lng, lat] of points) {
    const [cx, cy] = lngLatTo3857(lng, lat);
    const r = radiusM / Math.cos((lat * Math.PI) / 180);
    for (const t of tilesForBbox3857([cx - r, cy - r, cx + r, cy + r], z)) {
      const k = tileKey(t);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(t);
      }
    }
  }
  return out;
}

/** The full ordered, deduped, capped plan. `bbox` is the county's lng/lat
 * bbox (union of manifest + boundary); `assets` are lng/lat asset positions. */
export function countyPrefetchPlan(
  bbox: [number, number, number, number],
  assets: [number, number][],
): TileId[] {
  const seen = new Set<string>();
  const out: TileId[] = [];
  const push = (tiles: TileId[]): void => {
    for (const t of tiles) {
      const k = tileKey(t);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(t);
      }
    }
  };
  for (const z of COUNTY_ZOOMS) push(tilesForLngLatBbox(bbox, z));
  for (const z of ASSET_ZOOMS) push(tilesNearPoints(assets, ASSET_RADIUS_M, z));
  return out.slice(0, MAX_PLAN_TILES);
}

export interface PrefetchResult {
  fetched: number;
  cached: number;
  failed: number;
}

/**
 * Drain a plan through the cache, `concurrency` tiles at a time. Progress
 * fires per settled tile. A second call while one runs is safe — the cache
 * dedupes at the store level — but main.ts serializes calls anyway.
 */
export async function runPrefetch(
  tiles: TileId[],
  opts: { concurrency?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<PrefetchResult> {
  const result: PrefetchResult = { fetched: 0, cached: 0, failed: 0 };
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= tiles.length) return;
      const t = tiles[i]!;
      try {
        if (await hasTile(t)) {
          result.cached++;
        } else {
          await loadTile(t);
          result.fetched++;
        }
      } catch {
        result.failed++;
      }
      done++;
      opts.onProgress?.(done, tiles.length);
    }
  };
  const n = Math.max(1, Math.min(opts.concurrency ?? 3, tiles.length));
  await Promise.all(Array.from({ length: n }, worker));
  return result;
}
