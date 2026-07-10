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
  | "harvested";

export interface Parcel {
  id: string;
  /** Polygon boundary in UTM meters. */
  boundary: Meters[];
  owned: boolean;
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
   * plows, plants, and harvests itself the moment each is possible, so the
   * player can walk away and the farm keeps running. */
  autoManage?: boolean;
  /** What was actually paid for this land — refunded in full if it's sold back
   * (maintainer request: sell-back price = purchase price, not a market rate). */
  purchaseCost?: number;
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

/** An attachable implement (a plow now; planters/etc. reuse this shape). A
 * tractor is a power unit; an implement gives it a job it can do. */
export interface Implement {
  id: string;
  kind: "plow";
  size: EquipmentSize;
  /** Id of the tractor this is hitched to, or undefined if parked in the yard. */
  attachedTo?: string;
  /** What was paid — refunded on sell-back. */
  purchaseCost?: number;
}

/** Fieldwork the player has ordered. Tasks queue up and agents (tractor for
 * plow/plant, combine for harvest) work through them one after another. */
export type TaskType = "plow" | "plant" | "harvest";

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
  contracts: unknown[]; // shape defined when the contract slice lands (brief §6)
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
    contracts: [],
  };
}
