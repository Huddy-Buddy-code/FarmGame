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
 * Every image MUST have a TRANSPARENT background — it's composited as a free
 * sprite over the satellite map, exactly like the SVGs. A baked-in backdrop
 * shows up as an opaque box around the machine in-field.
 */

// Vite resolves each match to its final asset URL at build time (eager, so the
// registry is ready synchronously on first import — no async icon pop-in).
const files = import.meta.glob<string>("../assets/Equipment/*.png", {
  eager: true,
  query: "?url",
  import: "default",
});

const KNOWN_SIZES = ["small", "medium", "large"] as const;

/** Filename `Kind` tokens that map onto a different internal kind. */
const KIND_ALIAS: Record<string, string> = { combine: "harvester" };

/** `${kind}|${size}` (or `${kind}|*` for a size-agnostic file) → asset URL. */
const registry = new Map<string, string>();

for (const [path, url] of Object.entries(files)) {
  const base = path.split("/").pop()!.replace(/\.png$/i, "");
  const [rawKind, rawSize] = base.split("_");
  if (!rawKind) continue;
  const kind = KIND_ALIAS[rawKind.toLowerCase()] ?? rawKind.toLowerCase();
  const size = KNOWN_SIZES.includes((rawSize ?? "").toLowerCase() as never)
    ? rawSize!.toLowerCase()
    : "*";
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

/** An `<img>` tag for a sprite URL, sized square to match the SVG icons it
 * replaces. Inherits the `.agent-glyph` rotate/mirror transform from its
 * parent, so it turns with heading just like the SVGs do. */
export function machineImgTag(url: string, px: number): string {
  return `<img class="machine-img" width="${px}" height="${px}" src="${url}" alt="" draggable="false">`;
}
