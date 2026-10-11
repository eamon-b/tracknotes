/**
 * `data/trails/<dir>/access.json` — where each off-route waypoint is walked to
 * from, found over OpenStreetMap by `scripts/fetch-access.ts` and committed
 * beside the trail, like `pois.json`: reviewable, and read by the build with
 * no network.
 *
 * File shape:
 *
 * ```json
 * {
 *   "source": "OpenStreetMap ways via Overpass; heights from Copernicus GLO-30",
 *   "attribution": "© OpenStreetMap contributors (ODbL); Copernicus DEM © DLR e.V. 2010-2014 and © Airbus 2014-2018",
 *   "fetchedAt": "2026-10-11T10:00:00.000Z",
 *   "endpoint": "https://overpass.private.coffee/api/interpreter",
 *   "minDistanceM": 150,
 *   "places": {
 *     "w_9eb2986a": {
 *       "name": "Maekawa Campground",
 *       "method": "osm",
 *       "junction": [33.930011, 134.519143],
 *       "junctionKm": 111.89,
 *       "offTrailKm": 2.82,
 *       "ascentM": 9,
 *       "descentM": 2,
 *       "straightLineM": 1409,
 *       "nearestKm": 114.52,
 *       "path": [[33.930011, 134.519143], …]
 *     }
 *   }
 * }
 * ```
 *
 * Keyed by the stable ids in `data/waypoint-ids.json`, so an entry follows its
 * waypoint through renames. `method`:
 *
 * - `osm` — found by the fetch. The build places the waypoint at `junction`
 *   and gives it `offTrailKm` and `accessMode: 'foot'`.
 * - `manual` — written by hand (`junction` and `offTrailKm` required; the rest
 *   optional). Applied the same way, and a re-fetch carries it over unchanged,
 *   so a correction to OSM survives a refresh.
 * - `none` — the fetch found no way to the route (`reason` says why). Nothing
 *   is applied: the waypoint stays at the route point nearest it, as before.
 *
 * `straightLineM`/`nearestKm` record what the build would do without the
 * entry, so a reviewer can see what moved and how far.
 */

import * as fs from 'fs';
import * as path from 'path';

export const ACCESS_FILENAME = 'access.json';
export const ACCESS_SOURCE = 'OpenStreetMap ways via Overpass; heights from Copernicus GLO-30';
export const ACCESS_ATTRIBUTION =
  '© OpenStreetMap contributors (ODbL); Copernicus DEM © DLR e.V. 2010-2014 and © Airbus 2014-2018';

export type AccessMethod = 'osm' | 'manual' | 'none';

export interface TrailAccessEntry {
  name: string;
  method: AccessMethod;
  junction?: [number, number];
  junctionKm?: number;
  offTrailKm?: number;
  ascentM?: number;
  descentM?: number;
  straightLineM?: number;
  nearestKm?: number;
  path?: Array<[number, number]>;
  /** Why a `none` entry found nothing; free text on a `manual` one. */
  reason?: string;
}

export interface TrailAccessFile {
  source: string;
  attribution: string;
  fetchedAt: string;
  endpoint: string;
  /** Waypoints nearer the route than this were not looked at (metres). */
  minDistanceM: number;
  places: Record<string, TrailAccessEntry>;
}

/** What the build applies to one waypoint. */
export interface WaypointAccessPlacement {
  junction: { lat: number; lon: number };
  offTrailKm: number;
}

export function trailAccessPath(trailDir: string): string {
  return path.join(trailDir, ACCESS_FILENAME);
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isLatLon = (value: unknown): value is [number, number] =>
  Array.isArray(value) &&
  value.length === 2 &&
  isFiniteNumber(value[0]) &&
  isFiniteNumber(value[1]) &&
  Math.abs(value[0]) <= 90 &&
  Math.abs(value[1]) <= 180;

/** Parse and check a file's text. Throws, naming the file and the entry, on anything malformed. */
export function parseTrailAccessFile(text: string, filePath: string): TrailAccessFile {
  const fail = (message: string): never => {
    throw new Error(`${filePath}: ${message}`);
  };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return fail(`not valid JSON (${(error as Error).message})`);
  }
  if (typeof data !== 'object' || data === null) return fail('not an object');
  const file = data as Record<string, unknown>;
  for (const key of ['source', 'attribution', 'fetchedAt', 'endpoint'] as const) {
    if (typeof file[key] !== 'string') fail(`"${key}" must be a string`);
  }
  if (!isFiniteNumber(file.minDistanceM)) fail('"minDistanceM" must be a number');
  if (typeof file.places !== 'object' || file.places === null || Array.isArray(file.places)) {
    fail('"places" must be an object keyed by waypoint id');
  }
  const places = file.places as Record<string, unknown>;
  for (const [id, raw] of Object.entries(places)) {
    const where = `places["${id}"]`;
    if (typeof raw !== 'object' || raw === null) fail(`${where} is not an object`);
    const entry = raw as Record<string, unknown>;
    if (typeof entry.name !== 'string') fail(`${where}.name must be a string`);
    if (entry.method !== 'osm' && entry.method !== 'manual' && entry.method !== 'none') {
      fail(`${where}.method must be "osm", "manual" or "none"`);
    }
    if (entry.method === 'none') {
      if (typeof entry.reason !== 'string') fail(`${where}: a "none" entry needs a "reason"`);
      continue;
    }
    if (!isLatLon(entry.junction)) fail(`${where}.junction must be [lat, lon]`);
    if (!isFiniteNumber(entry.offTrailKm) || entry.offTrailKm < 0) fail(`${where}.offTrailKm must be a number ≥ 0`);
    for (const key of ['junctionKm', 'ascentM', 'descentM', 'straightLineM', 'nearestKm'] as const) {
      if (entry[key] !== undefined && !isFiniteNumber(entry[key])) fail(`${where}.${key} must be a number`);
    }
    if (entry.path !== undefined && !(Array.isArray(entry.path) && entry.path.every(isLatLon))) {
      fail(`${where}.path must be a list of [lat, lon]`);
    }
  }
  return data as TrailAccessFile;
}

export function readTrailAccessFile(trailDir: string): TrailAccessFile | null {
  const filePath = trailAccessPath(trailDir);
  if (!fs.existsSync(filePath)) return null;
  return parseTrailAccessFile(fs.readFileSync(filePath, 'utf-8'), filePath);
}

/** The placements the build applies: every `osm` and `manual` entry, by waypoint id. */
export function accessPlacements(file: TrailAccessFile | null): Map<string, WaypointAccessPlacement> {
  const placements = new Map<string, WaypointAccessPlacement>();
  if (!file) return placements;
  for (const [id, entry] of Object.entries(file.places)) {
    if (entry.method === 'none' || !entry.junction || entry.offTrailKm === undefined) continue;
    placements.set(id, {
      junction: { lat: entry.junction[0], lon: entry.junction[1] },
      offTrailKm: entry.offTrailKm,
    });
  }
  return placements;
}

/**
 * A fetch's entries over the previous file's. Hand-written (`manual`) entries
 * always survive; so does any previous entry for an id the fetch tried and
 * failed to query (`failedIds`), since a mirror timing out is not evidence
 * that the way it would have returned is gone. Everything else is replaced.
 */
export function mergeTrailAccess(
  previous: TrailAccessFile | null,
  fetched: Record<string, TrailAccessEntry>,
  failedIds: ReadonlySet<string>
): Record<string, TrailAccessEntry> {
  const merged: Record<string, TrailAccessEntry> = { ...fetched };
  for (const [id, entry] of Object.entries(previous?.places ?? {})) {
    if (entry.method === 'manual' || (failedIds.has(id) && !(id in fetched))) merged[id] = entry;
  }
  return merged;
}

/** Stable text: places sorted by id, each coordinate pair on one line. */
export function stringifyTrailAccessFile(file: TrailAccessFile): string {
  const places: Record<string, TrailAccessEntry> = {};
  for (const id of Object.keys(file.places).sort()) places[id] = file.places[id];
  const text = JSON.stringify({ ...file, places }, null, 2);
  return text.replace(/\[\s+(-?[\d.e-]+),\s+(-?[\d.e-]+)\s+\]/g, '[$1, $2]') + '\n';
}

export function writeTrailAccessFile(trailDir: string, file: TrailAccessFile): string {
  const filePath = trailAccessPath(trailDir);
  fs.writeFileSync(filePath, stringifyTrailAccessFile(file));
  return filePath;
}
