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
 *   - --refresh           query Overpass even for boxes in the way cache
 *   - --max-cache-age <d> re-query a box whose cached answer is older than this many days (default 90)
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
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

import { buildWalkNetwork, findAccess, type AccessRoutePoint, type WalkWay } from '../src/lib/access-routing.js';
import { snapToTrail } from '../src/lib/position-on-trail.js';
import { routeBreakStarts } from '../src/lib/route-breaks.js';
import { DEFAULT_WAYPOINT_MAX_DISTANCE_METERS } from '../src/lib/trail-ingest.js';
import { simplifyTrack } from '../src/lib/track-simplify.js';
import { cumulativeKm } from '../src/lib/track-spurs.js';
import type { ProcessedTrail, RouteVariant } from '../src/lib/trail-types.js';
import { isAccessWaypoint } from '../src/lib/waypoint-taxonomy.js';
import { CopernicusDem, type Bbox } from './lib/dem-sampler.js';
import {
  ACCESS_ATTRIBUTION,
  ACCESS_SOURCE,
  mergeTrailAccess,
  readTrailAccessFile,
  trailAccessPath,
  writeTrailAccessFile,
  type TrailAccessEntry,
  type TrailAccessFile,
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

/** Pause after a failed query, and after a 429 that does not say how long to wait. */
const FAIL_PAUSE_S = 5;
const RATE_LIMIT_PAUSE_S = 30;
/** The longest a `Retry-After` is honoured for; past it the query fails into the next pass. */
const MAX_RETRY_AFTER_S = 300;

/** A cached Overpass answer older than this is fetched again (days). */
const DEFAULT_MAX_CACHE_AGE_DAYS = 90;

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
  /**
   * The alternate the place is walked to from, by name, when it is off an
   * alternate rather than the main route; `nearestKm` is then km along it.
   */
  variant?: string;
  /**
   * Near-duplicates the build merged into this waypoint (`dedupeWaypoints`).
   * They get the same entry: one place, and if only the survivor moved, the
   * next build's merge would keep the other copy, which has none.
   */
  mergedIds?: string[];
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
 * Types that mark a point of the route itself — a junction, a crossing, a km
 * marker, a route break — not a place anyone walks off it to reach. The CDT's
 * "Wyoming old route 6 branches off Wyoming old route 5" is a junction note.
 */
const NOT_DESTINATIONS = new Set([
  'junction',
  'milestone',
  'road-crossing',
  'inlet-crossing',
  'gap',
  'side-trip',
  'endpoint',
]);

/** A walk whose last, cross-country stretch is longer than this is printed for review (metres). */
const LONG_CROSS_COUNTRY_M = 150;

/** A waypoint this close to one of the trail's side trips is reached by it (metres). */
const ON_SIDE_TRIP_M = 200;

/**
 * The waypoints worth routing: far enough off the route, not a turn-off (which
 * is on the route by definition), not one on a side trip the trail draws (the
 * side trip is how it is reached: Shikoku's Okunoin is up a summit path from
 * the temple that OSM lacks, and routing over OSM found a road and a 250 m
 * cross-country climb from elsewhere instead), and not one whose source file
 * already says how far off it is — unless that figure came from this file.
 *
 * Then the same for places off an **alternate** rather than the main route
 * (Shikoku's Cotton Field Campground: 560 m off the Kamiyama alternative, 3 km
 * from the main route): every waypoint the main route did not match — an
 * off-trail row, or one of an alternate's own — whose nearest line is an
 * alternate, at least `minDistanceM` and at most the trail's match radius
 * (`waypointMaxDistance`, as the main route matches its waypoints) off it. It
 * is routed to that alternate's line, with km along the alternate
 * ({@link alternateRoute}). Side trips are not routed to: they are the way to
 * what is near them, and the same 200 m rule leaves those places alone.
 */
export function selectCandidates(
  trail: Pick<ProcessedTrail, 'waypoints' | 'track'> &
    Partial<Pick<ProcessedTrail, 'sideTrips' | 'alternates' | 'offTrailWaypoints' | 'config'>>,
  minDistanceM: number,
  ownIds: ReadonlySet<string>
): Candidate[] {
  const breakStarts = routeBreakStarts(trail.track.breaks, 'points');
  // Only the distance to the line is read, so the km along it can be left at 0.
  const sideTripLines = (trail.sideTrips ?? []).map(trip =>
    trip.points.map(p => ({ lat: p.lat, lon: p.lon, dist: 0 }))
  );
  const onSideTrip = (lat: number, lon: number) =>
    sideTripLines.some(line => (snapToTrail(lat, lon, line)?.offTrailMeters ?? Infinity) <= ON_SIDE_TRIP_M);
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const routable = (wp: { id?: string; type: string; offTrailKm?: number }): wp is { id: string; type: string } =>
    !!wp.id &&
    !seen.has(wp.id) &&
    !isAccessWaypoint(wp.type) &&
    !NOT_DESTINATIONS.has(wp.type) &&
    (wp.offTrailKm === undefined || ownIds.has(wp.id));
  for (const wp of trail.waypoints) {
    if (!routable(wp)) continue;
    seen.add(wp.id);
    const snap = snapToTrail(wp.lat, wp.lon, trail.track.points, undefined, breakStarts);
    if (!snap || snap.offTrailMeters < minDistanceM) continue;
    if (onSideTrip(wp.lat, wp.lon)) continue;
    candidates.push({
      id: wp.id,
      name: wp.name,
      lat: wp.lat,
      lon: wp.lon,
      straightLineM: snap.offTrailMeters,
      nearestKm: snap.currentKm,
      ...(wp.mergedIds?.length ? { mergedIds: [...wp.mergedIds] } : {}),
      ...searchBox(wp.lat, wp.lon, snap.offTrailMeters),
    });
  }

  // Off an alternate. The main route's rows (and the twins merged into them)
  // are its own, routed above or left alone there.
  for (const wp of trail.waypoints) for (const id of wp.mergedIds ?? []) seen.add(id);
  const alternates = routableAlternates(trail.alternates ?? []);
  if (alternates.length === 0) return candidates;
  const matchRadiusM = trail.config?.waypointMaxDistance ?? DEFAULT_WAYPOINT_MAX_DISTANCE_METERS;
  const lines = alternates.map(alt => ({ name: alt.name, line: alternateRoute(alt) }));
  const rows = [...(trail.offTrailWaypoints ?? []), ...alternates.flatMap(alt => alt.waypoints ?? [])];
  for (const wp of rows) {
    if (!routable(wp)) continue;
    seen.add(wp.id);
    let nearest: { name: string; offM: number; km: number } | null = null;
    for (const { name, line } of lines) {
      const snap = snapToTrail(wp.lat, wp.lon, line);
      if (snap && (nearest === null || snap.offTrailMeters < nearest.offM)) {
        nearest = { name, offM: snap.offTrailMeters, km: snap.currentKm };
      }
    }
    if (!nearest || nearest.offM < minDistanceM || nearest.offM > matchRadiusM) continue;
    // Nearer the main route, it is the main route's to route (or leave).
    const main = snapToTrail(wp.lat, wp.lon, trail.track.points, undefined, breakStarts);
    if (main && main.offTrailMeters <= nearest.offM) continue;
    if (onSideTrip(wp.lat, wp.lon)) continue;
    candidates.push({
      id: wp.id,
      name: wp.name,
      lat: wp.lat,
      lon: wp.lon,
      straightLineM: nearest.offM,
      nearestKm: nearest.km,
      variant: nearest.name,
      ...('mergedIds' in wp && wp.mergedIds?.length ? { mergedIds: [...wp.mergedIds] } : {}),
      ...searchBox(wp.lat, wp.lon, nearest.offM),
    });
  }
  return candidates;
}

/**
 * The alternates a place can be routed to: those with a line, and a name no
 * other alternate shares — the entry names its alternate, and the build would
 * apply it to every one of that name.
 */
export function routableAlternates(alternates: readonly RouteVariant[]): RouteVariant[] {
  const count = new Map<string, number>();
  for (const alt of alternates) count.set(alt.name, (count.get(alt.name) ?? 0) + 1);
  return alternates.filter(alt => alt.type === 'alternate' && alt.points.length >= 2 && count.get(alt.name) === 1);
}

/**
 * An alternate's line with km along it from `points[0]` — the branch point,
 * as the build turns every variant round to read forwards — which is the
 * scale a variant entry's `junctionKm`/`nearestKm` are on.
 */
export function alternateRoute(alternate: Pick<RouteVariant, 'points'>): AccessRoutePoint[] {
  return cumulativeKm(alternate.points).map((km, i) => ({
    lat: alternate.points[i].lat,
    lon: alternate.points[i].lon,
    dist: km,
  }));
}

interface OverpassWay {
  type: string;
  nodes?: number[];
  geometry?: Array<{ lat: number; lon: number } | null>;
  tags?: Record<string, string>;
}

/**
 * Overpass answers are kept here, keyed by box, so changing the routing and
 * running again re-routes from disk instead of re-downloading every query
 * (`--refresh` ignores the cache). Gitignored: it is a download cache.
 */
const CACHE_DIR = path.join(PROJECT_ROOT, 'data/osm-ways-cache');

/**
 * Seconds a `Retry-After` header asks for (delta-seconds or an HTTP date), or
 * null when there is none or it cannot be read.
 */
export function retryAfterSeconds(header: string | null, now = Date.now()): number | null {
  if (header === null || header.trim() === '') return null;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

/** A query the mirror refused for now: wait this long before the next one. */
export class RateLimitedError extends Error {
  constructor(
    message: string,
    readonly retryAfterS: number
  ) {
    super(message);
  }
}

/** How long to pause after a failed query (seconds). */
export function pauseAfterFailure(error: unknown): number {
  if (error instanceof RateLimitedError) return Math.min(MAX_RETRY_AFTER_S, Math.max(FAIL_PAUSE_S, error.retryAfterS));
  return FAIL_PAUSE_S;
}

/** Ways for a box, and when Overpass answered for it (the cache's age, or now). */
async function fetchWays(
  endpoint: string,
  bbox: Bbox,
  timeoutS: number,
  refresh: boolean,
  maxCacheAgeMs: number
): Promise<{ ways: WalkWay[]; answeredAt: Date }> {
  const box = `${bbox.south.toFixed(5)},${bbox.west.toFixed(5)},${bbox.north.toFixed(5)},${bbox.east.toFixed(5)}`;
  const cacheFile = path.join(CACHE_DIR, `${createHash('sha1').update(box).digest('hex')}.json`);
  if (!refresh && fs.existsSync(cacheFile)) {
    const answeredAt = fs.statSync(cacheFile).mtime;
    if (Date.now() - answeredAt.getTime() <= maxCacheAgeMs) {
      return { ways: parseWays(fs.readFileSync(cacheFile, 'utf-8')), answeredAt };
    }
  }
  const query = `[out:json][timeout:${timeoutS}];way["highway"](${box});out body geom;`;
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
    if (response.status === 429 || response.status === 503) {
      const wait = retryAfterSeconds(response.headers.get('retry-after'));
      // Overpass answers a busy slot with 429 and no header; a 503 without one
      // is an ordinary failure.
      if (wait !== null || response.status === 429) {
        throw new RateLimitedError(
          `HTTP ${response.status}, retry after ${wait ?? RATE_LIMIT_PAUSE_S} s`,
          wait ?? RATE_LIMIT_PAUSE_S
        );
      }
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const ways = parseWays(text);
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheFile, text);
    return { ways, answeredAt: new Date() };
  } finally {
    clearTimeout(timer);
  }
}

/** Walkable ways out of an Overpass JSON answer; throws on an error page or a truncated answer. */
function parseWays(text: string): WalkWay[] {
  let body: { elements?: OverpassWay[]; remark?: string };
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(
      `not JSON: ${text
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160)}`
    );
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
    ...(candidate.variant !== undefined ? { variant: candidate.variant } : {}),
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
    ...(base.variant !== undefined ? { variant: base.variant } : {}),
    junction: [round(result.junction.lat, 6), round(result.junction.lon, 6)],
    junctionKm: round(result.junctionKm, 2),
    offTrailKm: round(result.lengthM / 1000, 2),
    ascentM: result.ascentM,
    descentM: result.descentM,
    ...(result.offNetworkM >= 1 ? { crossCountryM: Math.round(result.offNetworkM) } : {}),
    straightLineM: base.straightLineM,
    nearestKm: base.nearestKm,
    path,
  };
}

/**
 * The file's places after a run: what it fetched over the previous file. A
 * run limited by `--only` says nothing about the places it left out, and a
 * query that failed says nothing about the places it covered, so the previous
 * entries for both are kept (as are `manual` ones, always).
 */
export function accessAfterRun(
  previous: TrailAccessFile | null,
  fetched: Record<string, TrailAccessEntry>,
  only: ReadonlySet<string> | null,
  failedIds: ReadonlySet<string>
): Record<string, TrailAccessEntry> {
  const keep = new Set(failedIds);
  if (only) for (const id of Object.keys(previous?.places ?? {})) if (!only.has(id)) keep.add(id);
  return mergeTrailAccess(previous, fetched, keep);
}

/**
 * `fetchedAt`: the oldest OpenStreetMap answer the file's entries rest on —
 * a cached box counts from when Overpass answered it, and a kept entry from
 * the previous file's own `fetchedAt` — so the date never claims fresher data
 * than the file has.
 */
export function oldestAnswer(
  answeredAt: readonly Date[],
  previous: TrailAccessFile | null,
  places: Record<string, TrailAccessEntry>,
  fetched: Record<string, TrailAccessEntry>,
  now = new Date()
): Date {
  let oldest = now;
  for (const at of answeredAt) if (at < oldest) oldest = at;
  const keptPrevious = Object.entries(places).some(
    ([id, entry]) => !(id in fetched) && entry.method !== 'manual' && previous?.places[id] === entry
  );
  if (keptPrevious && previous) {
    const at = new Date(previous.fetchedAt);
    if (!Number.isNaN(at.getTime()) && at < oldest) oldest = at;
  }
  return oldest;
}

interface Args {
  trailId: string;
  endpoint: string;
  timeoutS: number;
  minDistanceM: number;
  dryRun: boolean;
  /** Fetch from Overpass even when the cache has the box. */
  refresh: boolean;
  /** Fetch from Overpass when the cached answer is older than this (days). */
  maxCacheAgeDays: number;
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
    refresh: false,
    maxCacheAgeDays: DEFAULT_MAX_CACHE_AGE_DAYS,
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
    else if (arg === '--refresh') args.refresh = true;
    else if (arg === '--max-cache-age') args.maxCacheAgeDays = Number(value());
    else if (arg === '--only')
      args.only = new Set(
        value()
          .split(',')
          .map(id => id.trim())
          .filter(Boolean)
      );
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else args.trailId = arg;
  }
  if (!args.trailId) throw new Error('usage: tsx scripts/fetch-access.ts <trail-id> [options]');
  if (!(args.timeoutS > 0) || !(args.minDistanceM >= 0) || !(args.maxCacheAgeDays >= 0)) {
    throw new Error('--timeout, --min-distance and --max-cache-age must be numbers');
  }
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
  const alternateRoutes = new Map(
    routableAlternates(trail.alternates ?? []).map(alt => [alt.name, alternateRoute(alt)])
  );
  const dem = new CopernicusDem();
  const fetched: Record<string, TrailAccessEntry> = {};
  const failedIds = new Set<string>();
  const answeredAt: Date[] = [];

  // Public mirrors fail queries in bursts (2026-10-11: a third of them 504'd
  // in one pass, and most of those answered minutes later), so failed queries
  // get further passes after a pause rather than ending the run.
  let pending = clusters.map((cluster, n) => ({ cluster, n }));
  for (let pass = 1; pass <= PASSES && pending.length > 0; pass++) {
    if (pass > 1) {
      console.log(
        `  pass ${pass}: retrying ${pending.length} failed quer${pending.length === 1 ? 'y' : 'ies'} in ${PASS_PAUSE_S} s`
      );
      await new Promise(resolve => setTimeout(resolve, PASS_PAUSE_S * 1000));
    }
    const failed: typeof pending = [];
    for (const { cluster, n } of pending) {
      const label = `[${n + 1}/${clusters.length}] ${widthKm(cluster.bbox).toFixed(1)} km box, ${cluster.members.length} place(s)`;
      let ways: WalkWay[];
      try {
        const answer = await fetchWays(
          args.endpoint,
          cluster.bbox,
          args.timeoutS,
          args.refresh,
          args.maxCacheAgeDays * 86_400_000
        );
        ways = answer.ways;
        // Overpass returns each way whole, running past the query box: load
        // heights for everything it returned, or the far ends read as unknown.
        // A height that cannot be read fails the query like the ways would:
        // routing without it would take every climb as flat.
        await dem.load(waysBbox(ways, cluster.bbox));
        // Only an answer the entries are routed over dates the file.
        answeredAt.push(answer.answeredAt);
      } catch (error) {
        console.warn(`  ${label}: failed: ${(error as Error).message}`);
        failed.push({ cluster, n });
        await new Promise(resolve => setTimeout(resolve, pauseAfterFailure(error) * 1000));
        continue;
      }
      const network = buildWalkNetwork(ways);
      console.log(`  ${label}: ${ways.length} ways`);
      for (const member of cluster.members) {
        // A place off an alternate is walked to from that alternate's line.
        const result = findAccess(
          network,
          member,
          member.variant ? alternateRoutes.get(member.variant)! : trail.track.points,
          {
            elevationAt: (lat, lon) => dem.at(lat, lon),
            maxWalkM: member.maxWalkM,
            ...(member.variant ? {} : { breakStarts }),
          }
        );
        const entry = entryFor(member, result);
        fetched[member.id] = entry;
        for (const id of member.mergedIds ?? []) fetched[id] = entry;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    pending = failed;
  }
  for (const { cluster } of pending) for (const member of cluster.members) failedIds.add(member.id);

  const places = accessAfterRun(previous, fetched, args.only, failedIds);
  // No file means "no candidates" (see `trail-access-file.ts`), so a run whose
  // queries failed never leaves the trail without one by writing nothing, and
  // a run that found nothing to route leaves no file rather than an empty one.
  if (Object.keys(places).length === 0) {
    if (failedIds.size > 0) {
      console.warn(
        `WARNING: every query failed; no file written. Re-run with\n  --only ${[...failedIds].sort().join(',')}`
      );
      process.exitCode = 1;
      return;
    }
    const existing = trailAccessPath(trailDir);
    if (fs.existsSync(existing)) {
      fs.rmSync(existing);
      console.log(`\nNo waypoint to route; removed ${path.relative(PROJECT_ROOT, existing)}`);
    } else {
      console.log('\nNo waypoint to route; no file written');
    }
    return;
  }
  const filePath = writeTrailAccessFile(trailDir, {
    source: ACCESS_SOURCE,
    attribution: ACCESS_ATTRIBUTION,
    fetchedAt: oldestAnswer(answeredAt, previous, places, fetched).toISOString(),
    endpoint: args.endpoint,
    minDistanceM: args.minDistanceM,
    places,
  });

  console.log('\n  km here → km by OSM   walk in        name');
  for (const candidate of candidates) {
    const entry = fetched[candidate.id];
    if (!entry) continue;
    // A place off an alternate: its km are along that alternate.
    const on = candidate.variant ? ` (km along "${candidate.variant}")` : '';
    if (entry.method === 'none') {
      console.log(
        `  ${candidate.nearestKm.toFixed(1).padStart(7)}  (unchanged)            ${candidate.name}${on}: ${entry.reason}`
      );
      continue;
    }
    const moved =
      (Math.abs((entry.junctionKm ?? 0) - candidate.nearestKm) >= 0.5 ? '  ← moved' : '') +
      ((entry.crossCountryM ?? 0) > LONG_CROSS_COUNTRY_M ? `  ← ends ${entry.crossCountryM} m cross-country` : '');
    console.log(
      `  ${candidate.nearestKm.toFixed(1).padStart(7)} → ${entry.junctionKm!.toFixed(1).padStart(7)}   ` +
        `${entry.offTrailKm!.toFixed(2)} km +${entry.ascentM}/-${entry.descentM} m   ${candidate.name}${on}${moved}`
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
