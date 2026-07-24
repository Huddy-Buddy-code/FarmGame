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

/** Crops the player can plant (brief §6, §10). All numbers are balance = tunable.
 * Grass & Alfalfa (2026-07-13) are PERENNIAL forage crops — planted once, cut
 * 3× a year, never plowed/replanted (see `perennial`/`harvestMonths`).
 * 2026-07-22: six more annuals (maintainer request) — wheat/oats/barley (small
 * grains, straw residue), canola/sunflowers (oilseeds), potatoes (high-risk
 * high-capital roots). */
export type CropId =
  | "corn" | "soybeans" | "grass" | "alfalfa"
  | "wheat" | "oats" | "barley" | "canola" | "sunflowers" | "potatoes";

/** What a field's dropped bales ARE, for pricing + coloring (2026-07-13). Corn
 * leaves stover; grass raked→baled is hay; alfalfa raked→baled is alfalfa hay;
 * small grains (wheat/oats/barley, 2026-07-22) leave straw; "forage" is the
 * (currently unreachable — baling always follows a rake) unraked path the
 * maintainer called out. */
export type BaleProduct = "cornStover" | "hay" | "alfalfaHay" | "straw" | "forage";

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
  /** Planting inputs — SEED + herbicide/pesticide CHEMICALS only, paid at
   * planting (brief §8). Fertilizer is deliberately excluded: it's its own
   * pass ([[fertilizeCostPerAcre]] below), so it isn't paid twice. */
  inputCostPerAcre: number;
  /** Fertilizer, per acre: material (N-P-K/topdress) + application fuel/wear,
   * charged on the FERTILIZE task, not at planting. Varies a lot by crop —
   * corn is a heavy N user, soybeans fix their own N (P&K top-up only), hay
   * crops get an annual topdress. Real-world per-acre ballpark (Corn Belt,
   * university extension budgets, 2023-24): corn ~$180-220 material, soy
   * ~$40-60, hay ~$70-100 — plus ~$20/ac fuel+wear for the pass itself,
   * same rate as [[plowCostPerAcre]]. */
  fertilizeCostPerAcre: number;
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
   * can be re-plowed — if the farm owns the gear. Corn + the perennials. */
  producesForage?: boolean;
  /** Does this crop yield GRAIN sold by the ton (corn/soybeans)? Perennial
   * forage crops (grass/alfalfa) don't — their whole product is bales — so
   * they're excluded from the grain inventory. Defaults to true when omitted. */
  producesGrain?: boolean;
  /** PERENNIAL forage crop (grass/alfalfa, 2026-07-13): planted once, never
   * plowed or replanted. Cut on fixed monthly windows (`harvestMonths`) rather
   * than the annuals' single ripen-then-done timer; the stand persists year to
   * year and regrows between cuttings. */
  perennial?: boolean;
  /** Perennial only: the 0-based months the field is READY to cut (mow), one
   * cutting per window. e.g. [4,5,6] = May/Jun/Jul. */
  harvestMonths?: number[];
  /** Perennial only: the 0-based month an annual fertilizer pass opens in
   * (April = 3). Independent of planting (the stand's already established). */
  fertilizeMonth?: number;
  /** Which bale product a rake→bale run on this crop produces (hay for grass,
   * alfalfaHay for alfalfa). Corn's stover is handled separately (its crop is
   * cleared at harvest before baling). */
  baleProduct?: BaleProduct;
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
  /* REMOVED 2026-07-23: `plowMonths`. Plowing is no longer a fixed season —
   * the window is derived per crop from when the ground is actually free
   * (`sim/schedule.ts`), so there's no global month list to tune. */
  /** Cost to weed, per acre — same pay-on-queue pattern as plow. Fertilize
   * moved to a per-crop cost ([[CropConfig.fertilizeCostPerAcre]]) since real
   * fertilizer need varies far more by crop than weeding chemicals do. */
  weedCostPerAcre: number;
  /** Cost to mow (cut) a perennial forage field, per acre (2026-07-13). */
  mowCostPerAcre: number;
  /** Cost to mulch (shred + incorporate crop residue) an annual field, per
   * acre (2026-07-21). Optional post-harvest pass — see the mulcher implement
   * and the `mulch` task (sim/tasks.ts). */
  mulchCostPerAcre: number;
  /** Cost to harvest, per acre — fuel + labor for the combine (2026-07-23).
   * The priciest fieldwork pass in the game: a combine burns more fuel and
   * costs more per hour to run than any tractor pass. */
  harvestCostPerAcre: number;
  /** Yield bonus the NEXT crop gets from a mulch pass (`Field.residueMulched`).
   * Two rates (maintainer spec, 2026-07-23): the full rate when the residue was
   * shredded back in whole, and a reduced one when the bulk of it was baled off
   * the field first and only the stubble got worked in. */
  mulchBonusPct: number;
  mulchBonusBaledPct: number;

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
    /** Mower implement (2026-07-13): CUTS a perennial forage field (grass/
     * alfalfa) — the "harvest" for those crops, in place of the combine. Leaves
     * cut material to rake + bale. Sold Small (10 ft) & Medium (20 ft). */
    mower: Record<EquipmentSize, { price: number; widthFt: number }>;
    /** Mulcher implement (2026-07-21): a flail/stalk shredder that chops annual
     * crop residue and works it back into the surface — an OPTIONAL post-harvest
     * pass that returns the field to stubble and boosts the next crop's yield.
     * Sold in three real sizes: Small 15 ft, Medium 25 ft, Large 35 ft. */
    mulcher: Record<EquipmentSize, { price: number; widthFt: number }>;
    /** The combine is self-contained (integral grain header) but now SIZED
     * like a tractor (maintainer request, 2026-07-12): each tier has its own
     * hopper capacity — the combine fills as it cuts, stops when full, and
     * waits for a Grain Trailer (see `hauling` + `sim/tasks.ts`). */
    harvester: Record<EquipmentSize, { price: number; widthFt: number; capacityTons: number }>;
    /** Grain Trailer: hauls a full combine hopper to a silo. A normal
     * implement (one tractor hitch slot, like a plow) — `widthFt` is unused
     * (not a fieldwork tool) but kept so it shares the generic implement
     * config shape. `capacityTons` caps how much one trip can carry; a
     * trailer smaller than the hopper just takes a partial load. */
    grainTrailer: Record<EquipmentSize, { price: number; widthFt: number; capacityTons: number }>;
    /** Hay Spikes (2026-07-17): a tractor implement that spears round bales to
     * collect them out of the field — tiny capacity (Small 1 bale, Medium 2),
     * `widthFt` unused (not a coverage tool). The in-field collector half of
     * the bale-hauling relay (see `sim/tasks.ts` haulBales). */
    haySpikes: Record<EquipmentSize, { price: number; widthFt: number; capacityBales: number }>;
    /** Bale Trailer (2026-07-17): the bulk hauler half of the relay — like the
     * Grain Trailer but for bales. Waits at a field entrance, is loaded by the
     * Hay-Spikes tractor, then runs full loads to Bale Storage. `capacityBales`
     * Small 10 / Medium 20; `widthFt` unused. */
    baleTrailer: Record<EquipmentSize, { price: number; widthFt: number; capacityBales: number }>;
  };

  /** Grain hauling (maintainer request, 2026-07-12): the pause a tractor+
   * Grain Trailer sits still for at each end of a haul — loading at the
   * combine, dumping at the silo. Same "~10 sim-seconds at 1×" convention as
   * `forage.baleTieMinutes`. */
  hauling: {
    loadMinutes: number;
    dumpMinutes: number;
    /** After fully draining the combine, a cart at or above this fraction of
     * its capacity makes a silo run right away instead of waiting in-field —
     * a nearly-full cart would have almost no room at the combine's next
     * stop (maintainer request, 2026-07-13). */
    cartSiloRunFraction: number;
    /** How many rigs may work one hauling job at once — grain carts servicing a
     * single combine, or bale haulers clearing a single field (maintainer
     * request, 2026-07-23). Crews are parallel TASKS rather than one task with
     * several machines on it, so each rig keeps its own independent brain; this
     * just caps how many get spawned, so a big fleet doesn't pile onto one
     * field and starve everything else. */
    maxCrewSize: number;
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
    /** How much the forage-per-bale threshold varies, as a ± fraction of a
     * nominal bale (maintainer request, 2026-07-20). The baler fills as it
     * drives and ties a bale once its hopper hits the (randomized) threshold,
     * so a bigger threshold means a longer drive before the drop — this
     * staggers the ON-PATH spacing between bales naturally, replacing the old
     * perpendicular jitter that flung bales onto un-baled ground. 0.3 = each
     * bale takes 70–130% of a nominal bale's forage to fill, so the field's
     * total bale COUNT (and thus revenue) varies a little run to run. */
    baleFillVariance: number;
  };

  /** Bale products (2026-07-13) — what a field's dropped bales are worth and how
   * densely they drop, keyed by `BaleProduct`. Corn's `cornStover` mirrors the
   * legacy `forage.balePricePerBale`/`balesPerAcre` so existing corn balances
   * are unchanged; grass→`hay` and alfalfa→`alfalfaHay` are their own tiers.
   * `color` drives the bale marker tint (hay = light brown, alfalfa = green). */
  baleProducts: Record<BaleProduct, {
    name: string;
    pricePerBale: number;
    balesPerAcre: number;
    color: "hay" | "alfalfa";
  }>;

  /** How much the visible yield range has narrowed by harvest-ready (0..1).
   * 0.85 = the band is 15% of its planting width when the crop is ready. */
  yieldRangeNarrowing: number;

  /** Crop-rotation yield bonus (0..1) applied when a field's current crop
   * differs from the one it grew the year before — 0.1 = +10%. No bonus for
   * planting the same crop again, and none on a field's first-ever crop
   * (nothing to rotate away from yet). See `productivityMultiplier`. */
  rotationBonusPct: number;

  /** Seasonal sell-price curve (maintainer request, 2026-07-21; re-anchored to
   * a fixed peak month 2026-07-21). A product's price = its base price ×
   * (1 + bonus), where bonus is keyed by how many months the CURRENT month is
   * from `peakMonth` (wrapping either way — see `sim/market.ts`). The SAME curve
   * applies to every product. Base price is the floor (no discounts); any
   * distance not listed = +0%. */
  market: {
    /** The single top-of-market month (0-11), shared by all products. */
    peakMonth: number;
    /** Bonus fraction on base price by |months from `peakMonth`| (0, 1, 2, …). */
    seasonalBonusByDistance: Record<number, number>;
    /**
     * What selling straight out of Inventory costs you, as a fraction off the
     * BASE price (maintainer decision, 2026-07-23). Selling from the panel is
     * instant — a buyer collects — so it forgoes the seasonal premium entirely
     * AND takes this haircut for the pickup.
     *
     * The alternative is a Sell task: tractors haul the load to a Sell Point
     * and it fetches the full seasonal price. That's the trade the whole
     * mechanic turns on — convenience versus logistics — so this number is the
     * price of not bothering.
     */
    instantSellPenaltyPct: number;
  };

  /**
   * How many months an annual crop stays harvestable, counted from the month it
   * ripens (maintainer decision, 2026-07-23). 2 = ready in August means August
   * and September; come October it WITHERS and the crop is a total loss.
   *
   * This is the game's main time-pressure lever: it caps how far a harvest can
   * be delayed toward the December price peak, and it's what makes combine
   * capacity and crew size matter. Perennials are unaffected — a missed cutting
   * window is simply skipped and the stand regrows.
   */
  harvestWindowMonths: number;

  /** Field Schedule tab windows (`sim/schedule.ts`). How far a player may shift
   * an auto-managed step from its natural month. */
  schedule: {
    /** How many months after harvest the optional mulch pass stays legal. */
    mulchWindowMonths: number;
  };

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
    /** Grain storage, tons — sized like equipment (Small/Medium/Large), each
     * tier cheaper per ton than the last (bulk-build economy). */
    silo: Record<EquipmentSize, { price: number; capacityTons: number }>;
    /** Indoor bale storage — pricier, presumably weatherproof (flavor; no
     * mechanical difference yet). */
    baleBarn: { price: number; capacityBales: number };
    /** Outdoor bale storage — cheaper, unlimited capacity (`Infinity`); only
     * the Barn caps (maintainer request, 2026-07-17). */
    baleArea: { price: number; capacityBales: number };
    /** Parks tractors/harvesters. `slots` = max machines. */
    tractorBarn: { price: number; slots: number };
    /** Parks unattached implements. `slots` = max implements. */
    implementBarn: { price: number; slots: number };
    /** The farm's rally point — no capacity, just a place on the map. */
    farmYard: { price: number };
    /** Sell Point (2026-07-17): a bale hauler's fallback when Bale Storage
     * doesn't exist or is full — cheap, no capacity, sells whatever's dropped
     * there on the spot at the flat bale price (same rate as selling from the
     * Inventory tab). */
    sellPoint: { price: number };
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
      inputCostPerAcre: 240, // seed + herbicide/pesticide only (fertilizer below)
      fertilizeCostPerAcre: 230, // heavy N user — ~$210 material + $20 pass
      baseYieldTonsPerAcre: 5.5, // ~200 bu/ac
      yieldUncertainty: 0.3,
      plantMonths: [3, 4], // Apr–May
      growMonths: 4, // whole months → planted in Apr, ready the 1st of Aug
      sellPricePerTon: 180,
      // Corn no longer bales (maintainer decision, 2026-07-23) — its residue is
      // mulched back in or plowed under. `cornStover` stays in `baleProducts`
      // below so stover already sitting in a save still prices and sells.
    },
    soybeans: {
      name: "Soybeans",
      emoji: "🫘",
      inputCostPerAcre: 250, // seed (pricier trait genetics) + herbicide
      fertilizeCostPerAcre: 70, // fixes its own N — just a P&K top-up + pass
      baseYieldTonsPerAcre: 1.6, // ~60 bu/ac
      yieldUncertainty: 0.3,
      plantMonths: [4, 5], // May–Jun
      growMonths: 4, // whole months → planted in May, ready the 1st of Sep
      sellPricePerTon: 390,
    },
    // --- Six more annuals (maintainer request, 2026-07-22). Balance targets,
    // per acre at base yield & base price (net of input+fert+plow+weed ≈ $35):
    //   corn ~$485 (+stover), soy ~$270 — the yardsticks.
    //   wheat ~$315 (+straw)  — the winter slot: field busy Sep→Jun, its own cycle.
    //   oats ~$185 (+straw)   — cheapest inputs in the game; low ceiling.
    //   barley ~$235 (+straw) — a step up from oats, still cheap.
    //   canola ~$390          — near-corn profit without corn's fertilizer bill,
    //                           but the widest uncertainty of the oilseeds.
    //   sunflowers ~$295      — soy-tier, but ready Oct/Nov = right at the
    //                           seasonal price ramp toward the Dec peak.
    //   potatoes ~$1060       — DOUBLE corn, but ~$1k/ac sunk before harvest and
    //                           ±45% yield risk; 14 t/ac also crushes silo space.
    wheat: {
      name: "Winter Wheat",
      emoji: "🌾",
      inputCostPerAcre: 130, // cheap seed + a fall herbicide pass
      fertilizeCostPerAcre: 130, // spring N topdress + pass
      baseYieldTonsPerAcre: 2.9, // ~95 bu/ac
      yieldUncertainty: 0.25, // overwinters established — steadier than spring crops
      plantMonths: [8, 9], // Sep–Oct (fall seeding)
      growMonths: 9, // Sep 1 + 9 → ready the 1st of Jun (overwinters)
      sellPricePerTon: 210,
      producesForage: true, // wheat straw → rake + bale before re-plowing
      baleProduct: "straw",
    },
    oats: {
      name: "Oats",
      emoji: "🥣",
      inputCostPerAcre: 90, // cheapest seed going
      fertilizeCostPerAcre: 70, // light N — oats lodge if pushed hard
      baseYieldTonsPerAcre: 2.3, // ~130 bu/ac (32 lb bushels)
      yieldUncertainty: 0.3,
      plantMonths: [2, 3], // Mar–Apr (early spring)
      growMonths: 4, // ready the 1st of Jul/Aug
      sellPricePerTon: 165,
      producesForage: true,
      baleProduct: "straw",
    },
    barley: {
      name: "Barley",
      emoji: "🍺",
      inputCostPerAcre: 110,
      fertilizeCostPerAcre: 105,
      baseYieldTonsPerAcre: 2.5, // ~105 bu/ac
      yieldUncertainty: 0.3,
      plantMonths: [2, 3], // Mar–Apr
      growMonths: 4, // ready the 1st of Jul/Aug
      sellPricePerTon: 195,
      producesForage: true,
      baleProduct: "straw",
    },
    canola: {
      name: "Canola",
      emoji: "🌼",
      inputCostPerAcre: 190, // hybrid seed is pricey
      fertilizeCostPerAcre: 150, // heavy N + sulfur
      baseYieldTonsPerAcre: 1.5, // ~55 bu/ac
      yieldUncertainty: 0.35, // touchy at flowering — heat snaps hurt
      plantMonths: [3, 4], // Apr–May
      growMonths: 4, // ready the 1st of Aug/Sep
      sellPricePerTon: 510,
    },
    sunflowers: {
      name: "Sunflowers",
      emoji: "🌻",
      inputCostPerAcre: 150,
      fertilizeCostPerAcre: 95, // deep taproot scavenges leftover N
      baseYieldTonsPerAcre: 1.2, // ~2100 lb/ac
      yieldUncertainty: 0.35,
      plantMonths: [4, 5], // May–Jun
      growMonths: 5, // ready the 1st of Oct/Nov — rides the ramp to the Dec peak
      sellPricePerTon: 480,
    },
    potatoes: {
      name: "Potatoes",
      emoji: "🥔",
      inputCostPerAcre: 780, // seed potatoes cost a fortune
      fertilizeCostPerAcre: 260, // heavy, split-applied feeding
      baseYieldTonsPerAcre: 14, // ~500 cwt/ac
      yieldUncertainty: 0.45, // boom or bust — the game's riskiest roll
      plantMonths: [3], // April only — a tight window
      growMonths: 5, // ready the 1st of Sep
      sellPricePerTon: 150,
    },
    // Perennial forage crops (2026-07-13): planted once in spring, cut 3× a
    // year (mow → rake → bale = hay), fertilized annually, never plowed. Yield
    // is realized as BALES, not grain, so baseYield/sellPricePerTon are unused
    // (kept at 0 to satisfy the shared CropConfig shape).
    grass: {
      name: "Grass",
      emoji: "🌿", // was 🌾, ceded to Winter Wheat (2026-07-22)
      inputCostPerAcre: 100, // establishment seed only
      fertilizeCostPerAcre: 110, // annual topdress (N-P-K) + pass, hay removes a lot of nutrients
      baseYieldTonsPerAcre: 0,
      yieldUncertainty: 0,
      plantMonths: [2], // March
      growMonths: 2,
      sellPricePerTon: 0,
      producesForage: true,
      producesGrain: false,
      perennial: true,
      harvestMonths: [4, 6, 8], // May / Jul / Sep cuttings (a growing month between each)
      fertilizeMonth: 3, // April
      baleProduct: "hay",
    },
    alfalfa: {
      name: "Alfalfa",
      emoji: "☘️",
      inputCostPerAcre: 160, // alfalfa seed is pricey — establishment cost stays high
      fertilizeCostPerAcre: 90, // fixes its own N — annual P&K/S topdress + pass
      baseYieldTonsPerAcre: 0,
      yieldUncertainty: 0,
      plantMonths: [2], // March
      growMonths: 2,
      sellPricePerTon: 0,
      producesForage: true,
      producesGrain: false,
      perennial: true,
      harvestMonths: [4, 6, 8], // May / Jul / Sep cuttings (a growing month between each)
      fertilizeMonth: 3, // April
      baleProduct: "alfalfaHay",
    },
  },

  plowCostPerAcre: 20,
  weedCostPerAcre: 15,
  mowCostPerAcre: 12,
  mulchCostPerAcre: 8,
  harvestCostPerAcre: 30,
  mulchBonusPct: 0.07,
  mulchBonusBaledPct: 0.03,
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
    // Mower: Small (10 ft) & Medium (20 ft) sold; the large slot mirrors medium
    // so the record type-checks like the others but is never offered.
    mower: {
      small: { price: 45_000, widthFt: 10 },
      medium: { price: 85_000, widthFt: 20 },
      large: { price: 85_000, widthFt: 20 },
    },
    // Mulcher — three real sizes, all sold (maintainer pricing, 2026-07-21).
    mulcher: {
      small: { price: 20_000, widthFt: 15 },
      medium: { price: 40_000, widthFt: 25 },
      large: { price: 75_000, widthFt: 35 },
    },
    harvester: {
      small: { price: 350_000, widthFt: 20, capacityTons: 30 },
      medium: { price: 450_000, widthFt: 30, capacityTons: 50 },
      large: { price: 600_000, widthFt: 40, capacityTons: 80 },
    },
    grainTrailer: {
      small: { price: 25_000, widthFt: 0, capacityTons: 40 },
      medium: { price: 45_000, widthFt: 0, capacityTons: 60 },
      large: { price: 70_000, widthFt: 0, capacityTons: 100 },
    },
    // Hay Spikes — cheap, low-capacity in-field bale collector. Small (1 bale)
    // is pullable by any tractor; Medium (2 bales) needs a medium+. The large
    // slot mirrors medium so the record type-checks; only Small/Medium are sold.
    haySpikes: {
      small: { price: 8_000, widthFt: 0, capacityBales: 1 },
      medium: { price: 16_000, widthFt: 0, capacityBales: 2 },
      large: { price: 16_000, widthFt: 0, capacityBales: 2 },
    },
    // Bale Trailer — the bulk hauler. Small 10 bales / Medium 20; large mirrors
    // medium (type-check only, never offered).
    baleTrailer: {
      small: { price: 20_000, widthFt: 0, capacityBales: 10 },
      medium: { price: 38_000, widthFt: 0, capacityBales: 20 },
      large: { price: 38_000, widthFt: 0, capacityBales: 20 },
    },
  },
  hauling: {
    loadMinutes: 0.17, // ≈ 10 s at 1×
    dumpMinutes: 0.17,
    cartSiloRunFraction: 0.75,
    maxCrewSize: 3,
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
    baleFillVariance: 0.3, // each bale fills at 70–130% of a nominal bale
  },
  baleProducts: {
    // LEGACY (2026-07-23): corn no longer produces forage, so no new stover is
    // ever made. Kept so bales already in a save keep a name, price and tint.
    cornStover: { name: "Corn Stover", pricePerBale: 45, balesPerAcre: 2.5, color: "hay" },
    // Grass hay: ~1.5 t/ac/cutting, round bale ≈ 1 t, ~$65/bale (2025 markets).
    hay: { name: "Grass Hay", pricePerBale: 65, balesPerAcre: 1.5, color: "hay" },
    // Alfalfa hay: a bit denser + roughly 2× the value of grass (~$170 vs ~$110/t).
    alfalfaHay: { name: "Alfalfa Hay", pricePerBale: 130, balesPerAcre: 1.6, color: "alfalfa" },
    // Small-grain straw (wheat/oats/barley, 2026-07-22) — bulkier and cheaper
    // than feed hay; bedding, not fodder.
    straw: { name: "Straw", pricePerBale: 35, balesPerAcre: 1.8, color: "hay" },
    // Unraked cut forage (currently unreachable — baling always follows a rake).
    forage: { name: "Forage", pricePerBale: 40, balesPerAcre: 1.5, color: "hay" },
  },
  buildings: {
    silo: {
      small: { price: 90_000, capacityTons: 200 },
      medium: { price: 200_000, capacityTons: 500 },
      large: { price: 350_000, capacityTons: 1000 },
    },
    baleBarn: { price: 70_000, capacityBales: 300 },
    // Outdoor bale storage — cheaper, and UNLIMITED capacity (maintainer
    // request, 2026-07-17): only the indoor Barn caps how many bales fit.
    baleArea: { price: 25_000, capacityBales: Infinity },
    tractorBarn: { price: 60_000, slots: 3 },
    implementBarn: { price: 40_000, slots: 4 },
    farmYard: { price: 15_000 },
    // Free (2026-07-23): the Sell task makes this the farm.s route to full
    // seasonal price, so gating it behind a purchase would just tax the
    // mechanic the player is meant to be choosing between.
    sellPoint: { price: 0 },
  },
  yieldRangeNarrowing: 0.85,
  rotationBonusPct: 0.1,
  market: {
    // Every product tops out in December, tapering to base ±2 months away:
    // Dec +25%, Nov/Jan +15%, Oct/Feb +10%, everything else base.
    peakMonth: 11, // December
    seasonalBonusByDistance: { 0: 0.25, 1: 0.15, 2: 0.1 },
    instantSellPenaltyPct: 0.1,
  },
  harvestWindowMonths: 2,
  schedule: {
    mulchWindowMonths: 3,
  },
  loan: {
    ratePercent: 5,
    termMonths: 180, // 15 years
    incrementAmount: 50_000,
    refinanceFee: 15_000,
  },
};
