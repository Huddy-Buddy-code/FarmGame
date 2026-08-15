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
 * grains, straw residue), canola/sunflowers (oilseeds). Potatoes were removed
 * 2026-07-23 — they'd need specialty planting/harvesting equipment the game
 * doesn't model; Cereal Rye took their slot as a second cover crop. */
export type CropId =
  | "corn" | "forage" | "soybeans" | "grass" | "alfalfa" | "grassSilage" | "alfalfaSilage"
  | "wheat" | "rye" | "oats" | "barley" | "canola" | "sunflowers";

/** What a field's dropped bales ARE, for pricing + coloring (2026-07-13). Corn
 * leaves stover; grass raked→baled is hay; alfalfa raked→baled is alfalfa hay;
 * small grains (wheat/oats/barley, 2026-07-22) leave straw; "forage" is the
 * (currently unreachable — baling always follows a rake) unraked path the
 * maintainer called out. */
/**
 * CHOPPED SILAGE (2026-07-31, silage Phases 2–3) — the bulk, bunker-stored
 * route, as opposed to baleage's wrapped bales.
 *
 * Stored as TONS in a Silage Bunker (not bales, not bushels), because that's
 * how a bunker is really specified and because chopped forage has no discrete
 * unit to count. Sold by the ton like grain.
 *
 * Corn Forage is the ONLY crop that ever chops into a bunker (2026-08-15 —
 * confirmed via `crops[x].silageProduct`; Grass/Alfalfa Silage went
 * bale-only back on 2026-08-13, and nothing else ever set one). "haylage"/
 * "alfalfaHaylage" existed here as a result but were never actually
 * reachable — the same class of dead product as the old bale-side "forage"
 * — so this shrank to just the one crop's two aging stages:
 *   "cornForage" (fresh, just chopped) → 2 months →  "cornSilage" (cured).
 * Renamed from "cornSilage"/"silage" (2026-08-15) — those ids had the
 * relationship backwards from their own display names (id "cornSilage"
 * displayed as "Corn Forage"), confusing to read in code even though
 * nothing was wrong at runtime. A legacy save is remapped on load
 * (`migrateLegacySilageProducts`, sim/buildings.ts).
 */
export type SilageProduct = "cornForage" | "cornSilage";

export const SILAGE_PRODUCTS: SilageProduct[] = ["cornForage", "cornSilage"];

export type BaleProduct =
  | "cornStover" | "hay" | "alfalfaHay" | "straw"
  // SQUARE-baled variants (2026-07-24). Which one a field ends up with is
  // decided by the baler that was hitched — the Large baler is a large square
  // baler (see `equipment.bailer`). Square bales are MUCH bigger than round
  // (1.6x the weight, 2026-08-15 balance pass — real large square balers
  // routinely make bales that much heavier) but sell at the SAME price per
  // TON as round — real hay markets price by tonnage/quality, not bale
  // shape, so there's no per-ton premium here any more either. Forked as
  // separate products rather than a shape flag because everything
  // downstream — storage, the Market rows, the sell schedule — is already
  // keyed by BaleProduct.
  | "haySquare" | "alfalfaHaySquare" | "strawSquare"
  // BALEAGE (wrapped bales, 2026-07-31 — silage Phase 1; square variants
  // 2026-08-13). A bale sealed in plastic ferments instead of drying, so it
  // keeps almost indefinitely wherever it's stacked. Only Grass/Alfalfa make
  // it (straw is dry residue, nothing to ferment) — see `BALEAGE_OF`,
  // sim/farming.ts. Priced ABOVE the dry twin per ton (2026-08-15 balance
  // pass, maintainer rule: "silage is always more valuable than its
  // original form") — a "finished, ready-to-feed, no spoilage risk" premium,
  // not the dry-matter-content discount a strict water-weight comparison
  // would give it (real markets show that too — DM-adjusted, a wetter
  // product is definitionally cheaper per ton — but a straight per-ton
  // comparison of finished feed products more often shows wrapped/ensiled
  // forage priced ABOVE dry hay, which is the comparison this game makes).
  // Same bale COUNT per acre as the dry route now, not a bonus one (2026-
  // 08-15 — confirmed the sim never actually used the old +8% "avoids field
  // loss" bonus for real bale counts; it was a display-only number that
  // didn't match what happened in the field).
  | "hayBaleage" | "alfalfaBaleage" | "haySquareBaleage" | "alfalfaHaySquareBaleage"
  // AGED baleage (2026-08-15, replacing the old crop-agnostic "silageBale"/
  // "silageBaleSquare"): what baleage becomes once it's sat wrapped for
  // `forage.silageAgingMonths` — see `resolveAgedBaleProduct`,
  // sim/farming.ts. Used to merge grass and alfalfa into one generic
  // "it's just silage now" product; now keeps crop identity (maintainer
  // rule: "Grass Silage, Alfalfa Silage, and Corn Silage are all different
  // and have different pricing" — losing which CROP it was contradicted
  // that even for the bale side). Priced above its own fresh baleage, same
  // "silage > original form" rule. Still real bales, not bunker silage —
  // named "Baleage"/"Aged Baleage" rather than "Silage" so the word
  // "Silage" keeps meaning exactly one thing in the whole game (the Corn
  // Forage/Corn Silage bunker pair, `SilageProduct`) instead of three.
  | "hayBaleageAged" | "alfalfaBaleageAged" | "haySquareBaleageAged" | "alfalfaHaySquareBaleageAged";
  // "grassRoundbaleUnwrapped"/"alfalfaRoundbaleUnwrapped" and their square
  // twins EXISTED 2026-08-14 → 2026-08-15 as a distinct id for a Silage
  // crop's not-yet-wrapped bales — the same product-list cleanup that
  // removed them (maintainer request: "too many products") confirmed the
  // gate that actually holds them back from hauling off unwrapped is
  // `wrapPending` reading the FIELD's crop (sim/tasks.ts), not the bale's
  // own id — so the distinct id was pricing-identical to plain "hay"/
  // "alfalfaHay"/"haySquare"/"alfalfaHaySquare" and cosmetic-only by the
  // time it was cut. Merged back into those four; a save from that one-day
  // window is remapped on load (`migrateLegacyBaleProducts`, sim/farming.ts).
  //
  // "forage" (unraked cut forage, never actually reachable — baling always
  // follows a rake) was cut in the same pass. Neither removal changed a
  // single price or balesPerAcre number.

/** Equipment size classes. A tractor pulls implements of its class or smaller. */
export type EquipmentSize = "small" | "medium" | "large";

/** Size ordering, so `canPull` and UI can compare classes. */
export const SIZE_RANK: Record<EquipmentSize, number> = { small: 0, medium: 1, large: 2 };

/** Feet → meters (implement widths are specified in real feet). */
export const FEET_TO_METERS = 0.3048;

/** km/h → mph (in-field working speeds are configured in km/h). */
export const KMH_TO_MPH = 0.621371;

/**
 * Tons in one bushel of `crop` — its test weight over 2000 lb.
 *
 * Storage is VOLUME throughout (2026-07-24): combine tanks, grain carts and
 * silos are all sized in bushels, so this is what turns a capacity into the
 * tonnage it holds OF A PARTICULAR CROP. Falls back to corn for a crop that
 * declares no test weight (the perennials, whose yield is bales).
 *
 * Lives here rather than in a sim module because `sim/buildings.ts` and
 * `sim/tasks.ts` both need it and tasks already imports buildings — putting it
 * in either would make a cycle. It's a pure config lookup, so the config is
 * where it belongs anyway.
 */
export function tonsPerBushel(crop: CropId): number {
  return (gameConfig.crops[crop].bushelWeightLbs ?? gameConfig.crops.corn.bushelWeightLbs ?? 56) / 2000;
}

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
  /** Can this crop's bales be wrapped into baleage (2026-08-13, Grass/Alfalfa
   * Silage rework)? Gates both an auto-hitched Combi Baler's wrap-as-it-rolls
   * behavior and the standalone Wrap task — set ONLY on the Silage crops
   * (grassSilage/alfalfaSilage), so a plain Grass/Alfalfa field can never end
   * up with baleage even if a combi baler happens to be hitched to it. */
  producesWrappedBale?: boolean;
  /**
   * TEST WEIGHT — pounds per bushel (maintainer request, 2026-07-24: "each crop
   * should have a volume per ton").
   *
   * On-board storage is VOLUME, not weight: a combine tank and a grain cart hold
   * so many bushels regardless of what's in them. Dense crops therefore go
   * further per load than light ones — a 500 bu tank is ~14 t of corn (56 lb/bu)
   * but only ~7 t of sunflowers (28 lb/bu), so oilseeds need roughly twice the
   * cart trips per ton hauled. These are the standard US test weights.
   *
   * Perennials omit it — their yield is bales, never a combine load — and
   * `tonsPerBushel` falls back to corn's for anything that somehow asks.
   */
  bushelWeightLbs?: number;
  /** Per-crop override for [[GameConfig.harvestWindowMonths]] — how many months
   * this crop stays harvestable once ripe (maintainer request, 2026-07-24:
   * "extend Planting and Harvesting windows by one month for Oats & Barley").
   * Omitted = the global default. The small grains are the forgiving ones: they
   * ripen early, dry down in the field and sit a while, unlike corn or beans
   * racing the weather. */
  harvestWindowMonths?: number;
  /**
   * SILAGE (2026-07-31, Phases 2–3). Set on every crop that can be CHOPPED
   * rather than combined or baled; absent means this crop has no silage route.
   *
   * `silageTonsPerAcre` is AS-FED tonnage at ~35–40% dry matter, which is why
   * it dwarfs the grain figure — corn silage is ~20 t/ac against grain corn's
   * 5.5 t, because it's the whole plant and most of it is water.
   */
  silageProduct?: SilageProduct;
  silageTonsPerAcre?: number;
  /** A COVER CROP: sown in autumn and held through the winter (Winter Wheat,
   * Cereal Rye). Never weeded (maintainer decision, 2026-07-23) — weeds only
   * flush in spring and summer, and a stand that went in the previous autumn is
   * thick enough by then to smother them, which is half the point of growing
   * one. The Schedule tab hides the Weed column entirely for these. */
  coverCrop?: boolean;
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
  /** 0-based months in which weeds actually flush (maintainer decision,
   * 2026-07-23): spring and summer only, never autumn or winter. Lives here
   * rather than in a sim module because BOTH the live gate (`inWeedingWindow`,
   * farming.ts) and the Schedule tab's legal months (`sim/schedule.ts`) read
   * it — and schedule.ts already imports farming.ts, so a shared constant in
   * either of them would be an import cycle. */
  weedSeasonMonths: number[];
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
    /**
     * DEFAULT in-field working speed while driving the coverage lanes, km/h,
     * for any pass without its own figure below.
     *
     * It was the single speed for every non-forage pass until 2026-07-24, which
     * made it a compromise: right for planting (8-16 km/h) and spraying, and
     * far too quick for the heavy work. Passes that need their own now have it,
     * the same way rake and bale always have (see `forage`).
     */
    fieldSpeedKmh: number;
    /** Combine speed, km/h (maintainer decision, 2026-07-24). A combine cuts at
     * 3-6.5 km/h in the real world; at the old shared 12 a medium corn head
     * did 27 ac/hr against a real 12-18, and the error grew with header width. */
    harvestSpeedKmh: number;
    /** Plowing speed, km/h. Tillage is the slowest pass on the farm — it's
     * moving soil, not gathering a crop. */
    plowSpeedKmh: number;
    /** Self-Propelled Windrower cutting speed, km/h (2026-07-25). Its own,
     * because a purpose-built machine runs a hay header noticeably faster than a
     * tractor does — that speed is half of what you're buying when the width
     * dropped to a realistic 25 ft. Keyed to the MACHINE, not the task: a
     * tractor with a mower on the same `mow` task still uses the default. */
    windrowerSpeedKmh: number;
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
     * plow/planter (a tractor needs one hitched). All three sizes are sold; the
     * 30 ft Small was added to the shop 2026-07-24 (it already existed here,
     * unsellable, as a type-check placeholder) so a small farm has a sprayer it
     * can actually justify. */
    sprayer: Record<EquipmentSize, { price: number; widthFt: number }>;
    /** Rake implement (windrows harvested forage into rows): price + width in
     * feet. Same hitch rule as the plow. Sold in one size (25 ft). */
    rake: Record<EquipmentSize, { price: number; widthFt: number }>;
    /**
     * ROUND baler (`bailer` keeps its long-standing internal spelling). Picks up
     * a windrow and rolls it; runs after (or alongside) the rake.
     *
     * `widthFt` is 0 and unused (maintainer note, 2026-07-24: "the baler itself
     * does not have a working width"). A baler swallows a windrow, so the ground
     * it clears per pass is set by whatever LAID that windrow — the rake, or the
     * combine header on straw, which skips the rake. See `Field.windrowWidthM`.
     *
     * With width gone, the size tiers had nothing left to express, so there is
     * one of each baler at Medium. Shape is now the implement KIND rather than a
     * size tier, which is what lets both be Medium.
     */
    bailer: Record<EquipmentSize, { price: number; widthFt: number }>;
    /** SQUARE baler (2026-07-24). Same windrow-driven width as the round one;
     * its bales are the heavier, denser, better-stacking square products (see
     * `baleProducts`). Pricier for it. */
    squareBaler: Record<EquipmentSize, { price: number; widthFt: number }>;
    /**
     * BALE WRAPPER (2026-07-31, silage Phase 1): an inline film wrapper that
     * seals dropped ROUND bales into baleage in a second pass over the field.
     * Cheap — this is the low-capital route into silage.
     *
     * Width is 0 and unused for the same reason the baler's is: it works the
     * bale line the baler already laid down, so the ground cleared per pass is
     * set by the windrow, not the tool.
     */
    baleWrapper: Record<EquipmentSize, { price: number; widthFt: number }>;
    /**
     * COMBI BALER (2026-07-31): a baler-wrapper combination (real machines —
     * McHale Fusion, Kuhn i-BIO) that rolls AND seals in ONE pass, so a field
     * baled with it never needs the separate wrap task and can never miss the
     * same-month wrapping window. That guarantee is what the ~3x price over a
     * plain round baler + wrapper is really buying.
     */
    combiBaler: Record<EquipmentSize, { price: number; widthFt: number }>;
    /** Mower implement (2026-07-13): CUTS a perennial forage field (grass/
     * alfalfa) — the "harvest" for those crops, in place of the combine. Leaves
     * cut material to rake + bale. Three real sizes as of 2026-07-24
     * (15 / 25 / 32 ft); it used to be Small 10 / Medium 20 with Large a
     * duplicate placeholder, then briefly a 50 ft Large that no manufacturer
     * builds (corrected 2026-07-25). */
    mower: Record<EquipmentSize, { price: number; widthFt: number }>;
    /** Mulcher implement (2026-07-21): a flail/stalk shredder that chops annual
     * crop residue and works it back into the surface — an OPTIONAL post-harvest
     * pass that returns the field to stubble and boosts the next crop's yield.
     * Sold in three real sizes: Small 15 ft, Medium 25 ft, Large 35 ft. */
    mulcher: Record<EquipmentSize, { price: number; widthFt: number }>;
    /** Self-Propelled Windrower (maintainer request, 2026-07-24): a MACHINE,
     * not an implement — it drives itself, so it cuts a hay field with no
     * tractor tied up at all. That's the whole trade: it costs about as much as
     * a tractor plus a big mower, and in exchange your tractors stay free
     * through hay season. One size only (25 ft, and its own cutting speed —
     * see `work.windrowerSpeedKmh`), so unlike every other machine this isn't
     * keyed by `EquipmentSize`. */
    windrower: { price: number; widthFt: number };
    /** The combine is SIZED like a tractor (maintainer request, 2026-07-12):
     * each tier has its own hopper capacity — the combine fills as it cuts,
     * stops when full, and waits for a Grain Trailer (see `hauling` +
     * `sim/tasks.ts`).
     *
     * Its `widthFt` is NO LONGER the cutting width (2026-07-24): a combine now
     * needs a HEADER hitched, and the header's width is what drives the
     * coverage path. The number is kept as the size tier's nominal/reference
     * width — what a sensibly-matched header for that combine looks like. */
    harvester: Record<EquipmentSize, { price: number; widthFt: number; capacityBushels: number }>;
    /** Corn Header (maintainer decision, 2026-07-24): row units that strip cobs
     * off standing stalks. CORN ONLY — it physically cannot cut a small grain.
     * Sized in rows on a real machine (8/12/16-row at 30 in rows = 20/30/40 ft);
     * expressed here in feet like every other implement. A combine can carry a
     * header of its own class or smaller, same `canPull` rule as a tractor. */
    cornHeader: Record<EquipmentSize, { price: number; widthFt: number }>;
    /** Grain Header (2026-07-24): the cutter-bar/draper platform for everything
     * that ISN'T corn — soybeans, the small grains, canola, sunflowers. Wider
     * than a corn header at every tier (it's cutting a standing crop off at the
     * base, not pulling rows through row units) and cheaper per foot. */
    grainHeader: Record<EquipmentSize, { price: number; widthFt: number }>;
    /** Grain Trailer: hauls a full combine hopper to a silo. A normal
     * implement (one tractor hitch slot, like a plow) — `widthFt` is unused
     * (not a fieldwork tool) but kept so it shares the generic implement
     * config shape. `capacityBushels` caps how much one trip can carry; a
     * trailer smaller than the hopper just takes a partial load.
     *
     * Volume, not weight, since 2026-07-24 — see [[CropConfig.bushelWeightLbs]]. */
    grainTrailer: Record<EquipmentSize, { price: number; widthFt: number; capacityBushels: number }>;
    /**
     * SELF-PROPELLED FORAGE HARVESTER (2026-07-31, silage Phase 2) — the
     * chopper. Cuts a standing crop (or picks a wilted windrow up) and blows
     * the chopped material straight into a wagon running alongside.
     *
     * `capacityTons` is NOT a grain tank: a chopper has no tank at all, only
     * the spout. It's a deliberately tiny buffer (a couple of tons) so the
     * existing relay machinery — which already stops a harvester whose hopper
     * is full — expresses the real constraint the maintainer asked for: the
     * chopper cannot work without a trailer. It fills in seconds and stops.
     */
    forageHarvester: Record<EquipmentSize, { price: number; widthFt: number; capacityTons: number }>;
    /**
     * FORAGE WAGON (2026-07-31): the silage half of the relay — the chopper's
     * grain cart. Rated in TONS, and deliberately a bigger line than the grain
     * trailers (maintainer request): chopped forage is bulky and low-density,
     * so a silage rig moves far more tonnage per trip than a grain one.
     * `widthFt` unused, like every other trailer.
     */
    forageWagon: Record<EquipmentSize, { price: number; widthFt: number; capacityTons: number }>;
    /** ROW-CROP HEAD (2026-07-31): the chopper's corn head — takes the WHOLE
     * plant, stalk and all, which is what makes corn silage. Corn only. */
    rowCropHead: Record<EquipmentSize, { price: number; widthFt: number }>;
    /** PICKUP HEAD (2026-07-31): lifts a wilted windrow off the ground for
     * haylage, so grass/alfalfa still get mowed (and raked) first. Its width is
     * nominal — like the baler it follows the windrow that's already lying
     * there; see `taskSwathMeters`. */
    pickupHead: Record<EquipmentSize, { price: number; widthFt: number }>;
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
    /* REMOVED 2026-07-24: `cartSiloRunFraction`. A cart used to leave for the
     * silo once it was ≥75% full rather than waiting to fill. It now waits for
     * 100% (maintainer request) — with bushel capacities a cart is several
     * hoppers' worth, so leaving early threw away a quarter of every round trip
     * in the part of the season that's already the bottleneck. A part-full cart
     * still runs when the harvest ends; see `sim/tasks.ts`. */
    /** How many rigs may work one hauling job at once — grain carts servicing a
     * single combine, or bale haulers clearing a single field (maintainer
     * request, 2026-07-23). Crews are parallel TASKS rather than one task with
     * several machines on it, so each rig keeps its own independent brain; this
     * just caps how many get spawned, so a big fleet doesn't pile onto one
     * field and starve everything else. */
    maxCrewSize: number;
    /** How many Hay-Spikes rigs can feed one Bale Trailer at a time
     * (2026-08-13) — see `trailerSpikeCount`/`assignTrailerHelper`. */
    maxSpikesPerTrailer: number;
    /**
     * ON-THE-GO UNLOADING (maintainer request, 2026-07-24: "get the grain carts
     * to fill from the harvester while it is moving, like it does in real
     * life"). A cart is called out to meet the combine once its tank is this
     * full, and pulls alongside while it keeps CUTTING — the combine only stops
     * dead if it brims over before a cart reaches it.
     *
     * 0.85 leaves roughly a tank-and-a-half of cutting time for the cart to
     * cross the field, which is what stops the combine idling.
     */
    callCartAtFraction: number;
    /**
     * Send a WAITING cart on to the silo early if it's already this full
     * (2026-08-13). Distinct from the removed `cartSiloRunFraction` above —
     * that used to pull ANY cart off at 75%, active or not, which is exactly
     * what wasted a round trip's worth of capacity. This only applies to a
     * cart that's already staged/idle (not the one currently alongside the
     * combine): it isn't getting topped off any time soon anyway, so there's
     * nothing to lose by running it now instead of holding capacity hostage
     * at the gate.
     */
    cartReturnIdleFraction: number;
    /** How fast grain crosses from the combine's tank into the cart, tons per
     * sim-minute. Replaces the old fixed `loadMinutes` pause for GRAIN — a rate
     * is what makes an on-the-move transfer legible, since the pair stay
     * side-by-side for as long as it takes. (`loadMinutes` still times the bale
     * relay, which really is a stop-and-load.) */
    unloadTonsPerMinute: number;
    /** How fast a full cart empties into a silo or Sell Point, tons per
     * sim-minute (2026-07-25). The silo leg used to be a flat `dumpMinutes` —
     * 10 seconds to empty a 1500 bu cart, which handed the hauling loop a free
     * pass at exactly the end that's meant to be the harvest bottleneck. A cart
     * auger really does run 600–1000 bu/min, faster than the combine-limited
     * `unloadTonsPerMinute` above, so it gets its own rate. `dumpMinutes` still
     * times the BALE relay, which really is a stop-and-drop. */
    dumpTonsPerMinute: number;
    /** How close a cart has to be to the combine to count as "alongside" and
     * start moving grain, in meters. Not zero, because the target is moving:
     * the cart keeps station within this gap rather than chasing an exact
     * position it can never hold. */
    alongsideMeters: number;
    /** How far BEHIND the chopper a Forage Wagon aims to trail while onloading
     * silage (maintainer request, 2026-08-13 — "trail just behind... instead
     * of next to it"), meters. Grain carts are unaffected — they still run
     * alongside the combine; this only steers the silage relay's approach
     * point. `alongsideMeters` is reused as the arrival tolerance around this
     * offset point, same "gap, not an exact position" reasoning as above. */
    chopperTrailMeters: number;
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
    /** How long the wrapper pauses at each bale to seal it, in SIM-minutes
     * (2026-08-14, replacing `wrapSpeedKmh`: Wrap is a per-bale task now —
     * the tractor visits each unwrapped bale in turn, like Hay-Spikes
     * visiting each one to collect it — not a coverage-path pass). Driving
     * BETWEEN bales uses the shared `work.travelSpeedKmh`, same as
     * Hay-Spikes' collector leg. */
    wrapMinutesPerBale: number;
    /** Cost per acre to wrap: plastic film plus the pass. Real film runs
     * $5–7/bale, so ~$18/ac at baleage's ~2.7 bales/ac. */
    wrapCostPerAcre: number;
    /**
     * Monthly loss for WRAPPED bales, wherever they're stacked — this
     * overrides the store's own `spoilPctPerMonth` (see `tickBaleSpoilage`).
     * Sealed bales ferment rather than rot; real wrapped-baleage DM loss is
     * 2–5% over a whole storage season, so per month it rounds to almost
     * nothing. This number IS the feature: it's what the wrapper buys.
     */
    wrappedSpoilPctPerMonth: number;
    /** In-field speed of the chopping pass, km/h (2026-07-31). A forage
     * harvester runs fast — it's a continuous-flow machine with no tank to
     * stop and empty. */
    chopSpeedKmh: number;
    /** Cost per acre to chop: fuel, knives and the machine's hourly. The
     * priciest pass in the game — a chopper burns more than a combine, and
     * real custom chopping runs $120-160/ac including the haul. */
    chopCostPerAcre: number;
    /** Months a fresh-wrapped bale (or freshly chopped Corn Forage) sits
     * before it ages into its Aged Baleage/Corn Silage twin — see
     * `resolveAgedBaleProduct` (sim/farming.ts) and `tickSilageAging`
     * (sim/buildings.ts). */
    silageAgingMonths: number;
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
    color: "hay" | "alfalfa" | "wrapped";
    /** Weight of ONE bale of this product, tons. Round bales sit at
     * `forage.baleTons`; square bales are ~1.5x heavier, which is why fewer of
     * them come off an acre. Read through `baleTonsOf` (sim/farming.ts). */
    tonsPerBale: number;
    /** A square bale (2026-07-24) — drives the "Square" labelling and lets the
     * round/square pair of a product be told apart in the UI. */
    square?: boolean;
    /** WRAPPED in plastic — baleage (2026-07-31). Sealed bales ferment rather
     * than rot, so these ignore their store's spoil rate and use
     * `forage.wrappedSpoilPctPerMonth` wherever they're stacked. That immunity
     * is what the wrapper, the plastic and the extra pass are bought for. */
    wrapped?: boolean;
  }>;

  /**
   * CHOPPED SILAGE products (2026-07-31, Phases 2–3) — priced per TON as-fed,
   * the unit a bunker is filled and sold in.
   *
   * Like baleage these are anchored on DRY MATTER so they sit honestly beside
   * the dry-hay and grain ladders; see each entry for the arithmetic. Chopped
   * forage ensiles wetter than baleage (~40% DM against ~50%), so a ton of it
   * carries less feed and is worth correspondingly less.
   */
  silageProducts: Record<SilageProduct, {
    name: string;
    /** HUD/inventory icon. */
    emoji: string;
    /** Flat sale price, $/ton as-fed (same placeholder role as
     * `CropConfig.sellPricePerTon` — the real market replaces it later). */
    pricePerTon: number;
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
   * be delayed toward the seasonal price peak, and it's what makes combine
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
    /** Grain storage. Capacity is BUSHELS (2026-07-24), like the combine tank
     * and the grain cart — a bin is a fixed VOLUME, so it holds fewer TONS of a
     * light crop than a dense one. It was capped in tons until then, which had
     * it backwards: the same silo silently held 75% more oats by volume than
     * corn. Sizes are round real-world farm-bin numbers. */
    silo: Record<EquipmentSize, { price: number; capacityBushels: number }>;
    /**
     * Indoor bale storage — weatherproof, and as of 2026-07-25 that finally
     * MEANS something: `spoilPctPerMonth` is the fraction of the bales sitting
     * here that are lost each month to rot and dry-matter breakdown. Until then
     * the Barn and the Area were mechanically identical, so the game asked
     * players to pay $70k instead of $25k for no difference whatsoever.
     */
    baleBarn: { price: number; capacityBales: number; spoilPctPerMonth: number };
    /** Outdoor bale storage — cheaper per bale than the Barn, capped since
     * 2026-07-24 (it was unlimited from 2026-07-17), and it ROTS: bales stacked
     * on open ground wick moisture and weather from the top down. That loss is
     * what you're buying your way out of with a Barn. */
    baleArea: { price: number; capacityBales: number; spoilPctPerMonth: number };
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
    /**
     * SILAGE BUNKER (2026-07-31, Phase 2): a walled, packed pile of chopped
     * forage. Capacity in TONS — the unit a real bunker is spec'd in.
     *
     * Deliberately kept SIMPLE (maintainer decision): "treat it more like a
     * silo for now". No cover/seal state and no feed-out face, so it neither
     * spoils nor needs managing — it's storage, and the fermentation is
     * assumed. Those mechanics are the obvious later slice.
     *
     * Cheap per ton against a grain silo: it's concrete walls and a slab, not
     * a sealed steel bin with a fan and an auger.
     */
    silageBunker: Record<EquipmentSize, { price: number; capacityTons: number }>;
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
      bushelWeightLbs: 56, // the reference grain
      // Corn no longer bales (maintainer decision, 2026-07-23) — its residue is
      // mulched back in or plowed under. `cornStover` stays in `baleProducts`
      // below so stover already sitting in a save still prices and sells.
      //
      // SILAGE moved OFF this crop entirely (2026-08-12): it used to be an
      // in-season toggle on Corn (chop instead of combine, chosen at "ready").
      // That made timing awkward — real silage corn is cut noticeably wetter
      // and earlier than grain corn, weeks before this crop is even ready to
      // combine — and conflated two different decisions (what to plant vs.
      // what to do with it once ripe). See the `forage` crop below: the same
      // plant, but its own crop chosen at PLANTING, with its own earlier
      // `growMonths` and no combine route at all.
    },
    // FORAGE (2026-08-12): corn grown specifically to be chopped whole for
    // silage rather than combined for grain — a separate crop from Corn, not
    // a toggle on it. `growMonths` is a full month short of Corn's 4, because
    // silage corn is cut wetter and earlier than grain corn ever could be;
    // `producesGrain: false` is what makes this crop CHOP-ONLY — see
    // `isChopOnlyCrop` (sim/farming.ts), which every "Queue Harvest" gate
    // checks. Same `cornSilage` product/economics as the old corn-silage
    // route, so storage/market code needed zero changes.
    forage: {
      name: "Corn (Forage)",
      emoji: "🌽", // same icon as grain Corn — it's the same plant
      inputCostPerAcre: 240, // same seed/herbicide program as grain corn
      fertilizeCostPerAcre: 230,
      baseYieldTonsPerAcre: 0, // no grain route — see silageTonsPerAcre below
      yieldUncertainty: 0,
      plantMonths: [3, 4], // Apr–May, same window as Corn
      growMonths: 3, // ready the 1st of Jul if planted in Apr — a month before Corn
      sellPricePerTon: 0, // sold as cornSilage (gameConfig.silageProducts), not by the crop
      producesGrain: false,
      // 20 t/ac as-fed is the standard Corn-Belt figure (~7 t DM). At $55/t
      // that grosses ~$1,100/ac — chopping costs ~$130/ac against grain
      // corn's $40 harvest, but a month less growing time and no drydown risk
      // is the actual trade a player is making.
      silageProduct: "cornForage",
      silageTonsPerAcre: 20,
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
      bushelWeightLbs: 60, // dense — a load goes further than corn
    },
    // --- Six more annuals (maintainer request, 2026-07-22).
    //
    // REALISM PASS 2026-07-25: yields for the small grains and oilseeds were
    // running 20–45% over US averages while corn and soy sat spot-on, so each
    // was cut to a real figure and RE-PRICED (at the upper end of its real
    // market range) to hold the crop ladder's shape. Net per acre at base yield
    // and base price, after input+fert+plow($20)+weed($15)+harvest($40):
    //   corn ~$445 (unchanged — 200 bu/ac at $5.04/bu was already real)
    //   canola ~$265      — 48 bu/ac @ $23.9/cwt
    //   wheat ~$255 (+straw) — 80 bu/ac @ $7.35/bu; the winter slot, field busy Sep→Jun
    //   soy ~$230 (unchanged — 53 bu/ac at $11.70/bu)
    //   sunflowers ~$225  — 2000 lb/ac @ $26/cwt; ready Oct/Nov
    //   rye ~$210 (+straw) — 64 bu/ac @ $7.42/bu; the OTHER cover crop, cheaper
    //                        and hardier than wheat and off the field a month
    //                        earlier (May vs June), which buys room for a
    //                        double crop behind it.
    //   barley ~$210 (+straw) — 83 bu/ac @ $6.00/bu (malting)
    //   oats ~$175 (+straw)   — 106 bu/ac @ $3.84/bu; cheapest inputs, low ceiling
    //
    // The ORDER is nearly identical to the pre-pass ladder (soy and sunflowers
    // swap, and they're $5 apart) — but the spread compressed hard: corn now
    // leads the field by ~1.7x instead of ~1.2x. That IS what real Corn-Belt
    // economics look like; the levers if it flattens crop choice too much are
    // corn's price or its fertilizer bill.
    wheat: {
      name: "Winter Wheat",
      emoji: "🌾",
      inputCostPerAcre: 130, // cheap seed + a fall herbicide pass
      fertilizeCostPerAcre: 130, // spring N topdress + pass
      baseYieldTonsPerAcre: 2.4, // ~80 bu/ac (was 2.9 = ~97, over a real belt average)
      yieldUncertainty: 0.25, // overwinters established — steadier than spring crops
      plantMonths: [8, 9], // Sep–Oct (fall seeding)
      growMonths: 9, // Sep 1 + 9 → ready the 1st of Jun (overwinters)
      sellPricePerTon: 245, // $7.35/bu
      bushelWeightLbs: 60,
      producesForage: true, // wheat straw → rake + bale before re-plowing
      baleProduct: "straw",
      coverCrop: true,
    },
    rye: {
      name: "Cereal Rye",
      emoji: "🥖",
      inputCostPerAcre: 100, // cheap, forgiving seed — the classic cover crop
      fertilizeCostPerAcre: 90, // modest spring topdress; rye scavenges well
      baseYieldTonsPerAcre: 1.8, // ~64 bu/ac — solid hybrid rye (was 2.4 = 86, a record crop)
      yieldUncertainty: 0.22, // the hardiest overwinterer in the game
      plantMonths: [8, 9, 10], // Sep–Nov — a wider window than wheat's
      growMonths: 8, // Sep 1 + 8 -> ready the 1st of May, a month before wheat
      sellPricePerTon: 265, // $7.42/bu — rye is a thin, dear market, not a corn substitute
      bushelWeightLbs: 56,
      producesForage: true, // rye straw
      baleProduct: "straw",
      coverCrop: true,
    },
    oats: {
      name: "Oats",
      emoji: "🥣",
      inputCostPerAcre: 90, // cheapest seed going
      fertilizeCostPerAcre: 70, // light N — oats lodge if pushed hard
      baseYieldTonsPerAcre: 1.7, // ~106 bu/ac (32 lb bushels; was 2.3 = 144, well over average)
      yieldUncertainty: 0.3,
      plantMonths: [2, 3, 4], // Mar–May — a month wider than the other springs (2026-07-24)
      growMonths: 4, // ready the 1st of Jul/Aug/Sep
      harvestWindowMonths: 3, // dries down and stands; a month longer than the default
      sellPricePerTon: 240, // $3.84/bu — the old $165 was $2.64, below any real market
      bushelWeightLbs: 32, // lightest grain in the game — bulky per ton
      producesForage: true,
      baleProduct: "straw",
    },
    barley: {
      name: "Barley",
      emoji: "🍺",
      inputCostPerAcre: 110,
      fertilizeCostPerAcre: 105,
      baseYieldTonsPerAcre: 2.0, // ~83 bu/ac (was 2.5 = 104, a top-end crop as the average)
      yieldUncertainty: 0.3,
      plantMonths: [2, 3, 4], // Mar–May (2026-07-24)
      growMonths: 4, // ready the 1st of Jul/Aug/Sep
      harvestWindowMonths: 3,
      sellPricePerTon: 250, // $6.00/bu — malting, not feed
      bushelWeightLbs: 48,
      producesForage: true,
      baleProduct: "straw",
    },
    canola: {
      name: "Canola",
      emoji: "🌼",
      inputCostPerAcre: 165, // hybrid seed is pricey (~$70/ac) + herbicide
      fertilizeCostPerAcre: 130, // heavy N + sulfur
      baseYieldTonsPerAcre: 1.2, // ~48 bu/ac (was 1.5 = 60, above real ND yields)
      yieldUncertainty: 0.35, // touchy at flowering — heat snaps hurt
      plantMonths: [3, 4], // Apr–May
      growMonths: 4, // ready the 1st of Aug/Sep
      sellPricePerTon: 530, // $23.9/cwt — top of the real range; canola simply
      // nets less per acre than corn, and no realistic price closes that gap
      bushelWeightLbs: 50,
    },
    sunflowers: {
      name: "Sunflowers",
      emoji: "🌻",
      inputCostPerAcre: 135,
      fertilizeCostPerAcre: 85, // deep taproot scavenges leftover N
      baseYieldTonsPerAcre: 1.0, // 2000 lb/ac (was 1.2 = 2400, a very good crop)
      yieldUncertainty: 0.35,
      plantMonths: [4, 5], // May–Jun
      growMonths: 5, // ready the 1st of Oct/Nov — straight into storage, since
      // the seasonal peak moved to July (2026-07-25); it no longer sells off the
      // combine into a rising market
      sellPricePerTon: 520, // $26/cwt
      bushelWeightLbs: 28, // half of corn — twice the cart trips per ton
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
      // Wrap/silage-chop moved off this crop entirely (2026-08-13) — see
      // `grassSilage` below. A plain Grass field only ever makes dry hay now.
    },
    // Grass/Alfalfa Silage (2026-08-13): the same stand, same timing, as
    // grass/alfalfa — the only difference is the crop is committed at planting
    // to being WRAPPED (baleage) instead of dry hay, rather than an in-season
    // toggle. See `producesWrappedBale`, `balerKindFor` (sim/tasks.ts, prefers
    // a Combi Baler for these crops), and `wrapPending`/the Wrap task (queued
    // automatically when a plain baler was used instead).
    grassSilage: {
      name: "Grass (Silage)",
      emoji: "🌿",
      inputCostPerAcre: 100,
      fertilizeCostPerAcre: 110,
      baseYieldTonsPerAcre: 0,
      yieldUncertainty: 0,
      plantMonths: [2],
      growMonths: 2,
      sellPricePerTon: 0,
      producesForage: true,
      producesGrain: false,
      perennial: true,
      harvestMonths: [4, 6, 8],
      fertilizeMonth: 3,
      // Shares plain Grass's "hay" id again (2026-08-15 — briefly had its own
      // "grassRoundbaleUnwrapped" id 2026-08-14, cut in the product-list
      // cleanup; see the BaleProduct union's comment for why that was safe).
      baleProduct: "hay",
      producesWrappedBale: true,
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
      // Wrap/silage-chop moved off this crop entirely (2026-08-13) — see
      // `alfalfaSilage` below.
    },
    alfalfaSilage: {
      name: "Alfalfa (Silage)",
      emoji: "☘️",
      inputCostPerAcre: 160,
      fertilizeCostPerAcre: 90,
      baseYieldTonsPerAcre: 0,
      yieldUncertainty: 0,
      plantMonths: [2],
      growMonths: 2,
      sellPricePerTon: 0,
      producesForage: true,
      producesGrain: false,
      perennial: true,
      harvestMonths: [4, 6, 8],
      fertilizeMonth: 3,
      // Shares plain Alfalfa's "alfalfaHay" id again (2026-08-15) — see
      // grassSilage's identical comment above.
      baleProduct: "alfalfaHay",
      producesWrappedBale: true,
    },
  },

  plowCostPerAcre: 20,
  weedSeasonMonths: [2, 3, 4, 5, 6, 7], // Mar–Aug (spring + summer)
  weedCostPerAcre: 15,
  mowCostPerAcre: 12,
  mulchCostPerAcre: 13, // real stalk-chopping custom rate is $12–15/ac (was $8)
  harvestCostPerAcre: 40, // real combine custom rate ~$40/ac (was $30)
  // Cut to real 2026-07-25: measured yield response to residue incorporation is
  // near-zero to +3%, and often NEGATIVE in cold soils. It was +7%/+3%, which
  // made mulching a no-brainer rather than a marginal call.
  mulchBonusPct: 0.03,
  mulchBonusBaledPct: 0.01,
  work: {
    // Slower than road travel: a working pass is deliberate. Tuned so a medium
    // (10 ft) plow on a ~30-acre field takes a few sim-hours — in the ballpark
    // of the old flat rate, now emerging from width × field size.
    fieldSpeedKmh: 12,
    harvestSpeedKmh: 7,
    plowSpeedKmh: 7,
    windrowerSpeedKmh: 24.1, // 15 mph (maintainer request, 2026-08-15)
    travelSpeedKmh: 22,
  },
  equipment: {
    tractor: {
      small: { price: 150_000 },
      medium: { price: 250_000 },
      large: { price: 400_000 },
    },
    // Tillage and planting were the biggest realism gap in the file until
    // 2026-07-25: at 5/10/20 ft a Large plow covered 10.5 ac/h against the Large
    // combine's 21, so the farm TILLED HALF AS FAST AS IT HARVESTED — backwards.
    // In reality tillage and planting outrun harvest 2–3x, which is exactly why
    // they compress into a narrow spring window. Widths are real implements now
    // (disk/field cultivator; 6/12/16-row planters on 30 in rows) and the
    // planter got far dearer to match — a 16-row planter really is $250k+.
    plow: {
      small: { price: 35_000, widthFt: 15 },
      medium: { price: 70_000, widthFt: 30 },
      large: { price: 130_000, widthFt: 50 },
    },
    planter: {
      small: { price: 60_000, widthFt: 15 },
      medium: { price: 150_000, widthFt: 30 },
      large: { price: 250_000, widthFt: 40 },
    },
    sprayer: {
      small: { price: 50_000, widthFt: 30 },
      medium: { price: 100_000, widthFt: 60 },
      // 90 ft, not 120 (2026-07-25): a 120 ft boom is a self-propelled machine
      // at $450–600k, not a $200k tractor implement. 90 ft is the widest that's
      // honestly trailed.
      large: { price: 200_000, widthFt: 90 },
    },
    // Rake — three real sizes (maintainer spec, 2026-07-24). A wheel/rotary rake
    // is cheap per foot: it has no crop-processing guts, it just moves cut
    // forage sideways, so the big ones are still far cheaper than a baler.
    rake: {
      small: { price: 30_000, widthFt: 15 },
      medium: { price: 55_000, widthFt: 30 },
      large: { price: 90_000, widthFt: 50 },
    },
    // Balers: one of each shape, both Medium, both zero-width (the windrow sets
    // the width). The three size slots exist only because IMPLEMENT_CONFIG is a
    // Record over EquipmentSize; only Medium is ever sold or built.
    // Repriced to real new-machine money 2026-07-25 (was $130k / $260k, which
    // put a round baler above a Large mower AND a Large rake combined —
    // inverting the real order).
    bailer: {
      small: { price: 70_000, widthFt: 0 },
      medium: { price: 70_000, widthFt: 0 },
      large: { price: 70_000, widthFt: 0 },
    },
    // One size each, like the balers — a wrapper has no working width to tier.
    baleWrapper: {
      small: { price: 30_000, widthFt: 0 },
      medium: { price: 30_000, widthFt: 0 },
      large: { price: 30_000, widthFt: 0 },
    },
    combiBaler: {
      small: { price: 215_000, widthFt: 0 },
      medium: { price: 215_000, widthFt: 0 },
      large: { price: 215_000, widthFt: 0 },
    },
    squareBaler: {
      small: { price: 180_000, widthFt: 0 },
      medium: { price: 180_000, widthFt: 0 },
      large: { price: 180_000, widthFt: 0 },
    },
    // Mower — three real sizes, all sold (maintainer spec, 2026-07-24). Large
    // was 50 ft until 2026-07-25; the widest real triple mower-conditioner is
    // ~32 ft, and at 50 it was cutting 45 ac/h against a real 31.
    mower: {
      small: { price: 35_000, widthFt: 15 },
      medium: { price: 70_000, widthFt: 25 },
      large: { price: 120_000, widthFt: 32 },
    },
    // Mulcher — three real sizes, all sold (maintainer pricing, 2026-07-21).
    mulcher: {
      small: { price: 20_000, widthFt: 15 },
      medium: { price: 40_000, widthFt: 25 },
      large: { price: 75_000, widthFt: 35 },
    },
    // Headers. A combine needs the RIGHT one hitched: corn header for corn,
    // grain header for everything else. Real American sizes — corn headers
    // 8/12/16-row on 30 in rows; grain platforms 25/35/45 ft.
    cornHeader: {
      small: { price: 70_000, widthFt: 20 },
      medium: { price: 110_000, widthFt: 30 },
      large: { price: 165_000, widthFt: 40 },
    },
    grainHeader: {
      small: { price: 55_000, widthFt: 25 },
      medium: { price: 85_000, widthFt: 35 },
      large: { price: 130_000, widthFt: 45 },
    },
    // Self-propelled windrower — one 25 ft machine (maintainer call, 2026-07-25;
    // was 40 ft at $320k). A real SP hay windrower runs a 16–18 ft rotary disc
    // header, so 40 ft was pure fantasy — but a strictly-narrower machine would
    // have nothing left to sell, since its whole pitch is freeing a tractor. 25
    // ft plus its own `work.windrowerSpeedKmh` (16 vs the tractor's 12) is the
    // compromise: 30.1 ac/h against a Large mower's 28.9 and a Medium's 22.6 —
    // a dead heat with the best tractor rig, so buying one is a question about
    // tractor time rather than raw throughput.
    windrower: { price: 270_000, widthFt: 25 },
    // Hopper/cart sizes are BUSHELS as of 2026-07-24 — real American numbers,
    // and a deliberate rebalance the maintainer signed off on ("let it bite").
    // A Medium combine used to hold a flat 50 t; it now holds 350 bu, which is
    // under 10 t of corn. Hauling is meant to be the bottleneck of harvest
    // season, the way it is on a real farm.
    harvester: {
      small: { price: 350_000, widthFt: 20, capacityBushels: 250 },
      medium: { price: 450_000, widthFt: 30, capacityBushels: 350 },
      large: { price: 600_000, widthFt: 40, capacityBushels: 500 },
    },
    grainTrailer: {
      // A 400 bu gravity wagon — deliberately SMALLER than the largest combine
      // tank (500 bu), so "the cart can't take a whole hopper in one go" stays
      // a real situation the hauling code has to handle.
      small: { price: 25_000, widthFt: 0, capacityBushels: 400 },
      medium: { price: 45_000, widthFt: 0, capacityBushels: 1000 },
      large: { price: 70_000, widthFt: 0, capacityBushels: 1500 },
    },
    // Real SPFH money — these are the most expensive machines in the game, and
    // they should be: a chopper only earns its keep on serious forage acres.
    // Widths are the HEAD's job (see rowCropHead/pickupHead); the width here is
    // only the fallback for a head-less chop, same as the combine's.
    // Flat 5t buffer at every size (2026-08-14, was 1.5/2/2.5 tiered) — a
    // small invisible cushion, not a real tank: it just means the chopper
    // doesn't stall dead the instant a wagon's briefly out of position,
    // giving the relay a little slack for logistics instead of a hard stop.
    forageHarvester: {
      small: { price: 420_000, widthFt: 15, capacityTons: 5 },
      medium: { price: 600_000, widthFt: 20, capacityTons: 5 },
      large: { price: 850_000, widthFt: 25, capacityTons: 5 },
    },
    // Bigger than the grain line at EVERY tier, in tons (maintainer request:
    // "a line of forage trailers with larger capacity"). The grain trailers
    // carry 10 / 25 / 38 t of corn, so these sit clearly above them — which
    // matters more here than it does for grain, because the chopper STOPS
    // whenever no wagon is taking material. Capacity is how long it keeps
    // cutting between wagons, i.e. the whole tempo of a silage harvest.
    // Doubled again 2026-08-14 (maintainer request).
    forageWagon: {
      small: { price: 40_000, widthFt: 0, capacityTons: 36 },
      medium: { price: 70_000, widthFt: 0, capacityTons: 64 },
      large: { price: 105_000, widthFt: 0, capacityTons: 96 },
    },
    // A chopper's corn head is narrower than a combine's (it's pulling whole
    // plants through, not stripping cobs) and dearer per foot.
    rowCropHead: {
      small: { price: 45_000, widthFt: 10 },
      medium: { price: 75_000, widthFt: 15 },
      large: { price: 110_000, widthFt: 20 },
    },
    // One size, like the balers — a pickup head follows the windrow, so there
    // is no width tier to express.
    pickupHead: {
      small: { price: 32_000, widthFt: 0 },
      medium: { price: 32_000, widthFt: 0 },
      large: { price: 32_000, widthFt: 0 },
    },
    // Hay Spike — cheap, low-capacity in-field bale collector. Single
    // SHOP tier now (2026-08-14, maintainer request) — sold as just
    // "Hay Spike" (was "Hay Spikes" with a Small/Medium choice), and
    // pullable by Small or Medium tractors, but NOT Large (see `canPull`'s
    // `haySpikes` special case, sim/tasks.ts: a bale spear is a light
    // errand, not what a large 4WD unit is bought for — a deliberate
    // exception to the usual "bigger tractor can always do what a smaller
    // one can" size rule). The `small` slot is UNCHANGED and no longer
    // purchasable — kept exactly as it was so existing 1-bale-per-trip relay
    // tests keep meaning what they say — same "kept for the record type,
    // not sold" convention the `large` slot already used.
    // Repriced 2026-07-25: a bale spear is a steel fork, not a machine. Real
    // money is $500–2000 for a single and $5–10k for a 2-bale hydraulic
    // handler; $8k/$16k had it costing more than a third of a Bale Trailer.
    haySpikes: {
      small: { price: 3_000, widthFt: 0, capacityBales: 1 },
      medium: { price: 6_000, widthFt: 0, capacityBales: 2 },
      large: { price: 6_000, widthFt: 0, capacityBales: 2 },
    },
    // Bale Trailer — the bulk hauler. Small 10 / Medium 20 / Large 30 bales
    // (Large added 2026-07-24).
    baleTrailer: {
      small: { price: 20_000, widthFt: 0, capacityBales: 10 },
      medium: { price: 38_000, widthFt: 0, capacityBales: 20 },
      large: { price: 55_000, widthFt: 0, capacityBales: 30 },
    },
  },
  hauling: {
    loadMinutes: 0.17, // ≈ 10 s at 1× — bale relay only; grain uses a rate now
    dumpMinutes: 0.17,
    maxCrewSize: 3,
    // Earlier call-out (2026-08-13, was 0.85) — gets the cart alongside with
    // more cutting time still ahead of it, so the pair spend longer working
    // together before the combine could ever brim over.
    callCartAtFraction: 0.75,
    cartReturnIdleFraction: 0.8,
    // How many Hay-Spikes rigs can feed ONE Bale Trailer on the same field
    // before a fresh rig needs its own (2026-08-13). Real capacity — the
    // trailer's own `capacityBales` — still gates how much it can hold at
    // once; this just caps the CREW size sharing it.
    maxSpikesPerTrailer: 2,
    // Combine-limited: a real combine unloads 3.5–6 bu/sec, so ~320 bu/min of
    // corn. Was 14 (≈500 bu/min), quicker than the machine doing the emptying.
    unloadTonsPerMinute: 9,
    // ~700 bu/min of corn — a real grain-cart auger. A 1500 bu cart takes ~2.1
    // sim-minutes to empty, against the 10 seconds it used to take.
    dumpTonsPerMinute: 20,
    alongsideMeters: 15,
    // Bigger than alongsideMeters so the tolerance band around it never
    // overlaps "beside" — the wagon's acceptable range ends up ~5-35m behind.
    chopperTrailMeters: 20,
  },
  forage: {
    rakeSpeedKmh: 24.1, // 15 mph (maintainer request, 2026-08-14) — still faster than the baler
    baleSpeedKmh: 16.1, // 10 mph (maintainer request, 2026-08-14) — still slower than the rake
    rakeCostPerAcre: 6,
    baleCostPerAcre: 14, // real round-baling custom rate $14–18/ac (was $10)
    // 2026-07-25: a round bale is 0.75 t, not 1 t — a real 5x6 of dry hay runs
    // 1200–1600 lb. Bales PER ACRE went up to match so the tonnage off an acre
    // is unchanged (2.5 t/ac of corn stover here, as before).
    balesPerAcre: 3.33,
    baleTons: 0.75,
    balePricePerBale: 38, // ~$50/t, unchanged in per-TON terms
    baleTieMinutes: 0.17, // ≈ 10 s at 1×
    baleFillVariance: 0.3, // each bale fills at 70–130% of a nominal bale
    wrapMinutesPerBale: 0.66, // ≈ 40 s at 1× (doubled, maintainer request, 2026-08-14 — was 0.33/≈20s)
    wrapCostPerAcre: 18, // plastic film (~$9/bale at ~2.0 bales/ac, 2026-08-15 — same bale count as the dry route now) + the pass
    // 0.2%/mo ≈ 1.2% over a six-month storage season, inside the real 2–5%.
    // Against the Bale Area's 2.5%/mo this is the whole reason to wrap.
    wrappedSpoilPctPerMonth: 0.002,
    chopSpeedKmh: 9, // continuous-flow: no tank to stop and empty
    chopCostPerAcre: 130, // real custom chopping $120-160/ac incl. haul
    // How long a wrapped bale keeps its crop-specific identity before it's
    // just "silage" (2026-08-13) — see `resolveAgedBaleProduct`. Tunable;
    // picked as a plausible "long enough nobody remembers what it was"
    // window rather than researched like the rest of this block.
    silageAgingMonths: 2,
  },
  // ═══════════════════════════════════════════════════════════════════════
  // BALE PRODUCTS — full repricing pass, 2026-08-15 (maintainer request:
  // "review all the current bale products for balance... use real world
  // market data"). Replaces the DM-content/field-loss modeling the previous
  // passes used with four maintainer rules, checked against USDA/extension
  // market data (hay/alfalfa/straw/baleage/corn-silage pricing, real round
  // vs. square bale weights):
  //
  //   1. Square bales sell at the SAME price per TON as round — real hay
  //      markets price by tonnage/quality, not bale shape (confirmed: no
  //      clean per-ton round-vs-square premium in the USDA data). Square is
  //      1.6x the round bale's WEIGHT (2026-08-15, up from 1.2x) — real
  //      large square balers (4x4x8) commonly run up to that much heavier
  //      than a round bale of the same crop.
  //   2. Grass Silage, Alfalfa Silage, and Corn Silage are priced
  //      independently — no averaging across crops (the old generic
  //      "silageBale" merged grass+alfalfa into one bucket; that's gone).
  //   3. Silage/baleage is ALWAYS priced above the dry form it came from —
  //      a "finished, ready-to-feed, no spoilage risk" premium rather than
  //      the dry-matter-content discount a strict water-weight comparison
  //      would give it. Real markets support pricing it either way
  //      depending what's being compared (DM-adjusted, wetter is cheaper;
  //      per ton of finished feed product, haylage/baleage often prices
  //      above hay) — this game deliberately takes the second reading.
  //      +15% dry→fresh-wrapped, +10% fresh-wrapped→aged (compounds to
  //      +26.5% dry→aged).
  //   4. A crop's dry and wrapped routes make the SAME bale COUNT per acre
  //      — confirmed the sim never actually used the old wrapped-bale
  //      "+8%, avoids field loss" bonus for real bale counts (it only fed a
  //      cosmetic Market-tab stat that didn't match what happened in the
  //      field), so it's gone. `balesPerAcre` is identical across a crop's
  //      dry/fresh-wrapped/aged bales of the same SHAPE now.
  //
  // Anchors (Nov 2024 USDA Agricultural Prices, hay/forage extension
  // pricing guides): grass "other" hay ~$147-150/t, alfalfa hay ~$165-235/t
  // depending on quality (average-to-premium dairy), straw ~$52/t including
  // baling cost, corn stover $50-60/t delivered. Hay markets are genuinely
  // volatile year to year (national alfalfa avg fell 43% from 2023 to
  // 2024) — these are a reasonable point-in-time anchor, not a promise.
  baleProducts: {
    // LEGACY (2026-07-23): corn no longer produces forage, so no new stover is
    // ever made. Kept so bales already in a save keep a name, price and tint.
    // $50.67/t is already inside the real $50-60/t delivered range —
    // unchanged by this pass.
    cornStover: { name: "Corn Stover", pricePerBale: 38, balesPerAcre: 3.33, color: "hay", tonsPerBale: 0.75 },
    // Grass hay: $150/t (real "other hay" average, Nov 2024) x 0.75 t/bale.
    // 1.5 t/ac/cutting, unchanged.
    hay: { name: "Round Grass Bale", pricePerBale: 113, balesPerAcre: 2.0, color: "hay", tonsPerBale: 0.75 },
    // Alfalfa hay: $200/t (between the real "average" ~$170-180 forecast and
    // "premium/dairy" ~$235 quote — good-not-elite quality) x 0.75 t/bale —
    // works out to the SAME $150 round-bale price as before this pass, pure
    // coincidence of the new anchor. 1.36 t/ac/cutting, unchanged.
    alfalfaHay: { name: "Round Alfalfa Bale", pricePerBale: 150, balesPerAcre: 1.81, color: "alfalfa", tonsPerBale: 0.75 },
    // Small-grain straw — bedding, not fodder: $60/t (real ~$52/t incl.
    // baling cost — kept at the prior anchor, already close) x 0.75 t/bale.
    // 1.35 t/ac, unchanged.
    straw: { name: "Straw", pricePerBale: 45, balesPerAcre: 1.8, color: "hay", tonsPerBale: 0.75 },
    // --- SQUARE variants. Same $/ton as round (rule 1) — 1.6x the WEIGHT,
    // so 1/1.6 the bales per acre for the same tonnage off the same ground.
    // The Square Baler is the only way to make them.
    haySquare: { name: "Square Grass Bale", pricePerBale: 180, balesPerAcre: 1.25, color: "hay", tonsPerBale: 1.2, square: true },
    alfalfaHaySquare: { name: "Square Alfalfa Bale", pricePerBale: 240, balesPerAcre: 1.13, color: "alfalfa", tonsPerBale: 1.2, square: true },
    strawSquare: { name: "Straw (Square)", pricePerBale: 72, balesPerAcre: 1.13, color: "hay", tonsPerBale: 1.2, square: true },
    // --- BALEAGE (wrapped bales). Only Grass/Alfalfa make it (straw is dry
    // residue, nothing to ferment) — see `BALEAGE_OF`, sim/farming.ts.
    // +15% over the dry twin's $/ton (rule 3); SAME balesPerAcre as the dry
    // twin of the same shape (rule 4 — same bales, just sealed instead of
    // dried).
    //   grass:   $150/t x1.15 = $172.50/t  ->  round $173, square $276
    //   alfalfa: $200/t x1.15 = $230.00/t  ->  round $230, square $368
    hayBaleage: { name: "Round Grass Bale (Baleage)", pricePerBale: 173, balesPerAcre: 2.0, color: "wrapped", tonsPerBale: 1.0, wrapped: true },
    alfalfaBaleage: { name: "Round Alfalfa Bale (Baleage)", pricePerBale: 230, balesPerAcre: 1.81, color: "wrapped", tonsPerBale: 1.0, wrapped: true },
    haySquareBaleage: { name: "Square Grass Bale (Baleage)", pricePerBale: 276, balesPerAcre: 1.25, color: "wrapped", tonsPerBale: 1.6, square: true, wrapped: true },
    alfalfaHaySquareBaleage: { name: "Square Alfalfa Bale (Baleage)", pricePerBale: 368, balesPerAcre: 1.13, color: "wrapped", tonsPerBale: 1.6, square: true, wrapped: true },
    // --- AGED BALEAGE (2026-08-15, replacing the old crop-agnostic
    // "silageBale"/"silageBaleSquare"): what baleage becomes after sitting
    // wrapped for `forage.silageAgingMonths` — see `resolveAgedBaleProduct`,
    // sim/farming.ts. Keeps crop identity now (rule 2). +10% over the
    // crop's OWN fresh baleage (rule 3, compounding with the +15% above to
    // +26.5% over dry); same balesPerAcre as the rest of the family (rule 4).
    //   grass:   $172.50/t x1.10 = $189.75/t  ->  round $190, square $304
    //   alfalfa: $230.00/t x1.10 = $253.00/t  ->  round $253, square $405
    hayBaleageAged: { name: "Round Grass Bale (Aged Baleage)", pricePerBale: 190, balesPerAcre: 2.0, color: "wrapped", tonsPerBale: 1.0, wrapped: true },
    alfalfaBaleageAged: { name: "Round Alfalfa Bale (Aged Baleage)", pricePerBale: 253, balesPerAcre: 1.81, color: "wrapped", tonsPerBale: 1.0, wrapped: true },
    haySquareBaleageAged: { name: "Square Grass Bale (Aged Baleage)", pricePerBale: 304, balesPerAcre: 1.25, color: "wrapped", tonsPerBale: 1.6, square: true, wrapped: true },
    alfalfaHaySquareBaleageAged: { name: "Square Alfalfa Bale (Aged Baleage)", pricePerBale: 405, balesPerAcre: 1.13, color: "wrapped", tonsPerBale: 1.6, square: true, wrapped: true },
  },

  // Chopped bunker silage. Corn Forage is the ONLY crop that ever chops into
  // a bunker (2026-08-15 — confirmed via `crops[x].silageProduct`; nothing
  // else has had a route onto a field since the 2026-08-13 Silage rework),
  // so this is just its two aging stages, not a crop-comparison table:
  //   cornForage (fresh chopped) -> forage.silageAgingMonths -> cornSilage (cured)
  // Renamed from "cornSilage"/"silage" in the same pass (those ids had the
  // relationship backwards from their own display names). $50/t fresh is
  // inside the real $43-53/t standing-to-delivered range (2024 estimates);
  // $55/t cured is +10% (rule 3 — silage always priced above what it aged
  // from — same +10% step the bale side's aging uses).
  silageProducts: {
    cornForage: { name: "Corn Forage", emoji: "🌽", pricePerTon: 50 },
    cornSilage: { name: "Corn Silage", emoji: "🌽", pricePerTon: 55 },
  },
  buildings: {
    silo: {
      // Priced at real installed rates (2026-07-24) — roughly $3.50/bu at
      // 10,000 falling to $2.70/bu at 50,000, the usual bulk curve as fixed
      // costs (foundation, fan, unload auger) spread over more grain. They used
      // to run $9.00/$8.00/$7.00 per bushel, ~2.6x real and the only thing in
      // the game priced away from reality.
      small: { price: 35_000, capacityBushels: 10_000 },
      medium: { price: 75_000, capacityBushels: 25_000 },
      large: { price: 135_000, capacityBushels: 50_000 },
    },
    // Real stored-hay dry-matter loss over a ~6-month storage season is 2–5%
    // under cover and 5–20% out in the weather. Expressed per month: 0.5% vs
    // 2.5%, so a bale left outside all winter loses ~14% and the same bale in
    // the Barn loses ~3%.
    baleBarn: { price: 70_000, capacityBales: 300, spoilPctPerMonth: 0.005 },
    // Outdoor bale storage — cheaper than the Barn, and now CAPPED like it
    // (maintainer request, 2026-07-24, replacing the unlimited capacity it had
    // from 2026-07-17). A real number here is what makes the Sell Point
    // fallback reachable: a hauler with nowhere to put its load sells it.
    baleArea: { price: 25_000, capacityBales: 1000, spoilPctPerMonth: 0.025 },
    tractorBarn: { price: 60_000, slots: 3 },
    implementBarn: { price: 40_000, slots: 4 },
    farmYard: { price: 15_000 },
    // Free (2026-07-23): the Sell task makes this the farm.s route to full
    // seasonal price, so gating it behind a purchase would just tax the
    // mechanic the player is meant to be choosing between.
    sellPoint: { price: 0 },
    // ~$20-25/ton of capacity — concrete walls and a slab. A grain silo runs
    // $2.70-3.50 per BUSHEL, roughly $100/ton of corn, so bulk forage storage
    // being far cheaper per ton is right.
    // Doubled 2026-08-14 (maintainer request).
    silageBunker: {
      small: { price: 30_000, capacityTons: 2_400 },
      medium: { price: 55_000, capacityTons: 5_000 },
      large: { price: 95_000, capacityTons: 10_000 },
    },
  },
  yieldRangeNarrowing: 0.85,
  rotationBonusPct: 0.1,
  market: {
    // Re-anchored to REAL grain seasonality 2026-07-25 (was December, +25%).
    //
    // Cash corn and beans bottom at harvest and peak the following early
    // SUMMER, as old-crop supply tightens ahead of the new one — the December
    // peak had the curve topping out six weeks after the combines stopped,
    // which rewarded exactly the marketing nobody does. The premium is +12%
    // too, not +25%: real Oct→Jun carry is 8–15%.
    //
    // The gameplay consequence is deliberate and good: autumn grain now has to
    // be STORED across the winter to catch the peak, which is what makes a silo
    // worth building instead of a formality. Hay peaks Feb–Mar in reality, but
    // one shared curve is a standing design choice.
    peakMonth: 6, // July
    seasonalBonusByDistance: { 0: 0.12, 1: 0.08, 2: 0.04 },
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
