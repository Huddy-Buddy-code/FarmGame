/**
 * Vendor MapLibre SDF glyph ranges into `public/fonts/` (2026-07-30).
 *
 * Usage:
 *   node tools/fetch-glyphs.mjs                       # the stacks the game uses
 *   node tools/fetch-glyphs.mjs "Noto Sans Italic"    # add another stack
 *
 * WHY VENDOR: a MapLibre style can only render text if it can fetch glyph PBFs,
 * and pointing `glyphs` at someone else's server would put a live third-party
 * call in the play path — the same thing `roads.geojson` exists to avoid (see
 * map/roadsLayer.ts). These are committed, so the game keeps its labels
 * offline and can't be broken by demotiles going down.
 *
 * RANGE 0-255 ONLY (~80 KB/stack). That covers ASCII + Latin-1, which is every
 * field name a US player will type. MapLibre requests other ranges lazily and
 * renders nothing when a range 404s, so the failure mode for an exotic
 * character is a blank glyph, not a broken map. Add ranges here if that ever
 * stops being true.
 *
 * Font: Noto Sans, SIL Open Font License 1.1 (see public/fonts/LICENSE.txt).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "public", "fonts");
const SOURCE = "https://demotiles.maplibre.org/font";
/** Stacks the game's style actually names. Keep in sync with src/main.ts. */
const DEFAULT_STACKS = ["Noto Sans Bold"];
const RANGES = ["0-255"];

const stacks = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_STACKS;

for (const stack of stacks) {
  for (const range of RANGES) {
    const url = `${SOURCE}/${encodeURIComponent(stack)}/${range}.pbf`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`FAIL ${stack} ${range}: HTTP ${res.status}`);
      process.exitCode = 1;
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    // Guard against a CDN error page landing on disk as a "font".
    if (buf.byteLength < 1000) {
      console.error(`FAIL ${stack} ${range}: implausibly small (${buf.byteLength} B)`);
      process.exitCode = 1;
      continue;
    }
    const dir = join(OUT_DIR, stack);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${range}.pbf`), buf);
    console.log(`Wrote public/fonts/${stack}/${range}.pbf (${(buf.byteLength / 1024).toFixed(1)} KB)`);
  }
}
