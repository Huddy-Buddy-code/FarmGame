/**
 * Road network for AGENT travel (brief §9 — "routes via roads").
 *
 * Machines used to drive straight lines between jobs. This module ingests the
 * county's bundled OSM road extract into a lightweight node/edge graph (UTM
 * meters, converted once at ingest per brief §3) and answers point-to-point
 * route queries with A*. Agents leave a field to the NEAREST point on a road,
 * follow roads, then leave the road at the point nearest their destination —
 * exactly how a tractor actually moves between fields.
 *
 * Pure data + pure functions: no map, no DOM. `tasks.ts` consumes it through
 * `setRoadNetwork` (main.ts wires it up after the county loads); when no
 * network is set (unit tests, load failure) travel falls back to the old
 * straight line, so nothing else changes.
 */

import type { FeatureCollection, LineString, MultiLineString } from "geojson";
import type { Meters, LngLat } from "../geo/coords";

interface Node {
  pos: Meters;
  /** Adjacent node indices + edge lengths (meters). */
  edges: { to: number; len: number }[];
}

export interface RoadNetwork {
  nodes: Node[];
  /** All road segments as node-index pairs, for nearest-point snapping. */
  segments: { a: number; b: number }[];
}

/** Nodes closer than this (meters) collapse into one graph node — makes
 * separately-drawn OSM ways that share an intersection actually connect. */
const SNAP_M = 1.5;

/** Build the routing graph from the county road GeoJSON (lng/lat), converting
 * to UTM meters at ingest. `toMeters` is passed in so this module stays free
 * of the projection singleton (testable with a fake projection). */
export function buildRoadNetwork(
  roads: FeatureCollection,
  toMeters: (p: LngLat) => Meters,
): RoadNetwork {
  const nodes: Node[] = [];
  const segments: { a: number; b: number }[] = [];
  const index = new Map<string, number>(); // snapped-position key -> node idx

  const nodeAt = (p: Meters): number => {
    const key = `${Math.round(p[0] / SNAP_M)},${Math.round(p[1] / SNAP_M)}`;
    let idx = index.get(key);
    if (idx === undefined) {
      idx = nodes.length;
      nodes.push({ pos: p, edges: [] });
      index.set(key, idx);
    }
    return idx;
  };

  const addLine = (coords: LngLat[]): void => {
    let prev = -1;
    for (const c of coords) {
      const idx = nodeAt(toMeters(c));
      if (prev !== -1 && prev !== idx) {
        const len = dist(nodes[prev]!.pos, nodes[idx]!.pos);
        nodes[prev]!.edges.push({ to: idx, len });
        nodes[idx]!.edges.push({ to: prev, len });
        segments.push({ a: prev, b: idx });
      }
      prev = idx;
    }
  };

  for (const f of roads.features) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === "LineString") addLine((g as LineString).coordinates as LngLat[]);
    else if (g.type === "MultiLineString") {
      for (const line of (g as MultiLineString).coordinates) addLine(line as LngLat[]);
    }
  }
  return { nodes, segments };
}

function dist(a: Meters, b: Meters): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

interface Snap {
  /** Closest point on the road network. */
  point: Meters;
  /** The segment it lies on (enter the graph via either endpoint). */
  a: number;
  b: number;
  /** Distance from the query point to `point`. */
  d: number;
}

/** The nearest point on any road segment to `p` (linear scan — county road
 * extracts are a few thousand segments, well under a millisecond). */
export function nearestRoadPoint(net: RoadNetwork, p: Meters): Snap | null {
  let best: Snap | null = null;
  for (const seg of net.segments) {
    const A = net.nodes[seg.a]!.pos;
    const B = net.nodes[seg.b]!.pos;
    const abx = B[0] - A[0], aby = B[1] - A[1];
    const len2 = abx * abx + aby * aby;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - A[0]) * abx + (p[1] - A[1]) * aby) / len2)) : 0;
    const q: Meters = [A[0] + abx * t, A[1] + aby * t];
    const d = dist(p, q);
    if (!best || d < best.d) best = { point: q, a: seg.a, b: seg.b, d };
  }
  return best;
}

/** A* over the node graph. Returns node indices from `start` to `goal`, or null. */
function astar(net: RoadNetwork, start: number, goal: number): number[] | null {
  if (start === goal) return [start];
  const goalPos = net.nodes[goal]!.pos;
  const g = new Map<number, number>([[start, 0]]);
  const came = new Map<number, number>();
  // Simple binary-less open list (array scan) — county graphs are small enough
  // that the O(n) pop hasn't shown up in profiles; swap for a heap if it does.
  const open = new Map<number, number>([[start, dist(net.nodes[start]!.pos, goalPos)]]);
  const closed = new Set<number>();

  while (open.size > 0) {
    let cur = -1, curF = Infinity;
    for (const [n, f] of open) if (f < curF) { curF = f; cur = n; }
    if (cur === goal) {
      const path = [cur];
      while (came.has(cur)) { cur = came.get(cur)!; path.push(cur); }
      return path.reverse();
    }
    open.delete(cur);
    closed.add(cur);
    const gCur = g.get(cur)!;
    for (const e of net.nodes[cur]!.edges) {
      if (closed.has(e.to)) continue;
      const tentative = gCur + e.len;
      if (tentative < (g.get(e.to) ?? Infinity)) {
        g.set(e.to, tentative);
        came.set(e.to, cur);
        open.set(e.to, tentative + dist(net.nodes[e.to]!.pos, goalPos));
      }
    }
  }
  return null;
}

/** If a trip is shorter than this (meters), don't bother with roads at all —
 * a machine crossing its own yard shouldn't detour to the highway. */
const MIN_ROAD_TRIP_M = 120;
/** Give up on the road route when it's this many times longer than the
 * straight line — the road network doesn't usefully serve this trip. */
const MAX_DETOUR_RATIO = 3.5;

/**
 * Plan a drivable polyline from `from` to `to`: off-road to the nearest road
 * point, along roads, off-road again to the destination. Returns null when
 * driving straight is the right call (short hop, no network coverage, or the
 * road detour is absurd) — the caller then drives direct, same as before.
 */
export function planRoute(net: RoadNetwork, from: Meters, to: Meters): Meters[] | null {
  const straight = dist(from, to);
  if (straight < MIN_ROAD_TRIP_M) return null;
  const sFrom = nearestRoadPoint(net, from);
  const sTo = nearestRoadPoint(net, to);
  if (!sFrom || !sTo) return null;
  // If getting on/off the road already costs more than driving direct, skip.
  if (sFrom.d + sTo.d > straight) return null;

  // Try the four entry/exit endpoint combinations and keep the shortest —
  // entering a segment toward the "wrong" endpoint can force a long U-turn.
  let bestPath: Meters[] | null = null;
  let bestLen = Infinity;
  for (const start of [sFrom.a, sFrom.b]) {
    for (const goal of [sTo.a, sTo.b]) {
      const idxPath = astar(net, start, goal);
      if (!idxPath) continue;
      const pts: Meters[] = [from, sFrom.point, ...idxPath.map((i) => net.nodes[i]!.pos), sTo.point, to];
      const cleaned = dedupePoints(pts);
      const len = polylineLength(cleaned);
      if (len < bestLen) {
        bestLen = len;
        bestPath = cleaned;
      }
    }
  }
  if (!bestPath) return null;
  if (bestLen > straight * MAX_DETOUR_RATIO) return null;
  return bestPath;
}

function dedupePoints(pts: Meters[]): Meters[] {
  const out: Meters[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || dist(last, p) > 0.25) out.push(p);
  }
  return out;
}

export function polylineLength(pts: Meters[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1]!, pts[i]!);
  return len;
}
