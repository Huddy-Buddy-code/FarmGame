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
import type { CropId } from "../config/gameConfig";

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
}

/** On-farm grain bin, tons per crop. Unlimited in this slice; storage limits and
 * costs arrive with the storage mechanic (brief §5 lever 1). */
export type GrainBin = Record<CropId, number>;

export interface Agent {
  id: string;
  kind: "player" | "worker" | "tractor" | "truck";
  pos: Meters;
}

export interface SaveState {
  version: number;
  clock: { now: SimTime };
  money: number;
  parcels: Parcel[];
  fields: Field[];
  grain: GrainBin;
  agents: Agent[];
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
    contracts: [],
  };
}
