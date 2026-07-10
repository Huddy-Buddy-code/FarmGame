/**
 * PILLAR 1 — The Single Config Object.
 *
 * Every balance-affecting number in the game lives here. Nothing balance-related
 * is hardcoded anywhere else. This object is how we (a) find the fun in playtesting
 * by tweaking numbers, and (b) get difficulty presets for free (two presets over
 * this one object, per brief §7).
 *
 * NOTE: county IDENTITY (name, UTM zone, bounds, imagery) is NOT balance — it lives
 * in the county package manifest (`public/counties/<id>/manifest.json`). This object
 * holds only tunable game economics.
 *
 * As systems come online (market, fuel, contracts, condition curve, interest),
 * their tunables get ADDED here — never inlined into the system code.
 */

/** Crops the player can plant (brief §6, §10). All numbers are balance = tunable. */
export type CropId = "corn" | "soybeans";

/** Equipment size classes. A tractor pulls implements of its class or smaller. */
export type EquipmentSize = "small" | "medium" | "large";

/** Size ordering, so `canPull` and UI can compare classes. */
export const SIZE_RANK: Record<EquipmentSize, number> = { small: 0, medium: 1, large: 2 };

/** Feet → meters (implement widths are specified in real feet). */
export const FEET_TO_METERS = 0.3048;

export interface CropConfig {
  name: string;
  /** HUD icon — cozy UI shorthand. */
  emoji: string;
  /** Planting inputs (seed, fertilizer, chemicals), paid at planting (brief §8). */
  inputCostPerAcre: number;
  /** Expected yield in tons/acre a typical season lands around. */
  baseYieldTonsPerAcre: number;
  /** Yield uncertainty half-width as a fraction of base (±30% = 0.3). The TRUE
   * yield is rolled inside this band at planting; the VISIBLE range narrows toward
   * it over the season (brief §6 — "show the range, don't hide the number"). */
  yieldUncertainty: number;
  /** 0-based months (0=Jan) in which planting is allowed. */
  plantMonths: number[];
  /** GAME-MONTHS from planting to harvest-ready. Keyed to months (not days) so the
   * crop stays synced to the calendar/seasons at any month length: shorten the
   * days-per-month pace knob and growth speeds up proportionally, harvest still
   * lands in the same season. (~3.7 months ≈ a real corn season.) */
  growMonths: number;
  /** Placeholder flat sale price, $/ton. Replaced by the real market (buyers,
   * local demand, hauling) in the economy slice (brief §5) — this just lets the
   * money loop close while that's being built. */
  sellPricePerTon: number;
}

export interface GameConfig {
  /** Starting cash for a new campaign. */
  startingMoney: number;

  /** Capital cost to buy land, per acre (brief §8, "Capital (lumpy): land").
   * Placeholder ballpark for Corn-Belt cropland; tune in playtest. */
  landPricePerAcre: number;

  crops: Record<CropId, CropConfig>;

  /** Cost to plow/till, per acre (fuel + wear; brief §8 variable costs). */
  plowCostPerAcre: number;

  /** Fieldwork pacing (brief §9–§10). PHYSICAL model (design decision 2026-07-10):
   * a machine drives a back-and-forth coverage path at `fieldSpeedKmh`, so a
   * job's duration EMERGES from the field's size and the implement's working
   * WIDTH (a wider tool = fewer, longer-spaced lanes = a shorter route = a faster
   * job). Nothing here is an abstract acres/hour rate any more. */
  work: {
    /** In-field working speed while driving the coverage lanes, km/h. */
    fieldSpeedKmh: number;
    /** Point-to-point travel speed between the yard and a field, km/h
     * (straight-line for now; real-road routing plugs in later, brief §9). */
    travelSpeedKmh: number;
  };

  /** Equipment: tractors are POWER UNITS that attach IMPLEMENTS (a plow now;
   * planters/etc. reuse this system later). A tractor can pull an implement of
   * its own size class or smaller. Widths are the real thing (feet); the physical
   * model turns width into lane count → route length → job time. Sell-back
   * refunds the purchase price, same rule as land. */
  equipment: {
    /** Power units. `pull` is the largest implement size this tractor handles. */
    tractor: Record<EquipmentSize, { price: number }>;
    /** Plow implements: price + working width in feet, by size. */
    plow: Record<EquipmentSize, { price: number; widthFt: number }>;
    /** The combine is self-contained for now (integral grain header). */
    harvester: { price: number; widthFt: number };
    /** Planting width (feet) until planter implements exist — the tractor's
     * implicit planter for plant tasks. */
    planterWidthFt: number;
  };

  /** How much the visible yield range has narrowed by harvest-ready (0..1).
   * 0.85 = the band is 15% of its planting width when the crop is ready. */
  yieldRangeNarrowing: number;

  // --- Economy, fuel, contracts, condition, interest, etc. get added
  //     here slice-by-slice as those systems are built (brief §5–§8). ---
}

/** Baseline config. Difficulty presets will be derived by overriding fields here. */
export const gameConfig: GameConfig = {
  startingMoney: 1_000_000,
  landPricePerAcre: 12_000,

  crops: {
    corn: {
      name: "Corn",
      emoji: "🌽",
      inputCostPerAcre: 450,
      baseYieldTonsPerAcre: 5.5, // ~200 bu/ac
      yieldUncertainty: 0.3,
      plantMonths: [3, 4], // Apr–May
      growMonths: 3.7, // ~110 days at 30-day months → ripe by Aug
      sellPricePerTon: 180,
    },
    soybeans: {
      name: "Soybeans",
      emoji: "🫘",
      inputCostPerAcre: 300,
      baseYieldTonsPerAcre: 1.6, // ~60 bu/ac
      yieldUncertainty: 0.3,
      plantMonths: [4, 5], // May–Jun
      growMonths: 3.3, // ~100 days at 30-day months → ripe by Sep
      sellPricePerTon: 390,
    },
  },

  plowCostPerAcre: 20,
  work: {
    // Slower than road travel: a working pass is deliberate. Tuned so a medium
    // (10 ft) plow on a ~30-acre field takes a few sim-hours — in the ballpark
    // of the old flat rate, now emerging from width × field size.
    fieldSpeedKmh: 12,
    travelSpeedKmh: 22,
  },
  equipment: {
    tractor: {
      small: { price: 150_000 },
      medium: { price: 250_000 },
      large: { price: 400_000 },
    },
    plow: {
      small: { price: 40_000, widthFt: 5 },
      medium: { price: 80_000, widthFt: 10 },
      large: { price: 150_000, widthFt: 20 },
    },
    harvester: { price: 450_000, widthFt: 30 },
    planterWidthFt: 30,
  },
  yieldRangeNarrowing: 0.85,
};
