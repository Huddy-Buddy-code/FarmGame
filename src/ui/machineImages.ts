/**
 * Photographic machine sprites (2026-07-20 workflow): AI-generated PNGs dropped
 * into `src/assets/Equipment/` are auto-discovered by filename at build time and
 * preferred over the hand-drawn SVGs in `icons.ts` wherever a match exists. Add
 * a machine to the game's art by dropping in a correctly-named file — no code
 * change needed.
 *
 * Filename convention (case-insensitive): `<Kind>_<Size>_sideleft.png`
 *   Kind     machine/implement kind — Tractor, Combine, Plow, Planter, …
 *            ("Combine" is accepted as an alias for the `harvester` agent kind).
 *   Size     Small | Medium | Large. Omit (e.g. `Plow_sideleft.png`) for a
 *            single size-agnostic image used across every size column.
 *   sideleft trailing tag; the art faces WEST (left), matching icons.ts, so
 *            main.ts's heading code can mirror it east with scaleX. Never
 *            pre-mirror the art.
 *
 * Fill-state variant (2026-07-21, Bale Trailer): `<Kind>_<0|25|50|100>.png` —
 * a SEPARATE set from the size sprites above, showing how full a cargo-hauling
 * implement is. Bucketed to the nearest of the four; 100 is reserved for
 * "mostly full" (see `trailerFillImageUrl`), not literally 100%. No `sideleft`
 * suffix on these — the number is the whole second token.
 *
 * Composite variant (2026-07-21, Small Tractor + Hay Spikes): `<Kind>_<Size>_
 * <Variant>.png` — a THIRD token for machines drawn together with a "minor"
 * mounted implement (see `MINOR_IMPLEMENT_KINDS` in main.ts — one that
 * doesn't get its own trailing badge). Recognized variants: `HaySpike` (empty
 * loader) and `HaySpikeBale` (carrying a bale). See `machineVariantImageUrl`.
 *
 * Every image MUST have a TRANSPARENT background — it's composited as a free
 * sprite over the satellite map, exactly like the SVGs. A baked-in backdrop
 * shows up as an opaque box around the machine in-field.
 */

// Vite resolves each match to its final asset URL at build time (eager, so the
// registry is ready synchronously on first import — no async icon pop-in).
// NOTE the `!…*%*.png` exclusion: a filename containing a literal `%` (e.g. a
// draft export like "Bale Trailer_50%.png") produces an asset URL with a raw
// `%`, which is an invalid escape — Vite's dev middleware then throws
// "URI malformed" from `decodeURI` the moment the browser requests it. Such
// files aren't valid `<Kind>_<Size>_sideleft.png` sprites anyway, so skip them.
const files = import.meta.glob<string>(
  ["../assets/Equipment/*.png", "!../assets/Equipment/*%*.png"],
  { eager: true, query: "?url", import: "default" },
);

const KNOWN_SIZES = ["small", "medium", "large"] as const;

/** Filename `Kind` tokens that map onto a different internal kind. */
const KIND_ALIAS: Record<string, string> = {
  combine: "harvester",
  // The game's internal ImplementKind keeps the "bailer" typo throughout
  // tasks.ts/main.ts, but the correctly-spelled "Baler" reads better as a
  // filename — alias it rather than propagate the typo into asset names.
  baler: "bailer",
};

const FILL_LEVELS = ["0", "25", "50", "100"] as const;
const VARIANT_TOKENS = ["hayspike", "hayspikebale"] as const;

/** `${kind}|${size}` (or `${kind}|*` for a size-agnostic file) → asset URL. */
const registry = new Map<string, string>();
/** `${kind}|${fillLevel}` → asset URL — the separate fill-state set. */
const fillRegistry = new Map<string, string>();
/** `${kind}|${size}|${variant}` → asset URL — composite machine+implement art. */
const variantRegistry = new Map<string, string>();

for (const [path, url] of Object.entries(files)) {
  const base = path.split("/").pop()!.replace(/\.png$/i, "");
  const parts = base.split("_");
  const rawKind = parts[0];
  if (!rawKind) continue;
  const kind = KIND_ALIAS[rawKind.toLowerCase()] ?? rawKind.toLowerCase();

  // Three-token filenames (Kind_Size_Variant) are checked first so a
  // recognized variant token doesn't fall through and get misread as an
  // unrecognized size/fill token below.
  const sizeTok = (parts[1] ?? "").toLowerCase();
  const variantTok = (parts[2] ?? "").toLowerCase();
  if (KNOWN_SIZES.includes(sizeTok as never) && (VARIANT_TOKENS as readonly string[]).includes(variantTok)) {
    variantRegistry.set(`${kind}|${sizeTok}|${variantTok}`, url);
    continue;
  }

  if ((FILL_LEVELS as readonly string[]).includes(sizeTok)) {
    fillRegistry.set(`${kind}|${sizeTok}`, url);
    continue;
  }
  const size = KNOWN_SIZES.includes(sizeTok as never) ? sizeTok : "*";
  registry.set(`${kind}|${size}`, url);
}

/**
 * The best photographic sprite for a machine, or `undefined` if none exists
 * (caller then falls back to the SVG icon). Prefers an exact size match, then a
 * size-agnostic file, then any other size as a stand-in.
 */
export function machineImageUrl(kind: string, size?: string | null): string | undefined {
  const k = kind.toLowerCase();
  if (size) {
    const exact = registry.get(`${k}|${size.toLowerCase()}`);
    if (exact) return exact;
  }
  return (
    registry.get(`${k}|*`) ??
    registry.get(`${k}|medium`) ??
    registry.get(`${k}|small`) ??
    registry.get(`${k}|large`)
  );
}

/**
 * The fill-state sprite for a cargo-hauling implement (e.g. Bale Trailer) at
 * a given fraction full (0-100), or `undefined` if no fill art exists for
 * this kind — caller then falls back to `machineImageUrl`/the SVG. Buckets
 * to the nearest of 0/25/50/100; the top bucket is deliberately "mostly
 * full" (≥90%) rather than exactly 100%, since cargo rarely lands on a round
 * number and a near-full load should already read as full.
 */
export function trailerFillImageUrl(kind: string, fillPct: number): string | undefined {
  const k = kind.toLowerCase();
  const bucket = fillPct >= 90 ? "100" : fillPct >= 37.5 ? "50" : fillPct >= 12.5 ? "25" : "0";
  return fillRegistry.get(`${k}|${bucket}`);
}

/**
 * A composite machine+implement sprite (e.g. a Small Tractor drawn with its
 * mounted Hay Spikes), or `undefined` if none exists for this exact
 * kind+size+variant — caller then falls back to the plain `machineImageUrl`.
 */
export function machineVariantImageUrl(
  kind: string,
  size: string | null | undefined,
  variant: "hayspike" | "hayspikebale",
): string | undefined {
  if (!size) return undefined;
  return variantRegistry.get(`${kind.toLowerCase()}|${size.toLowerCase()}|${variant}`);
}

/** An `<img>` tag for a sprite URL, sized square to match the SVG icons it
 * replaces. Inherits the `.agent-glyph` rotate/mirror transform from its
 * parent, so it turns with heading just like the SVGs do. */
export function machineImgTag(url: string, px: number): string {
  return `<img class="machine-img" width="${px}" height="${px}" src="${url}" alt="" draggable="false">`;
}
