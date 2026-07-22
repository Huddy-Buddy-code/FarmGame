/**
 * Machinery icons — hand-drawn SVG side profiles of real farm equipment
 * (maintainer request, 2026-07-12: "look like the actual machinery, not
 * cartoon icons"). Generic silhouettes and colors, no manufacturer trade
 * dress. Every machine faces WEST (left) — main.ts's heading code mirrors
 * them east with scaleX, so the drawings must never be pre-mirrored.
 *
 * Shared palette (kept close to the game's cozy tones, but with the matte
 * greens/steels real equipment actually wears):
 *   body green  #3f7233 / #325c28 (shade)   chassis/steel  #6e6a5e / #4c483e
 *   grain-cart red #a8382e                   tire #2e2c28, rim #d8b04c
 *   glass #cfe4f0                            highlight #86a86b
 */

const TIRE = "#2e2c28";
const RIM = "#d8b04c";
const HUB = "#7a6a3a";
const BODY = "#3f7233";
const BODY_D = "#325c28";
const STEEL = "#6e6a5e";
const STEEL_D = "#4c483e";
const GLASS = "#cfe4f0";
const RED = "#a8382e";
const RED_D = "#7e2a22";

function svg(size: number, inner: string, vb = 32): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${vb} ${vb}" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
}

/** A treaded drive wheel: tire, lug notches, rim, hub. */
function wheel(cx: number, cy: number, r: number): string {
  const lugs: string[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const x1 = cx + Math.cos(a) * r * 0.72, y1 = cy + Math.sin(a) * r * 0.72;
    const x2 = cx + Math.cos(a) * r * 0.97, y2 = cy + Math.sin(a) * r * 0.97;
    lugs.push(`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#1c1b18" stroke-width="${(r * 0.22).toFixed(1)}"/>`);
  }
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${TIRE}"/>` +
    lugs.join("") +
    `<circle cx="${cx}" cy="${cy}" r="${(r * 0.55).toFixed(1)}" fill="${RIM}" stroke="#9a7c30" stroke-width="0.6"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${(r * 0.18).toFixed(1)}" fill="${HUB}"/>`;
}

/** Row-crop tractor: big lugged rear wheel, small front wheel, glass cab,
 * sloped hood with exhaust stack, rear 3-point hitch nub. */
export function tractorIconSvg(size = 22): string {
  return svg(size, `
    ${wheel(22.5, 22.5, 7)}
    ${wheel(7.5, 24.5, 4.4)}
    <path d="M3.5 21.5 L3 17.5 q0-1.4 1.4-1.6 L13 14.8 V21 h-2.2 a4.6 4.6 0 0 0-8 0Z" fill="${BODY}" stroke="${BODY_D}" stroke-width="0.7"/>
    <rect x="3.6" y="16.6" width="8.6" height="1.1" fill="${BODY_D}" opacity="0.55"/>
    <rect x="1.8" y="18.2" width="2.2" height="3" rx="0.5" fill="${STEEL_D}"/>
    <rect x="5.2" y="10.2" width="1.2" height="6" fill="${STEEL_D}"/>
    <rect x="4.9" y="9.4" width="1.8" height="1.2" rx="0.4" fill="${STEEL}"/>
    <path d="M13 21 V9.6 q0-1.6 1.6-1.6 h5.2 q1.7 0 2.4 1.5 l2.3 5 v6.6 l-1.8 0.4 a7.2 7.2 0 0 0-9.5 0Z" fill="${BODY}" stroke="${BODY_D}" stroke-width="0.8"/>
    <path d="M14.4 9.4 h5.2 q0.9 0 1.3 0.9 l2 4.4 -8.5 0.1Z" fill="${GLASS}" stroke="${BODY_D}" stroke-width="0.5"/>
    <rect x="13.6" y="15.6" width="10" height="1" fill="${BODY_D}" opacity="0.5"/>
    <rect x="27.5" y="18.5" width="2.6" height="1.6" rx="0.4" fill="${STEEL_D}"/>
    <rect x="26.3" y="16.8" width="1.4" height="5" rx="0.5" fill="${STEEL}"/>
  `);
}

/** Combine: wide grain header with reel out front (west), feederhouse up to
 * the glass cab, boxy grain tank behind, unload auger, big front wheel. */
export function combineIconSvg(size = 22): string {
  const reel: string[] = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.4;
    reel.push(`<line x1="4.6" y1="19.4" x2="${(4.6 + Math.cos(a) * 2.6).toFixed(1)}" y2="${(19.4 + Math.sin(a) * 2.6).toFixed(1)}" stroke="${STEEL_D}" stroke-width="0.55"/>`);
  }
  return svg(size, `
    <path d="M1 20.6 h8.6 l-0.6 3 H1.6Z" fill="${RIM}" stroke="#9a7c30" stroke-width="0.6"/>
    <line x1="2.6" y1="20.7" x2="2.3" y2="23.4" stroke="#9a7c30" stroke-width="0.5"/>
    <line x1="4.6" y1="20.7" x2="4.4" y2="23.4" stroke="#9a7c30" stroke-width="0.5"/>
    <line x1="6.6" y1="20.7" x2="6.5" y2="23.4" stroke="#9a7c30" stroke-width="0.5"/>
    <circle cx="4.6" cy="19.4" r="2.6" fill="none" stroke="${STEEL_D}" stroke-width="0.6"/>
    ${reel.join("")}
    <path d="M9.6 21.6 l3.4-3.4 h1.4 v3.8 h-4.6Z" fill="${STEEL}" stroke="${STEEL_D}" stroke-width="0.6"/>
    <path d="M14.2 10.4 h9.6 q1.8 0 1.8 1.8 v9.6 H14.2Z" fill="${BODY}" stroke="${BODY_D}" stroke-width="0.8"/>
    <path d="M14.2 13.6 h11.4 v1 H14.2Z" fill="${BODY_D}" opacity="0.5"/>
    <path d="M13 8.4 h4.6 v5.6 H13Z" fill="${BODY}" stroke="${BODY_D}" stroke-width="0.7"/>
    <path d="M13.7 9.1 h3.2 v3.4 h-3.2Z" fill="${GLASS}" stroke="${BODY_D}" stroke-width="0.4"/>
    <path d="M18.6 8.8 h5.8 l1.4 1.6 h-7.2Z" fill="${BODY_D}"/>
    <rect x="24.6" y="6.2" width="1.1" height="5" rx="0.4" transform="rotate(38 25.1 8.7)" fill="${STEEL}"/>
    ${wheel(16.5, 24.5, 5.4)}
    ${wheel(25.8, 25.8, 3.2)}
  `);
}

/** Moldboard plow: angled steel frame with a rank of curved bottoms. */
export function plowIconSvg(size = 22): string {
  const bottoms: string[] = [];
  for (let i = 0; i < 4; i++) {
    const x = 7 + i * 5.4, y = 15 + i * 2.1;
    bottoms.push(`
      <line x1="${x}" y1="${y}" x2="${x + 1.6}" y2="${y + 5}" stroke="${STEEL_D}" stroke-width="1.1"/>
      <path d="M${x + 0.4} ${y + 3.4} q3 -0.6 3.4 2.4 l-3.8 0.6 Z" fill="#8d99a6" stroke="${STEEL_D}" stroke-width="0.5"/>`);
  }
  return svg(size, `
    <rect x="2" y="12.6" width="4.6" height="1.6" rx="0.6" fill="${STEEL_D}"/>
    <line x1="5.5" y1="13.6" x2="26.5" y2="21.6" stroke="${RED}" stroke-width="2.4"/>
    <line x1="5.5" y1="13.6" x2="26.5" y2="21.6" stroke="${RED_D}" stroke-width="0.7" opacity="0.6"/>
    ${bottoms.join("")}
    ${wheel(25.5, 25, 2.6)}
  `);
}

/** Row planter: toolbar with seed hoppers over closing-wheel row units. */
export function planterIconSvg(size = 22): string {
  const units: string[] = [];
  for (let i = 0; i < 4; i++) {
    const x = 6.5 + i * 6;
    units.push(`
      <path d="M${x - 2} 12.5 h4 l-0.7 4.4 h-2.6 Z" fill="${RED}" stroke="${RED_D}" stroke-width="0.6"/>
      <rect x="${x - 2.2}" y="11.4" width="4.4" height="1.4" rx="0.4" fill="${RED_D}"/>
      <line x1="${x}" y1="16.9" x2="${x}" y2="20.4" stroke="${STEEL_D}" stroke-width="1"/>
      <circle cx="${x}" cy="21.8" r="1.9" fill="${TIRE}"/>
      <circle cx="${x}" cy="21.8" r="0.8" fill="${STEEL}"/>`);
  }
  return svg(size, `
    <rect x="1.5" y="17.6" width="3.6" height="1.4" rx="0.5" fill="${STEEL_D}"/>
    <rect x="3.5" y="17.8" width="26" height="1.6" rx="0.7" fill="${STEEL}" stroke="${STEEL_D}" stroke-width="0.5"/>
    ${units.join("")}
  `);
}

/** Trailed sprayer: tank on wheels with a long folded boom + drop nozzles. */
export function sprayerIconSvg(size = 22): string {
  const nozzles: string[] = [];
  for (let i = 0; i < 7; i++) {
    const x = 4.5 + i * 3.6;
    nozzles.push(`<line x1="${x}" y1="13.6" x2="${x}" y2="15.4" stroke="${STEEL_D}" stroke-width="0.7"/>`);
  }
  return svg(size, `
    <rect x="2.5" y="12.6" width="27" height="1.3" rx="0.6" fill="${STEEL}" stroke="${STEEL_D}" stroke-width="0.4"/>
    ${nozzles.join("")}
    <rect x="1.5" y="18" width="4" height="1.4" rx="0.5" fill="${STEEL_D}"/>
    <ellipse cx="16" cy="17.4" rx="6.2" ry="4.4" fill="#d8d2c2" stroke="${STEEL_D}" stroke-width="0.8"/>
    <ellipse cx="16" cy="17.4" rx="6.2" ry="4.4" fill="none" stroke="#ffffff" stroke-width="0.7" opacity="0.4" stroke-dasharray="2 7"/>
    <rect x="13" y="12.2" width="6" height="1.6" rx="0.6" fill="${STEEL}"/>
    ${wheel(12.5, 24, 3.4)}
    ${wheel(20.5, 24, 3.4)}
  `);
}

/** Rotary rake: angled beam carrying spoked tine-wheels. */
export function rakeIconSvg(size = 22): string {
  const wheels: string[] = [];
  for (let i = 0; i < 4; i++) {
    const cx = 8 + i * 5.6, cy = 17.5 + i * 1.3, r = 4.1;
    const spokes: string[] = [];
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + i;
      spokes.push(`<line x1="${cx}" y1="${cy}" x2="${(cx + Math.cos(a) * r).toFixed(1)}" y2="${(cy + Math.sin(a) * r).toFixed(1)}" stroke="${RED}" stroke-width="0.7"/>`);
    }
    wheels.push(spokes.join("") + `<circle cx="${cx}" cy="${cy}" r="1.2" fill="${RED_D}"/>`);
  }
  return svg(size, `
    <rect x="1.5" y="11.8" width="3.8" height="1.4" rx="0.5" fill="${STEEL_D}"/>
    <line x1="4.5" y1="12.5" x2="27" y2="17.5" stroke="${STEEL}" stroke-width="1.6"/>
    ${wheels.join("")}
  `);
}

/** Round baler: pickup out front, big drum chamber, a bale peeking out back. */
export function balerIconSvg(size = 22): string {
  return svg(size, `
    <rect x="1.5" y="17.6" width="4" height="1.4" rx="0.5" fill="${STEEL_D}"/>
    <path d="M5 17 l3.6 3.2 h2.2 l-1-3.8Z" fill="${STEEL}" stroke="${STEEL_D}" stroke-width="0.5"/>
    <line x1="6" y1="20.6" x2="9" y2="20.6" stroke="${STEEL_D}" stroke-width="0.8" stroke-dasharray="0.8 0.8"/>
    <rect x="10" y="9.5" width="14.5" height="13" rx="4.6" fill="${RED}" stroke="${RED_D}" stroke-width="0.9"/>
    <circle cx="17.2" cy="16" r="4.6" fill="none" stroke="${RED_D}" stroke-width="0.7" opacity="0.7"/>
    <circle cx="17.2" cy="16" r="2.3" fill="none" stroke="${RED_D}" stroke-width="0.6" opacity="0.5"/>
    <circle cx="26.6" cy="20.2" r="2.6" fill="#d9c187" stroke="#9c8348" stroke-width="0.7"/>
    <circle cx="26.6" cy="20.2" r="1.1" fill="none" stroke="#b39a5c" stroke-width="0.5"/>
    ${wheel(15.5, 24.6, 3.2)}
  `);
}

/** Grain trailer/cart: sloped red hopper on tandem wheels, unload auger. */
export function grainTrailerIconSvg(size = 22): string {
  return svg(size, `
    <rect x="1.5" y="18.6" width="4" height="1.4" rx="0.5" fill="${STEEL_D}"/>
    <path d="M5.5 11.5 h21 v6.5 l-4 4.5 h-13 l-4-4.5Z" fill="${RED}" stroke="${RED_D}" stroke-width="0.9"/>
    <path d="M5.5 13.2 h21 v1 h-21Z" fill="${RED_D}" opacity="0.5"/>
    <path d="M6.5 11.5 h19 l-1.6-2 h-15.8Z" fill="#c9a24b" stroke="#9a7c30" stroke-width="0.5"/>
    <rect x="24.4" y="7.2" width="1.2" height="7" rx="0.5" transform="rotate(30 25 10.7)" fill="${STEEL}"/>
    ${wheel(12, 24.8, 3.4)}
    ${wheel(20, 24.8, 3.4)}
  `);
}

/** Grain header (maintainer request, 2026-07-13): the wide cutting platform
 * a combine mounts out front — divider points at each end, a reel of tines
 * above the cutting bar, an auger trough feeding the middle. Shown in the
 * Work Queue as the combine's "implement" (assumed always fitted — no
 * separate buyable header exists). */
export function grainHeaderIconSvg(size = 22): string {
  const reelTines: string[] = [];
  for (let i = 0; i < 6; i++) {
    const x = 5 + i * 4.2;
    reelTines.push(`<line x1="${x}" y1="9.5" x2="${x}" y2="13" stroke="${STEEL_D}" stroke-width="0.8"/>`);
  }
  return svg(size, `
    <path d="M2 20.5 L4.4 15.5 h22.2 L29 20.5 Z" fill="${BODY}" stroke="${BODY_D}" stroke-width="0.9"/>
    <path d="M4.4 15.5 h22.2 v1.6 H4.4 Z" fill="${BODY_D}" opacity="0.55"/>
    <path d="M2 20.5 h27 v2.2 H2 Z" fill="${STEEL}" stroke="${STEEL_D}" stroke-width="0.7"/>
    <path d="M1 20.6 l2.6-1.2 v2.4 Z" fill="${STEEL_D}"/>
    <path d="M30 20.6 l-2.6-1.2 v2.4 Z" fill="${STEEL_D}"/>
    <line x1="3" y1="19" x2="28" y2="19" stroke="#8d99a6" stroke-width="0.6" stroke-dasharray="1.4 1.4"/>
    <line x1="5" y1="11.4" x2="26" y2="11.4" stroke="${STEEL_D}" stroke-width="1.1"/>
    ${reelTines.join("")}
    <line x1="21" y1="9.5" x2="21" y2="13" stroke="${STEEL_D}" stroke-width="0.8"/>
    <line x1="25.8" y1="9.5" x2="25.8" y2="13" stroke="${STEEL_D}" stroke-width="0.8"/>
    <circle cx="5" cy="11.4" r="1.1" fill="${STEEL}" stroke="${STEEL_D}" stroke-width="0.5"/>
    <circle cx="26" cy="11.4" r="1.1" fill="${STEEL}" stroke="${STEEL_D}" stroke-width="0.5"/>
  `);
}

/** Bale color tints (2026-07-13): the same round-bale shape, different wrap
 * color per product — light brown for hay/corn stover, darker green for
 * alfalfa. `color` keys match `gameConfig.baleProducts[*].color`. */
const BALE_TINTS: Record<"hay" | "alfalfa", { fill: string; stroke: string; band: string; core: string }> = {
  hay: { fill: "#d9c187", stroke: "#9c8348", band: "#b39a5c", core: "#c7ad72" },
  // Alfalfa bales read as a deep, dark forage green (maintainer request, 2026-07-14).
  alfalfa: { fill: "#4a6234", stroke: "#2f4121", band: "#3b4f2a", core: "#425a2f" },
};

/** A round bale seen end-on: wound cylinder, tinted by product (`color`). */
export function baleIconSvg(size = 14, color: "hay" | "alfalfa" = "hay"): string {
  const t = BALE_TINTS[color];
  return svg(size, `
    <ellipse cx="16" cy="17" rx="12" ry="10.5" fill="${t.fill}" stroke="${t.stroke}" stroke-width="1.4"/>
    <path d="M6.5 13.5 c4 2 15 2 19 0 M5.5 18 c4.6 2.6 16.4 2.6 21 0 M7 22 c4 2 14 2 18 0" stroke="${t.band}" stroke-width="1" fill="none"/>
    <ellipse cx="16" cy="17" rx="4.4" ry="3.9" fill="${t.core}" stroke="${t.stroke}" stroke-width="0.9"/>
    <ellipse cx="16" cy="17" rx="1.7" ry="1.5" fill="none" stroke="${t.stroke}" stroke-width="0.6"/>
  `);
}

/** Mower (2026-07-13): a trailed disc mower — angled cutter bar carrying a row
 * of spinning cutting discs, on a small transport wheel. Cuts perennial forage. */
export function mowerIconSvg(size = 22): string {
  const discs: string[] = [];
  for (let i = 0; i < 6; i++) {
    const cx = 6 + i * 3.7, cy = 18 + i * 0.7;
    discs.push(`<ellipse cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" rx="2" ry="1" fill="#b9c0c6" stroke="${STEEL_D}" stroke-width="0.5"/>` +
      `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="0.5" fill="${STEEL_D}"/>`);
  }
  return svg(size, `
    <rect x="1.5" y="11.6" width="3.8" height="1.4" rx="0.5" fill="${STEEL_D}"/>
    <line x1="4.5" y1="12.4" x2="27" y2="17.2" stroke="${RED}" stroke-width="2.2"/>
    <line x1="4.5" y1="12.4" x2="27" y2="17.2" stroke="${RED_D}" stroke-width="0.6" opacity="0.6"/>
    <line x1="5" y1="16.2" x2="27.5" y2="21" stroke="${STEEL}" stroke-width="1.4"/>
    ${discs.join("")}
    ${wheel(26.5, 24, 2.6)}
  `);
}

/** Mulcher (2026-07-21): a trailed flail mulcher — a wide hooded rotor housing
 * with a row of hanging flail hammers underneath that shred crop residue back
 * into the surface. Hitch bar at the rear (east), transport wheel below. */
export function mulcherIconSvg(size = 22): string {
  const flails: string[] = [];
  for (let i = 0; i < 7; i++) {
    const x = 6.5 + i * 2.6;
    flails.push(`<line x1="${x.toFixed(1)}" y1="18.4" x2="${x.toFixed(1)}" y2="21.6" stroke="${STEEL_D}" stroke-width="1.1"/>` +
      `<circle cx="${x.toFixed(1)}" cy="21.9" r="0.9" fill="${STEEL_D}"/>`);
  }
  return svg(size, `
    <rect x="25.8" y="12.5" width="2.4" height="7" rx="0.6" fill="${STEEL_D}"/>
    <path d="M26 16 h-3" stroke="${STEEL}" stroke-width="1.4"/>
    <rect x="4" y="10.5" width="20" height="8" rx="1.6" fill="${RED}" stroke="${RED_D}" stroke-width="0.8"/>
    <rect x="4" y="10.5" width="20" height="2.6" rx="1.2" fill="${RED_D}" opacity="0.55"/>
    <rect x="5.5" y="17.3" width="17" height="1.8" rx="0.7" fill="${STEEL}" stroke="${STEEL_D}" stroke-width="0.5"/>
    ${flails.join("")}
    ${wheel(6, 21.5, 2.4)}
  `);
}

/** Hay Spikes (2026-07-17): a rear 3-point frame carrying two forward
 * (west-pointing) spears that skewer a round bale — the in-field bale
 * collector. Shows one speared bale for readability. */
export function haySpikesIconSvg(size = 22): string {
  return svg(size, `
    <rect x="25.5" y="12.5" width="2.4" height="9" rx="0.6" fill="${STEEL_D}"/>
    <path d="M25.8 15 h-3 M25.8 19 h-3" stroke="${STEEL}" stroke-width="1.4"/>
    <path d="M22.8 15 h-16 M22.8 19 h-16" stroke="${STEEL}" stroke-width="1.6" stroke-linecap="round"/>
    <ellipse cx="12" cy="17" rx="8" ry="7.4" fill="${BALE_TINTS.hay.fill}" stroke="${BALE_TINTS.hay.stroke}" stroke-width="1.2"/>
    <path d="M5 14.5 c3 1.4 11 1.4 14 0 M4.4 17.4 c3.4 1.8 11.8 1.8 15.2 0 M5.4 20.2 c3 1.4 10 1.4 13 0" stroke="${BALE_TINTS.hay.band}" stroke-width="0.8" fill="none"/>
  `);
}

/** Bale Trailer (2026-07-17): a flat-deck trailer stacked with round bales —
 * the bulk hauler half of the bale relay. */
export function baleTrailerIconSvg(size = 22): string {
  const bale = (cx: number, cy: number, r: number) =>
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${BALE_TINTS.hay.fill}" stroke="${BALE_TINTS.hay.stroke}" stroke-width="0.9"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${(r * 0.4).toFixed(1)}" fill="${BALE_TINTS.hay.core}" stroke="${BALE_TINTS.hay.stroke}" stroke-width="0.5"/>`;
  return svg(size, `
    <rect x="1.5" y="17.4" width="4" height="1.4" rx="0.5" fill="${STEEL_D}"/>
    <rect x="4.5" y="17.6" width="23" height="2.4" rx="0.6" fill="${STEEL}" stroke="${STEEL_D}" stroke-width="0.6"/>
    ${bale(9, 14.4, 3.4)}
    ${bale(16, 14.4, 3.4)}
    ${bale(23, 14.4, 3.4)}
    ${wheel(11, 22, 3)}
    ${wheel(21, 22, 3)}
  `);
}

/** Machines (power units), by agent kind. */
export const MACHINE_ICON: Record<string, (size?: number) => string> = {
  tractor: tractorIconSvg,
  harvester: combineIconSvg,
};

/** Implements, by implement kind. */
export const IMPLEMENT_ICON_SVG: Record<string, (size?: number) => string> = {
  plow: plowIconSvg,
  planter: planterIconSvg,
  sprayer: sprayerIconSvg,
  rake: rakeIconSvg,
  bailer: balerIconSvg,
  grainTrailer: grainTrailerIconSvg,
  mower: mowerIconSvg,
  mulcher: mulcherIconSvg,
  haySpikes: haySpikesIconSvg,
  baleTrailer: baleTrailerIconSvg,
};
