/**
 * Photographic structure sprites (2026-07-30) — the buildings' equivalent of
 * `machineImages.ts`. PNGs dropped into `src/assets/Structures/` are
 * auto-discovered by filename at build time and preferred over the hand-drawn
 * SVGs in `structureIcons.ts` wherever a match exists. Add art by dropping in a
 * correctly-named file; no code change needed.
 *
 * Filename convention (case-insensitive): `<Kind>[_<Size>].png`
 *   Kind  building kind — Silo, BaleBarn, BaleArea, TractorBarn,
 *         ImplementBarn, FarmYard, SellPoint.
 *   Size  Small | Medium | Large — SILO ONLY, the one kind with tiers. Omit it
 *         for every other kind (e.g. `BaleBarn.png`); a size-agnostic file is
 *         also accepted for silos and used across all three tiers.
 *
 * Unlike the machines these have NO heading and are never mirrored — a
 * building sits where it sits, so there's no `sideleft` tag and no scaleX.
 *
 * Art direction (matches structureIcons.ts so PNG and SVG are interchangeable):
 *   - FRONT/SIDE ELEVATION, viewed level — not top-down, not isometric.
 *   - The structure's base sits at the BOTTOM EDGE of the image. It's anchored
 *     to the ground at that point, so trailing whitespace under the building
 *     makes it float.
 *   - TRANSPARENT background, always. It composites over satellite imagery, so
 *     a baked-in backdrop shows as an opaque box sitting in the farmyard.
 *   - No brand logos or manufacturer trade dress.
 *   - The image's WIDTH represents the structure's real footprint width (see
 *     STRUCTURE_WIDTH_M in field/buildingRender.ts) — that's what makes a grain
 *     bin and a machine shed scale honestly against each other.
 *
 * Size on disk: 256x256 like the machine sprites, and for the same reason —
 * see the CLAUDE.md "Machine sprites" section; raw 1024px exports ballooned the
 * bundle 6x before they were resized.
 */

// Vite resolves each match to its final asset URL at build time (eager, so the
// registry is ready synchronously on first import — no async icon pop-in).
// The `%` exclusion mirrors machineImages.ts: a literal `%` in a filename
// yields an invalid escape in the asset URL and breaks Vite's dev middleware.
const files = import.meta.glob<string>(
  ["../assets/Structures/*.png", "!../assets/Structures/*%*.png"],
  { eager: true, query: "?url", import: "default" },
);

const KNOWN_SIZES = ["small", "medium", "large"] as const;

/** `${kind}|${size}` (or `${kind}|*` for a size-agnostic file) → asset URL. */
const registry = new Map<string, string>();

for (const [path, url] of Object.entries(files)) {
  const base = path.split("/").pop()!.replace(/\.png$/i, "");
  const parts = base.split("_");
  const rawKind = parts[0];
  if (!rawKind) continue;
  const kind = rawKind.toLowerCase();
  const sizeTok = (parts[1] ?? "").toLowerCase();
  const size = KNOWN_SIZES.includes(sizeTok as never) ? sizeTok : "*";
  registry.set(`${kind}|${size}`, url);
}

/**
 * The best sprite for a structure, or `undefined` when there's no art (the
 * caller then falls back to the SVG). Prefers an exact size match, then a
 * size-agnostic file, then any other size as a stand-in — same precedence
 * ladder as `machineImageUrl`, so a half-finished silo set still renders.
 */
export function structureImageUrl(kind: string, size?: string | null): string | undefined {
  const k = kind.toLowerCase();
  if (size) {
    const exact = registry.get(`${k}|${size.toLowerCase()}`);
    if (exact) return exact;
  }
  const agnostic = registry.get(`${k}|*`);
  if (agnostic) return agnostic;
  for (const s of KNOWN_SIZES) {
    const any = registry.get(`${k}|${s}`);
    if (any) return any;
  }
  return undefined;
}

/** Every registry key, for tests/diagnostics (`kind|size`). */
export function structureImageKeys(): string[] {
  return [...registry.keys()].sort();
}
