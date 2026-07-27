/**
 * Build `public/counties/index.json` — the national county picker index —
 * from a US Census cartographic boundary shapefile (2026-07-26).
 *
 * Usage:
 *   1. Download https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_us_county_500k.zip
 *      (any recent vintage works; update `SOURCE` below to match) and unzip it
 *      anywhere OUTSIDE the repo (the zip is ~11 MB and is not committed).
 *   2. node tools/build-county-index.mjs <dir-containing-the-.shp>
 *   3. Review the diff of public/counties/index.json and commit it.
 *
 * The index carries one entry per CONUS county: a stable slug id, FIPS, the
 * display name (NAMELSAD: "Story County", "St. Louis city"), USPS state, a
 * lng/lat bbox and its midpoint. No UTM zone — the runtime computes it from
 * the center longitude (src/county/countyIndex.ts), one less field to drift.
 *
 * Alaska/Hawaii/territories are excluded: the game's NAIP imagery source is
 * the USDA CONUS mosaic, which doesn't cover them.
 */

import { open } from "shapefile";
import { readdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = "cb_2024_us_county_500k";
/** STATEFP prefixes with no NAIP CONUS coverage: AK, HI, and the territories
 * (AS, GU, MP, PR, VI). DC (11) stays — it's in the mosaic, silly as a farm. */
const EXCLUDED_STATEFP = new Set(["02", "15", "60", "66", "69", "72", "78"]);
/** Sanity envelope: the script hard-fails outside this, catching a bad
 * download or an accidentally-different Census product. */
const MIN_COUNT = 3100;
const MAX_COUNT = 3120;

const dir = process.argv[2];
if (!dir) {
  console.error("Usage: node tools/build-county-index.mjs <dir-with-cb_*_us_county_*.shp>");
  process.exit(1);
}
const shpName = readdirSync(dir).find((f) => f.endsWith(".shp"));
if (!shpName) {
  console.error(`No .shp file found in ${dir}`);
  process.exit(1);
}
const base = join(dir, shpName.replace(/\.shp$/, ""));

/** Kebab slug: lowercase, runs of non-alphanumerics collapse to "-".
 * slug("Story") + "-ia" === "story-ia" — matching the bundled package id. */
function slug(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function round4(n) {
  return Math.round(n * 1e4) / 1e4;
}

/** bbox [w,s,e,n] over every ring of a Polygon or MultiPolygon. */
function bboxOf(geometry) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const polys = geometry.type === "MultiPolygon" ? geometry.coordinates : [geometry.coordinates];
  for (const poly of polys) {
    for (const ring of poly) {
      for (const [x, y] of ring) {
        if (x < w) w = x;
        if (x > e) e = x;
        if (y < s) s = y;
        if (y > n) n = y;
      }
    }
  }
  return [round4(w), round4(s), round4(e), round4(n)];
}

const records = [];
const source = await open(base + ".shp", base + ".dbf");
for (;;) {
  const { done, value } = await source.read();
  if (done) break;
  const p = value.properties;
  if (EXCLUDED_STATEFP.has(p.STATEFP)) continue;
  if (!value.geometry) continue;
  const bbox = bboxOf(value.geometry);
  records.push({
    // id assigned below, after collision detection over the full set
    nameToken: slug(p.NAME),
    lsadToken: slug(p.NAMELSAD),
    fips: p.GEOID,
    name: p.NAMELSAD,
    state: p.STUSPS,
    bbox,
    center: [round4((bbox[0] + bbox[2]) / 2), round4((bbox[1] + bbox[3]) / 2)],
  });
}

if (records.length < MIN_COUNT || records.length > MAX_COUNT) {
  console.error(`County count ${records.length} outside sanity range [${MIN_COUNT}, ${MAX_COUNT}] — wrong source file?`);
  process.exit(1);
}

// Stable ids: slug(NAME)-state, falling back to slug(NAMELSAD)-state where two
// entities in one state share a NAME (Virginia's independent cities vs their
// namesake counties, "St. Louis city" vs "St. Louis County"). The one whose
// NAMELSAD ends in "County" keeps the short id — it's the one people mean.
const byShortId = new Map();
for (const r of records) {
  const short = `${r.nameToken}-${r.state.toLowerCase()}`;
  if (!byShortId.has(short)) byShortId.set(short, []);
  byShortId.get(short).push(r);
}
for (const [short, group] of byShortId) {
  if (group.length === 1) {
    group[0].id = short;
    continue;
  }
  for (const r of group) {
    r.id = r.name.endsWith("County") ? short : `${r.lsadToken}-${r.state.toLowerCase()}`;
  }
}

// Final uniqueness assert — fail loudly rather than ship a colliding index.
const seen = new Set();
for (const r of records) {
  if (seen.has(r.id)) {
    console.error(`Duplicate id after collision handling: ${r.id}`);
    process.exit(1);
  }
  seen.add(r.id);
}

records.sort((a, b) => (a.state === b.state ? a.name.localeCompare(b.name) : a.state.localeCompare(b.state)));
const counties = records.map(({ id, fips, name, state, bbox, center }) => ({ id, fips, name, state, bbox, center }));

const out = { version: 1, source: SOURCE, counties };
const outPath = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "counties", "index.json");
writeFileSync(outPath, JSON.stringify(out));

// Spot-check table (zones the runtime will derive; formula mirrors countyIndex.ts).
const zone = (lng) => Math.min(60, Math.floor((lng + 180) / 6) + 1);
const spot = ["story-ia", "whitman-wa", "lancaster-pa"];
console.log(`Wrote ${counties.length} counties to ${outPath} (${(JSON.stringify(out).length / 1024).toFixed(0)} KB)`);
for (const id of spot) {
  const c = counties.find((x) => x.id === id);
  console.log(c ? `  ${id}: fips ${c.fips}, center ${c.center}, UTM zone ${zone(c.center[0])}` : `  ${id}: MISSING!`);
}
