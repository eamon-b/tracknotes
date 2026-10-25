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
 *       "crossCountryM": 5,
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
 * - `none` — the fetch found no way to the route (`reason` says why). The
 *   waypoint stays at the route point nearest it, and its walk is the straight
 *   line to the route (`offTrailKm`, no `accessMode`), not nothing. So is an
 *   `osm`/`manual` entry's the build ignores as stale.
 *
 * A trail with no file has had no waypoint worth routing: `fetch-access`
 * found none at least `--min-distance` off the route (or every one is a
 * turn-off, on a side trip, or already given a distance by its source — the
 * CDT's). It writes no file then (and removes an old one), and a run whose
 * every query failed writes none and exits 1, so an absent file means "no
 * candidates", never "not fetched yet".
 *
 * `straightLineM`/`nearestKm` record what the build would do without the
 * entry, so a reviewer can see what moved and how far.
 *
 * An entry with `variant` is for a place off one of the trail's alternates
 * rather than off the main route (Shikoku's Cotton Field Campground, a few
 * hundred metres off the Kamiyama alternative and 3 km from the main route):
 * `variant` names the alternate, its walk leaves from that alternate's line,
 * and `junctionKm`/`nearestKm` are km along the alternate from its start
 * (`points[0]`, the branch point), not trail km — the build adds the
 * alternate's `startDistance`. The build applies it to that alternate's
 * waypoints only (`variantAccess`), never to the main route.
 *
 * `store` (any entry) is what a resupply place sells — `full`, `limited`,
 * `meals` or `none` (`StoreKind` in `src/lib/types.ts`) — written by hand from
 * the place's description, and left out where the description does not make
 * it clear. A place with nothing to route (on the route, or already given its
 * distance by its source, like the CDT's) takes a **store-only** entry:
 * `name` and `store`, no `method`. The build gives every row of the waypoint
 * its `store` (`accessStores`) and nothing else; `fetch-access` never routes a
 * store-only entry, keeps it through a re-fetch, and carries an entry's
 * `store` over when it re-fetches that entry's walk. So a file can exist with
 * only store-only entries (the CDT's), which says nothing about routing.
 */

import * as fs from 'fs';
import * as path from 'path';
import { isStoreKind, type StoreKind } from '../../src/lib/types.js';

export const ACCESS_FILENAME = 'access.json';
export const ACCESS_SOURCE = 'OpenStreetMap ways via Overpass; heights from Copernicus GLO-30';
export const ACCESS_ATTRIBUTION =
  '© OpenStreetMap contributors (ODbL); Copernicus DEM © DLR e.V. 2010-2014 and © Airbus 2014-2018';

export type AccessMethod = 'osm' | 'manual' | 'none';

export interface TrailAccessEntry {
  name: string;
  /** Absent only on a store-only entry (`name` + `store`). */
  method?: AccessMethod;
  /** What the place sells, by hand from its description; absent when unclear. */
  store?: StoreKind;
  /**
   * The alternate the walk leaves from, by name, when it is not the main
   * route; `junctionKm`/`nearestKm` are then km along that alternate.
   */
  variant?: string;
  junction?: [number, number];
  junctionKm?: number;
  offTrailKm?: number;
  ascentM?: number;
  descentM?: number;
  /**
   * Of the walk, the part off any mapped way, between the place and the
   * nearest way. Long ones deserve a look: a landmark seen from a lookout, or
   * a place with no mapped path to it.
   */
  crossCountryM?: number;
  straightLineM?: number;
  nearestKm?: number;
  path?: Array<[number, number]>;
  /** Why a `none` entry found nothing; free text on a `manual` one. */
  reason?: string;
}

export interface TrailAccessFile {
  source: string;
  attribution: string;
  /**
   * The oldest Overpass answer the entries rest on: a box served from the way
   * cache counts from when it was downloaded, and an entry kept from the
   * previous file from that file's date.
   */
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
  ascentM?: number;
  descentM?: number;
  path?: Array<[number, number]>;
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
    if (entry.store !== undefined && !isStoreKind(entry.store)) {
      fail(`${where}.store must be "full", "limited", "meals" or "none"`);
    }
    if (entry.method === undefined) {
      if (entry.store === undefined) fail(`${where} needs a "method" (or, store-only, a "store")`);
      const extra = Object.keys(entry).filter(key => key !== 'name' && key !== 'store');
      if (extra.length > 0)
        fail(`${where}: a store-only entry has only "name" and "store" (found ${extra.join(', ')})`);
      continue;
    }
    if (entry.method !== 'osm' && entry.method !== 'manual' && entry.method !== 'none') {
      fail(`${where}.method must be "osm", "manual" or "none"`);
    }
    if (entry.variant !== undefined && (typeof entry.variant !== 'string' || entry.variant === '')) {
      fail(`${where}.variant must be an alternate's name`);
    }
    if (entry.method === 'none') {
      if (typeof entry.reason !== 'string') fail(`${where}: a "none" entry needs a "reason"`);
      continue;
    }
    if (!isLatLon(entry.junction)) fail(`${where}.junction must be [lat, lon]`);
    if (!isFiniteNumber(entry.offTrailKm) || entry.offTrailKm < 0) fail(`${where}.offTrailKm must be a number ≥ 0`);
    for (const key of ['junctionKm', 'ascentM', 'descentM', 'crossCountryM', 'straightLineM', 'nearestKm'] as const) {
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

/** What the build applies to one entry, or null for a `none` (or incomplete) one. */
function placementFor(entry: TrailAccessEntry): WaypointAccessPlacement | null {
  if (entry.method === undefined || entry.method === 'none' || !entry.junction || entry.offTrailKm === undefined)
    return null;
  return {
    junction: { lat: entry.junction[0], lon: entry.junction[1] },
    offTrailKm: entry.offTrailKm,
    ...(entry.ascentM !== undefined ? { ascentM: entry.ascentM } : {}),
    ...(entry.descentM !== undefined ? { descentM: entry.descentM } : {}),
    // Only a routed walk has a way to draw: a hand-written entry's path,
    // were one added, would say no more than its junction does.
    ...(entry.method === 'osm' && entry.path && entry.path.length >= 2 ? { path: entry.path } : {}),
  };
}

/**
 * The main route's placements: every `osm` and `manual` entry without a
 * `variant`, by waypoint id.
 */
export function accessPlacements(file: TrailAccessFile | null): Map<string, WaypointAccessPlacement> {
  const placements = new Map<string, WaypointAccessPlacement>();
  for (const [id, entry] of Object.entries(file?.places ?? {})) {
    if (entry.variant !== undefined) continue;
    const placement = placementFor(entry);
    if (placement) placements.set(id, placement);
  }
  return placements;
}

/**
 * The main route's waypoints the fetch found no way to (`none` entries without
 * a `variant`), by id: the build gives them the straight line to the route as
 * their walk.
 */
export function unroutedAccessIds(file: TrailAccessFile | null): Set<string> {
  return new Set(
    Object.entries(file?.places ?? {})
      .filter(([, entry]) => entry.method === 'none' && entry.variant === undefined)
      .map(([id]) => id)
  );
}

/** Every entry's `store`, by waypoint id: applied to every row of that waypoint. */
export function accessStores(file: TrailAccessFile | null): Map<string, StoreKind> {
  const stores = new Map<string, StoreKind>();
  for (const [id, entry] of Object.entries(file?.places ?? {})) if (entry.store) stores.set(id, entry.store);
  return stores;
}

/** The ids of entries with a walk to route or keep (`method` set) — not store-only ones. */
export function routedAccessIds(file: TrailAccessFile | null): Set<string> {
  return new Set(
    Object.entries(file?.places ?? {})
      .filter(([, entry]) => entry.method !== undefined)
      .map(([id]) => id)
  );
}

/** One alternate's entries, as the build applies them to its waypoints. */
export interface VariantAccessPlacements {
  placements: Map<string, WaypointAccessPlacement>;
  /** Its `none` entries: walked as the straight line to the alternate. */
  unrouted: Set<string>;
}

/** The entries with a `variant`, by alternate name, then waypoint id. */
export function variantAccess(file: TrailAccessFile | null): Map<string, VariantAccessPlacements> {
  const byVariant = new Map<string, VariantAccessPlacements>();
  for (const [id, entry] of Object.entries(file?.places ?? {})) {
    if (entry.variant === undefined) continue;
    let access = byVariant.get(entry.variant);
    if (!access) {
      access = { placements: new Map(), unrouted: new Set() };
      byVariant.set(entry.variant, access);
    }
    const placement = placementFor(entry);
    if (placement) access.placements.set(id, placement);
    else if (entry.method === 'none') access.unrouted.add(id);
  }
  return byVariant;
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
    if (entry.method === undefined && id in fetched) {
      // A store-only place the fetch has now found a walk to: keep its store.
      merged[id] = { ...fetched[id], store: entry.store };
    } else if (entry.method === undefined || entry.method === 'manual' || (failedIds.has(id) && !(id in fetched))) {
      merged[id] = entry;
    } else if (entry.store !== undefined && id in fetched) {
      // The walk is re-fetched; what the place sells is hand-written and stays.
      merged[id] = { ...fetched[id], store: entry.store };
    }
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
