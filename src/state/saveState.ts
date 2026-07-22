/**
 * PILLAR 4 — The Save-State Shape (brief §4).
 *
 * The backbone everything reads/writes: parcels, field status, agents, money,
 * clock, contracts. Defined early and deliberately so systems built later slot
 * into a stable shape rather than reshaping the save each slice. Persisted to
 * IndexedDB (brief §2).
 *
 * All positions/geometry are stored in UTM meters (the internal metric space,
 * brief §3) — never lng/lat.
 *
 * These are intentionally thin during the data spike; fields fill in as each
 * system comes online. Adding fields is fine; renaming/repurposing is a big deal.
 */

import type { Meters } from "../geo/coords";
import type { SimTime } from "../sim/clock";
import { gameConfig } from "../config/gameConfig";
import type { CropId, EquipmentSize, BaleProduct } from "../config/gameConfig";

/** Field lifecycle (brief §10). */
export type FieldStatus =
  | "stubble"
  | "tilled"
  | "planted"
  | "growing"
  | "ready"
  | "harvested"
  /** Raked + baled: clean, organized surface, bales sitting in the field. Set
   * when a baler finishes; re-plowable in the winter window. */
  | "mulched";

export interface Parcel {
  id: string;
  /** Polygon boundary in UTM meters. */
  boundary: Meters[];
  owned: boolean;
}

/** One year of a field's rotation plan (maintainer design, 2026-07-12). Picks the
 * crop for that campaign year and toggles which optional operations to fold into
 * the auto-managed lifecycle; the game schedules each at its natural window. The
 * mandatory cycle (plow → plant → harvest) is always run. */
export interface FieldPlan {
  crop: CropId;
  /** Fold a weeding pass in (once, when the weeding window opens). */
  weed?: boolean;
  /** Fold a fertilizing pass in (once, the month after planting). */
  fertilize?: boolean;
  /** Fold a mulching pass in (once, the month after harvest, before plowing).
   * Annual crops whose residue wasn't baled only — shreds the residue back in
   * and boosts the next crop's yield. Ignored on perennials / baled fields. */
  mulch?: boolean;
  /** Rake + bale the residue after harvest (forage crops only) instead of plowing
   * it under. */
  bale?: boolean;
  /** Field Schedule tab (maintainer request, 2026-07-21): player-chosen month
   * (0-11) overriding when auto-manage queues this step, for tasks that have
   * more than one legal month. plow/plant/weed/fertilize: a full override —
   * can be moved to any of the task's real legal months. harvest: DELAY-ONLY
   * — auto-manage still never harvests before growth completes; an override
   * here just makes it wait for the chosen month instead of harvesting the
   * instant it's ready. Undefined = today's behavior (earliest legal month /
   * instant-on-ready). Mow/rake/bale have no entry here — see
   * `sim/schedule.ts`'s `legalMonthsFor` doc comment for why. Only ever
   * consulted by `autoManageField`; manual View-tab queue buttons are never
   * restricted by it. Always re-validated against the live legal-month set
   * before being honored, so a stale override from an edited crop can never
   * silently misfire. */
  schedule?: Partial<Record<"plow" | "plant" | "weed" | "fertilize" | "mulch" | "harvest", number>>;
}

export interface Field {
  id: string;
  parcelId: string;
  boundary: Meters[];
  status: FieldStatus;
  /** Player-chosen display name, set at purchase time. Falls back to a
   * prettified id (e.g. "Field 3") wherever this is unset — older saves. */
  name?: string;
  crop?: CropId;
  /** Sim-time the crop went in the ground. */
  plantedAt?: SimTime;
  /** TRUE yield in tons/acre, rolled at planting and hidden from the player —
   * they see only the narrowing range around it (brief §6). */
  trueYieldTonsPerAcre?: number;
  /** Acres harvested so far (harvest runs over sim-days, brief §10). */
  harvestedAcres?: number;
  /** Idle-game mode (brief §7-adjacent, player-requested): when true, the field
   * runs itself against its rotation `plans`, looping year to year. */
  autoManage?: boolean;
  /** Rotation plans, one per campaign year (1–5). The active plan advances each
   * campaign year (Jan 1) and loops after the last — `plans[(year-1) % len]`.
   * Empty/undefined while auto-managing falls back to a single default plan. */
  plans?: FieldPlan[];
  /** Per-season guards so an auto-managed weeding/fertilizing pass runs ONCE per
   * crop (reset when a new crop is planted). */
  autoWeedDone?: boolean;
  autoFertDone?: boolean;
  /** Per-cycle guard so an auto-managed mulching pass runs ONCE after harvest
   * (reset when a new crop is planted). */
  autoMulchDone?: boolean;
  /** What was actually paid for this land — refunded in full if it's sold back
   * (maintainer request: sell-back price = purchase price, not a market rate). */
  purchaseCost?: number;
  /** Forage baling (2026-07-11). Set true when a forage crop is harvested —
   * the field still has residue to rake + bale. Cleared once baled (or plowed
   * under). */
  forageReady?: boolean;
  /** Set true the moment a rake starts working this field — unlocks the baler
   * (which may start before the rake finishes). Cleared once baled/plowed. */
  windrowed?: boolean;
  /** Weed pressure (visual + weeding-task target): set once per crop when the
   * weeding window opens on a standing crop that hasn't been sprayed; the
   * weeding task's sweep clears it strip-by-strip. */
  weedy?: boolean;
  /** This crop has been weeded — no more weed flushes until the next planting. */
  weeded?: boolean;
  /** Sim-time the field was last fertilized. Visual-only: the texture darkens
   * ~20% (wet liquid spray) for the rest of THAT month, then dries back to
   * normal on the month turn (tickFarming clears this). */
  fertilizedAt?: SimTime;
  /** This crop cycle has been fertilized — drives the +30% yield boost
   * (`productivityMultiplier`). Reset at harvest/replanting; for a perennial
   * stand it resets when the campaign year turns, so the boost/taper is
   * per-year, tied to `cutsThisYear`/`cutYear`. */
  fertilized?: boolean;
  /** Productivity multiplier snapshotted the moment a perennial cut (mow)
   * completes — the fertilize taper is keyed to cuttings before THIS one, and
   * baling (which reads this) always runs after `cutsThisYear` has already
   * advanced past that. Cleared once the bale using it settles. */
  lastCutProductivity?: number;
  /** The field's two entrance/exit gates, on/near the boundary. Machines
   * leave the field via the nearest gate and enter through one (tasks.ts
   * route composition). Auto-placed at creation (`sim/access.ts`), draggable
   * from the field panel's edit mode. No map icons outside edit mode. */
  accessPoints?: Meters[];
  /** Physical bales sitting in the field — one entry per bale, at the UTM-meter
   * spot the baler dropped it. They accumulate as the baler works and persist
   * (exactly where dropped, across save/reload) until the player sells them.
   * Count = `baleLocations.length`. */
  baleLocations?: Meters[];
  /** What the field's dropped bales ARE (2026-07-13) — drives sale price + the
   * marker tint. Set when a bale run completes (corn→cornStover, grass→hay,
   * alfalfa→alfalfaHay). Undefined = corn-stover default (legacy saves). */
  baleProduct?: BaleProduct;
  /** Perennial forage crops only (grass/alfalfa): how many of this year's
   * cuttings have been mowed, and which campaign year that count belongs to
   * (reset to 0 when the year turns). Drives the fixed-monthly-window "ready"
   * derivation — the field is mowable while an opened cutting window is still
   * un-cut. */
  cutsThisYear?: number;
  cutYear?: number;
  /** The crop this field grew immediately before its current one (set when the
   * previous crop comes off at harvest — `applyHarvestDone`). Compared against
   * `crop` for the rotation yield bonus (`productivityMultiplier`, farming.ts).
   * Undefined on a field's first-ever crop — no bonus, nothing to rotate from. */
  lastCrop?: CropId;
  /** A mulching pass has shredded this field's residue back in — adds +7% to
   * the NEXT crop's yield (`productivityMultiplier`, farming.ts). Set when the
   * mulch task completes (after the current harvest); consumed/cleared by the
   * next harvest (`applyHarvestDone`). Independent of the "mulched" FieldStatus,
   * which means a clean baled surface — a name collision, not the same thing. */
  residueMulched?: boolean;
}

/** On-farm grain bin, tons per crop. Unlimited in this slice; storage limits and
 * costs arrive with the storage mechanic (brief §5 lever 1). */
export type GrainBin = Record<CropId, number>;

/** Placeable farm structures (maintainer request, 2026-07-12). A single point,
 * not a polygon like `Field` — see `sim/buildings.ts`.
 * `sellPoint` (2026-07-17): a bale hauler's fallback destination when no Bale
 * Storage exists or all of it's full — no capacity, no product assignment,
 * just cashes out whatever's dropped there at the flat bale price. */
export type BuildingKind = "silo" | "baleBarn" | "baleArea" | "tractorBarn" | "implementBarn" | "farmYard" | "sellPoint";

export interface Building {
  id: string;
  kind: BuildingKind;
  /** UTM-meter placement point. */
  pos: Meters;
  /** Silo-only: capacity tier (Small/Medium/Large), chosen at purchase. */
  size?: EquipmentSize;
  /** Silo-only: which crop's grain this silo is dedicated to (chosen by the
   * player on click). A silo holds no capacity until assigned — grain
   * capacity is tracked per crop, not pooled across crops. */
  assignedCrop?: CropId;
  /** Bale-storage-only (baleBarn/baleArea, 2026-07-17): bales physically
   * stored here, counted per product (a bale is self-describing, so unlike a
   * silo a store can hold a mix). Filled by the bale-hauling relay
   * (`sim/tasks.ts` haulBales). A Barn caps at `capacityBales`; an Area is
   * unlimited (`gameConfig.buildings.baleArea.capacityBales === Infinity`). */
  storedBales?: Partial<Record<BaleProduct, number>>;
  /** Bale-storage-only (optional): dedicate this store to ONE product — only
   * that product hauls in. Unassigned (undefined) accepts any product (the
   * default; mirrors an unassigned silo but bales may then be mixed). */
  assignedProduct?: BaleProduct;
}

/** What an agent is doing right now (brief §9 state machine — "drive home at
 * night" and road routing come later; v1 is idle → drive to field → work). */
export type AgentState = "idle" | "traveling" | "working";

export interface Agent {
  id: string;
  kind: "player" | "worker" | "tractor" | "harvester" | "truck";
  /** Display name for the queue panel / map label ("Tractor", "Combine"). */
  name: string;
  pos: Meters;
  state: AgentState;
  /** Size class of a tractor/combine — caps which implements a tractor can pull. */
  size?: EquipmentSize;
  /** Travel heading in radians (meters frame), for rotating the map icon. */
  heading?: number;
  /** The task this agent is on (traveling to or working), if any. */
  taskId?: string;
  /** What was paid for this machine — refunded in full on sell-back (same rule
   * as land). The starting fleet gets the config price (bought with starting
   * capital, notionally). */
  purchaseCost?: number;
  /** Harvester-only: tons currently in the hopper. Fills as it cuts, capped
   * at the combine's size tier's capacity (maintainer request, 2026-07-12) —
   * once full it stops and waits for a Grain Trailer (`sim/tasks.ts`). */
  grainOnboard?: number;
  /** Harvester-only: the field/crop the current `grainOnboard` came from.
   * Set whenever grain banks; kept around after the harvest task itself is
   * long gone so a leftover hopper (e.g. no silo existed yet when the field
   * finished) can still get a Grain Trailer routed to it later, once one
   * does (maintainer request, 2026-07-13). */
  lastFieldId?: string;
  lastCrop?: CropId;
}

/** An attachable implement (a plow, a planter, a sprayer, a Grain Trailer). A
 * tractor is a power unit; an implement gives it a job it can do. */
export interface Implement {
  id: string;
  kind: "plow" | "planter" | "sprayer" | "rake" | "bailer" | "grainTrailer" | "mower" | "mulcher" | "haySpikes" | "baleTrailer";
  size: EquipmentSize;
  /** Id of the tractor this is hitched to, or undefined if parked in the yard. */
  attachedTo?: string;
  /** What was paid — refunded on sell-back. */
  purchaseCost?: number;
  /** Grain Trailer-only: tons currently loaded, and which crop. Cleared back
   * to 0/undefined once fully dumped at a silo. */
  cargoTons?: number;
  cargoCrop?: CropId;
  /** Hay Spikes / Bale Trailer-only (2026-07-17): bales currently carried, and
   * which product. Cleared back to 0/undefined once dumped (into a trailer,
   * for spikes; into storage, for a trailer). */
  cargoBales?: number;
  cargoBaleProduct?: BaleProduct;
}

/** Fieldwork the player has ordered. Tasks queue up and agents (tractor for
 * plow/plant/weed/fertilize, combine for harvest) work through them one after
 * another. Weed/fertilize are independent side-tasks — they don't gate or get
 * gated by plow/plant/harvest, they just need a standing crop in the field.
 * `unloadHarvester` is system-generated (never player-queued) — a tractor+
 * Grain Trailer hauling a full combine's hopper to a silo. */
export type TaskType = "plow" | "plant" | "harvest" | "mow" | "mulch" | "weed" | "fertilize" | "rake" | "bale" | "unloadHarvester" | "haulBales";

export interface FarmTask {
  id: string;
  type: TaskType;
  fieldId: string;
  /** Which crop to put in (plant tasks only). */
  crop?: CropId;
  totalAcres: number;
  /** Acres worked so far (progress = doneAcres / totalAcres). */
  doneAcres: number;
  status: "queued" | "active";
  /** Agent working this task, once one picks it up. */
  agentId?: string;
  /** unloadHarvester-only: which combine this trip services. */
  harvesterAgentId?: string;
  /** unloadHarvester-only: which leg of the trip the tractor+trailer is on.
   * "staging" = parked at the field's access gate, waiting for the combine to
   * actually STOP for unloading (full hopper / finished field) before driving
   * in (maintainer request, 2026-07-13). */
  unloadPhase?: "staging" | "toHarvester" | "onloading" | "toSilo" | "dumping";
  /** unloadHarvester-only: sim-minutes left in the current onload/dump pause. */
  phaseTimer?: number;
  /** unloadHarvester-only: true while parked with nowhere to dump (no silo
   * assigned to the crop, or the assigned silo(s) are at capacity) — surfaced
   * as a ⚠️ in the UI until the player clears it. */
  waitingForSilo?: boolean;
  /** haulBales-only (2026-07-17): the two-agent bale-hauling relay. `agentId`
   * is the Hay-Spikes tractor collecting in-field; `trailerAgentId` is the
   * optional idle tractor+Bale-Trailer helper that stages at a field entrance
   * and runs full loads to storage (undefined = spikes tractor hauls direct).
   * `baleProduct` is what this field's bales are (captured at creation). Each
   * agent tracks its own leg + pause timer so both can be busy at once. */
  trailerAgentId?: string;
  baleProduct?: BaleProduct;
  haulPhase?: "toBale" | "loading" | "toTrailer" | "unloadToTrailer" | "toStorage" | "dumping" | "waiting";
  trailerPhase?: "toEntrance" | "waiting" | "toStorage" | "dumping";
  /** Sim-minutes left in the trailer helper's current load/dump pause (the
   * spikes tractor uses `phaseTimer`; the trailer needs its own so both can
   * pause simultaneously). */
  trailerTimer?: number;
  /** haulBales-only: true while a hauler is parked with nowhere to put bales
   * (no Bale Storage exists, or every eligible store is full) — ⚠️ in the UI. */
  waitingForStorage?: boolean;
  /** haulBales-only (2026-07-17): which kind of destination the spikes/trailer
   * tractor is currently headed to or dumping at — "storage" if it's driving
   * toward Bale Storage, "sell" if it fell back to a Sell Point (no storage
   * exists/has room). Decided once when the trip starts (`chooseBaleDest`) and
   * locked for that trip so arrival always matches what was decided, rather
   * than re-deciding mid-drive. */
  haulDest?: "storage" | "sell";
  trailerDest?: "storage" | "sell";
  /** Grain cart: where this unload trip is headed — a silo, or a Sell Point when
   * silos are full/absent (so a partial dump into a filling silo diverts to
   * selling instead of stalling). Same lock-per-trip idea as haulDest. */
  unloadDest?: "silo" | "sell";
  /** What was paid when the task was queued (plow cost / seed inputs) —
   * refunded in full if a still-queued task is canceled. */
  costPaid: number;
}

/** A snapshot of a finished field-work task OR a grain/bale sale, kept for the
 * Work Queue's "Completed" section (maintainer request, 2026-07-14; sales
 * added 2026-07-14). The live `FarmTask` is discarded the instant its work is
 * done, and a sale (economy.ts) was never a task at all — so anything worth
 * showing after the fact (cost, revenue, tons, bales) has to be captured into
 * its own record right when it happens. Bounded and pruned by `dateOf(now)`
 * month in the UI, not stored per-type — a flat log is enough for "what
 * happened this month". */
export interface CompletedTask {
  id: string;
  type: TaskType | "sellGrain" | "sellBales";
  /** Field the work happened on. Omitted for sales that span every field
   * holding a product (e.g. "sell all hay bales"). */
  fieldId?: string;
  crop?: CropId;
  /** Display label for sale entries that aren't tied to a single crop (e.g.
   * a bale product name — "Hay", "Alfalfa Hay"). */
  label?: string;
  acres?: number;
  /** Money paid to DO the work (task completions only). */
  costPaid?: number;
  /** Money received (sale entries only). */
  revenue?: number;
  /** Grain harvested (harvest) or forage gathered/sold (bale, sales), in tons. */
  tons?: number;
  /** Bales produced or sold. */
  bales?: number;
  /** Name of the machine that did the work (task completions only). */
  agentName?: string;
  completedAt: SimTime;
}

/** A locked-in, amortizing loan (brief §8, "loan interest, the difficulty
 * dial"). Loans are grouped by campaign YEAR borrowed in (maintainer design,
 * 2026-07-11) — see `sim/finance.ts` for the full model. Fixed rate + a fixed
 * monthly payment set at lock-in (or the last refinance); extra principal
 * payments don't touch the payment, they just retire the loan sooner. */
export interface Loan {
  id: string;
  /** Campaign year (1-based) this loan's balance was borrowed in. */
  originYear: number;
  /** Remaining balance owed. */
  principal: number;
  /** Annual interest rate, percent (5 = 5%) — stored per-loan so a future
   * difficulty preset or differently-rated refinance doesn't need a save
   * migration. */
  ratePercent: number;
  /** Fixed monthly payment, set at lock-in and recalculated on refinance.
   * Extra principal payments don't change this — they shorten the payoff. */
  monthlyPayment: number;
  /** Sim-time the next monthly payment is due. */
  nextPaymentAt: SimTime;
  /** How many times this loan has been refinanced (display/flavor only). */
  refinancedCount?: number;
}

/** The farm's borrowing (brief §8). One OPEN balance accumulates via +/−
 * button clicks through the current campaign year; the moment the year turns
 * it locks in as its own `Loan` (5%, 15-year amortization) and a fresh open
 * balance starts for the new year (maintainer design, 2026-07-11). */
export interface FinanceState {
  /** The campaign year currently accumulating the open (not-yet-locked)
   * balance. */
  openYear: number;
  /** This year's not-yet-locked borrowed balance. */
  pendingPrincipal: number;
  loans: Loan[];
}

export interface SaveState {
  version: number;
  clock: { now: SimTime };
  money: number;
  parcels: Parcel[];
  fields: Field[];
  grain: GrainBin;
  /** Placed buildings (silos, barns, farm yard). */
  buildings: Building[];
  agents: Agent[];
  /** Attachable implements owned by the farm (plows now; more later). */
  implements: Implement[];
  tasks: FarmTask[];
  finance: FinanceState;
  /** Cashflow ledger: campaign year -> category -> item -> net dollars (see
   * `sim/ledger.ts`). Only the most recent 5 years are kept. */
  ledger?: Record<number, import("../sim/ledger").LedgerYear>;
  /** Per-field cashflow, mirroring `ledger` but keyed by field id too — feeds
   * the Field Finances tab's multi-year profit & loss table (maintainer
   * request, 2026-07-21). Additive: every dollar booked here ALSO goes
   * through the existing global `recordCash` call at the same site, so the
   * whole-farm Finance tab is unaffected. Last 5 years per field, pruned in
   * `sim/fieldLedger.ts`. */
  fieldLedger?: Record<string, Record<number, import("../sim/fieldLedger").FieldLedgerYear>>;
  /** REMOVED 2026-07-22: `produceStock` (sale-time produce provenance) — field
   * revenue is now booked at harvest/bale time in `sim/fieldLedger.ts`. Stale
   * keys in old saves are simply ignored. */
  /** Auto-sell schedule (maintainer request, 2026-07-21): product -> chosen
   * sell month (0-11) + whether auto-sell is on. When on, all stored inventory
   * of that product is sold the moment the clock reaches that month
   * (`tickAutoSell`, sim/economy.ts). */
  sellSchedule?: Record<string, { month: number; auto: boolean }>;
  /** Highest months-since-epoch already processed by `tickAutoSell` — the
   * month-turn cursor (same idea as loan payments), so auto-sells fire once
   * per crossed month and survive time-compression / skip-month. */
  sellLastMonthAbs?: number;
  contracts: unknown[]; // shape defined when the contract slice lands (brief §6)
  /** Finished field-work tasks, newest last — feeds the Work Queue's
   * "Completed" section. Pruned to a bounded length in `sim/tasks.ts`. */
  completedTasks?: CompletedTask[];
  /** Set once `ensureAgents` has seeded (or migrated) the starter fleet, so a
   * later reload never re-grants free equipment after the player sells it. */
  starterFleetGranted?: boolean;
}

export function newGame(): SaveState {
  return {
    version: 1,
    clock: { now: 0 },
    money: gameConfig.startingMoney,
    parcels: [],
    fields: [],
    grain: { corn: 0, soybeans: 0, grass: 0, alfalfa: 0 },
    buildings: [],
    agents: [],
    implements: [],
    tasks: [],
    finance: { openYear: 1, pendingPrincipal: 0, loans: [] }, // campaign always starts in Year 1
    contracts: [],
    completedTasks: [],
  };
}
