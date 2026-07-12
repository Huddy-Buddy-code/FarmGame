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
import type { CropId, EquipmentSize } from "../config/gameConfig";

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
  /** Rake + bale the residue after harvest (forage crops only) instead of plowing
   * it under. */
  bale?: boolean;
}

export interface Field {
  id: string;
  parcelId: string;
  boundary: Meters[];
  status: FieldStatus;
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
  /** Physical bales sitting in the field — one entry per bale, at the UTM-meter
   * spot the baler dropped it. They accumulate as the baler works and persist
   * (exactly where dropped, across save/reload) until the player sells them.
   * Count = `baleLocations.length`. */
  baleLocations?: Meters[];
}

/** On-farm grain bin, tons per crop. Unlimited in this slice; storage limits and
 * costs arrive with the storage mechanic (brief §5 lever 1). */
export type GrainBin = Record<CropId, number>;

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
}

/** An attachable implement (a plow, a planter, a sprayer). A tractor is a
 * power unit; an implement gives it a job it can do. */
export interface Implement {
  id: string;
  kind: "plow" | "planter" | "sprayer" | "rake" | "bailer";
  size: EquipmentSize;
  /** Id of the tractor this is hitched to, or undefined if parked in the yard. */
  attachedTo?: string;
  /** What was paid — refunded on sell-back. */
  purchaseCost?: number;
}

/** Fieldwork the player has ordered. Tasks queue up and agents (tractor for
 * plow/plant/weed/fertilize, combine for harvest) work through them one after
 * another. Weed/fertilize are independent side-tasks — they don't gate or get
 * gated by plow/plant/harvest, they just need a standing crop in the field. */
export type TaskType = "plow" | "plant" | "harvest" | "weed" | "fertilize" | "rake" | "bale";

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
  /** What was paid when the task was queued (plow cost / seed inputs) —
   * refunded in full if a still-queued task is canceled. */
  costPaid: number;
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

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
}

export interface SaveState {
  version: number;
  clock: { now: SimTime };
  money: number;
  parcels: Parcel[];
  fields: Field[];
  grain: GrainBin;
  agents: Agent[];
  /** Attachable implements owned by the farm (plows now; more later). */
  implements: Implement[];
  tasks: FarmTask[];
  finance: FinanceState;
  contracts: unknown[]; // shape defined when the contract slice lands (brief §6)
  /** Lite to-do list for player notes. */
  todos?: TodoItem[];
}

export function newGame(): SaveState {
  return {
    version: 1,
    clock: { now: 0 },
    money: gameConfig.startingMoney,
    parcels: [],
    fields: [],
    grain: { corn: 0, soybeans: 0 },
    agents: [],
    implements: [],
    tasks: [],
    finance: { openYear: 1, pendingPrincipal: 0, loans: [] }, // campaign always starts in Year 1
    contracts: [],
  };
}
