import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Repo-integrity gate for the vendored SDF glyphs — same role
 * `countyIndex.test.ts` plays for the county index: the committed binary IS the
 * artifact, so the suite is what catches a bad or missing regeneration.
 *
 * Without these files NOTHING with a `text-field` renders — the field labels
 * simply vanish, silently, with no console error. That's a failure mode worth
 * a test.
 */

const FONT_DIR = join(process.cwd(), "public", "fonts");
/** Every stack the style may name. Keep in sync with src/main.ts + fields.ts. */
const REQUIRED_STACKS = ["Noto Sans Bold"];

describe("vendored map glyphs", () => {
  it("ships every font stack the style names", () => {
    for (const stack of REQUIRED_STACKS) {
      expect(existsSync(join(FONT_DIR, stack)), `missing public/fonts/${stack}`).toBe(true);
    }
  });

  it("ships range 0-255 (ASCII + Latin-1 — every field name a US player types)", () => {
    for (const stack of REQUIRED_STACKS) {
      expect(existsSync(join(FONT_DIR, stack, "0-255.pbf"))).toBe(true);
    }
  });

  it("the PBFs are plausible glyph payloads, not an error page on disk", () => {
    for (const stack of REQUIRED_STACKS) {
      const buf = readFileSync(join(FONT_DIR, stack, "0-255.pbf"));
      // A Latin range runs tens of KB; an HTML/JSON error body would be tiny.
      expect(buf.byteLength).toBeGreaterThan(20_000);
      expect(buf.byteLength).toBeLessThan(2_000_000);
      // Protobuf, not text: field 1 (fontstacks), wire type 2 → first byte 0x0a.
      expect(buf[0]).toBe(0x0a);
      const head = buf.subarray(0, 200).toString("utf8");
      expect(head).not.toContain("<html");
      expect(head).not.toContain("<!DOCTYPE");
    }
  });

  it("the stack's own name is embedded, so a mislabeled download is caught", () => {
    for (const stack of REQUIRED_STACKS) {
      const buf = readFileSync(join(FONT_DIR, stack, "0-255.pbf"));
      expect(buf.subarray(0, 300).toString("utf8")).toContain(stack);
    }
  });

  it("carries the OFL notice required to redistribute Noto Sans", () => {
    const license = readFileSync(join(FONT_DIR, "LICENSE.txt"), "utf8");
    expect(license).toContain("SIL Open Font License");
    expect(license).toContain("Noto Sans");
  });

  it("ships no stray extra font stacks (every PNG-in-assets lesson, applied to fonts)", () => {
    const dirs = readdirSync(FONT_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    expect(dirs.sort()).toEqual([...REQUIRED_STACKS].sort());
  });
});
