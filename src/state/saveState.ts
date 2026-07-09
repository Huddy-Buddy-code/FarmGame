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
  crop?: string;
}

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
  agents: Agent[];
  contracts: unknown[]; // shape defined when the contract slice lands (brief §6)
}

export function newGame(): SaveState {
  return {
    version: 1,
    clock: { now: 0 },
    money: 0,
    parcels: [],
    fields: [],
    agents: [],
    contracts: [],
  };
}
