/**
 * Where an off-route place is walked to from: the junction on the route, the
 * walk in, and its climb, found over a walkable network (OpenStreetMap ways).
 *
 * The build otherwise attaches a waypoint to the route point nearest it in a
 * straight line. Within a few hundred metres that is the junction near enough;
 * further out it can be the wrong side of a hill. Shikoku's Maekawa Campground
 * is 1.4 km from the summit of the Temple 20 climb in a straight line, but is
 * reached by 2.8 km of flat road from the valley before the climb. Placed at
 * the summit, a night there planned the climb into the day before.
 *
 * The rule here: the junction is the one that makes the round trip from the
 * route to the place and back cheapest, by Naismith's rule — a metre of climb
 * costs what {@link CLIMB_EQUIVALENT_M} metres of flat walking does. Under a
 * single junction a hiker walks the whole route either way, so the round trip
 * is the only part that differs between junctions, and minimising it is
 * exactly "the cheapest way to fit this place into the walk". The round trip
 * climbs every metre of height difference along the path once (up on the way
 * in or up on the way out), which makes each edge's cost the same in both
 * directions, so a plain undirected shortest-path search finds it.
 *
 * The search starts at the place and stops at the first network node that
 * touches the route: a path that reaches the route and walks along it to a
 * better-looking junction is on the route by then, and the route's own km and
 * climb already count that walking.
 *
 * Platform-neutral and pure: the caller supplies the ways (from Overpass) and
 * an elevation lookup (a DEM sampler), and decides what to do with a failure.
 */

import { haversineDistance } from './distance';
import { calculateElevationStats } from './gpx-optimizer';

/**
 * Flat metres one metre of climb is worth: Naismith's 600 m of climb per hour
 * against 5 km of flat walking per hour.
 */
export const CLIMB_EQUIVALENT_M = 5000 / 600;

/** Network edges are split so no piece is longer than this (metres). */
export const DEFAULT_DENSIFY_M = 25;

/** A network node this close to the route line is on the route (metres). */
export const DEFAULT_ROUTE_TOUCH_M = 35;

/**
 * Network nodes within this distance of the place are where its walk can
 * start, reached cross-country (metres). A campground in a field sits off the
 * end of its access road; a lodge a few doors down a lane from a mapped road.
 */
export const DEFAULT_PLACE_SNAP_M = 300;

/** Walking off the network costs this many times walking on it. */
export const OFF_NETWORK_PENALTY = 1.5;

/**
 * The walk starts from ways no more than this much further from the place
 * than the nearest one (metres). Without it, a road the route itself follows
 * 150-300 m away beats the place's own access lane, and the "walk" is a
 * straight line across a river or a gorge: Shikoku's Iyadani Kanon rest stop
 * read 0.4 km where the walk is 2.2 km. Only when no way that close leads to
 * the route are the further ones tried.
 */
export const PLACE_SNAP_SLACK_M = 60;

/** The longest walk allowed with no mapped way at all between the place and the route (metres)… */
export const MAX_CROSS_COUNTRY_ONLY_M = 150;

/** …unless the ground between is gentle: up to this far (metres), */
export const MAX_GENTLE_CROSS_COUNTRY_M = 500;

/** at no steeper an average grade than this (rise over run). */
export const MAX_CROSS_COUNTRY_GRADE = 0.2;

/** One OSM way: its vertices in order, and their node ids when known. */
export interface WalkWay {
  coords: ReadonlyArray<readonly [number, number]>;
  nodeIds?: readonly number[];
}

/** A route point: position and cumulative km, as the build's `track.points`. */
export interface AccessRoutePoint {
  lat: number;
  lon: number;
  dist: number;
}

export interface WalkNetwork {
  lat: number[];
  lon: number[];
  /** Neighbours of each node, with the edge length in metres. */
  adj: Array<Array<{ to: number; lengthM: number }>>;
}

/** Turn ways into a graph, joining ways at shared nodes and densifying long edges. */
export function buildWalkNetwork(ways: readonly WalkWay[], densifyM = DEFAULT_DENSIFY_M): WalkNetwork {
  const network: WalkNetwork = { lat: [], lon: [], adj: [] };
  const byKey = new Map<string, number>();

  const addNode = (lat: number, lon: number): number => {
    network.lat.push(lat);
    network.lon.push(lon);
    network.adj.push([]);
    return network.lat.length - 1;
  };
  const vertex = (way: WalkWay, i: number): number => {
    const [lat, lon] = way.coords[i];
    // Overpass's `out geom` gives every vertex exact coordinates, so a shared
    // node has the same key in each way even without its id.
    const key = way.nodeIds ? `n${way.nodeIds[i]}` : `${lat.toFixed(7)},${lon.toFixed(7)}`;
    let index = byKey.get(key);
    if (index === undefined) {
      index = addNode(lat, lon);
      byKey.set(key, index);
    }
    return index;
  };
  const link = (a: number, b: number, lengthM: number) => {
    network.adj[a].push({ to: b, lengthM });
    network.adj[b].push({ to: a, lengthM });
  };

  for (const way of ways) {
    if (way.coords.length < 2) continue;
    let prev = vertex(way, 0);
    for (let i = 1; i < way.coords.length; i++) {
      const next = vertex(way, i);
      if (next === prev) continue;
      const [lat1, lon1] = way.coords[i - 1];
      const [lat2, lon2] = way.coords[i];
      const length = haversineDistance(lat1, lon1, lat2, lon2);
      const pieces = Math.max(1, Math.ceil(length / densifyM));
      let from = prev;
      for (let p = 1; p < pieces; p++) {
        const t = p / pieces;
        const mid = addNode(lat1 + (lat2 - lat1) * t, lon1 + (lon2 - lon1) * t);
        link(from, mid, length / pieces);
        from = mid;
      }
      link(from, next, length / pieces);
      prev = next;
    }
  }
  return network;
}

/** Metres per degree of latitude, for the local flat projections below. */
const M_PER_DEG = 111_320;

/** Uniform grid over node indices, in degrees, for radius queries. */
class NodeGrid {
  private readonly cells = new Map<string, number[]>();
  constructor(
    private readonly network: WalkNetwork,
    private readonly cellDeg: number
  ) {
    for (let i = 0; i < network.lat.length; i++) {
      const key = this.key(network.lat[i], network.lon[i]);
      const cell = this.cells.get(key);
      if (cell) cell.push(i);
      else this.cells.set(key, [i]);
    }
  }
  private key(lat: number, lon: number): string {
    return `${Math.floor(lat / this.cellDeg)},${Math.floor(lon / this.cellDeg)}`;
  }
  /** Nodes within `radiusM` of the point, nearest first, with their distances. */
  within(lat: number, lon: number, radiusM: number): Array<{ node: number; distanceM: number }> {
    const latSpan = radiusM / M_PER_DEG;
    const lonSpan = radiusM / (M_PER_DEG * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
    const out: Array<{ node: number; distanceM: number }> = [];
    const r0 = Math.floor((lat - latSpan) / this.cellDeg);
    const r1 = Math.floor((lat + latSpan) / this.cellDeg);
    const c0 = Math.floor((lon - lonSpan) / this.cellDeg);
    const c1 = Math.floor((lon + lonSpan) / this.cellDeg);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        for (const node of this.cells.get(`${r},${c}`) ?? []) {
          const d = haversineDistance(lat, lon, this.network.lat[node], this.network.lon[node]);
          if (d <= radiusM) out.push({ node, distanceM: d });
        }
      }
    }
    return out.sort((a, b) => a.distanceM - b.distanceM);
  }
}

/** Where a point meets the route line: distance to it and the km there. */
interface RouteProjection {
  distanceM: number;
  km: number;
  index: number;
}

/** The route's segments on a grid, so each network node checks only its neighbours. */
class RouteLine {
  private readonly cells = new Map<string, number[]>();
  private readonly cellDeg: number;
  constructor(
    private readonly points: readonly AccessRoutePoint[],
    reachM: number,
    breakStarts: ReadonlySet<number>
  ) {
    this.cellDeg = Math.max(0.0005, (reachM * 2) / M_PER_DEG);
    for (let i = 1; i < points.length; i++) {
      // The step into a route break is a ferry or an unbridged river: not a
      // line anyone walks, so nothing can join the route along it.
      if (breakStarts.has(i)) continue;
      const a = points[i - 1];
      const b = points[i];
      // Padded by the reach either side. A cell is square in degrees, and a
      // degree of longitude shrinks with latitude, so east-west the reach
      // spans more than one cell beyond 60°.
      const maxAbsLat = Math.max(Math.abs(a.lat), Math.abs(b.lat));
      const cellLonM = this.cellDeg * M_PER_DEG * Math.max(0.01, Math.cos((maxAbsLat * Math.PI) / 180));
      const lonPad = Math.max(1, Math.ceil(reachM / cellLonM));
      const r0 = Math.floor(Math.min(a.lat, b.lat) / this.cellDeg) - 1;
      const r1 = Math.floor(Math.max(a.lat, b.lat) / this.cellDeg) + 1;
      const c0 = Math.floor(Math.min(a.lon, b.lon) / this.cellDeg) - lonPad;
      const c1 = Math.floor(Math.max(a.lon, b.lon) / this.cellDeg) + lonPad;
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const key = `${r},${c}`;
          const cell = this.cells.get(key);
          if (cell) cell.push(i);
          else this.cells.set(key, [i]);
        }
      }
    }
  }

  /** The nearest point of the route line within the grid's reach, or null. */
  project(lat: number, lon: number): RouteProjection | null {
    const segments = this.cells.get(`${Math.floor(lat / this.cellDeg)},${Math.floor(lon / this.cellDeg)}`);
    if (!segments) return null;
    let best: RouteProjection | null = null;
    const cosLat = Math.cos((lat * Math.PI) / 180);
    for (const i of segments) {
      const a = this.points[i - 1];
      const b = this.points[i];
      const ax = (a.lon - lon) * cosLat * M_PER_DEG;
      const ay = (a.lat - lat) * M_PER_DEG;
      const bx = (b.lon - lon) * cosLat * M_PER_DEG;
      const by = (b.lat - lat) * M_PER_DEG;
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2));
      const px = ax + t * dx;
      const py = ay + t * dy;
      const distanceM = Math.sqrt(px * px + py * py);
      if (!best || distanceM < best.distanceM) {
        best = { distanceM, km: a.dist + (b.dist - a.dist) * t, index: i - 1 };
      }
    }
    return best;
  }
}

/** Binary min-heap of (cost, node). */
class MinHeap {
  private readonly costs: number[] = [];
  private readonly nodes: number[] = [];
  get size(): number {
    return this.costs.length;
  }
  push(cost: number, node: number): void {
    this.costs.push(cost);
    this.nodes.push(node);
    let i = this.costs.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.costs[parent] <= this.costs[i]) break;
      this.swap(i, parent);
      i = parent;
    }
  }
  pop(): { cost: number; node: number } {
    const top = { cost: this.costs[0], node: this.nodes[0] };
    const lastCost = this.costs.pop()!;
    const lastNode = this.nodes.pop()!;
    if (this.costs.length > 0) {
      this.costs[0] = lastCost;
      this.nodes[0] = lastNode;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.costs.length && this.costs[l] < this.costs[m]) m = l;
        if (r < this.costs.length && this.costs[r] < this.costs[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number): void {
    [this.costs[a], this.costs[b]] = [this.costs[b], this.costs[a]];
    [this.nodes[a], this.nodes[b]] = [this.nodes[b], this.nodes[a]];
  }
}

export interface FindAccessOptions {
  /** Height in metres at a position, or null where there is no data. */
  elevationAt?: (lat: number, lon: number) => number | null;
  routeTouchM?: number;
  placeSnapM?: number;
  /** Give up on walks longer than this, one way (metres). Default 10 km. */
  maxWalkM?: number;
  /** Indices of route points that start a stretch after a route break. */
  breakStarts?: ReadonlySet<number>;
}

export interface AccessFound {
  ok: true;
  /** The network node where the walk meets the route. */
  junction: { lat: number; lon: number };
  /** Route km at the junction, on the scale of the points passed in. */
  junctionKm: number;
  /** One-way walk from the junction to the place, metres. */
  lengthM: number;
  /** Climb and descent walking in, from the junction to the place (3 m hysteresis). */
  ascentM: number;
  descentM: number;
  /** Of `lengthM`, the cross-country part between the place and the network. */
  offNetworkM: number;
  /** The walk, junction first, place last. */
  path: Array<[number, number]>;
}

export interface AccessNotFound {
  ok: false;
  reason: string;
}

export type AccessResult = AccessFound | AccessNotFound;

/** The cheapest round trip from the route to a place over the network. */
export function findAccess(
  network: WalkNetwork,
  place: { lat: number; lon: number },
  route: readonly AccessRoutePoint[],
  options: FindAccessOptions = {}
): AccessResult {
  const touchM = options.routeTouchM ?? DEFAULT_ROUTE_TOUCH_M;
  const snapM = options.placeSnapM ?? DEFAULT_PLACE_SNAP_M;
  const maxWalkM = options.maxWalkM ?? 10_000;
  const elevationAt = options.elevationAt ?? (() => null);

  if (network.lat.length === 0) return { ok: false, reason: 'no mapped ways nearby' };
  const grid = new NodeGrid(network, 0.002);
  const line = new RouteLine(route, touchM, options.breakStarts ?? new Set());

  const allSeeds = grid.within(place.lat, place.lon, snapM);
  if (allSeeds.length === 0) {
    return { ok: false, reason: `no mapped way within ${snapM} m of the place` };
  }
  const nearSeeds = allSeeds.filter(seed => seed.distanceM <= allSeeds[0].distanceM + PLACE_SNAP_SLACK_M);

  const elevations = new Map<number, number | null>();
  const ele = (node: number): number | null => {
    let value = elevations.get(node);
    if (value === undefined) {
      value = elevationAt(network.lat[node], network.lon[node]);
      elevations.set(node, value);
    }
    return value;
  };
  const placeEle = elevationAt(place.lat, place.lon);
  const climb = (a: number | null, b: number | null) => (a === null || b === null ? 0 : Math.abs(a - b));

  const touches = new Map<number, RouteProjection | null>();
  const touch = (node: number): RouteProjection | null => {
    let value = touches.get(node);
    if (value === undefined) {
      const projection = line.project(network.lat[node], network.lon[node]);
      value = projection && projection.distanceM <= touchM ? projection : null;
      touches.set(node, value);
    }
    return value;
  };

  // Effort is the round trip in flat-equivalent metres; walked is one way, to
  // bound the search by something a reader can picture.
  let effort = new Map<number, number>();
  let walked = new Map<number, number>();
  let prev = new Map<number, number>();

  const near = search(nearSeeds);
  if (near.ok || nearSeeds.length === allSeeds.length) return near;
  // The nearest ways lead nowhere (a fragment of driveway joined to nothing):
  // let the walk start from any way in reach.
  effort = new Map();
  walked = new Map();
  prev = new Map();
  return search(allSeeds);

  function search(seeds: ReadonlyArray<{ node: number; distanceM: number }>): AccessResult {
    const heap = new MinHeap();
    for (const { node, distanceM } of seeds) {
      // A walk that is cross-country all the way to the route — straight to a
      // node on the route itself — is a line over whatever lies between:
      // Rainbow Falls on the Great Ocean Walk read 225 m down a cliff, where
      // the falls are reached along the beach. Short ones stand, and so do
      // longer ones over gentle ground: the Heysen passes The Scrub Campsite
      // 231 m away through flat bush while its tracks join the trail 7 km
      // round by road.
      if (distanceM > MAX_CROSS_COUNTRY_ONLY_M && touch(node)) {
        const rise = climb(placeEle, ele(node));
        const gentle = distanceM <= MAX_GENTLE_CROSS_COUNTRY_M && rise <= distanceM * MAX_CROSS_COUNTRY_GRADE;
        if (!gentle) continue;
      }
      const cost = 2 * distanceM * OFF_NETWORK_PENALTY + CLIMB_EQUIVALENT_M * climb(placeEle, ele(node));
      if (cost < (effort.get(node) ?? Infinity)) {
        effort.set(node, cost);
        walked.set(node, distanceM);
        heap.push(cost, node);
      }
    }

    const done = new Set<number>();
    while (heap.size > 0) {
      const { cost, node } = heap.pop();
      if (done.has(node) || cost > (effort.get(node) ?? Infinity)) continue;
      done.add(node);

      const projection = touch(node);
      if (projection) return describe(node, projection);

      const here = walked.get(node)!;
      if (here > maxWalkM) continue;
      for (const { to, lengthM } of network.adj[node]) {
        if (done.has(to)) continue;
        const next = cost + 2 * lengthM + CLIMB_EQUIVALENT_M * climb(ele(node), ele(to));
        if (next < (effort.get(to) ?? Infinity)) {
          effort.set(to, next);
          walked.set(to, here + lengthM);
          prev.set(to, node);
          heap.push(next, to);
        }
      }
    }
    return { ok: false, reason: `no mapped way reaches the route within ${(maxWalkM / 1000).toFixed(1)} km` };
  }

  function describe(junctionNode: number, projection: RouteProjection): AccessFound {
    // prev runs from the junction back towards the place.
    const nodes: number[] = [junctionNode];
    for (let n = prev.get(junctionNode); n !== undefined; n = prev.get(n)) nodes.push(n);
    const first = nodes[nodes.length - 1];
    const offNetworkM = haversineDistance(place.lat, place.lon, network.lat[first], network.lon[first]);

    const path: Array<[number, number]> = nodes.map(n => [network.lat[n], network.lon[n]]);
    path.push([place.lat, place.lon]);
    const heights = nodes.map(ele);
    heights.push(placeEle);
    // A gap in the heights (the edge of the DEM, open water) is skipped over
    // rather than read as flat ground.
    const { gain, loss } = calculateElevationStats(
      heights.filter((h): h is number => h !== null).map(h => ({ ele: h }))
    );

    return {
      ok: true,
      junction: { lat: network.lat[junctionNode], lon: network.lon[junctionNode] },
      junctionKm: projection.km,
      lengthM: walked.get(junctionNode)!,
      ascentM: Math.round(gain),
      descentM: Math.round(loss),
      offNetworkM,
      path,
    };
  }
}
