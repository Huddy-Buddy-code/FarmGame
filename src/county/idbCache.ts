/**
 * IndexedDB cache for runtime-built county packages (2026-07-26).
 *
 * A built county (manifest + roads) runs 1–10 MB — far past localStorage —
 * and rebuilding means a 10–30 s Overpass round-trip, so the first build of a
 * county is cached here and every later boot of that county is instant.
 *
 * STRICTLY best-effort: every failure path (no IndexedDB, private browsing,
 * blocked upgrade, quota) degrades to "cache miss" / "didn't cache", never an
 * error — the caller just rebuilds. Versioning is per-RECORD
 * (`recipeVersion` vs overpass.ts's EXTRACT_RECIPE_VERSION); the DB schema
 * itself never migrates.
 */

import type { FeatureCollection } from "geojson";
import type { CountyManifest } from "./types";
import { EXTRACT_RECIPE_VERSION } from "./overpass";

const DB_NAME = "farm-sim-counties";
const DB_VERSION = 1;
const STORE = "counties";

export interface CachedCounty {
  id: string;
  recipeVersion: number;
  fetchedAt: number;
  manifest: CountyManifest;
  roads: FeatureCollection;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("idb blocked"));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("idb aborted"));
  });
}

/** A cached county built with the CURRENT recipe, or null (miss/stale/error). */
export async function getCachedCounty(id: string): Promise<CachedCounty | null> {
  try {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(id);
      await txDone(tx);
      const rec = req.result as CachedCounty | undefined;
      return rec && rec.recipeVersion === EXTRACT_RECIPE_VERSION ? rec : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** Store a built county. Failures are swallowed — the cache is an optimization. */
export async function putCachedCounty(rec: CachedCounty): Promise<void> {
  try {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(rec);
      await txDone(tx);
    } finally {
      db.close();
    }
  } catch {
    /* best-effort */
  }
}

/** Drop one county's cache (future "rebuild road data" affordance). */
export async function deleteCachedCounty(id: string): Promise<void> {
  try {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      await txDone(tx);
    } finally {
      db.close();
    }
  } catch {
    /* best-effort */
  }
}
