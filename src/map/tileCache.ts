/**
 * Persistent NAIP tile cache (2026-07-28).
 *
 * Every NAIP tile is a live `exportImage` render on USDA's server, and the
 * only reuse was the browser HTTP cache (weak headers) plus MapLibre's
 * in-memory tile cache (evicts as you pan) — so revisiting an area re-rendered
 * it server-side. Fix: the map's raster source now requests
 * `naip://tile/{z}/{x}/{y}` through a custom MapLibre protocol whose handler
 * is `naipProtocolHandler` below — cache-first against an IndexedDB tile
 * store, fetching from the ImageServer only on a miss and keeping the bytes
 * forever after. naipPrefetch.ts pushes tiles through the same path in the
 * background so panning hits warm cache.
 *
 * This module deliberately does NOT import maplibre-gl (main.ts does the
 * one-line `addProtocol` registration) so the whole cache is testable in the
 * node suite: `configureNaipCache` accepts an injectable fetch + store, and
 * `memoryTileStore()` stands in for IndexedDB.
 *
 * Storage is STRICTLY best-effort, same stance as county/idbCache.ts: no
 * IndexedDB / private browsing / quota pressure degrade to "always miss",
 * never an error. The browser may also evict the DB under storage pressure —
 * durable in practice, not guaranteed; a miss just refetches.
 */

/** Above this zoom the source overzooms cached z17 tiles instead of asking
 * the server for z18+ renders NAIP can't actually resolve (~0.6-1 m ground
 * resolution ≈ z17). Fewer requests, fewer cache entries, same picture. */
export const TILE_MAXZOOM = 17;

/** Half the web-mercator world span, meters (EPSG:3857). */
export const WORLD_3857 = 20037508.342789244;

export interface TileId {
  z: number;
  x: number;
  y: number;
}

export function tileKey(t: TileId): string {
  return `${t.z}/${t.x}/${t.y}`;
}

/** A tile's EPSG:3857 bbox [minX, minY, maxX, maxY] (XYZ scheme, y down). */
export function tileBbox3857(t: TileId): [number, number, number, number] {
  const size = (2 * WORLD_3857) / Math.pow(2, t.z);
  const minX = -WORLD_3857 + t.x * size;
  const maxY = WORLD_3857 - t.y * size;
  return [minX, maxY - size, minX + size, maxY];
}

/** The exportImage request for one tile — the same render MapLibre used to
 * request via its {bbox-epsg-3857} template, now addressed by z/x/y. */
export function naipExportUrl(imageServer: string, t: TileId): string {
  const [minX, minY, maxX, maxY] = tileBbox3857(t);
  const params = new URLSearchParams({
    bbox: `${minX},${minY},${maxX},${maxY}`,
    bboxSR: "3857",
    imageSR: "3857",
    size: "256,256",
    format: "jpgpng",
    transparent: "false",
    f: "image",
  });
  return `${imageServer}/exportImage?${params}`;
}

/** `naip://tile/{z}/{x}/{y}` → TileId, or null for anything else. */
export function parseNaipTileUrl(url: string): TileId | null {
  const m = /^naip:\/\/tile\/(\d+)\/(\d+)\/(\d+)$/.exec(url);
  if (!m) return null;
  return { z: Number(m[1]), x: Number(m[2]), y: Number(m[3]) };
}

// ---------------------------------------------------------------------------
// Tile stores

export interface TileStore {
  get(key: string): Promise<ArrayBuffer | null>;
  put(key: string, data: ArrayBuffer): Promise<void>;
}

/** In-memory store — the test double, also the no-IndexedDB fallback's shape. */
export function memoryTileStore(): TileStore {
  const m = new Map<string, ArrayBuffer>();
  return {
    get: async (k) => m.get(k) ?? null,
    put: async (k, d) => {
      m.set(k, d);
    },
  };
}

const DB_NAME = "farm-sim-naip";
const DB_VERSION = 1;
const STORE = "tiles";

/** IndexedDB-backed store. One connection, opened lazily and memoized —
 * tiles are high-frequency (unlike county packages), so open/close per op
 * would thrash. Every failure path degrades to miss / didn't-store. */
export function idbTileStore(): TileStore {
  let dbPromise: Promise<IDBDatabase | null> | null = null;
  const open = (): Promise<IDBDatabase | null> => {
    dbPromise ??= new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(STORE)) {
            req.result.createObjectStore(STORE);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return dbPromise;
  };
  return {
    async get(key) {
      const db = await open();
      if (!db) return null;
      return new Promise((resolve) => {
        try {
          const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
          req.onsuccess = () => resolve(req.result instanceof ArrayBuffer ? req.result : null);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
    },
    async put(key, data) {
      const db = await open();
      if (!db) return;
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).put(data, key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
          tx.onabort = () => resolve();
        } catch {
          resolve();
        }
      });
    },
  };
}

// ---------------------------------------------------------------------------
// The cache itself

interface NaipCacheConfig {
  imageServer: string;
  fetchFn: typeof fetch;
  store: TileStore;
}

let config: NaipCacheConfig | null = null;

/** Point the cache at a county's ImageServer. Call before the map is created;
 * `fetchFn`/`store` are injectable for tests (defaults: global fetch + IDB). */
export function configureNaipCache(opts: {
  imageServer: string;
  fetchFn?: typeof fetch;
  store?: TileStore;
}): void {
  // Wrap the fetch so it's never invoked as a METHOD of the config object:
  // `config.fetchFn(url)` would call native fetch with `this === config`,
  // which browsers reject ("Illegal invocation") — that shipped on 2026-07-28
  // and blacked out every tile until the maintainer's screenshot caught it.
  const rawFetch = opts.fetchFn ?? fetch;
  config = {
    imageServer: opts.imageServer,
    fetchFn: (input, init) => rawFetch(input, init),
    store: opts.store ?? idbTileStore(),
  };
}

/** Cache-first tile load. Throws on a network failure with no cached copy —
 * MapLibre treats that as a failed tile (blank, retried on next visit). */
export async function loadTile(t: TileId): Promise<ArrayBuffer> {
  if (!config) throw new Error("naip cache: configureNaipCache() not called");
  const key = tileKey(t);
  const hit = await config.store.get(key);
  if (hit) return hit;
  const res = await config.fetchFn(naipExportUrl(config.imageServer, t));
  if (!res.ok) throw new Error(`NAIP tile ${key}: HTTP ${res.status}`);
  const data = await res.arrayBuffer();
  await config.store.put(key, data);
  return data;
}

/** True if the tile is already stored (prefetch bookkeeping — avoids counting
 * warm tiles as downloads). */
export async function hasTile(t: TileId): Promise<boolean> {
  if (!config) return false;
  return (await config.store.get(tileKey(t))) !== null;
}

/** The MapLibre protocol handler for the "naip" scheme. Registered by main.ts
 * (`maplibregl.addProtocol("naip", naipProtocolHandler)`) — kept here so the
 * logic is testable without importing maplibre-gl. */
export async function naipProtocolHandler(params: { url: string }): Promise<{ data: ArrayBuffer }> {
  const t = parseNaipTileUrl(params.url);
  if (!t) throw new Error(`naip protocol: bad url "${params.url}"`);
  return { data: await loadTile(t) };
}
