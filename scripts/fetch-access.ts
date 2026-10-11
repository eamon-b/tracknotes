/**
 * Find where each off-route waypoint is walked to from, over OpenStreetMap.
 *
 * The build attaches a waypoint to the route point nearest it in a straight
 * line. For a place a few hundred metres off that is the junction near enough;
 * for one further out it can be the wrong side of a climb (Shikoku's Maekawa
 * Campground: 1.4 km from the top of the Temple 20 climb, reached by 2.8 km of
 * flat road from the bottom). This script finds the real junction for every
 * waypoint at least `--min-distance` from the route — the one that makes the
 * round trip cheapest by Naismith's rule, over OSM's walkable ways with
 * heights from the Copernicus GLO-30 DEM (`@lib/access-routing`) — and writes
 * the results to `data/trails/<dir>/access.json` (`scripts/lib/trail-access-file.ts`),
 * which `build-trails.ts` applies with no network.
 *
 * Reads the route and waypoints from `public/data/generated/{id}.json`, so
 * `npm run build:trails` must have run.
 *
 * Usage: tsx scripts/fetch-access.ts <trail-id> [--endpoint <url>] [--timeout <s>]
 *          [--min-distance <m>] [--dry-run]
 *   - --endpoint <url>    Overpass instance (also `OVERPASS_ENDPOINT`); see
 *                         `fetch-pois.ts` on which mirrors answer
 *   - --timeout <s>       Overpass `[timeout:]` per query (default 90)
 *   - --min-distance <m>  waypoints nearer the route are left alone (default 150)
 *   - --only <id,…>       only these waypoints (a run that lost queries prints the list)
 *   - --dry-run           list the candidates and queries, fetch nothing
 *
 * Behind a proxy, Node's fetch needs `NODE_USE_ENV_PROXY=1` (Node ≥ 22.21).
 *
 * A query that fails is retried in up to three later passes; if it never
 * succeeds, the waypoints it covered keep whatever entry the file already had, the run says which, and
 * the script exits 1 — re-run until it exits 0. Hand-written `manual` entries
 * are never touched.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { buildWalkNetwork, findAccess, type WalkWay } from '../src/lib/access-routing.js';
import { snapToTrail } from '../src/lib/position-on-trail.js';
import { routeBreakStarts } from '../src/lib/route-breaks.js';
import { simplifyTrack } from '../src/lib/track-simplify.js';
import type { ProcessedTrail } from '../src/lib/trail-types.js';
import { isAccessWaypoint } from '../src/lib/waypoint-taxonomy.js';
import { CopernicusDem, type Bbox } from './lib/dem-sampler.js';
import {
  ACCESS_ATTRIBUTION,
  ACCESS_SOURCE,
  mergeTrailAccess,
  readTrailAccessFile,
  writeTrailAccessFile,
  type TrailAccessEntry,
} from './lib/trail-access-file.js';
import { trailDirsById } from './fetch-pois.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GENERATED_DIR = path.join(PROJECT_ROOT, 'public/data/generated');
const DATA_DIR = path.join(PROJECT_ROOT, 'data/trails');

const DEFAULT_ENDPOINT = 'https://overpass-api.de/api/interpreter';
const USER_AGENT = 'trail-maps fetch-access (+https://github.com/eamon-b/trail-maps)';
const M_PER_DEG = 111_320;

/**
 * Merged query boxes stay under this many km across, so one query stays cheap:
 * a 15-20 km box over a Japanese city is tens of thousands of ways, and public
 * mirrors answered those with HTTP 500 (2026-10-11) while 10 km boxes passed.
 */
const MAX_CLUSTER_KM = 10;

/** Passes over the queries that failed, and the pause before each repeat. */
const PASSES = 4;
const PASS_PAUSE_S = 60;

/** Highways nobody walks on, or that are not there yet. */
const UNWALKABLE_HIGHWAYS = new Set([
  'motorway',
  'motorway_link',
  'construction',
  'proposed',
  'abandoned',
  'razed',
  'raceway',
  'bus_guideway',
  'escape',
]);

/** Whether an OSM way's tags let someone walk along it. */
export function isWalkableWay(tags: Record<string, string> | undefined): boolean {
  if (!tags?.highway || UNWALKABLE_HIGHWAYS.has(tags.highway)) return false;
  const foot = tags.foot;
  if (foot === 'no' || foot === 'private' || foot === 'use_sidepath') return false;
  if (foot === 'yes' || foot === 'designated' || foot === 'permissive') return true;
  return tags.access !== 'no' && tags.access !== 'private';
}

export interface Candidate {
  id: string;
  name: string;
  lat: number;
  lon: number;
  straightLineM: number;
  nearestKm: number;
  /** The area to fetch ways for. */
  bbox: Bbox;
  /** The longest walk worth searching (metres). */
  maxWalkM: number;
}

/** The box around a place a walk to the route could plausibly use. */
export function searchBox(lat: number, lon: number, straightLineM: number): { bbox: Bbox; maxWalkM: number } {
  // Roads wind: allow a walk several times the straight line, and look that
  // far around the place for the ways it might take.
  const maxWalkM = Math.min(10_000, Math.max(3000, straightLineM * 4));
  const radiusM = Math.min(6000, Math.max(1500, straightLineM * 2.5));
  const dLat = radiusM / M_PER_DEG;
  const dLon = radiusM / (M_PER_DEG * Math.cos((lat * Math.PI) / 180));
  return { bbox: { west: lon - dLon, south: lat - dLat, east: lon + dLon, north: lat + dLat }, maxWalkM };
}

const union = (a: Bbox, b: Bbox): Bbox => ({
  west: Math.min(a.west, b.west),
  south: Math.min(a.south, b.south),
  east: Math.max(a.east, b.east),
  north: Math.max(a.north, b.north),
});
const overlaps = (a: Bbox, b: Bbox) => a.west <= b.east && b.west <= a.east && a.south <= b.north && b.south <= a.north;
const widthKm = (b: Bbox) =>
  Math.max(
    (b.north - b.south) * (M_PER_DEG / 1000),
    (b.east - b.west) * (M_PER_DEG / 1000) * Math.cos((((b.north + b.south) / 2) * Math.PI) / 180)
  );

/** Group candidates whose boxes overlap into one query each, while the union stays small. */
export function clusterCandidates(candidates: readonly Candidate[]): Array<{ bbox: Bbox; members: Candidate[] }> {
  const clusters: Array<{ bbox: Bbox; members: Candidate[] }> = [];
  for (const candidate of [...candidates].sort((a, b) => a.nearestKm - b.nearestKm)) {
    const into = clusters.find(
      c => overlaps(c.bbox, candidate.bbox) && widthKm(union(c.bbox, candidate.bbox)) <= MAX_CLUSTER_KM
    );
    if (into) {
      into.bbox = union(into.bbox, candidate.bbox);
      into.members.push(candidate);
    } else {
      clusters.push({ bbox: { ...candidate.bbox }, members: [candidate] });
    }
  }
  return clusters;
}

/**
 * The waypoints worth routing: far enough off the route, not a turn-off (which
 * is on the route by definition), and not one whose source file already says
 * how far off it is — unless that figure came from this file to begin with.
 */
export function selectCandidates(
  trail: Pick<ProcessedTrail, 'waypoints' | 'track'>,
  minDistanceM: number,
  ownIds: ReadonlySet<string>
): Candidate[] {
  const breakStarts = routeBreakStarts(trail.track.breaks, 'points');
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  for (const wp of trail.waypoints) {
    if (!wp.id || seen.has(wp.id) || isAccessWaypoint(wp.type)) continue;
    if (wp.offTrailKm !== undefined && !ownIds.has(wp.id)) continue;
    seen.add(wp.id);
    const snap = snapToTrail(wp.lat, wp.lon, trail.track.points, undefined, breakStarts);
    if (!snap || snap.offTrailMeters < minDistanceM) continue;
    candidates.push({
      id: wp.id,
      name: wp.name,
      lat: wp.lat,
      lon: wp.lon,
      straightLineM: snap.offTrailMeters,
      nearestKm: snap.currentKm,
      ...searchBox(wp.lat, wp.lon, snap.offTrailMeters),
    });
  }
  return candidates;
}

interface OverpassWay {
  type: string;
  nodes?: number[];
  geometry?: Array<{ lat: number; lon: number } | null>;
  tags?: Record<string, string>;
}

async function fetchWays(endpoint: string, bbox: Bbox, timeoutS: number): Promise<WalkWay[]> {
  const query =
    `[out:json][timeout:${timeoutS}];` +
    `way["highway"](${bbox.south.toFixed(5)},${bbox.west.toFixed(5)},${bbox.north.toFixed(5)},${bbox.east.toFixed(5)});` +
    'out body geom;';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), (timeoutS + 10) * 1000);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
      body: new URLSearchParams({ data: query }).toString(),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    let body: { elements?: OverpassWay[]; remark?: string };
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`not JSON: ${text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)}`);
    }
    // Overpass reports a timeout or memory limit as a remark on a 200 with a
    // truncated element list: treat it as a failure, not as an empty map.
    if (body.remark && /runtime error|timed out|out of memory/i.test(body.remark)) throw new Error(body.remark);
    const ways: WalkWay[] = [];
    for (const element of body.elements ?? []) {
      if (element.type !== 'way' || !isWalkableWay(element.tags) || !element.geometry) continue;
      // `out geom` leaves a null for a vertex outside the box; split there.
      let coords: Array<[number, number]> = [];
      let ids: number[] = [];
      const flush = () => {
        if (coords.length >= 2) ways.push({ coords, nodeIds: element.nodes ? ids : undefined });
        coords = [];
        ids = [];
      };
      element.geometry.forEach((vertex, i) => {
        if (!vertex) return flush();
        coords.push([vertex.lat, vertex.lon]);
        if (element.nodes) ids.push(element.nodes[i]);
      });
      flush();
    }
    return ways;
  } finally {
    clearTimeout(timer);
  }
}

function waysBbox(ways: readonly WalkWay[], start: Bbox): Bbox {
  const box = { ...start };
  for (const way of ways) {
    for (const [lat, lon] of way.coords) {
      box.south = Math.min(box.south, lat);
      box.north = Math.max(box.north, lat);
      box.west = Math.min(box.west, lon);
      box.east = Math.max(box.east, lon);
    }
  }
  return box;
}

const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;

function entryFor(candidate: Candidate, result: ReturnType<typeof findAccess>): TrailAccessEntry {
  const base = {
    name: candidate.name,
    straightLineM: Math.round(candidate.straightLineM),
    nearestKm: round(candidate.nearestKm, 2),
  };
  if (!result.ok) return { ...base, method: 'none', reason: result.reason };
  // A few metres is plenty for a reviewer's map and keeps the file small.
  const path = simplifyTrack(
    result.path.map(([lat, lon]) => ({ lat, lon })),
    5
  ).map(p => [round(p.lat, 6), round(p.lon, 6)] as [number, number]);
  return {
    name: base.name,
    method: 'osm',
    junction: [round(result.junction.lat, 6), round(result.junction.lon, 6)],
    junctionKm: round(result.junctionKm, 2),
    offTrailKm: round(result.lengthM / 1000, 2),
    ascentM: result.ascentM,
    descentM: result.descentM,
    straightLineM: base.straightLineM,
    nearestKm: base.nearestKm,
    path,
  };
}

interface Args {
  trailId: string;
  endpoint: string;
  timeoutS: number;
  minDistanceM: number;
  dryRun: boolean;
  /** Only these waypoint ids (what a run that lost queries prints). */
  only: Set<string> | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    trailId: '',
    endpoint: process.env.OVERPASS_ENDPOINT || DEFAULT_ENDPOINT,
    timeoutS: 90,
    minDistanceM: 150,
    dryRun: false,
    only: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === '--endpoint') args.endpoint = value();
    else if (arg === '--timeout') args.timeoutS = Number(value());
    else if (arg === '--min-distance') args.minDistanceM = Number(value());
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--only') args.only = new Set(value().split(',').map(id => id.trim()).filter(Boolean));
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else args.trailId = arg;
  }
  if (!args.trailId) throw new Error('usage: tsx scripts/fetch-access.ts <trail-id> [options]');
  if (!(args.timeoutS > 0) || !(args.minDistanceM >= 0)) throw new Error('--timeout and --min-distance must be numbers');
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const trailFile = path.join(GENERATED_DIR, `${args.trailId}.json`);
  if (!fs.existsSync(trailFile)) throw new Error(`${trailFile} not found — run npm run build:trails first`);
  const trailDir = trailDirsById(DATA_DIR).get(args.trailId);
  if (!trailDir) throw new Error(`no data/trails/*/trail.json with "id": "${args.trailId}"`);

  const trail = JSON.parse(fs.readFileSync(trailFile, 'utf-8')) as ProcessedTrail;
  const previous = readTrailAccessFile(trailDir);
  const ownIds = new Set(Object.keys(previous?.places ?? {}));
  const candidates = selectCandidates(trail, args.minDistanceM, ownIds).filter(
    c => previous?.places[c.id]?.method !== 'manual' && (!args.only || args.only.has(c.id))
  );
  const clusters = clusterCandidates(candidates);
  console.log(
    `${args.trailId}: ${candidates.length} waypoint(s) at least ${args.minDistanceM} m off the route, ` +
      `${clusters.length} quer${clusters.length === 1 ? 'y' : 'ies'}`
  );
  if (args.dryRun) {
    for (const cluster of clusters) {
      console.log(`  ${widthKm(cluster.bbox).toFixed(1)} km box: ${cluster.members.map(m => m.name).join(', ')}`);
    }
    return;
  }

  const breakStarts = routeBreakStarts(trail.track.breaks, 'points');
  const dem = new CopernicusDem();
  const fetched: Record<string, TrailAccessEntry> = {};
  const failedIds = new Set<string>();

  // Public mirrors fail queries in bursts (2026-10-11: a third of them 504'd
  // in one pass, and most of those answered minutes later), so failed queries
  // get further passes after a pause rather than ending the run.
  let pending = clusters.map((cluster, n) => ({ cluster, n }));
  for (let pass = 1; pass <= PASSES && pending.length > 0; pass++) {
    if (pass > 1) {
      console.log(`  pass ${pass}: retrying ${pending.length} failed quer${pending.length === 1 ? 'y' : 'ies'} in ${PASS_PAUSE_S} s`);
      await new Promise(resolve => setTimeout(resolve, PASS_PAUSE_S * 1000));
    }
    const failed: typeof pending = [];
    for (const { cluster, n } of pending) {
      const label = `[${n + 1}/${clusters.length}] ${widthKm(cluster.bbox).toFixed(1)} km box, ${cluster.members.length} place(s)`;
      let ways: WalkWay[];
      try {
        ways = await fetchWays(args.endpoint, cluster.bbox, args.timeoutS);
      } catch (error) {
        console.warn(`  ${label}: failed: ${(error as Error).message}`);
        failed.push({ cluster, n });
        await new Promise(resolve => setTimeout(resolve, 5000));
        continue;
      }
      // Overpass returns each way whole, running past the query box: load
      // heights for everything it returned, or the far ends read as unknown.
      await dem.load(waysBbox(ways, cluster.bbox));
      const network = buildWalkNetwork(ways);
      console.log(`  ${label}: ${ways.length} ways`);
      for (const member of cluster.members) {
        const result = findAccess(network, member, trail.track.points, {
          elevationAt: (lat, lon) => dem.at(lat, lon),
          maxWalkM: member.maxWalkM,
          breakStarts,
        });
        fetched[member.id] = entryFor(member, result);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    pending = failed;
  }
  for (const { cluster } of pending) for (const member of cluster.members) failedIds.add(member.id);

  // A run limited by --only says nothing about the places it left out.
  const keep = args.only
    ? new Set(Object.keys(previous?.places ?? {}).filter(id => !args.only!.has(id)))
    : new Set<string>();
  for (const id of failedIds) keep.add(id);
  const places = mergeTrailAccess(previous, fetched, keep);
  const filePath = writeTrailAccessFile(trailDir, {
    source: ACCESS_SOURCE,
    attribution: ACCESS_ATTRIBUTION,
    fetchedAt: new Date().toISOString(),
    endpoint: args.endpoint,
    minDistanceM: args.minDistanceM,
    places,
  });

  console.log('\n  km here → km by OSM   walk in        name');
  for (const candidate of candidates) {
    const entry = fetched[candidate.id];
    if (!entry) continue;
    if (entry.method === 'none') {
      console.log(`  ${candidate.nearestKm.toFixed(1).padStart(7)}  (unchanged)            ${candidate.name}: ${entry.reason}`);
      continue;
    }
    const moved = Math.abs((entry.junctionKm ?? 0) - candidate.nearestKm) >= 0.5 ? '  ← moved' : '';
    console.log(
      `  ${candidate.nearestKm.toFixed(1).padStart(7)} → ${entry.junctionKm!.toFixed(1).padStart(7)}   ` +
        `${entry.offTrailKm!.toFixed(2)} km +${entry.ascentM}/-${entry.descentM} m   ${candidate.name}${moved}`
    );
  }
  console.log(`\nWrote ${path.relative(PROJECT_ROOT, filePath)}`);
  if (failedIds.size > 0) {
    console.warn(
      `WARNING: ${failedIds.size} waypoint(s) kept their previous entry after failed queries; re-run with\n` +
        `  --only ${[...failedIds].sort().join(',')}`
    );
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (typeof invokedPath === 'string' && path.resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`Error: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
