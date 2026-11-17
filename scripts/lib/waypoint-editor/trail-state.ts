/**
 * The waypoint editor's view of one bundled trail, and its saves.
 *
 * The last build (`public/data/generated/<id>.json`) says which waypoints the
 * trail has, their stable ids, km and lists; the source files say what they are
 * *now*. Each built waypoint is joined back to its `<wpt>` by exact coordinates
 * (the build copies them unchanged), trying the registry entry first, because a
 * save moves the entry with the waypoint: a waypoint moved or renamed since the
 * build is still found, and the next build hands it the same id.
 *
 * A save writes, for one waypoint:
 *  - description: its entry in `descriptions.json` (added in km order,
 *    replaced, or removed when emptied);
 *  - position: the `<wpt>`'s `lat`/`lon`, the CalTopo marker the build types it
 *    from (so the type cannot change), and its registry entry (so a move of any
 *    distance keeps its id, comments and description); an `<ele>` the `<wpt>`
 *    has is looked up again for the new position (`elevation.ts`);
 *  - name: the `<wpt>`'s `<name>` and the CalTopo marker's title, both keeping
 *    their type prefix, the registry entry's name, and `descriptions.json`'s
 *    `name` aid.
 * Nothing else is touched; `build:trails` then turns the sources into data.
 *
 * A `<wpt>` added since the last build has no id yet (`pending`), so nothing
 * that keys by id is written for it: every edit goes to its `<wpt>` (the
 * description to its `<desc>`), and the build's id matching is run to say
 * which id the next build will give it.
 *
 * A `<wpt>` the build merged into a near-duplicate (`dedupeWaypoints`) has an
 * id and a live registry entry but no built row: the surviving row lists it in
 * `mergedIds`. It is joined to its `<wpt>` through its registry entry and
 * listed as a row of its own (`mergedInto`), so a redundant duplicate can be
 * deleted, or one that is a different place renamed apart.
 */

import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { routeBreakStarts } from '../../../src/lib/route-breaks';
import { snapToTrail } from '../../../src/lib/position-on-trail';
import { haversineDistance } from '../../../src/lib/distance';
import type { ProcessedTrail, RouteVariant } from '../../../src/lib/trail-types';
import { classifyWaypoint } from '../../../src/lib/waypoint-classifier';
import { WAYPOINT_DEDUPE_DEFAULT_RADIUS_METERS } from '../../../src/lib/waypoint-dedupe';
import {
  isAccessWaypoint,
  isResupplyWaypoint,
  isWaterWaypoint,
  WAYPOINT_TYPES,
  waypointTypeLabel,
} from '../../../src/lib/waypoint-taxonomy';
import { DESCRIPTIONS_FILENAME, MAX_DESCRIPTION_LENGTH, type CuratedDescriptionsFile } from '../waypoint-descriptions';
import {
  assignWaypointIds,
  MATCH_RADIUS_METERS,
  type WaypointForId,
  type WaypointRegistry,
  type WaypointRegistryEntry,
} from '../waypoint-ids';
import {
  PENDING_KEY_PREFIX,
  type EditorTrail,
  type EditorTrailSummary,
  type EditorWaypoint,
  type NewWaypointRequest,
  type PlacementKind,
  type WaypointDeleteRequest,
  type WaypointDeleteResponse,
  type WaypointEditRequest,
  type WaypointEditResponse,
  type WaypointExpected,
  type WaypointPlacement,
} from './api-types';
import { lookupElevation, routeElevation, type DemSource, type ElevationLookup } from './elevation';
import {
  addCaltopoFolder,
  editCaltopoMarker,
  editJsonPreservingLayout,
  elevationDecimals,
  findGpxWaypoint,
  formatCoordinate,
  formatElevation,
  gpxWaypointElevationStyle,
  insertGpxWaypoint,
  listGpxWaypoints,
  nearestCaltopoMarker,
  newFolderTitle,
  folderTitlesForType,
  readCaltopoExport,
  removeCaltopoFeature,
  removeGpxWaypoint,
  renameKeepingPrefix,
  setCaltopoMarkerFolder,
  setGpxWaypointDesc,
  setGpxWaypointElevation,
  setGpxWaypointName,
  setGpxWaypointPosition,
  setGpxWaypointType,
  stringifyJson,
  type CaltopoExport,
  type CaltopoMarkerInfo,
  type GpxWaypointSpan,
} from './sources';

export interface EditorPaths {
  /** Repository root. */
  root: string;
  /** `data/trails`. */
  trailsDir: string;
  /** `public/data/generated`. */
  generatedDir: string;
  /** `data/waypoint-ids.json`. */
  registryPath: string;
}

export function editorPaths(root: string): EditorPaths {
  return {
    root,
    trailsDir: path.join(root, 'data', 'trails'),
    generatedDir: path.join(root, 'public', 'data', 'generated'),
    registryPath: path.join(root, 'data', 'waypoint-ids.json'),
  };
}

/** A save that cannot go ahead; the API answers with `status`. */
export class EditorError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

/** Furthest a single save may move a waypoint: past this it is a slip, not a correction. */
export const MAX_MOVE_METERS = 50_000;
const MAX_NAME_LENGTH = 200;

interface TrailConfigFile {
  id?: string;
  name?: string;
  gpxFile?: string;
  geojsonFile?: string;
  dedupeWaypoints?: boolean | { radiusMeters?: number };
}

/** The radius the build merges same-name, same-type waypoints within (`buildTrail`), 0 when the trail does not merge. */
function dedupeRadiusMeters(config: TrailConfigFile): number {
  const dedupe = config.dedupeWaypoints;
  if (dedupe === true) return WAYPOINT_DEDUPE_DEFAULT_RADIUS_METERS;
  if (typeof dedupe !== 'object' || dedupe === null) return 0;
  return Math.max(0, dedupe.radiusMeters ?? WAYPOINT_DEDUPE_DEFAULT_RADIUS_METERS);
}

/** Why a trail's sources are not edited here, or undefined when they are. */
function readOnlyReason(trailId: string): string | undefined {
  if (trailId === 'te_araroa') {
    return 'Te Araroa is built upstream in te-araroa-data (npm run sync:te-araroa): fix its waypoints there, never here.';
  }
  return undefined;
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
}

function trailConfig(paths: EditorPaths, dir: string): TrailConfigFile {
  return readJson<TrailConfigFile>(path.join(paths.trailsDir, dir, 'trail.json'));
}

function trailDirs(paths: EditorPaths): string[] {
  return fs
    .readdirSync(paths.trailsDir)
    .filter(dir => fs.existsSync(path.join(paths.trailsDir, dir, 'trail.json')))
    .sort((a, b) => a.localeCompare(b));
}

/** The trail directory for `dir`, refusing anything that is not one (the API takes it from a URL). */
export function resolveTrailDir(paths: EditorPaths, dir: string): string {
  if (!trailDirs(paths).includes(dir)) throw new EditorError(`No trail directory "${dir}"`, 404);
  return dir;
}

function generatedPath(paths: EditorPaths, trailId: string): string {
  return path.join(paths.generatedDir, `${trailId}.json`);
}

export function listTrails(paths: EditorPaths): EditorTrailSummary[] {
  return trailDirs(paths).map(dir => {
    const config = trailConfig(paths, dir);
    const id = config.id ?? dir.toLowerCase();
    const summary: EditorTrailSummary = {
      dir,
      id,
      name: config.name ?? dir,
      built: fs.existsSync(generatedPath(paths, id)),
    };
    const reason = readOnlyReason(id);
    if (reason) summary.readOnlyReason = reason;
    return summary;
  });
}

function gpxFileName(paths: EditorPaths, dir: string, config: TrailConfigFile): string {
  if (config.gpxFile) return config.gpxFile;
  const found = fs.readdirSync(path.join(paths.trailsDir, dir)).find(f => f.toLowerCase().endsWith('.gpx'));
  if (!found) throw new EditorError(`${dir} has no GPX file`, 500);
  return found;
}

/** The CalTopo export the build reads (`findGeojsonFile` in `build-trails.ts`), if any. */
function geojsonFileName(paths: EditorPaths, dir: string, config: TrailConfigFile): string | undefined {
  const trailDir = path.join(paths.trailsDir, dir);
  if (config.geojsonFile && fs.existsSync(path.join(trailDir, config.geojsonFile))) return config.geojsonFile;
  for (const file of fs.readdirSync(trailDir)) {
    if (!file.toLowerCase().endsWith('.json') || file === 'trail.json' || file === 'climate.json') continue;
    try {
      if (Array.isArray(readJson<{ features?: unknown }>(path.join(trailDir, file)).features)) return file;
    } catch {
      // not JSON: the build skips it too
    }
  }
  return undefined;
}

interface AccessEntryLite {
  method?: string;
  store?: string;
}

function readAccess(trailDir: string): Record<string, AccessEntryLite> {
  const file = path.join(trailDir, 'access.json');
  if (!fs.existsSync(file)) return {};
  return readJson<{ places?: Record<string, AccessEntryLite> }>(file).places ?? {};
}

function readDescriptions(file: string): CuratedDescriptionsFile | null {
  return fs.existsSync(file) ? readJson<CuratedDescriptionsFile>(file) : null;
}

/** Everything one trail's view and saves need, read fresh from disk. */
interface TrailContext {
  dir: string;
  trailDir: string;
  trailId: string;
  name: string;
  readOnlyReason?: string;
  gpxPath: string;
  geojsonPath?: string;
  descriptionsPath: string;
  built: ProcessedTrail;
  builtAt: string;
  /** `dedupeWaypoints`' radius as trail.json has it now; 0 when off. */
  dedupeRadiusMeters: number;
}

function loadContext(paths: EditorPaths, dirParam: string): TrailContext {
  const dir = resolveTrailDir(paths, dirParam);
  const config = trailConfig(paths, dir);
  const trailId = config.id ?? dir.toLowerCase();
  const trailDir = path.join(paths.trailsDir, dir);
  const builtFile = generatedPath(paths, trailId);
  if (!fs.existsSync(builtFile)) {
    throw new EditorError(`${trailId} has not been built yet: run npm run build:trails (or Rebuild below)`, 409);
  }
  const geojson = geojsonFileName(paths, dir, config);
  const context: TrailContext = {
    dir,
    trailDir,
    trailId,
    name: config.name ?? dir,
    gpxPath: path.join(trailDir, gpxFileName(paths, dir, config)),
    descriptionsPath: path.join(trailDir, DESCRIPTIONS_FILENAME),
    built: readJson<ProcessedTrail>(builtFile),
    builtAt: fs.statSync(builtFile).mtime.toISOString(),
    dedupeRadiusMeters: dedupeRadiusMeters(config),
  };
  if (geojson) context.geojsonPath = path.join(trailDir, geojson);
  const reason = readOnlyReason(trailId);
  if (reason) context.readOnlyReason = reason;
  return context;
}

/** A built waypoint as the editor first meets it: one per id, with every list it is in. */
interface BuiltWaypoint {
  id: string;
  name: string;
  type: string;
  lat: number;
  lon: number;
  description?: string;
  placements: WaypointPlacement[];
  distanceFromTrailKm?: number;
  /** Ids of the near-duplicates the build merged into it, over every list it is in. */
  mergedIds?: string[];
}

function variantKind(variant: RouteVariant, alternate: boolean): PlacementKind {
  if (alternate) return 'alternate';
  return variant.type === 'terminus' ? 'terminus' : 'side-trip';
}

function collectBuiltWaypoints(trail: ProcessedTrail): BuiltWaypoint[] {
  const byId = new Map<string, BuiltWaypoint>();
  const add = (
    w: {
      id?: string;
      name: string;
      type: string;
      lat: number;
      lon: number;
      description?: string;
      mergedIds?: string[];
    },
    placement: WaypointPlacement,
    distanceFromTrailKm?: number
  ) => {
    if (!w.id) return;
    let entry = byId.get(w.id);
    if (!entry) {
      entry = { id: w.id, name: w.name, type: w.type, lat: w.lat, lon: w.lon, placements: [] };
      if (w.description) entry.description = w.description;
      byId.set(w.id, entry);
    }
    entry.placements.push(placement);
    if (distanceFromTrailKm !== undefined) entry.distanceFromTrailKm = distanceFromTrailKm;
    for (const id of w.mergedIds ?? []) {
      if (!entry.mergedIds?.includes(id)) entry.mergedIds = [...(entry.mergedIds ?? []), id];
    }
  };
  for (const w of trail.waypoints ?? []) add(w, { kind: 'main', km: w.totalDistance ?? w.distance });
  for (const w of trail.offTrailWaypoints ?? []) add(w, { kind: 'off-trail' }, w.distanceFromTrail);
  for (const v of trail.alternates ?? []) {
    for (const w of v.waypoints ?? []) add(w, { kind: variantKind(v, true), variant: v.name, km: w.distance });
  }
  for (const v of trail.sideTrips ?? []) {
    for (const w of v.waypoints ?? []) add(w, { kind: variantKind(v, false), variant: v.name, km: w.distance });
  }
  return [...byId.values()];
}

/**
 * A revisited place's later passes are `<id>_2`, `<id>_3`, sharing the first
 * pass's registry entry. Only a suffix after a whole id counts: `w_00176641`
 * is an id of its own, not pass 176641 of `w`.
 */
export function registryId(id: string): string {
  return id.replace(/^(.+_[^_]+)_\d+$/, '$1');
}

interface Joined {
  built: BuiltWaypoint;
  /** Current name and position (registry entry when found, else the build). */
  name: string;
  lat: number;
  lon: number;
  span: GpxWaypointSpan | null;
}

function joinToSources(
  builtWaypoints: BuiltWaypoint[],
  spans: GpxWaypointSpan[],
  registry: WaypointRegistry,
  trailId: string
): Joined[] {
  const entries = new Map((registry[trailId] ?? []).map(e => [e.id, e]));
  return builtWaypoints.map(built => {
    const entry = entries.get(registryId(built.id));
    const tries = entry
      ? [
          { lat: entry.lat, lon: entry.lon, name: entry.name },
          { lat: built.lat, lon: built.lon, name: built.name },
        ]
      : [{ lat: built.lat, lon: built.lon, name: built.name }];
    for (const at of tries) {
      const span = findGpxWaypoint(spans, at);
      // A later pass keeps its own built name; the registry entry names the first.
      if (span)
        return {
          built,
          name: registryId(built.id) === built.id ? at.name : built.name,
          lat: at.lat,
          lon: at.lon,
          span,
        };
    }
    return { built, name: built.name, lat: built.lat, lon: built.lon, span: null };
  });
}

/** A `<wpt>` the last build merged into `survivor` and dropped: it has an id and a registry entry, but no built row. */
interface MergedAway {
  id: string;
  survivor: Joined;
  entry: WaypointRegistryEntry;
  /** Null when its `<wpt>` is gone since the build. */
  span: GpxWaypointSpan | null;
}

/**
 * The merged-away duplicates, joined to their `<wpt>`s. The build drops the
 * row, so the registry entry is all that says where the `<wpt>` is: the join
 * is on the entry's exact coordinates (the build refreshes them, and a save
 * here keeps them in step), like every other join. One with no entry cannot be
 * placed and is not listed; nor is one that still has a row of its own in
 * another list, or whose `<wpt>` a built waypoint was joined to.
 */
function joinMergedAway(
  joined: readonly Joined[],
  spans: readonly GpxWaypointSpan[],
  registry: WaypointRegistry,
  trailId: string,
  taken: ReadonlySet<number>
): MergedAway[] {
  const builtIds = new Set(joined.map(j => j.built.id));
  const entries = new Map((registry[trailId] ?? []).map(e => [e.id, e]));
  const seen = new Set<string>();
  const merged: MergedAway[] = [];
  for (const survivor of joined) {
    for (const id of survivor.built.mergedIds ?? []) {
      if (builtIds.has(id) || seen.has(id) || registryId(id) !== id) continue;
      const entry = entries.get(id);
      if (!entry) continue;
      const span = findGpxWaypoint(spans, entry);
      if (span && taken.has(span.start)) continue;
      seen.add(id);
      merged.push({ id, survivor, entry, span });
    }
  }
  return merged;
}

/** What the build's merge compares: the cleaned name, the type and the position. */
interface MergeMember {
  id: string;
  name: string;
  type: string;
  lat: number;
  lon: number;
}

/**
 * The members the build would merge with `seed`: same name and type, chained
 * by gaps of at most `radiusMeters` (single linkage, as
 * `dedupeNearDuplicateWaypoints` clusters). Only among `members`: waypoints
 * the last build put in one list, so they are compared with each other again.
 */
function mergesWith(seed: MergeMember, members: readonly MergeMember[], radiusMeters: number): Set<string> {
  const group = new Set([seed.id]);
  const queue = [seed];
  const alike = members.filter(m => m.name === seed.name && m.type === seed.type);
  while (queue.length) {
    const at = queue.pop()!;
    for (const member of alike) {
      if (group.has(member.id)) continue;
      if (haversineDistance(at.lat, at.lon, member.lat, member.lon) > radiusMeters) continue;
      group.add(member.id);
      queue.push(member);
    }
  }
  return group;
}

/** The rows the last build merged into one (the survivor and its merged-away duplicates) whose `<wpt>`s are still there. */
function mergeGroup(rows: ReadonlyMap<string, EditorWaypoint>, survivorId: string): EditorWaypoint[] {
  const survivor = rows.get(survivorId);
  if (!survivor) return [];
  const group = [survivor, ...(survivor.mergedIds ?? []).flatMap(id => rows.get(id) ?? [])];
  return group.filter(w => !w.deleted);
}

/**
 * The duplicates merged with `leaving`'s survivor that the next build lists
 * again once `leaving` is out of the group (deleted, or renamed apart): the
 * ones it alone chained to the survivor.
 */
function freedByLeaving(
  rows: ReadonlyMap<string, EditorWaypoint>,
  leaving: EditorWaypoint,
  radiusMeters: number
): EditorWaypoint[] {
  if (!leaving.mergedInto) return [];
  const group = mergeGroup(rows, leaving.mergedInto);
  const survivor = group.find(w => w.id === leaving.mergedInto);
  if (!survivor) return [];
  const before = mergesWith(survivor, group, radiusMeters);
  const after = mergesWith(
    survivor,
    group.filter(w => w.id !== leaving.id),
    radiusMeters
  );
  return group.filter(w => w.id !== leaving.id && before.has(w.id) && !after.has(w.id));
}

/** A merged-away duplicate as a row: its own id, name and position, flagged with the waypoint it merged into. */
function toMergedWaypoint(
  context: TrailContext,
  merged: MergedAway,
  survivor: EditorWaypoint,
  curated: Map<string, string>,
  access: Record<string, AccessEntryLite>,
  sources: Sources
): EditorWaypoint {
  const { id, entry, span } = merged;
  const typeSource = span ? resolveSourceType(span, sources.caltopo) : null;
  const editable = !context.readOnlyReason && !!span;
  const waypoint: EditorWaypoint = {
    id,
    mergedInto: survivor.id,
    mergedDistanceM: haversineDistance(entry.lat, entry.lon, survivor.lat, survivor.lon),
    name: entry.name,
    type: typeSource?.type ?? entry.type,
    // The build dropped its row: what it built under this name and type is the survivor.
    builtType: merged.survivor.built.type,
    lat: entry.lat,
    lon: entry.lon,
    builtLat: entry.lat,
    builtLon: entry.lon,
    builtName: merged.survivor.built.name,
    placements: [],
    // Listed beside the waypoint it merged into.
    sortKm: survivor.sortKm,
    description: curated.get(id) ?? '',
    // Its position, type and description are not the app's while it is merged
    // (the survivor's are); a rename is what takes it out of the merge.
    canMove: false,
    canRename: editable,
    canDescribe: false,
    canChangeType: false,
    canDelete: editable,
  };
  if (typeSource)
    waypoint.typeSource = typeSourceText(typeSource, context.geojsonPath && path.basename(context.geojsonPath));
  if (!span && !context.readOnlyReason) waypoint.deleted = true;
  const ele = sourceElevation(span);
  if (ele !== undefined) waypoint.ele = ele;
  const sourceText = sourceDescription(span, sources.caltopo, entry);
  if (sourceText) waypoint.sourceDescription = sourceText;
  const accessEntry = access[id];
  if (accessEntry) {
    waypoint.access = {};
    if (accessEntry.method) waypoint.access.method = accessEntry.method;
    if (accessEntry.store) waypoint.access.store = accessEntry.store;
  }
  return waypoint;
}

/** Why a merged-away duplicate is locked, and what to do with it. */
function mergedLockedReason(context: TrailContext, waypoint: EditorWaypoint, survivor: EditorWaypoint): string {
  if (context.readOnlyReason) return context.readOnlyReason;
  if (waypoint.deleted) {
    return 'Its <wpt> is no longer in the GPX: deleted since the last build (or edited by hand). The next build retires its id; rebuild before editing it.';
  }
  const into = `“${waypoint.builtName}” (${survivor.id})`;
  if (waypoint.unmerges) {
    return `The last build merged this <wpt> into ${into}, but as the sources stand it is no longer a duplicate of it (the two differ in name or type, are more than ${context.dedupeRadiusMeters} m apart, or that waypoint is gone), so the next build lists it as a waypoint of its own under ${waypoint.id}. Rebuild, then edit it like any other; until then it can be renamed or deleted.`;
  }
  const apart = waypoint.mergedDistanceM ?? 0;
  const rule =
    apart <= context.dedupeRadiusMeters
      ? `the same name and type within ${context.dedupeRadiusMeters} m (dedupeWaypoints in trail.json)`
      : `the same name and type, each within ${context.dedupeRadiusMeters} m of another duplicate between the two (dedupeWaypoints in trail.json merges a chain)`;
  return `The last build merged this <wpt> into ${into}, ${Math.round(apart)} m away: ${rule}, so the app shows that one row and none for this. Delete it if it is a redundant duplicate. If it is a different place, rename it: under a name of its own the next build lists it again under ${waypoint.id}, and it can then be moved, retyped and described like any other. Its position, type and description are locked while it is merged: the app shows that waypoint's, so correct them there (the build appends this one's description, when it has one, to that waypoint's).`;
}

function displayPoints(trail: ProcessedTrail): { lat: number; lon: number; dist: number }[] {
  const points = trail.track.displayPoints?.length ? trail.track.displayPoints : trail.track.points;
  return points.map(p => ({ lat: p.lat, lon: p.lon, dist: p.dist }));
}

function sortKm(
  joined: Joined,
  points: { lat: number; lon: number; dist: number }[],
  starts: ReadonlySet<number>
): number {
  const main = joined.built.placements.find(p => p.kind === 'main');
  if (main?.km !== undefined) return main.km;
  return snapToTrail(joined.lat, joined.lon, points, undefined, starts)?.currentKm ?? 0;
}

/** The source files of one trail as they are on disk now. */
interface Sources {
  gpx: string;
  spans: GpxWaypointSpan[];
  geojsonText: string | null;
  caltopo: CaltopoExport | null;
  registry: WaypointRegistry;
}

function readSources(paths: EditorPaths, context: TrailContext): Sources {
  const gpx = fs.readFileSync(context.gpxPath, 'utf-8');
  const geojsonText = context.geojsonPath ? fs.readFileSync(context.geojsonPath, 'utf-8') : null;
  return {
    gpx,
    spans: listGpxWaypoints(gpx),
    geojsonText,
    caltopo: geojsonText === null ? null : readCaltopoExport(geojsonText),
    registry: readJson<WaypointRegistry>(paths.registryPath),
  };
}

/** What decides a `<wpt>`'s type in the build. */
export interface TypeSource {
  type: string;
  /**
   * - `caltopo-folder`: the folder of the nearest CalTopo marker with its name;
   * - `caltopo-title`: that marker's title (it is in no folder `FOLDER_TYPE_MAP` knows);
   * - `gpx-type`: the `<wpt>`'s `<type>`;
   * - `gpx-name`: its `<name>` (a prefix, a known town, or nothing: `waypoint`).
   */
  by: 'caltopo-folder' | 'caltopo-title' | 'gpx-type' | 'gpx-name';
  /** The name the build gives the waypoint (prefix removed). */
  cleanedName: string;
  /** For `gpx-name`: how the name typed it. */
  nameRule?: 'prefix' | 'known-town' | 'default';
  /** For `gpx-name` with a prefix: the prefix. */
  prefix?: string;
  marker?: CaltopoMarkerInfo;
}

/**
 * The type the build gives a `<wpt>`, and what decides it, exactly as
 * `build-trails.ts` does: the nearest CalTopo marker with the same cleaned
 * name wins (`resolveTrailWaypoints`); otherwise the GPX `<type>`, otherwise
 * the name (`flattenGpx`: `wpt.type || classifyWaypoint(name).type`).
 */
export function resolveSourceType(
  wpt: { name: string; type?: string; lat: number; lon: number },
  caltopo: CaltopoExport | null
): TypeSource {
  const classification = classifyWaypoint(wpt.name || 'Unnamed');
  const cleanedName = classification.cleanedName;
  if (caltopo && caltopo.markers.length > 0) {
    const marker = nearestCaltopoMarker(caltopo.markers, { lat: wpt.lat, lon: wpt.lon, name: cleanedName });
    if (marker) {
      return { type: marker.type, by: marker.typedByFolder ? 'caltopo-folder' : 'caltopo-title', cleanedName, marker };
    }
  }
  if (wpt.type) return { type: wpt.type, by: 'gpx-type', cleanedName };
  const source: TypeSource = {
    type: classification.type,
    by: 'gpx-name',
    cleanedName,
    nameRule:
      classification.source === 'prefix' || classification.source === 'known-town' ? classification.source : 'default',
  };
  if (classification.matchedPrefix) source.prefix = classification.matchedPrefix;
  return source;
}

function typeSourceText(source: TypeSource, geojsonFile: string | undefined): string {
  const file = geojsonFile ? ` in ${geojsonFile}` : '';
  switch (source.by) {
    case 'caltopo-folder':
      return `the CalTopo folder “${source.marker?.folderTitle ?? ''}” of its marker${file}`;
    case 'caltopo-title':
      return `the title “${source.marker?.title ?? ''}” of its CalTopo marker${file} (in no folder that sets a type)`;
    case 'gpx-type':
      return 'its GPX <type>';
    case 'gpx-name':
      if (source.nameRule === 'prefix') return `the prefix “${source.prefix ?? ''}” of its GPX <name>`;
      if (source.nameRule === 'known-town') return 'its name, a known town (no <type> in the GPX)';
      return 'nothing: no <type>, prefix or CalTopo folder, so it is unclassified';
  }
}

/** A pending waypoint's temporary key: stable while its `<wpt>` is unchanged, and never a valid id. */
function pendingKey(span: GpxWaypointSpan): string {
  const hash = createHash('sha1').update(`${span.lat}|${span.lon}|${span.name}`).digest('hex');
  return `${PENDING_KEY_PREFIX}${hash.slice(0, 10)}`;
}

function toEditorWaypoint(
  context: TrailContext,
  joined: Joined,
  curated: Map<string, string>,
  access: Record<string, AccessEntryLite>,
  sharers: Map<number, string[]>,
  sources: Sources,
  km: number
): EditorWaypoint {
  const { built, span } = joined;
  const locked = context.readOnlyReason
    ? context.readOnlyReason
    : span
      ? undefined
      : 'Its <wpt> is no longer in the GPX: deleted since the last build (or edited by hand). The next build retires its id; rebuild before editing it.';
  const typeSource = span ? resolveSourceType(span, sources.caltopo) : null;
  const waypoint: EditorWaypoint = {
    id: built.id,
    name: joined.name,
    type: typeSource?.type ?? built.type,
    builtType: built.type,
    lat: joined.lat,
    lon: joined.lon,
    builtLat: built.lat,
    builtLon: built.lon,
    builtName: built.name,
    placements: built.placements,
    sortKm: km,
    description: curated.get(built.id) ?? '',
    canMove: !locked,
    canRename: !locked,
    canDescribe: !context.readOnlyReason && !!span,
    canChangeType: !locked,
    // A later pass is built from the first pass's <wpt>: deleting it is deleting the first.
    canDelete: !locked && registryId(built.id) === built.id,
  };
  if (typeSource)
    waypoint.typeSource = typeSourceText(typeSource, context.geojsonPath && path.basename(context.geojsonPath));
  if (locked) waypoint.lockedReason = locked;
  if (!span && !context.readOnlyReason) waypoint.deleted = true;
  const ele = sourceElevation(span);
  if (ele !== undefined) waypoint.ele = ele;
  if (built.distanceFromTrailKm !== undefined) waypoint.distanceFromTrailM = built.distanceFromTrailKm;
  const sourceText = sourceDescription(span, sources.caltopo, joined);
  if (sourceText) waypoint.sourceDescription = sourceText;
  else if (!curated.has(built.id) && built.description) waypoint.sourceDescription = built.description;
  const accessEntry = access[registryId(built.id)];
  if (accessEntry) {
    waypoint.access = {};
    if (accessEntry.method) waypoint.access.method = accessEntry.method;
    if (accessEntry.store) waypoint.access.store = accessEntry.store;
  }
  const others = span ? (sharers.get(span.start) ?? []).filter(id => id !== built.id) : [];
  if (others.length) waypoint.sharesSourceWith = others;
  return waypoint;
}

/**
 * A `<wpt>` no built waypoint came from: added since the build, so it has no
 * id yet. It is edited like any other, but in its `<wpt>` alone: its
 * description is its `<desc>`, since `descriptions.json` keys by id.
 */
function toPendingWaypoint(
  context: TrailContext,
  span: GpxWaypointSpan,
  sources: Sources,
  points: { lat: number; lon: number; dist: number }[],
  starts: ReadonlySet<number>
): EditorWaypoint {
  const typeSource = resolveSourceType(span, sources.caltopo);
  const editable = !context.readOnlyReason;
  // The build shows a CalTopo marker's description in place of the <desc>
  // (`resolveTrailWaypoints`), so a <desc> written here would never be seen.
  const markerText = typeSource.marker?.description;
  const waypoint: EditorWaypoint = {
    id: pendingKey(span),
    pending: true,
    name: typeSource.cleanedName,
    type: typeSource.type,
    builtType: typeSource.type,
    typeSource: typeSourceText(typeSource, context.geojsonPath && path.basename(context.geojsonPath)),
    lat: span.lat,
    lon: span.lon,
    builtLat: span.lat,
    builtLon: span.lon,
    builtName: typeSource.cleanedName,
    placements: [],
    sortKm: snapToTrail(span.lat, span.lon, points, undefined, starts)?.currentKm ?? 0,
    description: span.desc?.trim() ?? '',
    canMove: editable,
    canRename: editable,
    canDescribe: editable && !markerText,
    canChangeType: editable,
    canDelete: editable,
  };
  const ele = sourceElevation(span);
  if (ele !== undefined) waypoint.ele = ele;
  if (context.readOnlyReason) waypoint.lockedReason = context.readOnlyReason;
  if (markerText) {
    waypoint.sourceDescription = markerText;
    waypoint.lockedReason ??= `Its CalTopo marker “${typeSource.marker?.title ?? ''}” has a description, which the build shows in place of the GPX <desc>, so its description cannot be edited here yet: rebuild to give it an id, then write curated text, which outranks both.`;
  }
  return waypoint;
}

/** A `<wpt>`'s `<ele>` in metres, when it has one that is a number. */
function sourceElevation(span: GpxWaypointSpan | null): number | undefined {
  if (!span?.ele) return undefined;
  const metres = Number(span.ele);
  return Number.isFinite(metres) ? metres : undefined;
}

/** The text the build would show without a curated entry: the CalTopo marker's, else the GPX `<desc>`. */
function sourceDescription(
  span: GpxWaypointSpan | null,
  caltopo: CaltopoExport | null,
  at: { name: string; lat: number; lon: number }
): string | undefined {
  if (caltopo) {
    const marker = nearestCaltopoMarker(caltopo.markers, at);
    if (marker?.description) return marker.description;
  }
  return span?.desc?.trim() || undefined;
}

function relative(paths: EditorPaths, file: string): string {
  return path.relative(paths.root, file).split(path.sep).join('/');
}

function buildEditorWaypoints(
  paths: EditorPaths,
  context: TrailContext,
  sources = readSources(paths, context)
): EditorWaypoint[] {
  const curated = new Map(
    (readDescriptions(context.descriptionsPath)?.descriptions ?? []).map(d => [d.waypointId, d.description])
  );
  const access = readAccess(context.trailDir);
  const joined = joinToSources(collectBuiltWaypoints(context.built), sources.spans, sources.registry, context.trailId);
  const sharers = new Map<number, string[]>();
  for (const j of joined) {
    if (!j.span) continue;
    sharers.set(j.span.start, [...(sharers.get(j.span.start) ?? []), j.built.id]);
  }
  const points = displayPoints(context.built);
  const starts = routeBreakStarts(context.built.track.breaks, 'displayPoints');
  const built = joined.map(j =>
    toEditorWaypoint(context, j, curated, access, sharers, sources, sortKm(j, points, starts))
  );

  // The <wpt>s the build merged into a near-duplicate (`dedupeWaypoints`): each
  // has an id but no built row, and is listed beside the waypoint it merged into.
  const rows = new Map(built.map(w => [w.id, w]));
  const mergedAway = joinMergedAway(joined, sources.spans, sources.registry, context.trailId, new Set(sharers.keys()));
  const merged = mergedAway.map(m =>
    toMergedWaypoint(context, m, rows.get(m.survivor.built.id)!, curated, access, sources)
  );
  for (const w of merged) rows.set(w.id, w);
  for (const j of joined) {
    if (j.built.mergedIds?.length) rows.get(j.built.id)!.mergedIds = j.built.mergedIds;
  }
  for (const w of merged) {
    // Still a duplicate, as the sources stand? Only while the waypoint it
    // merged into is there and the build would chain the two together again.
    const survivor = rows.get(w.mergedInto!)!;
    const group = mergeGroup(rows, survivor.id);
    const stays = !w.deleted && !survivor.deleted && mergesWith(survivor, group, context.dedupeRadiusMeters).has(w.id);
    if (!stays && !w.deleted) w.unmerges = true;
    w.lockedReason = mergedLockedReason(context, w, survivor);
  }

  // A <wpt> none of those came from is new since the build, unless a live
  // registry entry sits exactly on it under its name: then it has an id the
  // editor cannot place (the build and the registry are out of step).
  const used = new Set([...sharers.keys(), ...mergedAway.flatMap(m => (m.span ? [m.span.start] : []))]);
  const live = (sources.registry[context.trailId] ?? []).filter(e => !e.retired);
  const hasId = (span: GpxWaypointSpan) => {
    const name = classifyWaypoint(span.name || 'Unnamed').cleanedName;
    return live.some(e => e.lat === span.lat && e.lon === span.lon && e.name === name);
  };
  const pending = sources.spans
    .filter(span => !used.has(span.start) && !hasId(span))
    .map(span => toPendingWaypoint(context, span, sources, points, starts));
  // In km order, each merged-away duplicate straight after the waypoint it merged into.
  const ordered = [...built, ...pending].sort((a, b) => a.sortKm - b.sortKm || a.name.localeCompare(b.name));
  return ordered.flatMap(w => [w, ...merged.filter(m => m.mergedInto === w.id)]);
}

export function loadEditorTrail(paths: EditorPaths, dirParam: string): EditorTrail {
  const context = loadContext(paths, dirParam);
  const built = context.built;
  const trail: EditorTrail = {
    dir: context.dir,
    id: context.trailId,
    name: context.name,
    files: {
      gpx: relative(paths, context.gpxPath),
      descriptions: relative(paths, context.descriptionsPath),
      registry: relative(paths, paths.registryPath),
    },
    track: {
      points: displayPoints(built),
      breaks: built.track.breaks,
      variants: [...(built.alternates ?? []), ...(built.sideTrips ?? [])].map(v => ({
        name: v.name,
        type: v.type,
        line: (v.points ?? []).map(p => [p.lat, p.lon] as [number, number]),
      })),
    },
    waypoints: buildEditorWaypoints(paths, context),
    pois: (built.pois ?? [])
      .filter(p => !p.duplicateOf && !p.duplicateOfPoi)
      .map(p => ({ id: `${p.type}/${p.id}`, name: p.name ?? '', category: p.category, lat: p.lat, lon: p.lon })),
    builtAt: context.builtAt,
    maxDescriptionLength: MAX_DESCRIPTION_LENGTH,
  };
  if (context.geojsonPath) trail.files.geojson = relative(paths, context.geojsonPath);
  if (context.readOnlyReason) trail.readOnlyReason = context.readOnlyReason;
  return trail;
}

// ---------------------------------------------------------------------------
// Saves
// ---------------------------------------------------------------------------

const OFFERED_TYPES: ReadonlySet<string> = new Set<string>(WAYPOINT_TYPES);

function sameCoordinate(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9;
}

function validName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) throw new EditorError('A waypoint needs a name');
  if (name.length > MAX_NAME_LENGTH || /[\r\n\t]/.test(name)) throw new EditorError('That name is not usable');
  return name;
}

/** Refuse a name the build would strip a type prefix from: what is typed here is the name it shows. */
function assertNoTypePrefix(name: string): void {
  const classified = classifyWaypoint(name);
  if (classified.cleanedName !== name) {
    throw new EditorError(
      `“${name}” starts with the type prefix “${classified.matchedPrefix ?? ''}”, which the build strips from names: leave it off (the type comes from Type).`
    );
  }
}

/** Refuse a position too far from the route to be meant. */
function assertNearRoute(context: TrailContext, lat: number, lon: number): void {
  const points = displayPoints(context.built);
  const snap = snapToTrail(lat, lon, points, undefined, routeBreakStarts(context.built.track.breaks, 'displayPoints'));
  if (!snap || snap.offTrailMeters > MAX_MOVE_METERS) {
    throw new EditorError(`That is more than ${MAX_MOVE_METERS / 1000} km from the route; a slip of the mouse?`);
  }
}

const SAME_POSITION_ERROR =
  'Another <wpt> is at exactly this position, and the editor tells waypoints apart by their coordinates: place it a little to one side.';

/** Why a `<wpt>` with no id yet cannot have the type asked for: the build would give it another. */
function typeClashError(
  context: TrailContext,
  resolved: TypeSource,
  type: string,
  at: { lat: number; lon: number }
): EditorError {
  const marker = resolved.marker;
  return new EditorError(
    marker
      ? `A CalTopo marker titled “${marker.title}” in ${path.basename(context.geojsonPath!)}, ${(haversineDistance(at.lat, at.lon, marker.lat, marker.lon) / 1000).toFixed(1)} km away, would type it as ${marker.type}: the build types a waypoint from the nearest marker with its name. Give it a name of its own.`
      : `The build would type it as ${resolved.type}, not ${type}.`
  );
}

function validType(raw: unknown): string {
  if (typeof raw !== 'string' || !OFFERED_TYPES.has(raw)) {
    throw new EditorError(`"${String(raw)}" is not one of the waypoint types the editor offers (WAYPOINT_TYPES)`);
  }
  return raw;
}

function validPosition(lat: unknown, lon: unknown): { lat: number; lon: number } {
  if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new EditorError('A position needs both lat and lon as numbers');
  }
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new EditorError('That position is not on Earth');
  return { lat, lon };
}

function validate(request: WaypointEditRequest, current: EditorWaypoint, maxDescription: number): void {
  if (request.description !== undefined) {
    if (typeof request.description !== 'string') throw new EditorError('description must be a string');
    if (request.description.trim().length > maxDescription) {
      throw new EditorError(`The description is longer than ${maxDescription} characters`);
    }
    if (!current.canDescribe) throw new EditorError(current.lockedReason ?? 'This description cannot be edited here');
  }
  if (request.name !== undefined) {
    validName(request.name);
    if (!current.canRename) throw new EditorError(current.lockedReason ?? 'This waypoint cannot be renamed here');
  }
  if (request.type !== undefined) {
    validType(request.type);
    if (!current.canChangeType) throw new EditorError(current.lockedReason ?? 'This waypoint cannot be retyped here');
  }
  if (request.lat !== undefined || request.lon !== undefined) {
    const { lat, lon } = validPosition(request.lat, request.lon);
    if (!current.canMove) throw new EditorError(current.lockedReason ?? 'This waypoint cannot be moved here');
    if (haversineDistance(current.lat, current.lon, lat, lon) > MAX_MOVE_METERS) {
      throw new EditorError(`That moves the waypoint more than ${MAX_MOVE_METERS / 1000} km; a slip of the mouse?`);
    }
  }
}

function assertExpected(expected: WaypointExpected | undefined, current: EditorWaypoint): void {
  if (
    !expected ||
    expected.name !== current.name ||
    !sameCoordinate(expected.lat, current.lat) ||
    !sameCoordinate(expected.lon, current.lon) ||
    expected.description !== current.description ||
    (expected.type !== undefined && expected.type !== current.type)
  ) {
    throw new EditorError(
      'This waypoint changed on disk since the page read it: reload the trail and redo the edit.',
      409
    );
  }
}

/** Where a new description entry goes: main-route entries by km, then the rest by position. */
function descriptionOrder(
  entries: { waypointId: string }[],
  waypointId: string,
  waypoints: Map<string, EditorWaypoint>
): number {
  const key = (id: string): [number, number] | null => {
    const w = waypoints.get(id);
    if (!w) return null;
    return [w.placements.some(p => p.kind === 'main') ? 0 : 1, w.sortKm];
  };
  const mine = key(waypointId);
  if (!mine) return entries.length;
  const index = entries.findIndex(e => {
    const theirs = key(e.waypointId);
    return theirs !== null && (theirs[0] > mine[0] || (theirs[0] === mine[0] && theirs[1] > mine[1]));
  });
  return index === -1 ? entries.length : index;
}

const NEW_DESCRIPTIONS_NOTE =
  'Curated waypoint descriptions, keyed by the stable ids in data/waypoint-ids.json. Applied by scripts/build-trails.ts (overriding any description from the GPX/GeoJSON source) and uploadable to the comments API with scripts/upload-descriptions.ts. Main-route entries come first in km order; off-trail, alternate and side-trip entries follow by their position along the route.';

/** `descriptions.json` with one entry added, replaced or (for '') removed; null when unchanged. */
function describedText(
  context: TrailContext,
  waypoint: EditorWaypoint,
  text: string,
  name: string,
  waypoints: Map<string, EditorWaypoint>
): string | null {
  const existing = fs.existsSync(context.descriptionsPath) ? fs.readFileSync(context.descriptionsPath, 'utf-8') : null;
  if (existing === null && !text) return null;
  const source =
    existing ??
    stringifyJson(
      { trailId: context.trailId, note: NEW_DESCRIPTIONS_NOTE, descriptions: [] },
      { indent: 2, trailingNewline: true, asciiOnly: false }
    );
  const next = editJsonPreservingLayout<CuratedDescriptionsFile>(source, DESCRIPTIONS_FILENAME, file => {
    const index = file.descriptions.findIndex(d => d.waypointId === waypoint.id);
    if (!text) {
      if (index !== -1) file.descriptions.splice(index, 1);
      return;
    }
    if (index !== -1) {
      file.descriptions[index] = { ...file.descriptions[index], name, description: text };
    } else {
      const at = descriptionOrder(file.descriptions, waypoint.id, waypoints);
      file.descriptions.splice(at, 0, { waypointId: waypoint.id, name, description: text });
    }
  });
  return next === existing ? null : next;
}

/** `descriptions.json` with the entry's `name` aid following a rename; null when unchanged. */
function renamedDescriptionText(context: TrailContext, id: string, name: string): string | null {
  if (!fs.existsSync(context.descriptionsPath)) return null;
  const existing = fs.readFileSync(context.descriptionsPath, 'utf-8');
  const next = editJsonPreservingLayout<CuratedDescriptionsFile>(existing, DESCRIPTIONS_FILENAME, file => {
    for (const d of file.descriptions) if (d.waypointId === id && d.name !== undefined) d.name = name;
  });
  return next === existing ? null : next;
}

/** `descriptions.json` without the entries for `ids`; null when it has none of them. */
function withoutDescriptionsText(context: TrailContext, ids: readonly string[]): string | null {
  if (!fs.existsSync(context.descriptionsPath)) return null;
  const existing = fs.readFileSync(context.descriptionsPath, 'utf-8');
  const next = editJsonPreservingLayout<CuratedDescriptionsFile>(existing, DESCRIPTIONS_FILENAME, file => {
    file.descriptions = file.descriptions.filter(d => !ids.includes(d.waypointId));
  });
  return next === existing ? null : next;
}

/** The registry with the waypoint's entry moved, renamed and/or retyped; null when it has none or nothing changed. */
function registryText(
  paths: EditorPaths,
  trailId: string,
  id: string,
  edit: { lat?: number; lon?: number; name?: string; type?: string }
): string | null {
  const existing = fs.readFileSync(paths.registryPath, 'utf-8');
  let found = false;
  const next = editJsonPreservingLayout<WaypointRegistry>(existing, 'waypoint-ids.json', registry => {
    const entry = (registry[trailId] ?? []).find(e => e.id === registryId(id));
    if (!entry) return;
    found = true;
    if (edit.lat !== undefined && edit.lon !== undefined) {
      entry.lat = Number(formatCoordinate(edit.lat));
      entry.lon = Number(formatCoordinate(edit.lon));
    }
    if (edit.name !== undefined && registryId(id) === id) entry.name = edit.name;
    if (edit.type !== undefined) entry.type = edit.type;
  });
  return !found || next === existing ? null : next;
}

// ---------------------------------------------------------------------------
// Ids: what the next build would do
// ---------------------------------------------------------------------------

/** What `assignWaypointIds` is handed for these sources: every `<wpt>`, in file order, named and typed as the build does. */
function idInputs(spans: readonly GpxWaypointSpan[], caltopo: CaltopoExport | null): WaypointForId[] {
  return spans.map(span => {
    const source = resolveSourceType(span, caltopo);
    return { name: source.cleanedName, type: source.type, lat: span.lat, lon: span.lon };
  });
}

interface IdRun {
  registry: WaypointRegistry;
  inputs: WaypointForId[];
}

/**
 * Run the build's id matching (on a copy of the registry) over the sources
 * before and after an edit, and refuse the edit if any waypoint the two share
 * would come out of the next build with a different id: that is a waypoint
 * losing its comments and description. `pairs` maps each after-index to the
 * before-index of the same `<wpt>`. Returns the ids after, and the build's
 * warnings about the after state.
 */
function assertIdsKept(
  trailId: string,
  before: IdRun,
  after: IdRun,
  pairs: readonly [number, number][]
): { ids: string[]; warnings: string[] } {
  let beforeIds: string[];
  try {
    beforeIds = assignWaypointIds(trailId, before.inputs, structuredClone(before.registry));
  } catch (error) {
    throw new EditorError(
      `The sources as they are would already stop the build, so the editor cannot check what this edit does to ids: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const warnings: string[] = [];
  let ids: string[];
  try {
    ids = assignWaypointIds(trailId, after.inputs, structuredClone(after.registry), m => warnings.push(m.trim()));
  } catch (error) {
    throw new EditorError(`That would stop the next build: ${error instanceof Error ? error.message : String(error)}`);
  }
  const lost = pairs
    .filter(([a, b]) => ids[a] !== beforeIds[b])
    .map(([a, b]) => `“${after.inputs[a].name}” (${beforeIds[b]} would become ${ids[a]})`);
  if (lost.length) {
    throw new EditorError(
      `That would change the id of ${lost.join(', ')}, orphaning the comments and description keyed to it; the editor will not do that.`
    );
  }
  return { ids, warnings };
}

// ---------------------------------------------------------------------------
// Elevation: the <ele> of a <wpt> that is added or moved
// ---------------------------------------------------------------------------

/**
 * The asynchronous half of a save that places a waypoint (an add or a move):
 * the elevation at the position, from the route or else from `dem`
 * (`elevation.ts`), for the caller to hand to {@link addWaypoint} or
 * {@link saveWaypointEdit}, which stay synchronous. Undefined when the save
 * would write no `<ele>` whatever the answer (no `<wpt>` in the GPX has one,
 * so the DEM is never asked on such a trail), or for a request the save
 * refuses on sight (no position, an unknown, unbuilt or read-only trail).
 * Never throws: the save reports what is wrong.
 */
export async function lookupWaypointElevation(
  paths: EditorPaths,
  dirParam: string,
  at: { lat?: unknown; lon?: unknown } | null | undefined,
  dem?: DemSource,
  timeoutMs?: number
): Promise<ElevationLookup | undefined> {
  try {
    const { lat, lon } = validPosition(at?.lat, at?.lon);
    const dir = resolveTrailDir(paths, dirParam);
    const config = trailConfig(paths, dir);
    const trailId = config.id ?? dir.toLowerCase();
    if (readOnlyReason(trailId)) return undefined;
    const gpx = fs.readFileSync(path.join(paths.trailsDir, dir, gpxFileName(paths, dir, config)), 'utf-8');
    if (!listGpxWaypoints(gpx).some(span => span.ele !== undefined)) return undefined;
    const built = readJson<ProcessedTrail>(generatedPath(paths, trailId));
    return await lookupElevation(built, writtenCoordinate(lat), writtenCoordinate(lon), dem, timeoutMs);
  } catch {
    return undefined;
  }
}

/** A coordinate as a save writes it: the position an elevation is looked up for. */
function writtenCoordinate(value: number): number {
  return Number(formatCoordinate(value));
}

/**
 * The elevation at a save's position: the lookup its caller made for exactly
 * this position ({@link lookupWaypointElevation}), else the route's own
 * answer, which needs no network.
 */
function elevationAt(context: TrailContext, lat: number, lon: number, given?: ElevationLookup): ElevationLookup {
  const at = { lat: writtenCoordinate(lat), lon: writtenCoordinate(lon) };
  if (given && given.lat === at.lat && given.lon === at.lon) return given;
  let route: ElevationLookup;
  try {
    route = routeElevation(context.built, at.lat, at.lon);
  } catch {
    // An elevation is never worth failing a save for.
    route = { ...at, metres: null, why: 'the route could not be read' };
  }
  if (route.metres !== null) return route;
  return { ...route, why: `${route.why ?? 'the route gave none'}, and the Copernicus DEM was not asked` };
}

/** Where a found elevation came from, for a save's notes. */
function elevationSourceText(found: ElevationLookup): string {
  if (found.source === 'route') {
    const away = Math.round(found.offRouteMeters ?? 0);
    return `from the route (the track's own elevations${away > 0 ? `, read ${away} m away` : ''})`;
  }
  return `from the Copernicus DEM${found.why ? ` (${found.why})` : ''}`;
}

/**
 * The `<ele>` a new `<wpt>` gets, and the note that says so. One is written
 * when the file's `<wpt>`s carry one (`gpxWaypointElevationStyle`: at least
 * half of them do) and the lookup found a height, in the decimals they use.
 */
function newWaypointElevation(
  spans: readonly GpxWaypointSpan[],
  lookup: () => ElevationLookup
): { ele?: string; note: string } {
  const style = gpxWaypointElevationStyle(spans);
  if (!style) return { note: 'No <ele> written: the <wpt>s in this GPX carry none.' };
  const found = lookup();
  if (found.metres === null) {
    return {
      note: `No <ele> written, though the other <wpt>s in this GPX have one: ${found.why ?? 'no elevation was found'}. The build does not read it; add one by hand to keep the file complete.`,
    };
  }
  const ele = formatElevation(found.metres, style.decimals);
  return { ele, note: `Its <ele> is ${ele} m, ${elevationSourceText(found)}.` };
}

/**
 * The GPX with a moved `<wpt>`'s `<ele>` rewritten for its new position, in
 * the decimals it had, and the note that says so. `span` is the `<wpt>` as it
 * is in `gpx`. One with no `<ele>` is left without (no note); when the lookup
 * found nothing the old value stays, and the note says it may be stale.
 */
function movedWaypointElevation(
  gpx: string,
  span: GpxWaypointSpan,
  lookup: () => ElevationLookup
): { gpx: string; note?: string } {
  if (span.ele === undefined) return { gpx };
  const found = lookup();
  if (found.metres === null) {
    return {
      gpx,
      note: `Its <ele> is left at ${span.ele} m, which may be stale for the new position: ${found.why ?? 'no elevation was found'}.`,
    };
  }
  const decimals = elevationDecimals(span.ele) ?? gpxWaypointElevationStyle(listGpxWaypoints(gpx))?.decimals ?? 1;
  const ele = formatElevation(found.metres, decimals);
  return {
    gpx: setGpxWaypointElevation(gpx, span, ele),
    note:
      ele === span.ele
        ? `Its <ele> stays ${ele} m, ${elevationSourceText(found)}.`
        : `Its <ele> went from ${span.ele} to ${ele} m, ${elevationSourceText(found)}.`,
  };
}

// ---------------------------------------------------------------------------
// Type changes
// ---------------------------------------------------------------------------

/**
 * The CalTopo export with `marker` moved into a folder that types it `type`
 * (a new folder when the export has none), so the build, which takes the
 * folder first, gives the waypoint that type. Throws `EditorError` when no
 * folder title means `type`, or when the marker types another waypoint too.
 */
function retypedCaltopo(
  context: TrailContext,
  sources: Sources,
  geojsonText: string,
  marker: CaltopoMarkerInfo,
  title: string,
  span: GpxWaypointSpan,
  type: string,
  notes: string[]
): string {
  const file = path.basename(context.geojsonPath!);
  const others = sources.spans.filter(
    s => s.start !== span.start && resolveSourceType(s, sources.caltopo).marker?.index === marker.index
  );
  if (others.length) {
    throw new EditorError(
      `Its CalTopo marker “${marker.title}” in ${file} also types ${others.map(s => `“${s.name}”`).join(', ')} (the build takes the nearest marker with the same name): retyping it would retype those too and cost them their ids. Rename one of them first.`
    );
  }
  const titles = folderTitlesForType(type);
  const folder = sources.caltopo!.folders.find(f => titles.includes(f.title.toLowerCase()));
  if (folder) {
    notes.push(`Moved its CalTopo marker into the folder “${folder.title}” in ${file}.`);
    return setCaltopoMarkerFolder(geojsonText, file, { index: marker.index, title }, folder.id);
  }
  const newTitle = newFolderTitle(type);
  if (!newTitle) {
    throw new EditorError(
      `${file} types this waypoint from the folder of its CalTopo marker, and no folder title means “${waypointTypeLabel(type)}” (${type}): FOLDER_TYPE_MAP in src/lib/waypoint-classifier.ts has none, so the editor cannot give it that type here. Add a folder title for it there first (a classifier change, rebuilt and reviewed on its own).`
    );
  }
  notes.push(`Added a CalTopo folder “${newTitle}” to ${file} and moved its marker into it.`);
  const id = randomUUID();
  // The folder goes first in `features`, so the marker's folderId is set before its index shifts.
  const moved = setCaltopoMarkerFolder(geojsonText, file, { index: marker.index, title }, id);
  return addCaltopoFolder(moved, file, { id, title: newTitle });
}

/** Notes on what a type change means beyond the id. */
function retypeNotes(from: string, to: string): string[] {
  const notes: string[] = [];
  const family = (t: string) => [isWaterWaypoint(t) ? 'water' : '', isResupplyWaypoint(t) ? 'resupply' : ''];
  const [waterFrom, resupplyFrom] = family(from);
  const [waterTo, resupplyTo] = family(to);
  if (waterFrom !== waterTo) {
    notes.push(
      waterTo
        ? 'It now counts as water in the carry calculator and the dry-stretch figures.'
        : 'It no longer counts as water: check the carry and dry-stretch figures either side of it.'
    );
  }
  if (resupplyFrom !== resupplyTo) {
    notes.push(resupplyTo ? 'It now counts as a resupply point.' : 'It no longer counts as a resupply point.');
  }
  if (isAccessWaypoint(to) !== isAccessWaypoint(from)) {
    notes.push(
      isAccessWaypoint(to)
        ? 'A turn-off is the point on the route where the walk to the place leaves it, not the place itself.'
        : 'It is now the place itself rather than a turn-off to it: if the place is off the route, check where it sits.'
    );
  }
  return notes;
}

/**
 * Apply one waypoint's edit to the source files. Throws `EditorError` (and
 * writes nothing) when the edit is invalid, or the waypoint changed on disk
 * since the page read it.
 *
 * `elevation` is what {@link lookupWaypointElevation} found for the position a
 * move asks for; without it a moved `<wpt>`'s `<ele>` is rewritten only where
 * the route itself gives the height.
 */
export function saveWaypointEdit(
  paths: EditorPaths,
  dirParam: string,
  waypointId: string,
  request: WaypointEditRequest,
  elevation?: ElevationLookup
): WaypointEditResponse {
  const context = loadContext(paths, dirParam);
  const sources = readSources(paths, context);
  const waypoints = buildEditorWaypoints(paths, context, sources);
  const byId = new Map(waypoints.map(w => [w.id, w]));
  const current = byId.get(waypointId);
  if (!current) throw new EditorError(`${context.trailId} has no waypoint ${waypointId}`, 404);

  validate(request, current, MAX_DESCRIPTION_LENGTH);
  assertExpected(request.expected, current);

  const newName = request.name?.trim();
  const rename = newName !== undefined && newName !== current.name;
  const move =
    request.lat !== undefined &&
    request.lon !== undefined &&
    (!sameCoordinate(request.lat, current.lat) || !sameCoordinate(request.lon, current.lon));
  const describe = request.description !== undefined && request.description.trim() !== current.description;
  const retype = request.type !== undefined && request.type !== current.type;

  // A pending waypoint has no id, so it is followed through the edit by its
  // place in the file (an edit never adds or removes a <wpt>), and held to
  // what an add is held to.
  const pendingIndex = current.pending ? sources.spans.findIndex(s => pendingKey(s) === current.id) : -1;
  if (current.pending) {
    if (pendingIndex === -1) throw new EditorError('Its <wpt> is no longer in the GPX: reload the trail', 409);
    if (rename) assertNoTypePrefix(newName);
    if (move) {
      assertNearRoute(context, request.lat!, request.lon!);
      const at = { lat: Number(formatCoordinate(request.lat!)), lon: Number(formatCoordinate(request.lon!)) };
      if (sources.spans.some((s, i) => i !== pendingIndex && s.lat === at.lat && s.lon === at.lon)) {
        throw new EditorError(SAME_POSITION_ERROR);
      }
    }
  }
  // Renaming a merged-away duplicate is how it leaves the merge: the new name
  // must be the one the build shows, or its type could change with it.
  if (current.mergedInto && rename) assertNoTypePrefix(newName);

  const changed = new Set<string>();
  const notes: string[] = [];
  const name = rename ? newName : current.name;
  const lat = move ? request.lat! : current.lat;
  const lon = move ? request.lon! : current.lon;

  // Compute every write before making any, so a refusal (a file whose layout
  // cannot be reproduced, a type that cannot be made safe) leaves nothing half-written.
  const writes: { file: string; text: string }[] = [];
  let gpxText = sources.gpx;
  let geojsonText = sources.geojsonText;
  let registryAfter: string | null = null;
  let elevationNote: string | undefined;
  if (move || rename || retype) {
    const span = current.pending ? sources.spans[pendingIndex] : findGpxWaypoint(sources.spans, current);
    if (!span) throw new EditorError('Its <wpt> is no longer in the GPX: reload the trail', 409);
    const typeSource = resolveSourceType(span, sources.caltopo);
    if (current.pending && typeSource.marker) {
      // A marker with its name types it. Its own marker is edited with it, as
      // for any waypoint; one that types another <wpt> too (the nearest marker
      // with the name wins, however far) cannot be touched for this one.
      const marker = typeSource.marker;
      const others = sources.spans.filter(
        s => s.start !== span.start && resolveSourceType(s, sources.caltopo).marker?.index === marker.index
      );
      if (others.length) {
        throw new EditorError(
          `The CalTopo marker “${marker.title}”${context.geojsonPath ? ` in ${path.basename(context.geojsonPath)}` : ''} types this waypoint and also ${others.map(s => `“${s.name}”`).join(', ')} (the build types a <wpt> from the nearest marker with its name), so the editor cannot move, rename or retype this one without changing what the build makes of those. Delete it and add it again under a name of its own.`
        );
      }
    }
    let rawName = rename ? renameKeepingPrefix(span.name, current.name, name) : span.name;
    if (retype && typeSource.by === 'gpx-name' && typeSource.prefix) {
      // The <type> written below decides from now on; a prefix left in the name
      // would contradict it. Dropped only when the name the build shows stays the same.
      const classified = classifyWaypoint(rawName);
      if (classified.matchedPrefix && classifyWaypoint(classified.cleanedName).cleanedName === classified.cleanedName) {
        rawName = classified.cleanedName;
        notes.push(
          `Dropped the type prefix “${classified.matchedPrefix.trim()}” from its GPX <name>: the <type> sets its type now.`
        );
      }
    }
    if (rawName !== span.name) gpxText = setGpxWaypointName(gpxText, span, rawName);
    if (move) {
      const moved = current.pending
        ? listGpxWaypoints(gpxText)[pendingIndex]
        : findGpxWaypoint(listGpxWaypoints(gpxText), { lat: current.lat, lon: current.lon, name });
      if (!moved) throw new EditorError('Lost its <wpt> while renaming it', 500);
      gpxText = setGpxWaypointPosition(gpxText, moved, lat, lon);
      // An <ele> the <wpt> carries follows it: read from the <wpt> itself, as it now is in the text.
      const placed = listGpxWaypoints(gpxText).find(s => s.start === moved.start);
      if (placed) {
        const rewritten = movedWaypointElevation(gpxText, placed, () => elevationAt(context, lat, lon, elevation));
        gpxText = rewritten.gpx;
        elevationNote = rewritten.note;
      }
    }
    if (retype && (typeSource.by === 'gpx-type' || typeSource.by === 'gpx-name')) {
      const at = current.pending
        ? listGpxWaypoints(gpxText)[pendingIndex]
        : findGpxWaypoint(listGpxWaypoints(gpxText), { lat, lon, name });
      if (!at) throw new EditorError('Lost its <wpt> while editing it', 500);
      gpxText = setGpxWaypointType(gpxText, at, request.type!);
      notes.push(
        typeSource.by === 'gpx-type'
          ? 'Changed its GPX <type>.'
          : `Added a GPX <type>, which outranks ${typeSource.nameRule === 'known-town' ? 'the known-town list' : 'its name'} in the build.`
      );
    }
    if (gpxText !== sources.gpx) writes.push({ file: context.gpxPath, text: gpxText });

    if (context.geojsonPath && geojsonText !== null) {
      const marker = typeSource.marker;
      const source = path.basename(context.geojsonPath);
      if (marker) {
        let title = marker.title;
        if (move || rename) {
          const edit: { lat?: number; lon?: number; title?: string } = {};
          if (move) Object.assign(edit, { lat, lon });
          if (rename) edit.title = title = renameKeepingPrefix(marker.title, current.name, name);
          geojsonText = editCaltopoMarker(geojsonText, source, marker, edit);
        }
        if (retype) {
          geojsonText = retypedCaltopo(context, sources, geojsonText, marker, title, span, request.type!, notes);
        }
        writes.push({ file: context.geojsonPath, text: geojsonText });
      } else if ((move || rename) && !current.pending) {
        notes.push(`No CalTopo marker named "${current.name}" in ${source}: its type comes from the GPX alone.`);
      }
    }

    const registryEdit: { lat?: number; lon?: number; name?: string; type?: string } = {};
    if (move) Object.assign(registryEdit, { lat, lon });
    if (rename) registryEdit.name = name;
    if (retype) registryEdit.type = request.type;
    // A pending waypoint has no entry to edit: the next build mints (or hands back) its id.
    registryAfter = current.pending ? null : registryText(paths, context.trailId, current.id, registryEdit);
    if (registryAfter !== null) writes.push({ file: paths.registryPath, text: registryAfter });
    else if ((move || retype) && !current.pending) {
      notes.push(`${current.id} has no registry entry of its own; the next build matches it by position.`);
    }
  }

  let nextId: string | null = null;
  if (retype || (current.pending && (move || rename)) || (current.mergedInto && rename)) {
    // Check the result as the build will see it: the type it resolves to, and
    // that every id comes through (this one included, when it has one). A
    // merged-away duplicate is renamed to come back as a row under its id, so
    // its rename is held to the same check.
    const caltopoAfter = geojsonText === null ? null : readCaltopoExport(geojsonText);
    const spansAfter = listGpxWaypoints(gpxText);
    const at = current.pending ? spansAfter[pendingIndex] : findGpxWaypoint(spansAfter, { lat, lon, name });
    const resolved = at ? resolveSourceType(at, caltopoAfter) : null;
    const wanted = retype ? request.type! : current.type;
    if (!resolved || resolved.type !== wanted || resolved.cleanedName !== name) {
      // With no id there is nothing to migrate: what the build would make of
      // the <wpt> is all there is, and it must be what the editor shows.
      if (current.pending && resolved && resolved.cleanedName === name) {
        throw typeClashError(context, resolved, wanted, at!);
      }
      if (!retype && resolved) {
        throw new EditorError(
          `Under that name the build would type it ${resolved.type}, not ${wanted}, and mint it a new id: nothing was written. Its type comes from ${current.typeSource ?? 'its name'}.`
        );
      }
      throw new EditorError(
        `Could not make that type stick: the build would still type it ${resolved?.type ?? '(not found)'}, so nothing was written.`,
        500
      );
    }
    const registryNow = sources.registry;
    const own = spansAfter.indexOf(at!);
    const { ids, warnings } = assertIdsKept(
      context.trailId,
      { registry: registryNow, inputs: idInputs(sources.spans, sources.caltopo) },
      {
        registry: registryAfter ? (JSON.parse(registryAfter) as WaypointRegistry) : registryNow,
        inputs: idInputs(spansAfter, caltopoAfter),
      },
      // A pending waypoint's own future id may change with the edit; no other id may.
      spansAfter.flatMap((_, i) => (current.pending && i === own ? [] : [[i, i] as [number, number]]))
    );
    if (current.pending) {
      nextId = ids[own];
      notes.push(...warnings.map(w => `The build will warn: ${w.replace(/^!\s*/, '')}`));
    } else if (ids[own] !== registryId(current.id)) {
      throw new EditorError(
        `The next build would give it id ${ids[own]} instead of ${registryId(current.id)} (its registry entry did not follow): nothing was written.`
      );
    }
  }

  if (describe && current.pending) {
    // No id, so no descriptions.json entry: the text is its <desc>, GPX source
    // text the build shows as it is.
    const text = request.description!.trim();
    gpxText = setGpxWaypointDesc(gpxText, listGpxWaypoints(gpxText)[pendingIndex], text);
    const gpxWrite = writes.find(w => w.file === context.gpxPath);
    if (gpxWrite) gpxWrite.text = gpxText;
    else writes.push({ file: context.gpxPath, text: gpxText });
    notes.push(
      text
        ? 'The description went into its GPX <desc>: it has no id for descriptions.json yet. Once it has one, text saved here becomes curated text, which outranks the <desc>.'
        : 'Removed its GPX <desc>.'
    );
  }
  const descriptionsText = current.pending
    ? null
    : describe
      ? describedText(context, current, request.description!.trim(), name, byId)
      : rename
        ? renamedDescriptionText(context, current.id, name)
        : null;
  if (descriptionsText !== null) writes.push({ file: context.descriptionsPath, text: descriptionsText });

  for (const { file, text } of writes) {
    fs.writeFileSync(file, text);
    changed.add(relative(paths, file));
  }

  if (move) {
    const metres = haversineDistance(current.lat, current.lon, lat, lon);
    notes.push(
      current.pending
        ? `Moved ${Math.round(metres)} m.`
        : `Moved ${Math.round(metres)} m; its registry entry moved with it, so it keeps id ${current.id}.`
    );
    if (elevationNote) notes.push(elevationNote);
    if (current.access?.method === 'osm' || current.access?.method === 'none') {
      notes.push(
        `access.json routes this place from where it was (${current.access.method}): run npm run fetch:access to re-route it.`
      );
    } else if (current.access?.method === 'manual') {
      notes.push('access.json has a manual junction and off-trail km for this place: check they still hold.');
    }
    if (current.sharesSourceWith?.length) {
      notes.push(`Also moves ${current.sharesSourceWith.join(', ')}, built from the same <wpt>.`);
    }
  }
  if (retype) {
    notes.push(
      current.pending
        ? `Type ${current.type} → ${request.type}.`
        : `Type ${current.type} → ${request.type}; its registry entry's type changed with it, so it keeps id ${registryId(current.id)}.`
    );
    notes.push(...retypeNotes(current.type, request.type!));
    if (current.sharesSourceWith?.length) {
      notes.push(`Also retypes ${current.sharesSourceWith.join(', ')}, built from the same <wpt>.`);
    }
  }
  if (nextId !== null) notes.push(nextIdNote(sources.registry, context.trailId, nextId));
  else if (move || rename || retype) notes.push('Run Rebuild to see its km, lists and type from the new source.');

  // A pending waypoint's temporary key is a hash of its name and position, so
  // a rename or a move re-keys it: the answer carries it under the new key.
  const key = current.pending ? pendingKey(listGpxWaypoints(gpxText)[pendingIndex]) : waypointId;
  const rowsAfter = buildEditorWaypoints(paths, loadContext(paths, dirParam));
  const after = rowsAfter.find(w => w.id === key);
  if (!after)
    throw new EditorError('The waypoint could not be found again after saving: rebuild and check the diff', 500);
  // The build merges on name, type and distance: an edit to the waypoint that
  // duplicates were merged into can end the merge, and they come back as rows.
  const wasMerged = new Set(waypoints.filter(w => w.mergedInto === current.id && !w.unmerges).map(w => w.id));
  const freed = rowsAfter.filter(w => wasMerged.has(w.id) && w.unmerges);
  if (freed.length) {
    const one = freed.length === 1;
    notes.push(
      `${freed.map(w => w.id).join(', ')}, which the build merged into it, ${one ? 'is' : 'are'} no longer ${one ? 'a duplicate' : 'duplicates'} of it as the sources now stand: the next build lists ${one ? 'it' : 'them'} again as ${one ? 'a row of its own, under its own id' : 'rows of their own, under their own ids'}.`
    );
  }
  if (current.mergedInto && rename) {
    const into = `“${after.builtName}” (${current.mergedInto})`;
    if (after.unmerges) {
      notes.push(
        `Under its own name the next build no longer merges it into ${into}: it is listed again as a row of its own under ${current.id}, with the comments filed under that id.`
      );
      const freed = freedByLeaving(byId, current, context.dedupeRadiusMeters);
      if (freed.length) notes.push(freedNote(freed, into, context.dedupeRadiusMeters));
    } else {
      notes.push(`Under that name the next build still merges it into ${into}.`);
    }
  }
  return { waypoint: after, changedFiles: [...changed], notes };
}

/** Says which other duplicates come back when one leaves a chain the build merged. */
function freedNote(freed: readonly EditorWaypoint[], into: string, radiusMeters: number): string {
  const ids = freed.map(w => w.id).join(', ');
  return `${ids} ${freed.length === 1 ? 'was' : 'were'} merged into ${into} only through this one (each within ${radiusMeters} m of the next): the next build lists ${freed.length === 1 ? 'it' : 'them'} again too, under ${freed.length === 1 ? 'its own id' : 'their own ids'}.`;
}

/**
 * What the next build does for a `<wpt>` that has no id yet: mints `id`, or
 * hands it an entry the registry already holds (`assignWaypointIds` on the
 * sources as saved).
 */
function nextIdNote(registry: WaypointRegistry, trailId: string, id: string): string {
  const entry = (registry[trailId] ?? []).find(e => e.id === id);
  if (!entry) {
    return `Rebuild to give it its id (the next build mints ${id}); until then it is listed as pending, and edits to it go to its <wpt> in the GPX alone.`;
  }
  if (entry.retired) {
    return `The next build will give it the retired id ${id} back: a ${entry.type} of the same name stood here once, and its comments and description come with the id.`;
  }
  return `The next build will give it the id ${id} of “${entry.name}”: that entry has no <wpt> any more and is within ${MATCH_RADIUS_METERS} m, which the build reads as the same ${entry.type} moved or renamed, so its comments and description come with the id. If this is a different place, delete it, rebuild (which retires ${id}) and add it again.`;
}

// ---------------------------------------------------------------------------
// Adding and deleting
// ---------------------------------------------------------------------------

/**
 * Add a waypoint: a new `<wpt>` (name, `<type>`, optional `<desc>`, and an
 * `<ele>` when the file's `<wpt>`s carry one) after the last one in the GPX.
 * Nothing goes in the registry or `descriptions.json`: the next build mints
 * its id, and until then the editor shows it as pending.
 *
 * `elevation` is what {@link lookupWaypointElevation} found for the position;
 * without it the `<ele>` is written only where the route itself gives the
 * height.
 *
 * On a CalTopo-typed trail no marker is added: the build types a `<wpt>` from
 * a marker only when one has its name, and otherwise from its `<type>`, so the
 * `<type>` is enough. A marker that does have its name would win, so the add
 * is refused when one would type it differently.
 */
export function addWaypoint(
  paths: EditorPaths,
  dirParam: string,
  request: NewWaypointRequest,
  elevation?: ElevationLookup
): WaypointEditResponse {
  const context = loadContext(paths, dirParam);
  if (context.readOnlyReason) throw new EditorError(context.readOnlyReason);
  const name = validName(request?.name);
  assertNoTypePrefix(name);
  const type = validType(request.type);
  const { lat: rawLat, lon: rawLon } = validPosition(request.lat, request.lon);
  const lat = Number(formatCoordinate(rawLat));
  const lon = Number(formatCoordinate(rawLon));
  const description = request.description === undefined ? '' : request.description;
  if (typeof description !== 'string') throw new EditorError('description must be a string');
  if (description.trim().length > MAX_DESCRIPTION_LENGTH) {
    throw new EditorError(`The description is longer than ${MAX_DESCRIPTION_LENGTH} characters`);
  }
  const points = displayPoints(context.built);
  const snap = snapToTrail(lat, lon, points, undefined, routeBreakStarts(context.built.track.breaks, 'displayPoints'));
  if (!snap || snap.offTrailMeters > MAX_MOVE_METERS) {
    throw new EditorError(`That is more than ${MAX_MOVE_METERS / 1000} km from the route; a slip of the mouse?`);
  }

  const sources = readSources(paths, context);
  if (sources.spans.some(s => s.lat === lat && s.lon === lon)) {
    throw new EditorError(
      'Another <wpt> is at exactly this position, and the editor tells waypoints apart by their coordinates: place it a little to one side.'
    );
  }
  const { ele, note: elevationNote } = newWaypointElevation(sources.spans, () =>
    elevationAt(context, lat, lon, elevation)
  );
  const gpx = insertGpxWaypoint(sources.gpx, { lat, lon, name, type, desc: description.trim() || undefined, ele });
  const spansAfter = listGpxWaypoints(gpx);
  const addedIndex = spansAfter.findIndex(s => s.lat === lat && s.lon === lon && s.name === name);
  if (addedIndex === -1) throw new EditorError('The new <wpt> could not be read back from the GPX', 500);
  const added = spansAfter[addedIndex];
  const resolved = resolveSourceType(added, sources.caltopo);
  if (resolved.type !== type) throw typeClashError(context, resolved, type, { lat, lon });
  const { ids, warnings } = assertIdsKept(
    context.trailId,
    { registry: sources.registry, inputs: idInputs(sources.spans, sources.caltopo) },
    { registry: sources.registry, inputs: idInputs(spansAfter, sources.caltopo) },
    sources.spans.map((_, i) => [i < addedIndex ? i : i + 1, i] as [number, number])
  );

  fs.writeFileSync(context.gpxPath, gpx);
  const notes: string[] = [nextIdNote(sources.registry, context.trailId, ids[addedIndex]), elevationNote];
  if (description.trim()) {
    notes.push(
      'The description went into its GPX <desc>; once it has an id it can become curated text in descriptions.json.'
    );
  }
  notes.push(...warnings.map(w => `The build will warn: ${w.replace(/^!\s*/, '')}`));
  const waypoint = buildEditorWaypoints(paths, loadContext(paths, dirParam)).find(w => w.id === pendingKey(added));
  if (!waypoint) throw new EditorError('The new waypoint could not be found again after saving: check the diff', 500);
  return { waypoint, changedFiles: [relative(paths, context.gpxPath)], notes };
}

/**
 * Delete a waypoint: its `<wpt>`, the CalTopo marker that typed it (unless
 * that marker types another waypoint too) and its `descriptions.json` entries.
 * The registry entry stays for the next build to mark `retired`: entries are
 * never deleted, and a retired id is never handed to a different place.
 * A revisited place's later pass (`<id>_2`) is built from the first pass's
 * `<wpt>`, so it is refused: deleting the first pass deletes them all.
 */
export function deleteWaypoint(
  paths: EditorPaths,
  dirParam: string,
  key: string,
  request: WaypointDeleteRequest
): WaypointDeleteResponse {
  const context = loadContext(paths, dirParam);
  if (context.readOnlyReason) throw new EditorError(context.readOnlyReason);
  const sources = readSources(paths, context);
  const rows = new Map(buildEditorWaypoints(paths, context, sources).map(w => [w.id, w]));
  const current = rows.get(key);
  if (!current) throw new EditorError(`${context.trailId} has no waypoint ${key}`, 404);
  if (!current.pending && registryId(current.id) !== current.id) {
    throw new EditorError(
      `${current.id} is a later pass of ${registryId(current.id)}, built from the same <wpt>: delete ${registryId(current.id)} to remove the place (every pass goes with it).`
    );
  }
  if (!current.canDelete) throw new EditorError(current.lockedReason ?? 'This waypoint cannot be deleted here');
  assertExpected(request?.expected, current);
  const span = current.pending
    ? sources.spans.find(s => pendingKey(s) === key)
    : findGpxWaypoint(sources.spans, current);
  if (!span) throw new EditorError('Its <wpt> is no longer in the GPX: reload the trail', 409);
  const spanIndex = sources.spans.indexOf(span);

  const notes: string[] = [];
  const writes: { file: string; text: string }[] = [];
  const gpx = removeGpxWaypoint(sources.gpx, span);
  writes.push({ file: context.gpxPath, text: gpx });
  let caltopoAfter = sources.caltopo;
  const marker = current.pending ? undefined : resolveSourceType(span, sources.caltopo).marker;
  if (marker && context.geojsonPath && sources.geojsonText !== null) {
    const file = path.basename(context.geojsonPath);
    const others = sources.spans.filter(
      s => s.start !== span.start && resolveSourceType(s, sources.caltopo).marker?.index === marker.index
    );
    if (others.length) {
      notes.push(
        `Left its CalTopo marker “${marker.title}” in ${file}: it also types ${others.map(s => `“${s.name}”`).join(', ')}.`
      );
    } else {
      const geojson = removeCaltopoFeature(sources.geojsonText, file, marker);
      caltopoAfter = readCaltopoExport(geojson);
      writes.push({ file: context.geojsonPath, text: geojson });
    }
  }
  const removed = [current.id, ...(current.sharesSourceWith ?? [])];
  if (!current.pending) {
    const text = withoutDescriptionsText(context, removed);
    if (text !== null) writes.push({ file: context.descriptionsPath, text });
  }
  assertIdsKept(
    context.trailId,
    { registry: sources.registry, inputs: idInputs(sources.spans, sources.caltopo) },
    { registry: sources.registry, inputs: idInputs(listGpxWaypoints(gpx), caltopoAfter) },
    sources.spans.flatMap((_, i) => (i === spanIndex ? [] : [[i < spanIndex ? i : i - 1, i] as [number, number]]))
  );

  const changed: string[] = [];
  for (const { file, text } of writes) {
    fs.writeFileSync(file, text);
    changed.push(relative(paths, file));
  }
  if (current.pending) {
    notes.push('Removed the unbuilt waypoint; it never had an id.');
  } else if (current.mergedInto) {
    // The build dropped its row, so the app never showed anything keyed to its
    // id: nothing in the app reads `mergedIds` to find comments.
    const into = `“${current.builtName}” (${current.mergedInto})`;
    notes.push(
      `The next build marks ${current.id} retired in data/waypoint-ids.json (entries are never deleted, and a retired id never passes to another place) and drops it from the ids merged into ${into}, which stays as it is.`
    );
    notes.push(
      `Comments keyed to ${current.id} were already out of sight, and stay so: the app looks comments up by a row's own id, and this duplicate has had no row since the build began merging it. They stay on the server.`
    );
    if (current.description || current.sourceDescription) {
      notes.push(
        `The build appended its description to that of ${into} in the trail data; the next build no longer does.`
      );
    }
    const freed = freedByLeaving(rows, current, context.dedupeRadiusMeters);
    if (freed.length) notes.push(freedNote(freed, into, context.dedupeRadiusMeters));
    if (current.access) {
      notes.push(
        `access.json still has an entry for ${current.id}: npm run fetch:access drops it, or remove it by hand.`
      );
    }
  } else {
    notes.push(
      `The next build marks ${current.id} retired in data/waypoint-ids.json (entries are never deleted, and a retired id never passes to another place); comments keyed to ${removed.join(', ')} are orphaned.`
    );
    const duplicates = mergeGroup(rows, current.id).filter(w => w.id !== current.id && w.mergedInto === current.id);
    if (duplicates.length) {
      const ids = duplicates.map(w => w.id).join(', ');
      const one = duplicates.length === 1;
      notes.push(
        `${ids} ${one ? 'is a near-duplicate' : 'are near-duplicates'} the build merged into it, with ${one ? 'a <wpt>' : '<wpt>s'} of ${one ? 'its' : 'their'} own that ${one ? 'stays' : 'stay'}: the next build lists ${one ? 'it' : 'them'} again as ${one ? 'a row of its own, under its own id' : `rows of their own, under their own ids (those within ${context.dedupeRadiusMeters} m of each other as one row)`}, with the comments filed under ${one ? 'that id' : 'those ids'}. Comments keyed to ${current.id} do not move to ${one ? 'it' : 'them'}. Delete ${one ? 'it' : 'them'} too if the place is gone.`
      );
    }
    if (current.sharesSourceWith?.length) {
      notes.push(`${current.sharesSourceWith.join(', ')} went with it: built from the same <wpt>.`);
    }
    if (current.access) {
      notes.push(
        `access.json still has an entry for ${current.id}: npm run fetch:access drops it, or remove it by hand.`
      );
    }
  }
  return { removed, changedFiles: changed, notes };
}
