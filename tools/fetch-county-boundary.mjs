/**
 * Fetch a county's boundary polygon from Census TIGERweb and write it as a
 * bundled-package `boundary.geojson` (2026-07-28).
 *
 * Usage:
 *   node tools/fetch-county-boundary.mjs <fips> <out-file>
 *   node tools/fetch-county-boundary.mjs 19169 public/counties/story-ia/boundary.geojson
 *
 * Same query recipe the runtime builder uses for non-bundled counties
 * (src/county/tigerweb.ts) — keep the two in sync so a bundled county and a
 * runtime-built one get the identical board edge. Output is a single GeoJSON
 * Feature (Polygon or MultiPolygon), ~20-50 KB at geometryPrecision=5 (~1 m).
 */

const fips = process.argv[2];
const out = process.argv[3];
if (!fips || !out) {
  console.error("Usage: node tools/fetch-county-boundary.mjs <fips> <out-file>");
  process.exit(1);
}

const base = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1/query";
const params = new URLSearchParams({
  where: `GEOID='${fips}'`,
  outFields: "GEOID,NAME",
  returnGeometry: "true",
  geometryPrecision: "5",
  outSR: "4326",
  f: "geojson",
});

const res = await fetch(`${base}?${params}`);
if (!res.ok) {
  console.error(`TIGERweb: HTTP ${res.status}`);
  process.exit(1);
}
const fc = await res.json();
const feature = fc?.features?.[0];
if (!feature?.geometry || !["Polygon", "MultiPolygon"].includes(feature.geometry.type)) {
  console.error(`TIGERweb: no polygon feature for GEOID ${fips}`);
  process.exit(1);
}

const { writeFileSync } = await import("node:fs");
writeFileSync(out, JSON.stringify(feature));
console.log(`Wrote ${out}: ${feature.geometry.type}, ${feature.properties?.NAME ?? "?"} (${fips})`);
