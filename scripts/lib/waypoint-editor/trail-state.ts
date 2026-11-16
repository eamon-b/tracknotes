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
 *    distance keeps its id, comments and description);
 *  - name: the `<wpt>`'s `<name>` and the CalTopo marker's title, both keeping
 *    their type prefix, the registry entry's name, and `descriptions.json`'s
 *    `name` aid.
 * Nothing else is touched; `build:trails` then turns the sources into data.
 */

import * as fs from 'fs';
import * as path from 'path';
import { routeBreakStarts } from '../../../src/lib/route-breaks';
import { snapToTrail } from '../../../src/lib/position-on-trail';
import { haversineDistance } from '../../../src/lib/distance';
import type { ProcessedTrail, RouteVariant } from '../../../src/lib/trail-types';
import { DESCRIPTIONS_FILENAME, MAX_DESCRIPTION_LENGTH, type CuratedDescriptionsFile } from '../waypoint-descriptions';
import type { WaypointRegistry } from '../waypoint-ids';
import type {
  EditorTrail,
  EditorTrailSummary,
  EditorWaypoint,
  PlacementKind,
  WaypointEditRequest,
  WaypointEditResponse,
  WaypointPlacement,
} from './api-types';
import {
  editCaltopoMarker,
  editJsonPreservingLayout,
  findCaltopoMarker,
  findGpxWaypoint,
  formatCoordinate,
  listGpxWaypoints,
  renameKeepingPrefix,
  setGpxWaypointName,
  setGpxWaypointPosition,
  stringifyJson,
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
}

function variantKind(variant: RouteVariant, alternate: boolean): PlacementKind {
  if (alternate) return 'alternate';
  return variant.type === 'terminus' ? 'terminus' : 'side-trip';
}

function collectBuiltWaypoints(trail: ProcessedTrail): BuiltWaypoint[] {
  const byId = new Map<string, BuiltWaypoint>();
  const add = (
    w: { id?: string; name: string; type: string; lat: number; lon: number; description?: string },
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

/** A revisited place's later passes are `<id>_2`, `<id>_3`, sharing the first pass's registry entry. */
function registryId(id: string): string {
  return id.replace(/_\d+$/, '');
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

function toEditorWaypoint(
  context: TrailContext,
  joined: Joined,
  curated: Map<string, string>,
  access: Record<string, AccessEntryLite>,
  sharers: Map<number, string[]>,
  geojsonText: string | null,
  km: number
): EditorWaypoint {
  const { built, span } = joined;
  const locked = context.readOnlyReason
    ? context.readOnlyReason
    : span
      ? undefined
      : 'Its <wpt> could not be found in the GPX (it may have been edited by hand since the build): rebuild, then try again.';
  const waypoint: EditorWaypoint = {
    id: built.id,
    name: joined.name,
    type: built.type,
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
    canDescribe: !context.readOnlyReason,
  };
  if (locked) waypoint.lockedReason = locked;
  if (built.distanceFromTrailKm !== undefined) waypoint.distanceFromTrailKm = built.distanceFromTrailKm;
  const sourceText = sourceDescription(span, geojsonText, joined);
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

/** The text the build would show without a curated entry: the CalTopo marker's, else the GPX `<desc>`. */
function sourceDescription(
  span: GpxWaypointSpan | null,
  geojsonText: string | null,
  joined: Joined
): string | undefined {
  if (geojsonText) {
    const marker = findCaltopoMarker(geojsonText, joined);
    if (marker?.description) return marker.description;
  }
  return span?.desc?.trim() || undefined;
}

function relative(paths: EditorPaths, file: string): string {
  return path.relative(paths.root, file).split(path.sep).join('/');
}

function buildEditorWaypoints(paths: EditorPaths, context: TrailContext): EditorWaypoint[] {
  const gpx = fs.readFileSync(context.gpxPath, 'utf-8');
  const geojsonText = context.geojsonPath ? fs.readFileSync(context.geojsonPath, 'utf-8') : null;
  const registry = readJson<WaypointRegistry>(paths.registryPath);
  const curated = new Map(
    (readDescriptions(context.descriptionsPath)?.descriptions ?? []).map(d => [d.waypointId, d.description])
  );
  const access = readAccess(context.trailDir);
  const joined = joinToSources(collectBuiltWaypoints(context.built), listGpxWaypoints(gpx), registry, context.trailId);
  const sharers = new Map<number, string[]>();
  for (const j of joined) {
    if (!j.span) continue;
    sharers.set(j.span.start, [...(sharers.get(j.span.start) ?? []), j.built.id]);
  }
  const points = displayPoints(context.built);
  const starts = routeBreakStarts(context.built.track.breaks, 'displayPoints');
  return joined
    .map(j => toEditorWaypoint(context, j, curated, access, sharers, geojsonText, sortKm(j, points, starts)))
    .sort((a, b) => a.sortKm - b.sortKm || a.name.localeCompare(b.name));
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

function sameCoordinate(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9;
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
    const name = typeof request.name === 'string' ? request.name.trim() : '';
    if (!name) throw new EditorError('A waypoint needs a name');
    if (name.length > MAX_NAME_LENGTH || /[\r\n\t]/.test(name)) throw new EditorError('That name is not usable');
    if (!current.canRename) throw new EditorError(current.lockedReason ?? 'This waypoint cannot be renamed here');
  }
  if (request.lat !== undefined || request.lon !== undefined) {
    const { lat, lon } = request;
    if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new EditorError('A move needs both lat and lon as numbers');
    }
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new EditorError('That position is not on Earth');
    if (!current.canMove) throw new EditorError(current.lockedReason ?? 'This waypoint cannot be moved here');
    if (haversineDistance(current.lat, current.lon, lat, lon) > MAX_MOVE_METERS) {
      throw new EditorError(`That moves the waypoint more than ${MAX_MOVE_METERS / 1000} km; a slip of the mouse?`);
    }
  }
}

function assertExpected(request: WaypointEditRequest, current: EditorWaypoint): void {
  const expected = request.expected;
  if (
    !expected ||
    expected.name !== current.name ||
    !sameCoordinate(expected.lat, current.lat) ||
    !sameCoordinate(expected.lon, current.lon) ||
    expected.description !== current.description
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

/** The registry with the waypoint's entry moved and/or renamed; null when it has none or nothing changed. */
function registryText(
  paths: EditorPaths,
  trailId: string,
  id: string,
  edit: { lat?: number; lon?: number; name?: string }
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
  });
  return !found || next === existing ? null : next;
}

/**
 * Apply one waypoint's edit to the source files. Throws `EditorError` (and
 * writes nothing) when the edit is invalid, or the waypoint changed on disk
 * since the page read it.
 */
export function saveWaypointEdit(
  paths: EditorPaths,
  dirParam: string,
  waypointId: string,
  request: WaypointEditRequest
): WaypointEditResponse {
  const context = loadContext(paths, dirParam);
  const waypoints = buildEditorWaypoints(paths, context);
  const byId = new Map(waypoints.map(w => [w.id, w]));
  const current = byId.get(waypointId);
  if (!current) throw new EditorError(`${context.trailId} has no waypoint ${waypointId}`, 404);

  validate(request, current, MAX_DESCRIPTION_LENGTH);
  assertExpected(request, current);

  const newName = request.name?.trim();
  const rename = newName !== undefined && newName !== current.name;
  const move =
    request.lat !== undefined &&
    request.lon !== undefined &&
    (!sameCoordinate(request.lat, current.lat) || !sameCoordinate(request.lon, current.lon));
  const describe = request.description !== undefined && request.description.trim() !== current.description;

  const changed = new Set<string>();
  const notes: string[] = [];
  const name = rename ? newName : current.name;

  // Compute every write before making any, so a refusal (a file whose layout
  // cannot be reproduced) leaves nothing half-written.
  const writes: { file: string; text: string }[] = [];
  if (move || rename) {
    let gpx = fs.readFileSync(context.gpxPath, 'utf-8');
    const span = findGpxWaypoint(listGpxWaypoints(gpx), current);
    if (!span) throw new EditorError('Its <wpt> is no longer in the GPX: reload the trail', 409);
    if (rename) {
      gpx = setGpxWaypointName(gpx, span, renameKeepingPrefix(span.name, current.name, name));
    }
    if (move) {
      const moved = findGpxWaypoint(listGpxWaypoints(gpx), { lat: current.lat, lon: current.lon, name });
      if (!moved) throw new EditorError('Lost its <wpt> while renaming it', 500);
      gpx = setGpxWaypointPosition(gpx, moved, request.lat!, request.lon!);
    }
    writes.push({ file: context.gpxPath, text: gpx });

    if (context.geojsonPath) {
      const geojson = fs.readFileSync(context.geojsonPath, 'utf-8');
      const marker = findCaltopoMarker(geojson, current);
      if (marker) {
        const edit: { lat?: number; lon?: number; title?: string } = {};
        if (move) Object.assign(edit, { lat: request.lat, lon: request.lon });
        if (rename) edit.title = renameKeepingPrefix(marker.title, current.name, name);
        const source = path.basename(context.geojsonPath);
        writes.push({ file: context.geojsonPath, text: editCaltopoMarker(geojson, source, marker, edit) });
      } else {
        notes.push(
          `No CalTopo marker named "${current.name}" in ${path.basename(context.geojsonPath)}: its type comes from the GPX alone.`
        );
      }
    }
  }

  if (move || rename) {
    const registryEdit: { lat?: number; lon?: number; name?: string } = {};
    if (move) Object.assign(registryEdit, { lat: request.lat, lon: request.lon });
    if (rename) registryEdit.name = name;
    const text = registryText(paths, context.trailId, current.id, registryEdit);
    if (text !== null) writes.push({ file: paths.registryPath, text });
    else if (move) notes.push(`${current.id} has no registry entry of its own; the next build matches it by position.`);
  }
  const descriptionsText = describe
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
    const metres = haversineDistance(current.lat, current.lon, request.lat!, request.lon!);
    notes.push(`Moved ${Math.round(metres)} m; its registry entry moved with it, so it keeps id ${current.id}.`);
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
  if (move || rename) notes.push('Run Rebuild to see its km, lists and type from the new source.');

  const after = buildEditorWaypoints(paths, loadContext(paths, dirParam)).find(w => w.id === waypointId);
  if (!after)
    throw new EditorError('The waypoint could not be found again after saving: rebuild and check the diff', 500);
  return { waypoint: after, changedFiles: [...changed], notes };
}
