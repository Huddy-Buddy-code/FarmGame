/**
 * PILLAR 1 — The Single Config Object.
 *
 * Every balance-affecting number in the game lives here. Nothing balance-related
 * is hardcoded anywhere else. This object is how we (a) find the fun in playtesting
 * by tweaking numbers, and (b) get difficulty presets for free (two presets over
 * this one object, per brief §7).
 *
 * As systems come online (market, fuel, contracts, condition curve, interest),
 * their tunables get ADDED here — never inlined into the system code.
 */

export interface GameConfig {
  /** The county this campaign is pinned to. Drives imagery, OSM extract, UTM zone. */
  county: {
    name: string;
    /** UTM zone for the county's internal metric space (brief §3). */
    utmZone: number;
    utmHemisphere: "N" | "S";
    /** Map start view (lng/lat — render-space only). */
    center: [number, number];
    zoom: number;
  };

  // --- Economy, fuel, contracts, condition, interest, yield, etc. get added
  //     here slice-by-slice as those systems are built (brief §5–§8). ---
}

/** Baseline config. Difficulty presets will be derived by overriding fields here. */
export const gameConfig: GameConfig = {
  county: {
    name: "Story County, Iowa",
    utmZone: 15,
    utmHemisphere: "N",
    center: [-93.4635, 42.0308], // near Ames, IA
    zoom: 12,
  },
};
