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

/** Above this zoom the source overzooms cached z18 tiles instead of asking
 * the server for z19+ renders. Was 17 (~1.19 m/px) until 2026-08-12 — that
 * number assumed NAIP's ceiling was ~0.6-1 m, but querying the ImageServer's
 * own catalog for a real source raster (Story County, IA) returned
 * `resolution_value: 0.3, resolution_units: METER` — modern NAIP is ~2-4x
 * finer than the old ceiling assumed. A Laplacian-variance check confirmed it
 * wasn't just interpolation: exporting the same ground footprint at z18-scale
 * pixel density (real server render) had ~30x more high-frequency detail than
 * upscaling the z17 tile to the same pixel count (921 vs 31), i.e. the server
 * was genuinely holding back resolvable detail our tiling never asked for.
 * Stopped at 18 (~0.6 m/px) rather than 19 (true 0.3 m match) because z19
 * quadruples near-asset tile counts again on top of z18's already-4x jump —
 * z18 is the resolution win without also re-tuning MAX_PLAN_TILES/ASSET_RADIUS_M. */
export const TILE_MAXZOOM = 18;

export interface NaipProviderDef {
  id: string;
  label: string;
  imageServer: string;
}

/** Alternate NAIP hosts — same public-domain imagery, different government
 * infrastructure, so a player can switch if one is down (2026-08-12: USDA
 * APFO refused every TLS handshake for an extended stretch, blacking out
 * every county's imagery with no code-side cause). "usda-apfo"'s imageServer
 * must match county/builder.ts's NAIP_IMAGE_SERVER — duplicated rather than
 * imported so this module's dependency graph stays light (see header). */
export const NAIP_PROVIDERS: readonly NaipProviderDef[] = [
  {
    id: "usda-apfo",
    label: "USDA APFO",
    imageServer: "https://gis.apfo.usda.gov/arcgis/rest/services/NAIP/USDA_CONUS_PRIME/ImageServer",
  },
  {
    id: "usgs-naip",
    label: "USGS National Map",
    imageServer: "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer",
  },
];
export const DEFAULT_NAIP_PROVIDER = NAIP_PROVIDERS[0]!.id;

export function naipProviderImageServer(id: string): string {
  return NAIP_PROVIDERS.find((p) => p.id === id)?.imageServer ?? NAIP_PROVIDERS[0]!.imageServer;
}

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

export interface NaipTileRef extends TileId {
  provider: string;
}

/** `naip://tile/{provider}/{z}/{x}/{y}` → NaipTileRef, or null for anything
 * else. The provider rides in the URL itself (not a mutable "active
 * provider" global) so an in-flight request always resolves against the
 * provider it was issued under, and so switching providers naturally busts
 * MapLibre's own per-URL tile cache via `source.setTiles()`. */
export function parseNaipTileUrl(url: string): NaipTileRef | null {
  const m = /^naip:\/\/tile\/([a-z0-9-]+)\/(\d+)\/(\d+)\/(\d+)$/.exec(url);
  if (!m) return null;
  return { provider: m[1]!, z: Number(m[2]), x: Number(m[3]), y: Number(m[4]) };
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
  fetchFn: typeof fetch;
  store: TileStore;
}

let config: NaipCacheConfig | null = null;

/** Wire up the cache's fetch + store. Call before the map is created;
 * `fetchFn`/`store` are injectable for tests (defaults: global fetch + IDB).
 * Which ImageServer a tile hits is resolved per-request from its provider
 * (see NaipTileRef) — not fixed here — so this no longer takes an imageServer. */
export function configureNaipCache(opts: { fetchFn?: typeof fetch; store?: TileStore } = {}): void {
  // Wrap the fetch so it's never invoked as a METHOD of the config object:
  // `config.fetchFn(url)` would call native fetch with `this === config`,
  // which browsers reject ("Illegal invocation") — that shipped on 2026-07-28
  // and blacked out every tile until the maintainer's screenshot caught it.
  const rawFetch = opts.fetchFn ?? fetch;
  config = {
    fetchFn: (input, init) => rawFetch(input, init),
    store: opts.store ?? idbTileStore(),
  };
}

/** Store key scoped by provider — the same z/x/y from two different hosts
 * are different bytes (different mosaic/year/compression), so they must
 * never collide in the cache. */
function cacheKey(t: NaipTileRef): string {
  return `${t.provider}/${tileKey(t)}`;
}

/** Cache-first tile load. Throws on a network failure with no cached copy —
 * MapLibre treats that as a failed tile (blank, retried on next visit). */
export async function loadTile(t: NaipTileRef): Promise<ArrayBuffer> {
  if (!config) throw new Error("naip cache: configureNaipCache() not called");
  const key = cacheKey(t);
  const hit = await config.store.get(key);
  if (hit) return hit;
  const res = await config.fetchFn(naipExportUrl(naipProviderImageServer(t.provider), t));
  if (!res.ok) throw new Error(`NAIP tile ${key}: HTTP ${res.status}`);
  const data = await res.arrayBuffer();
  await config.store.put(key, data);
  return data;
}

/** True if the tile is already stored (prefetch bookkeeping — avoids counting
 * warm tiles as downloads). */
export async function hasTile(t: NaipTileRef): Promise<boolean> {
  if (!config) return false;
  return (await config.store.get(cacheKey(t))) !== null;
}

/** The MapLibre protocol handler for the "naip" scheme. Registered by main.ts
 * (`maplibregl.addProtocol("naip", naipProtocolHandler)`) — kept here so the
 * logic is testable without importing maplibre-gl. */
export async function naipProtocolHandler(params: { url: string }): Promise<{ data: ArrayBuffer }> {
  const t = parseNaipTileUrl(params.url);
  if (!t) throw new Error(`naip protocol: bad url "${params.url}"`);
  return { data: await loadTile(t) };
}
