/**
 * Runtime county builder (2026-07-26) — synthesizes a full CountyPackage for
 * any CONUS county straight from the national index entry: manifest fields
 * derived (UTM zone from center longitude, zoom from bbox size, the one
 * national NAIP mosaic every county shares), roads fetched live from the
 * Overpass API and converted to the bundled-extract shape (overpass.ts).
 *
 * Built packages are cached in IndexedDB (idbCache.ts) so the 10–30 s Overpass
 * round-trip happens once per county per browser.
 */

import type { CountyIndexEntry } from "./countyIndex";
import { utmZoneForLng } from "./countyIndex";
import type { CountyManifest, CountyPackage } from "./types";
import { buildOverpassQuery, overpassToRoads, EXTRACT_RECIPE_VERSION } from "./overpass";
import { fetchCountyBoundary, type FetchBoundaryOptions } from "./tigerweb";
import { putCachedCounty } from "./idbCache";

/** The single national CONUS mosaic — same server for every county. */
export const NAIP_IMAGE_SERVER = "https://gis.apfo.usda.gov/arcgis/rest/services/NAIP/USDA_CONUS_PRIME/ImageServer";
export const NAIP_ATTRIBUTION = "Imagery: USDA NAIP (public domain)";
export const OSM_ATTRIBUTION = "© OpenStreetMap contributors (ODbL)";

/** Public Overpass endpoints, tried in order. Both send CORS `*`. */
const OVERPASS_MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

export type BuildStage = "query" | "download" | "parse" | "cache-write";
export type BuildProgress = (stage: BuildStage, detail?: { bytes?: number; mirror?: string }) => void;

/** Both mirrors failed — `attempts` says how, `message` is player-readable. */
export class CountyBuildError extends Error {
  readonly attempts: { mirror: string; reason: string }[];
  constructor(message: string, attempts: { mirror: string; reason: string }[]) {
    super(message);
    this.name = "CountyBuildError";
    this.attempts = attempts;
  }
}

/**
 * Initial zoom that roughly fits a county's bbox in view. Bundled manifests
 * keep their hand-picked zooms — this only governs runtime-built counties.
 * Clamped to [9, 12]: 9 for sprawling western counties, 12 for tiny eastern
 * ones (the zoom Story County ships at).
 */
export function zoomForBbox(bbox: [number, number, number, number]): number {
  const [w, s, e, n] = bbox;
  // Latitude degrees are "taller" than mid-latitude longitude degrees are
  // wide (~1/cos(40°) ≈ 1.4) — weight them so tall counties fit too.
  const span = Math.max(e - w, (n - s) * 1.4);
  const z = Math.floor(Math.log2(360 / span)) + 2;
  return Math.max(9, Math.min(12, z));
}

/** Derive a full manifest from an index entry — no network needed. */
export function buildCountyManifest(entry: CountyIndexEntry): CountyManifest {
  return {
    id: entry.id,
    name: entry.name,
    state: entry.state,
    fips: entry.fips,
    utm: { zone: utmZoneForLng(entry.center[0]), hemisphere: "N" },
    bbox: entry.bbox,
    center: entry.center,
    defaultZoom: zoomForBbox(entry.bbox),
    imagery: { kind: "naip-arcgis", imageServer: NAIP_IMAGE_SERVER, attribution: NAIP_ATTRIBUTION },
    // Runtime counties have no package folder — roads came from Overpass.
    roads: { file: "(runtime)", attribution: OSM_ATTRIBUTION },
  };
}

export interface FetchOverpassOptions {
  onProgress?: BuildProgress;
  timeoutMs?: number;
  /** Pause between mirror attempts (politeness); tests pass 0. */
  pauseMs?: number;
  /** Injectable for tests — no real network in the suite. */
  fetchFn?: typeof fetch;
  mirrors?: string[];
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/**
 * POST the query to each mirror in turn until one answers; throw
 * CountyBuildError when the whole list fails. Downloads via the body reader
 * so `onProgress` can show a live byte count (county road JSON is 1–30 MB).
 */
export async function fetchOverpass(query: string, opts: FetchOverpassOptions = {}): Promise<unknown> {
  const mirrors = opts.mirrors ?? OVERPASS_MIRRORS;
  const fetchFn = opts.fetchFn ?? fetch;
  const attempts: { mirror: string; reason: string }[] = [];
  for (const mirror of mirrors) {
    if (attempts.length > 0) {
      await new Promise((r) => setTimeout(r, opts.pauseMs ?? 2000));
    }
    try {
      opts.onProgress?.("query", { mirror });
      const res = await fetchFn(mirror, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000),
      });
      if (!res.ok) {
        attempts.push({ mirror, reason: `HTTP ${res.status}` });
        continue;
      }
      if (res.body) {
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          bytes += value.byteLength;
          opts.onProgress?.("download", { bytes, mirror });
        }
        opts.onProgress?.("parse", { mirror });
        return JSON.parse(new TextDecoder().decode(concatChunks(chunks, bytes)));
      }
      // Bodyless response (some test doubles): fall back to .json().
      return await res.json();
    } catch (err) {
      const e = err as Error;
      attempts.push({ mirror, reason: e?.name === "TimeoutError" ? "timed out" : String(e?.message ?? err) });
    }
  }
  throw new CountyBuildError(
    "Couldn't download road data — all road-data servers failed. Check your connection and try again.",
    attempts,
  );
}

/** Build a county package end-to-end: manifest + live roads + boundary + cache write. */
export async function buildCounty(
  entry: CountyIndexEntry,
  onProgress?: BuildProgress,
  boundaryOpts?: FetchBoundaryOptions,
): Promise<CountyPackage> {
  const manifest = buildCountyManifest(entry);
  // Boundary (TIGERweb) and roads (Overpass) are independent servers — fetch
  // in parallel; roads dominate the wait. Boundary failure is non-fatal (null,
  // see tigerweb.ts) — registry.ts retries the backfill on later cache hits.
  const boundaryPromise = fetchCountyBoundary(entry.fips, boundaryOpts);
  let json: unknown;
  try {
    json = await fetchOverpass(buildOverpassQuery(entry.bbox), { onProgress });
  } catch (err) {
    if (err instanceof CountyBuildError) {
      // Re-throw with the county named, for the home screen's error banner.
      throw new CountyBuildError(
        `Couldn't download road data for ${entry.name}, ${entry.state} — ` +
          "both road-data servers failed. Check your connection and try again.",
        err.attempts,
      );
    }
    throw err;
  }
  const roads = overpassToRoads(json);
  const boundary = await boundaryPromise;
  onProgress?.("cache-write");
  await putCachedCounty({
    id: entry.id,
    recipeVersion: EXTRACT_RECIPE_VERSION,
    fetchedAt: Date.now(),
    manifest,
    roads,
    boundary,
  });
  return { manifest, roads, boundary };
}
