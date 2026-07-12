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
   * lands in the same season. MUST be a WHOLE number: growth is measured from the
   * START of the planting month, so the crop ripens on the 1st of a month exactly
   * `growMonths` later — the day you actually seeded (2nd, 3rd…) doesn't matter
   * (maintainer request, 2026-07-10). */
  growMonths: number;
  /** Placeholder flat sale price, $/ton. Replaced by the real market (buyers,
   * local demand, hauling) in the economy slice (brief §5) — this just lets the
   * money loop close while that's being built. */
  sellPricePerTon: number;
  /** Does this crop leave balable forage/residue behind after harvest? When
   * true, a harvested field must be raked + baled (the forage loop) before it
   * can be re-plowed — if the farm owns the gear. Corn only, for now. */
  producesForage?: boolean;
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
  /** 0-based months (0=Jan) plowing is allowed in. Winter only (maintainer
   * decision, 2026-07-11; narrowed to winter 2026-07-12) — keeps auto-manage
   * from re-plowing the instant a field is harvested; ground rests until the
   * field naturally comes back around to plowable. */
  plowMonths: number[];
  /** Cost to weed/fertilize, per acre — same pay-on-queue pattern as plow. */
  weedCostPerAcre: number;
  fertilizeCostPerAcre: number;

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

  /** Equipment: tractors are POWER UNITS that attach IMPLEMENTS (a plow, a
   * planter). A tractor can pull an implement of its own size class or
   * smaller. Widths are the real thing (feet); the physical model turns width
   * into lane count → route length → job time. Sell-back refunds the purchase
   * price, same rule as land. */
  equipment: {
    /** Power units. `pull` is the largest implement size this tractor handles. */
    tractor: Record<EquipmentSize, { price: number }>;
    /** Plow implements: price + working width in feet, by size. */
    plow: Record<EquipmentSize, { price: number; widthFt: number }>;
    /** Planter implements: price + working width in feet, by size. Same
     * widths/requirements as the plow — a tractor needs one hitched (its own
     * class or smaller) to plant. */
    planter: Record<EquipmentSize, { price: number; widthFt: number }>;
    /** Sprayer implements (weed control + fertilizing — same implement, either
     * task): price + working width in feet, by size. Same requirements as the
     * plow/planter (a tractor needs one hitched). Design choice: only Medium
     * and Large are sold in the shop (a sprayer is a big-acreage tool); `small`
     * exists only so this record type-checks like the others and is never
     * offered for purchase. */
    sprayer: Record<EquipmentSize, { price: number; widthFt: number }>;
    /** Rake implement (windrows harvested forage into rows): price + width in
     * feet. Same hitch rule as the plow. Sold in one size (25 ft). */
    rake: Record<EquipmentSize, { price: number; widthFt: number }>;
    /** Baler implement (collects windrowed forage into bales): price + width in
     * feet. Same hitch rule; runs after (or alongside) the rake. Sold in one
     * size (25 ft). */
    bailer: Record<EquipmentSize, { price: number; widthFt: number }>;
    /** The combine is self-contained for now (integral grain header). */
    harvester: { price: number; widthFt: number };
  };

  /** Forage baling (maintainer request, 2026-07-11). After a forage crop is
   * harvested, the field is RAKED (windrowed) then BALED; baling drops physical
   * bales in the field that the player sells from the field panel, and leaves
   * the field "mulched" (ready to re-plow in the winter window). */
  forage: {
    /** In-field working speed of the rake, km/h — slightly FASTER than the
     * baler (so it pulls ahead when both run the same field in parallel). */
    rakeSpeedKmh: number;
    /** In-field working speed of the baler, km/h — slightly slower than the rake. */
    baleSpeedKmh: number;
    /** Cost per acre to rake / to bale (fuel + wear; pay-on-queue like plowing). */
    rakeCostPerAcre: number;
    baleCostPerAcre: number;
    /** Bales produced per acre baled. */
    balesPerAcre: number;
    /** Weight of a single bale, tons (flavor/display; each bale ≈ 1 t). */
    baleTons: number;
    /** Flat sale price per bale (placeholder, like the flat grain price). */
    balePricePerBale: number;
    /** How long the baler stops to tie & eject each bale, in SIM-minutes. Tuned
     * to feel like ~10 s at 1× (1× = 1 sim-min per real minute, so 10 s ≈ 0.17
     * sim-min). At higher time-compression it blurs past like everything else. */
    baleTieMinutes: number;
  };

  /** How much the visible yield range has narrowed by harvest-ready (0..1).
   * 0.85 = the band is 15% of its planting width when the crop is ready. */
  yieldRangeNarrowing: number;

  /** Loans (brief §8, "loan interest, the difficulty dial"). v1 is simple: one
   * fixed-rate, fixed-term amortized loan per campaign YEAR the player
   * borrows in (maintainer design, 2026-07-11) — see `sim/finance.ts`. */
  loan: {
    /** Annual interest rate, percent (5 = 5%). */
    ratePercent: number;
    /** Amortization term in months, fixed at lock-in/refinance (15 years). */
    termMonths: number;
    /** The +/− button increment for borrowing and paying down. */
    incrementAmount: number;
    /** Flat refinance fee, added to the loan's PRINCIPAL (not charged in
     * cash) — resets its amortization to a fresh `termMonths`. */
    refinanceFee: number;
  };

  /** Placeable farm structures (maintainer request, 2026-07-12): storage and a
   * rally point. This slice adds them as purchasable/sellable map fixtures with
   * their capacity numbers defined here — WIRING those numbers into gameplay
   * (grain/bale caps that block harvesting/baling, barn slot limits that gate
   * where equipment parks) is a follow-up pass. Sell-back refunds full price,
   * same rule as land/equipment. */
  buildings: {
    /** Grain storage, tons. */
    silo: { price: number; capacityTons: number };
    /** Indoor bale storage — pricier, presumably weatherproof (flavor; no
     * mechanical difference yet). */
    baleBarn: { price: number; capacityBales: number };
    /** Outdoor bale storage — cheaper. */
    baleArea: { price: number; capacityBales: number };
    /** Parks tractors/harvesters. `slots` = max machines. */
    tractorBarn: { price: number; slots: number };
    /** Parks unattached implements. `slots` = max implements. */
    implementBarn: { price: number; slots: number };
    /** The farm's rally point — no capacity, just a place on the map. */
    farmYard: { price: number };
  };

  // --- Economy, fuel, contracts, condition, etc. get added here slice-by-
  //     slice as those systems are built (brief §5, §8). ---
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
      growMonths: 4, // whole months → planted in Apr, ready the 1st of Aug
      sellPricePerTon: 180,
      producesForage: true, // corn stover → rake + bale before re-plowing
    },
    soybeans: {
      name: "Soybeans",
      emoji: "🫘",
      inputCostPerAcre: 300,
      baseYieldTonsPerAcre: 1.6, // ~60 bu/ac
      yieldUncertainty: 0.3,
      plantMonths: [4, 5], // May–Jun
      growMonths: 4, // whole months → planted in May, ready the 1st of Sep
      sellPricePerTon: 390,
    },
  },

  plowCostPerAcre: 20,
  plowMonths: [11, 0, 1], // Dec–Feb (winter only)
  weedCostPerAcre: 15,
  fertilizeCostPerAcre: 35,
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
    planter: {
      small: { price: 40_000, widthFt: 5 },
      medium: { price: 80_000, widthFt: 10 },
      large: { price: 150_000, widthFt: 20 },
    },
    sprayer: {
      small: { price: 50_000, widthFt: 30 }, // not sold — see field comment above
      medium: { price: 100_000, widthFt: 60 },
      large: { price: 200_000, widthFt: 120 },
    },
    // Rake & baler are single-size tools (25 ft). All three size slots exist so
    // they type-check like the other implements; only Medium is sold in the shop
    // (and Medium is pullable by the starting medium tractor).
    rake: {
      small: { price: 60_000, widthFt: 25 },
      medium: { price: 60_000, widthFt: 25 },
      large: { price: 60_000, widthFt: 25 },
    },
    bailer: {
      small: { price: 130_000, widthFt: 25 },
      medium: { price: 130_000, widthFt: 25 },
      large: { price: 130_000, widthFt: 25 },
    },
    harvester: { price: 450_000, widthFt: 30 },
  },
  forage: {
    rakeSpeedKmh: 13, // slightly faster than the baler
    baleSpeedKmh: 10, // slightly slower than the rake
    rakeCostPerAcre: 6,
    baleCostPerAcre: 10,
    balesPerAcre: 2.5,
    baleTons: 1,
    balePricePerBale: 45,
    baleTieMinutes: 0.17, // ≈ 10 s at 1×
  },
  buildings: {
    silo: { price: 90_000, capacityTons: 200 },
    baleBarn: { price: 70_000, capacityBales: 300 },
    baleArea: { price: 25_000, capacityBales: 300 },
    tractorBarn: { price: 60_000, slots: 3 },
    implementBarn: { price: 40_000, slots: 4 },
    farmYard: { price: 15_000 },
  },
  yieldRangeNarrowing: 0.85,
  loan: {
    ratePercent: 5,
    termMonths: 180, // 15 years
    incrementAmount: 50_000,
    refinanceFee: 15_000,
  },
};
