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
  /** Spatial index: grid cell key -> indices into `segments` whose bbox
   * touches the cell. Keeps nearest-road snapping O(local), not O(county). */
  grid: Map<string, number[]>;
}

/** Spatial-grid cell size, meters. Rural road spacing is ~1600 m (the mile
 * grid), so a couple of ring expansions from any farm point finds a road. */
const GRID_CELL_M = 800;

function gridKey(cx: number, cy: number): string {
  return cx + "," + cy;
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

  // Index every segment into each grid cell its bounding box touches.
  const grid = new Map<string, number[]>();
  for (let i = 0; i < segments.length; i++) {
    const A = nodes[segments[i]!.a]!.pos;
    const B = nodes[segments[i]!.b]!.pos;
    const x0 = Math.floor(Math.min(A[0], B[0]) / GRID_CELL_M);
    const x1 = Math.floor(Math.max(A[0], B[0]) / GRID_CELL_M);
    const y0 = Math.floor(Math.min(A[1], B[1]) / GRID_CELL_M);
    const y1 = Math.floor(Math.max(A[1], B[1]) / GRID_CELL_M);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const key = gridKey(cx, cy);
        let bucket = grid.get(key);
        if (!bucket) grid.set(key, (bucket = []));
        bucket.push(i);
      }
    }
  }
  return { nodes, segments, grid };
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

/** Project `p` onto one segment; returns the snap if it beats `best`. */
function snapToSegment(net: RoadNetwork, segIdx: number, p: Meters, best: Snap | null): Snap | null {
  const seg = net.segments[segIdx]!;
  const A = net.nodes[seg.a]!.pos;
  const B = net.nodes[seg.b]!.pos;
  const abx = B[0] - A[0], aby = B[1] - A[1];
  const len2 = abx * abx + aby * aby;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - A[0]) * abx + (p[1] - A[1]) * aby) / len2)) : 0;
  const q: Meters = [A[0] + abx * t, A[1] + aby * t];
  const d = dist(p, q);
  return !best || d < best.d ? { point: q, a: seg.a, b: seg.b, d } : best;
}

/** The nearest point on any road segment to `p`, via the spatial grid:
 * expand square rings of cells outward until a candidate is found, then one
 * more ring's worth of margin to make sure nothing closer hides diagonally. */
export function nearestRoadPoint(net: RoadNetwork, p: Meters): Snap | null {
  const cx = Math.floor(p[0] / GRID_CELL_M);
  const cy = Math.floor(p[1] / GRID_CELL_M);
  // Ring cap: enough to cross any realistic gap in a county extract (fields
  // sit at most a few km from a road); beyond that, fall back to a full scan
  // once rather than looping forever on a point outside the road network.
  const MAX_RING = 25;
  let best: Snap | null = null;
  for (let r = 0; r <= MAX_RING; r++) {
    // Once a candidate exists, only rings that could still contain something
    // closer matter: a ring at distance (r-1)*cell is the guaranteed floor.
    if (best && best.d < (r - 1) * GRID_CELL_M) return best;
    for (let x = cx - r; x <= cx + r; x++) {
      for (let y = cy - r; y <= cy + r; y++) {
        if (r > 0 && Math.abs(x - cx) !== r && Math.abs(y - cy) !== r) continue; // ring shell only
        const bucket = net.grid.get(gridKey(x, y));
        if (!bucket) continue;
        for (const i of bucket) best = snapToSegment(net, i, p, best);
      }
    }
  }
  if (best) return best;
  for (let i = 0; i < net.segments.length; i++) best = snapToSegment(net, i, p, best);
  return best;
}

/** Minimal binary min-heap of (f-score, node) pairs for the A* open list.
 * Stale entries are allowed (lazy-decrease-key) and skipped on pop. */
class MinHeap {
  private f: number[] = [];
  private n: number[] = [];
  get size(): number { return this.f.length; }
  push(f: number, node: number): void {
    const fs = this.f, ns = this.n;
    let i = fs.length;
    fs.push(f); ns.push(node);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (fs[p]! <= fs[i]!) break;
      [fs[p], fs[i]] = [fs[i]!, fs[p]!];
      [ns[p], ns[i]] = [ns[i]!, ns[p]!];
      i = p;
    }
  }
  pop(): number {
    const fs = this.f, ns = this.n;
    const top = ns[0]!;
    const lf = fs.pop()!, ln = ns.pop()!;
    if (fs.length > 0) {
      fs[0] = lf; ns[0] = ln;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < fs.length && fs[l]! < fs[m]!) m = l;
        if (r < fs.length && fs[r]! < fs[m]!) m = r;
        if (m === i) break;
        [fs[m], fs[i]] = [fs[i]!, fs[m]!];
        [ns[m], ns[i]] = [ns[i]!, ns[m]!];
        i = m;
      }
    }
    return top;
  }
}

/**
 * ONE A* search from the snapped start to the snapped goal, using two virtual
 * nodes: START (the on-road point near `from`, feeding both endpoints of its
 * segment) and GOAL (the on-road point near `to`, reachable from both
 * endpoints of its segment). This replaces the old 4-combination search —
 * the entry/exit-direction choice falls out of the graph itself, in a single
 * pass, with a heap-backed open list (the old linear-scan pop was O(n²) and
 * caused a visible hitch on every task pickup).
 *
 * Returns the on-road polyline START→…→GOAL and its length, or null.
 */
function roadPath(net: RoadNetwork, sFrom: Snap, sTo: Snap): { pts: Meters[]; len: number } | null {
  const N = net.nodes.length;
  const START = N, GOAL = N + 1;
  const goalPos = sTo.point;
  const posOf = (i: number): Meters =>
    i === START ? sFrom.point : i === GOAL ? goalPos : net.nodes[i]!.pos;

  // Flat arrays (indexable by node id) beat Maps here by a wide margin.
  const g = new Float64Array(N + 2).fill(Infinity);
  const came = new Int32Array(N + 2).fill(-1);
  const closed = new Uint8Array(N + 2);
  const heap = new MinHeap();

  const goalNeighbors = new Map<number, number>(); // endpoint -> edge len to GOAL
  for (const end of [sTo.a, sTo.b]) {
    const d = dist(net.nodes[end]!.pos, goalPos);
    const prev = goalNeighbors.get(end);
    if (prev === undefined || d < prev) goalNeighbors.set(end, d);
  }

  g[START] = 0;
  heap.push(dist(sFrom.point, goalPos), START);

  while (heap.size > 0) {
    const cur = heap.pop();
    if (closed[cur]) continue; // stale heap entry
    if (cur === GOAL) {
      const pts: Meters[] = [];
      let len = 0;
      for (let i: number = GOAL; i !== -1; i = came[i]!) pts.push(posOf(i));
      pts.reverse();
      for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1]!, pts[i]!);
      return { pts, len };
    }
    closed[cur] = 1;
    const gCur = g[cur]!;

    const relax = (to: number, len: number): void => {
      if (closed[to]) return;
      const tentative = gCur + len;
      if (tentative < g[to]!) {
        g[to] = tentative;
        came[to] = cur;
        heap.push(tentative + (to === GOAL ? 0 : dist(posOf(to), goalPos)), to);
      }
    };

    if (cur === START) {
      relax(sFrom.a, dist(sFrom.point, net.nodes[sFrom.a]!.pos));
      relax(sFrom.b, dist(sFrom.point, net.nodes[sFrom.b]!.pos));
    } else {
      for (const e of net.nodes[cur]!.edges) relax(e.to, e.len);
      const toGoal = goalNeighbors.get(cur);
      if (toGoal !== undefined) relax(GOAL, toGoal);
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

  const onRoad = roadPath(net, sFrom, sTo);
  if (!onRoad) return null;
  const pts = dedupePoints([from, ...onRoad.pts, to]);
  const len = polylineLength(pts);
  if (len > straight * MAX_DETOUR_RATIO) return null;
  return pts;
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
