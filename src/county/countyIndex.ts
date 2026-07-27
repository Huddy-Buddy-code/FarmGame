/**
 * The national county index (2026-07-26) — every CONUS county the picker can
 * offer, built by `tools/build-county-index.mjs` from Census cartographic
 * boundary data and shipped as `public/counties/index.json` (~434 KB raw,
 * ~80 KB over the wire).
 *
 * Entries deliberately DON'T carry a UTM zone — it's derived from the center
 * longitude here, so the file can't disagree with the formula. Bundled county
 * packages (registry.ts) keep their hand-written manifests; the index is for
 * search/display and for synthesizing manifests of runtime-built counties.
 */

export interface CountyIndexEntry {
  /** Stable slug id, e.g. "story-ia" — matches bundled package ids. */
  id: string;
  /** 5-digit county FIPS. */
  fips: string;
  /** Display name incl. entity type: "Story County", "St. Louis city". */
  name: string;
  /** USPS state code, e.g. "IA". */
  state: string;
  /** [west, south, east, north] in lng/lat. */
  bbox: [number, number, number, number];
  /** bbox midpoint [lng, lat]. */
  center: [number, number];
}

interface CountyIndexFile {
  version: number;
  source: string;
  counties: CountyIndexEntry[];
}

/** Standard UTM zone for a longitude. CONUS spans zones 10–19; the clamp only
 * matters for garbage input. Northern hemisphere is implied for CONUS. */
export function utmZoneForLng(lng: number): number {
  return Math.max(1, Math.min(60, Math.floor((lng + 180) / 6) + 1));
}

let cached: CountyIndexEntry[] | null = null;

/** Fetch (once) and memoize the index. */
export async function loadCountyIndex(): Promise<CountyIndexEntry[]> {
  if (cached) return cached;
  const res = await fetch(`${import.meta.env.BASE_URL}counties/index.json`);
  if (!res.ok) throw new Error(`County index: ${res.status}`);
  const file = (await res.json()) as CountyIndexFile;
  cached = file.counties;
  return cached;
}

export function findCounty(list: CountyIndexEntry[], id: string): CountyIndexEntry | undefined {
  return list.find((c) => c.id === id);
}
