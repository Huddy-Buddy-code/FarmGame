/**
 * Farm structure art — hand-drawn SVG elevations of real farm buildings
 * (maintainer request, 2026-07-30: "instead of just tags, lets use real
 * placeable assets"). Structures used to render as an emoji in a cream box,
 * which read as a MAP PIN rather than a building standing on the ground.
 *
 * Same house style as `icons.ts`: front/side elevation, generic silhouettes,
 * no manufacturer trade dress, cozy-but-matte palette. Unlike the machines
 * these have no heading and are never mirrored — a building sits where it sits.
 *
 * Each drawing is authored on a 64-wide viewBox whose WIDTH equals the
 * structure's real footprint width (see `STRUCTURE_WIDTH_M` in
 * field/buildingRender.ts), so scaling the sprite to ground size is a single
 * multiply and the proportions between a grain bin and a machine shed stay
 * honest. Ground line sits at y=56; everything below is the shadow.
 *
 * These are the FALLBACK. A PNG dropped into `src/assets/Structures/` wins —
 * see `ui/structureImages.ts` for the naming convention.
 */

const ROOF = "#8c3b30";
const ROOF_D = "#6d2c23";
const WALL = "#c8b189";
const WALL_D = "#a8916b";
const WOOD = "#8a5a33";
const WOOD_D = "#6b4426";
const METAL = "#b9bcc0";
const METAL_D = "#8d9196";
const METAL_L = "#d8dade";
const DARK = "#3a332a";
const HAY = "#d8bd72";
const HAY_D = "#b39a56";
const GRAVEL = "#9a9184";
const STEEL_RAIL = "#6e6a5e";
const GLASS_BLUE = "#cfe4f0";

function svg(inner: string, w = 64, h = 64): string {
  return (
    `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" ` +
    `preserveAspectRatio="xMidYMax meet">${inner}</svg>`
  );
}

/** Soft contact shadow so a structure sits ON the imagery, not over it. */
function shadow(cx: number, rx: number, ry = 3.2): string {
  return `<ellipse cx="${cx}" cy="57" rx="${rx}" ry="${ry}" fill="#000" opacity="0.28"/>`;
}

/** Vertical corrugation ribs, the tell for a steel grain bin or shed wall. */
function ribs(x0: number, x1: number, yTop: number, yBot: number, step = 3): string {
  const out: string[] = [];
  for (let x = x0 + step; x < x1; x += step) {
    out.push(`<line x1="${x.toFixed(1)}" y1="${yTop}" x2="${x.toFixed(1)}" y2="${yBot}" stroke="${METAL_D}" stroke-width="0.5" opacity="0.55"/>`);
  }
  return out.join("");
}

/**
 * Grain bin: corrugated steel cylinder, conical roof with a peak cap, side
 * ladder, and the unload chute at the base. Bigger tiers get taller and wider.
 */
export function siloSvg(size: "small" | "medium" | "large" = "small"): string {
  const w = { small: 26, medium: 32, large: 38 }[size];
  const top = { small: 26, medium: 20, large: 14 }[size];
  const cx = 32;
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const eave = top + 9; // where the cone meets the wall
  return svg(`
    ${shadow(cx, w / 2 + 2)}
    <path d="M${x0} ${eave} L${cx} ${top} L${x1} ${eave} Z" fill="${METAL}" stroke="${METAL_D}" stroke-width="0.8" stroke-linejoin="round"/>
    <path d="M${cx} ${top} L${x1} ${eave} L${cx} ${eave} Z" fill="${METAL_D}" opacity="0.35"/>
    <rect x="${cx - 2}" y="${top - 2.6}" width="4" height="3" rx="1" fill="${METAL_L}" stroke="${METAL_D}" stroke-width="0.6"/>
    <rect x="${x0}" y="${eave}" width="${w}" height="${56 - eave}" fill="${METAL}" stroke="${METAL_D}" stroke-width="0.8"/>
    ${ribs(x0, x1, eave + 1, 55)}
    <rect x="${x1 - w * 0.3}" y="${eave}" width="${w * 0.3}" height="${56 - eave}" fill="${METAL_D}" opacity="0.22"/>
    <line x1="${x0}" y1="${eave + 2}" x2="${x1}" y2="${eave + 2}" stroke="${METAL_D}" stroke-width="0.7"/>
    <line x1="${x0}" y1="${(eave + 56) / 2}" x2="${x1}" y2="${(eave + 56) / 2}" stroke="${METAL_D}" stroke-width="0.7"/>
    <g stroke="${DARK}" stroke-width="0.8">
      <line x1="${cx - 4}" y1="${eave + 1}" x2="${cx - 4}" y2="55"/>
      <line x1="${cx - 1.4}" y1="${eave + 1}" x2="${cx - 1.4}" y2="55"/>
      ${Array.from({ length: Math.floor((55 - eave) / 3) }, (_, i) =>
        `<line x1="${cx - 4}" y1="${(eave + 3 + i * 3).toFixed(1)}" x2="${cx - 1.4}" y2="${(eave + 3 + i * 3).toFixed(1)}" stroke-width="0.6"/>`).join("")}
    </g>
    <path d="M${x1 - 3} 56 l4 0 l-1.5 -5 l-2.5 0 Z" fill="${METAL_D}"/>
    <rect x="${x0 - 1}" y="55" width="${w + 2}" height="2" rx="0.6" fill="${WALL_D}"/>
  `);
}

/** Gambrel-roof hay barn — the classic red barn, with a loft door and big
 * sliding doors on the gable end. Bale storage under cover. */
export function baleBarnSvg(): string {
  return svg(`
    ${shadow(32, 24)}
    <path d="M6 34 L14 24 L50 24 L58 34 Z" fill="${ROOF}" stroke="${ROOF_D}" stroke-width="0.9" stroke-linejoin="round"/>
    <path d="M14 24 L20 17 L44 17 L50 24 Z" fill="${ROOF}" stroke="${ROOF_D}" stroke-width="0.9" stroke-linejoin="round"/>
    <path d="M20 17 L44 17 L50 24 L14 24 Z" fill="#fff" opacity="0.08"/>
    <rect x="8" y="34" width="48" height="22" fill="${ROOF}" stroke="${ROOF_D}" stroke-width="0.9"/>
    <rect x="8" y="34" width="48" height="3" fill="${ROOF_D}" opacity="0.5"/>
    <rect x="29" y="19.5" width="6" height="5" rx="0.6" fill="${DARK}" stroke="${ROOF_D}" stroke-width="0.6"/>
    <rect x="20" y="39" width="24" height="17" fill="${WALL}" stroke="${WOOD_D}" stroke-width="0.9"/>
    <line x1="32" y1="39" x2="32" y2="56" stroke="${WOOD_D}" stroke-width="0.9"/>
    <path d="M20 39 L32 56 M32 39 L20 56 M32 39 L44 56 M44 39 L32 56" stroke="${WOOD}" stroke-width="0.8" fill="none"/>
    <rect x="11" y="42" width="6" height="6" rx="0.6" fill="${DARK}" opacity="0.75"/>
    <rect x="47" y="42" width="6" height="6" rx="0.6" fill="${DARK}" opacity="0.75"/>
    <rect x="6" y="55" width="52" height="2" rx="0.6" fill="${WALL_D}"/>
  `);
}

/** Open-air bale yard: stacked round bales on a gravel pad. No roof — that's
 * the whole point of it being the cheap, rot-prone option. */
export function baleAreaSvg(): string {
  const bale = (cx: number, cy: number, r: number): string =>
    `<ellipse cx="${cx}" cy="${cy}" rx="${r}" ry="${(r * 0.86).toFixed(1)}" fill="${HAY}" stroke="${HAY_D}" stroke-width="0.9"/>` +
    `<ellipse cx="${cx}" cy="${cy}" rx="${(r * 0.38).toFixed(1)}" ry="${(r * 0.33).toFixed(1)}" fill="${HAY_D}" opacity="0.6"/>`;
  return svg(`
    ${shadow(32, 26, 3.6)}
    <ellipse cx="32" cy="54" rx="27" ry="5" fill="${GRAVEL}" stroke="#857c70" stroke-width="0.7"/>
    ${bale(15, 48, 7)}${bale(29, 48, 7)}${bale(43, 48, 7)}
    ${bale(22, 36, 7)}${bale(36, 36, 7)}
    ${bale(29, 25, 7)}
  `);
}

/** Machine shed: wide steel span with open drive-through bays for tractors
 * and combines. Low pitch, no walls on the working side. */
export function tractorBarnSvg(): string {
  return svg(`
    ${shadow(32, 26)}
    <path d="M4 32 L32 22 L60 32 Z" fill="${METAL}" stroke="${METAL_D}" stroke-width="0.9" stroke-linejoin="round"/>
    <path d="M32 22 L60 32 L32 32 Z" fill="${METAL_D}" opacity="0.3"/>
    <rect x="6" y="32" width="52" height="24" fill="${METAL}" stroke="${METAL_D}" stroke-width="0.9"/>
    ${ribs(6, 58, 33, 55, 4)}
    <rect x="10" y="37" width="17" height="19" rx="0.8" fill="${DARK}" opacity="0.82"/>
    <rect x="31" y="37" width="17" height="19" rx="0.8" fill="${DARK}" opacity="0.82"/>
    <rect x="27" y="32" width="4" height="24" fill="${METAL_D}"/>
    <rect x="48" y="32" width="4" height="24" fill="${METAL_D}" opacity="0.6"/>
    <rect x="4" y="55" width="56" height="2" rx="0.6" fill="${WALL_D}"/>
  `);
}

/** Implement shed: the machine shed's smaller sibling — one bay, a lean-to
 * roof, and a rack of hanging tools on the back wall. */
export function implementBarnSvg(): string {
  return svg(`
    ${shadow(32, 19)}
    <path d="M11 34 L30 26 L53 34 Z" fill="${METAL}" stroke="${METAL_D}" stroke-width="0.9" stroke-linejoin="round"/>
    <rect x="13" y="34" width="38" height="22" fill="${METAL}" stroke="${METAL_D}" stroke-width="0.9"/>
    ${ribs(13, 51, 35, 55, 4)}
    <rect x="17" y="39" width="30" height="17" rx="0.8" fill="${DARK}" opacity="0.8"/>
    <g stroke="${WOOD}" stroke-width="1.4" stroke-linecap="round">
      <line x1="21" y1="42" x2="21" y2="53"/>
      <line x1="27" y1="42" x2="27" y2="51"/>
      <line x1="33" y1="42" x2="33" y2="53"/>
    </g>
    <rect x="18" y="41" width="26" height="1.4" fill="${STEEL_RAIL}"/>
    <rect x="11" y="55" width="42" height="2" rx="0.6" fill="${WALL_D}"/>
  `);
}

/** Farm yard: the rally point — a gravel pad with a signposted entrance.
 * No building, because it isn't one; it's a place. */
export function farmYardSvg(): string {
  return svg(`
    ${shadow(32, 24, 3.4)}
    <ellipse cx="32" cy="50" rx="26" ry="7" fill="${GRAVEL}" stroke="#857c70" stroke-width="0.8"/>
    <ellipse cx="32" cy="50" rx="18" ry="4.4" fill="#a89e90" opacity="0.6"/>
    <rect x="30.4" y="24" width="2.6" height="26" rx="0.6" fill="${WOOD_D}"/>
    <rect x="18" y="20" width="28" height="12" rx="1.6" fill="${WALL}" stroke="${WOOD_D}" stroke-width="1.1"/>
    <rect x="20.5" y="22.5" width="23" height="7" rx="0.8" fill="none" stroke="${WOOD}" stroke-width="0.8"/>
    <path d="M24 26.5 l3.4 -3 v6 Z M31 23.5 h8 M31 27 h6" stroke="${WOOD_D}" stroke-width="1" fill="${WOOD_D}" stroke-linecap="round"/>
  `);
}

/** Silage bunker: low concrete push-walls holding a packed pile, sheeted over
 * and weighted down with tyres — the universal look of a bunker silo. */
export function silageBunkerSvg(): string {
  const tyres: string[] = [];
  for (let i = 0; i < 7; i++) {
    const x = 13 + i * 6.2;
    const y = 31 + Math.abs(i - 3) * 1.5;
    tyres.push(`<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="2.4" ry="1.3" fill="${DARK}" opacity="0.75"/>`);
  }
  return svg(`
    ${shadow(32, 27)}
    <path d="M8 34 q6 -10 24 -10 q18 0 24 10 Z" fill="#5c6b4a" stroke="#44503a" stroke-width="0.9" stroke-linejoin="round"/>
    <path d="M8 34 q6 -10 24 -10 q18 0 24 10 Z" fill="#eef0ee" opacity="0.5"/>
    <path d="M32 24 q18 0 24 10 L32 34 Z" fill="${DARK}" opacity="0.1"/>
    ${tyres.join("")}
    <rect x="4" y="34" width="56" height="20" rx="1" fill="${WALL}" stroke="#8f8574" stroke-width="1"/>
    <g stroke="#8f8574" stroke-width="0.7">
      <line x1="17" y1="34" x2="17" y2="54"/>
      <line x1="32" y1="34" x2="32" y2="54"/>
      <line x1="47" y1="34" x2="47" y2="54"/>
    </g>
    <rect x="4" y="34" width="56" height="3" fill="#b3a891"/>
    <rect x="2" y="53" width="60" height="3" rx="0.8" fill="${GRAVEL}"/>
  `);
}

/** Sell point: a truck scale and a little scale house — where a hauler dumps
 * and gets paid on the spot. */
export function sellPointSvg(): string {
  return svg(`
    ${shadow(32, 25)}
    <rect x="7" y="44" width="50" height="10" rx="1" fill="${METAL}" stroke="${METAL_D}" stroke-width="0.9"/>
    <line x1="7" y1="49" x2="57" y2="49" stroke="${METAL_D}" stroke-width="0.7"/>
    <g stroke="${METAL_D}" stroke-width="0.6">
      <line x1="20" y1="44" x2="20" y2="54"/>
      <line x1="33" y1="44" x2="33" y2="54"/>
      <line x1="46" y1="44" x2="46" y2="54"/>
    </g>
    <rect x="38" y="26" width="19" height="18" rx="1.2" fill="${WALL}" stroke="${WOOD_D}" stroke-width="1"/>
    <path d="M36 26 L47.5 19 L59 26 Z" fill="${ROOF}" stroke="${ROOF_D}" stroke-width="0.9" stroke-linejoin="round"/>
    <rect x="42" y="30" width="11" height="8" rx="0.7" fill="${GLASS_BLUE}" stroke="${WOOD_D}" stroke-width="0.7"/>
    <g stroke="${WOOD_D}" stroke-width="1.1" stroke-linecap="round">
      <line x1="16" y1="44" x2="16" y2="30"/>
      <line x1="9" y1="30" x2="23" y2="30"/>
    </g>
    <rect x="10" y="24" width="12" height="6" rx="1" fill="${WALL}" stroke="${WOOD_D}" stroke-width="0.9"/>
    <text x="16" y="28.9" font-family="monospace" font-size="5" font-weight="bold" fill="${WOOD_D}" text-anchor="middle">$</text>
    <rect x="6" y="53" width="52" height="2" rx="0.6" fill="${WALL_D}"/>
  `);
}
