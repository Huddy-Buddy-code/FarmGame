/**
 * County registry + loader (brief §12; hybrid model 2026-07-26).
 *
 * Resolution order for `loadCounty(id)`:
 *   1. BUNDLED — counties shipped as `public/counties/<id>/` folders (instant,
 *      offline, hand-tuned manifests). Membership in BUNDLED_COUNTIES decides
 *      this tier — no 404 probing, and a broken bundle throws (it's a bug,
 *      not a fallback case).
 *   2. CACHED — a county previously built at runtime, stored in IndexedDB
 *      (idbCache.ts). Only honored when its extract recipe is current.
 *   3. BUILT — synthesized live from the national index + Overpass API
 *      (builder.ts), then cached for next time. ~10–30 s once per county.
 */

import type { CountyId, CountyManifest, CountyPackage } from "./types";
import type { FeatureCollection } from "geojson";
import { loadCountyIndex, findCounty } from "./countyIndex";
import { buildCounty, type BuildProgress } from "./builder";
import { getCachedCounty } from "./idbCache";

/** Counties shipped with the app as pre-built packages (tier 1). */
export const BUNDLED_COUNTIES: { id: CountyId; name: string }[] = [
  { id: "story-ia", name: "Story County, Iowa" },
];

export function isBundled(id: CountyId): boolean {
  return BUNDLED_COUNTIES.some((c) => c.id === id);
}

function base(id: CountyId): string {
  return `${import.meta.env.BASE_URL}counties/${id}`;
}

/** Tier 1: fetch a bundled county package's files. */
async function loadBundledCounty(id: CountyId): Promise<CountyPackage> {
  const root = base(id);

  const manifestRes = await fetch(`${root}/manifest.json`);
  if (!manifestRes.ok) {
    throw new Error(`County "${id}": manifest ${manifestRes.status}`);
  }
  const manifest = (await manifestRes.json()) as CountyManifest;

  const roadsRes = await fetch(`${root}/${manifest.roads.file}`);
  if (!roadsRes.ok) {
    throw new Error(`County "${id}": roads ${roadsRes.status}`);
  }
  const roads = (await roadsRes.json()) as FeatureCollection;

  return { manifest, roads };
}

/** Resolve a county package by id: bundled → IndexedDB cache → live build. */
export async function loadCounty(id: CountyId, onProgress?: BuildProgress): Promise<CountyPackage> {
  if (isBundled(id)) return loadBundledCounty(id);

  const cached = await getCachedCounty(id);
  if (cached) return { manifest: cached.manifest, roads: cached.roads };

  const entry = findCounty(await loadCountyIndex(), id);
  if (!entry) throw new Error(`County "${id}" not found in the index`);
  return buildCounty(entry, onProgress);
}
