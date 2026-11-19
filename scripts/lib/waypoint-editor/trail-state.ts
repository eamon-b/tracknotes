/**
 * The waypoint editor's view of one bundled trail, and its saves.
 *
 * The last build (`public/data/generated/<id>.json`) says which waypoints the
 * trail has, their stable ids, km and lists; the source files say what they are
 * *now*. Each built waypoint is joined back to its `<wpt>` by what the build's
 * id matching would keep its id on: the exact coordinates (the build copies
 * them unchanged), the name the build shows and the type it gives. The registry
 * entry is tried first, because a save moves, renames and retypes the entry
 * with the waypoint: a waypoint edited since the build is still found, and the
 * next build hands it the same id. A `<wpt>` is claimed for one id only (the
 * passes of a revisited place share theirs), so a waypoint whose `<wpt>` is
 * gone is never shown as another that stands on the same spot.
 *
 * A save writes, for one waypoint:
 *  - description: its entry in `descriptions.json` (added before the first
 *    entry that follows it in km order, replaced, or removed when emptied);
 *  - position: the `<wpt>`'s `lat`/`lon`, the CalTopo marker the build types it
 *    from (so the type cannot change), and its registry entry (so a move of any
 *    distance keeps its id, comments and description); an `<ele>` the `<wpt>`
 *    has is looked up again for the new position (`elevation.ts`);
 *  - name: the `<wpt>`'s `<name>` and the CalTopo marker's title, both keeping
 *    their type prefix, the registry entry's name, `descriptions.json`'s
 *    `name` aid, and the name in trail.json's `revisitedWaypoints`.
 * A delete takes the place's name out of that list, when no other `<wpt>` has
 * it. Nothing else is touched; `build:trails` then turns the sources into data.
 *
 * Every move, rename and type change is checked as the build will see it
 * before anything is written: the type the build resolves for the edited
 * `<wpt>` must be the one meant, and the build's id matching, run over every
 * `<wpt>` before and after, must give each the id it had. All the files of a
 * save are then replaced together, or none is (`commitWrites`).
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
import { placeIdOf } from '../../../src/lib/waypoint-passes';
import {
  isAccessWaypoint,
  isResupplyWaypoint,
  isWaterWaypoint,
  WAYPOINT_TYPES,
  waypointTypeLabel,
} from '../../../src/lib/waypoint-taxonomy';
import {
  DESCRIPTIONS_FILENAME,
  MAX_DESCRIPTION_LENGTH,
  type CuratedDescription,
  type CuratedDescriptionsFile,
} from '../waypoint-descriptions';
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
  gpxWaypointChildTags,
  gpxWaypointElevationStyle,
  insertGpxWaypoint,
  listGpxWaypoints,
  nearestCaltopoMarker,
  newFolderTitle,
  folderTitlesForType,
  readCaltopoExport,
  removeCaltopoFeature,
  removeGpxWaypoint,
  removeJsonArrayString,
  renameJsonArrayString,
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

/** The key in trail.json that lists, by name, the waypoints the route passes more than once. */
const REVISITED_KEY = 'revisitedWaypoints';

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

/** The CalTopo export the build reads (`findGeojsonFile` in `trail-waypoint-sources.ts`), if any. */
function geojsonFileName(paths: EditorPaths, dir: string, config: TrailConfigFile): string | undefined {
  const trailDir = path.join(paths.trailsDir, dir);
  if (config.geojsonFile && fs.existsSync(path.join(trailDir, config.geojsonFile))) return config.geojsonFile;
  // The trail's own data files are never the CalTopo export: the same list as the build's.
  const ownFiles = new Set(['trail.json', 'climate.json', 'pois.json', 'access.json', 'descriptions.json']);
  for (const file of fs.readdirSync(trailDir)) {
    if (!file.toLowerCase().endsWith('.json') || ownFiles.has(file)) continue;
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

/** Everything one trail's view and saves need that a save does not change (trail.json apart), read fresh from disk. */
interface TrailContext {
  dir: string;
  trailDir: string;
  trailId: string;
  name: string;
  readOnlyReason?: string;
  /** trail.json, and its text as it is on disk. */
  configPath: string;
  configText: string;
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
  const trailDir = path.join(paths.trailsDir, dir);
  const configPath = path.join(trailDir, 'trail.json');
  const configText = fs.readFileSync(configPath, 'utf-8');
  const config = JSON.parse(configText) as TrailConfigFile;
  const trailId = config.id ?? dir.toLowerCase();
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
    configPath,
    configText,
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

/** The CalTopo export's file name, for a message. */
function geojsonFile(context: TrailContext): string | undefined {
  return context.geojsonPath && path.basename(context.geojsonPath);
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
  /** For an off-trail place: metres to the nearest point of the main track (the built data's `distanceFromTrail`). */
  distanceFromTrailM?: number;
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
    distanceFromTrailM?: number
  ) => {
    if (!w.id) return;
    let entry = byId.get(w.id);
    if (!entry) {
      entry = { id: w.id, name: w.name, type: w.type, lat: w.lat, lon: w.lon, placements: [] };
      if (w.description) entry.description = w.description;
      byId.set(w.id, entry);
    }
    entry.placements.push(placement);
    if (distanceFromTrailM !== undefined) entry.distanceFromTrailM = distanceFromTrailM;
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
  return placeIdOf(id);
}

// ---------------------------------------------------------------------------
// The source files, and what the build makes of each <wpt>
// ---------------------------------------------------------------------------

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
 * the name (`flattenGpx`: `wpt.type || classifyWaypoint(name).type`). `name`
 * and `type` are the `<wpt>`'s text as it stands, untrimmed, as the build
 * reads them.
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

function typeSourceText(source: TypeSource, file: string | undefined): string {
  const inFile = file ? ` in ${file}` : '';
  switch (source.by) {
    case 'caltopo-folder':
      return `the CalTopo folder “${source.marker?.folderTitle ?? ''}” of its marker${inFile}`;
    case 'caltopo-title':
      return `the title “${source.marker?.title ?? ''}” of its CalTopo marker${inFile} (in no folder that sets a type)`;
    case 'gpx-type':
      return 'its GPX <type>';
    case 'gpx-name':
      if (source.nameRule === 'prefix') return `the prefix “${source.prefix ?? ''}” of its GPX <name>`;
      if (source.nameRule === 'known-town') return 'its name, a known town (no <type> in the GPX)';
      return 'nothing: no <type>, prefix or CalTopo folder, so it is unclassified';
  }
}

/** The text of the files a save may change, as they are on disk or as an edit leaves them. */
interface SourceTexts {
  gpx: string;
  /** The CalTopo export, null when the trail has none. */
  geojson: string | null;
  registry: string;
  /** `descriptions.json`, null when the trail has none. */
  descriptions: string | null;
}

/** The source files of one trail, parsed. */
interface Sources extends SourceTexts {
  spans: GpxWaypointSpan[];
  /** What the build makes of each `<wpt>` (its name and type, and what decides the type), parallel to `spans`. */
  typed: TypeSource[];
  caltopo: CaltopoExport | null;
  registryEntries: WaypointRegistry;
  curated: CuratedDescription[];
}

function readSourceTexts(paths: EditorPaths, context: TrailContext): SourceTexts {
  return {
    gpx: fs.readFileSync(context.gpxPath, 'utf-8'),
    geojson: context.geojsonPath ? fs.readFileSync(context.geojsonPath, 'utf-8') : null,
    registry: fs.readFileSync(paths.registryPath, 'utf-8'),
    descriptions: fs.existsSync(context.descriptionsPath) ? fs.readFileSync(context.descriptionsPath, 'utf-8') : null,
  };
}

/**
 * A GPX's `<wpt>`s, each typed as the build will type it from the trail's
 * CalTopo export (`geojson`, null when it has none). The one place the editor
 * predicts the build's reading of the sources: every check of an edit, and
 * `sourceIdInputs`, go through it.
 */
function typeWaypoints(
  gpx: string,
  geojson: string | null
): { spans: GpxWaypointSpan[]; typed: TypeSource[]; caltopo: CaltopoExport | null } {
  const spans = listGpxWaypoints(gpx);
  const caltopo = geojson === null ? null : readCaltopoExport(geojson);
  return { spans, typed: spans.map(span => resolveSourceType(span, caltopo)), caltopo };
}

function parseSources(context: TrailContext, texts: SourceTexts): Sources {
  let waypoints: ReturnType<typeof typeWaypoints>;
  try {
    waypoints = typeWaypoints(texts.gpx, texts.geojson);
  } catch (error) {
    // The editor reads the GPX as the build does, and refuses what stops the build.
    throw new EditorError(
      `${path.basename(context.gpxPath)}: ${error instanceof Error ? error.message : String(error)}`,
      422
    );
  }
  return {
    ...texts,
    ...waypoints,
    registryEntries: JSON.parse(texts.registry) as WaypointRegistry,
    curated:
      texts.descriptions === null
        ? []
        : ((JSON.parse(texts.descriptions) as CuratedDescriptionsFile).descriptions ?? []),
  };
}

function readSources(paths: EditorPaths, context: TrailContext): Sources {
  return parseSources(context, readSourceTexts(paths, context));
}

/** The other `<wpt>`s the build types from the CalTopo marker that types `spans[index]`. */
function markerSharers(sources: Pick<Sources, 'spans' | 'typed'>, index: number): GpxWaypointSpan[] {
  const marker = sources.typed[index].marker;
  if (!marker) return [];
  return sources.spans.filter((_, i) => i !== index && sources.typed[i].marker?.index === marker.index);
}

function quotedNames(spans: readonly GpxWaypointSpan[]): string {
  return spans.map(s => `“${s.name.trim()}”`).join(', ');
}

// ---------------------------------------------------------------------------
// Joining ids to <wpt>s
// ---------------------------------------------------------------------------

/** Where a `<wpt>` is looked for, and as what: the build keeps an id on exactly this. */
interface JoinTarget {
  lat: number;
  lon: number;
  name: string;
  type: string;
}

/** An id that a `<wpt>` may be claimed for: a place (every pass of it), or a merged-away duplicate. */
interface Claimant {
  id: string;
  /** Its registry entry, when it has one: tried first. */
  entry?: JoinTarget;
  /** The waypoint as the last build has it; absent for a merged-away duplicate, which has no built row. */
  built?: JoinTarget;
}

interface Claim {
  /** Index into `sources.spans`, null when no `<wpt>` could be claimed. */
  span: number | null;
  /** The target that matched (so the current name and position), or the build's when none did. */
  at: JoinTarget | null;
  /** More than one `<wpt>` fits and nothing tells them apart. */
  ambiguous: boolean;
}

/**
 * Claim a `<wpt>` for each id. A `<wpt>` is an id's when the build's id
 * matching would keep that id on it without question: it stands on the exact
 * coordinates, under the name the build shows and with the type it gives. So
 * a `<wpt>` that merely shares a deleted waypoint's coordinates (two towns
 * hitched from one pass) is not claimed for it, and nor is a new one put on
 * the spot under another name or type.
 *
 * Registry entries are tried first, for every id, and what the last build has
 * second: a save moves the entry with its `<wpt>`, and a `<wpt>` that another
 * id's entry sits on is not this id's however it was built. Each `<wpt>` is
 * claimed once; where two fit one id equally (twins) neither is claimed, and
 * the claim says so. `claimed` is filled in, span index to id.
 */
function claimSpans(
  claimants: readonly Claimant[],
  sources: Sources,
  claimed: Map<number, string>
): Map<string, Claim> {
  const byPosition = new Map<string, number[]>();
  sources.spans.forEach((span, i) => {
    const key = `${span.lat},${span.lon}`;
    byPosition.set(key, [...(byPosition.get(key) ?? []), i]);
  });
  const candidates = (target: JoinTarget | undefined): number[] =>
    target === undefined
      ? []
      : (byPosition.get(`${target.lat},${target.lon}`) ?? []).filter(
          i => !claimed.has(i) && sources.typed[i].cleanedName === target.name && sources.typed[i].type === target.type
        );
  const claims = new Map<string, Claim>();
  for (const tier of ['entry', 'built'] as const) {
    // Until nothing more resolves: one claim can leave another id a single candidate.
    for (let progress = true; progress;) {
      progress = false;
      for (const claimant of claimants) {
        if (claims.has(claimant.id)) continue;
        const found = candidates(claimant[tier]);
        if (found.length !== 1) continue;
        claimed.set(found[0], claimant.id);
        claims.set(claimant.id, { span: found[0], at: claimant[tier]!, ambiguous: false });
        progress = true;
      }
    }
  }
  for (const claimant of claimants) {
    if (claims.has(claimant.id)) continue;
    const ambiguous = candidates(claimant.entry).length > 0 || candidates(claimant.built).length > 0;
    claims.set(claimant.id, { span: null, at: null, ambiguous });
  }
  return claims;
}

interface Joined {
  built: BuiltWaypoint;
  /** Current name and position: those of the target its `<wpt>` was found by, else the build's. */
  name: string;
  lat: number;
  lon: number;
  /** Index into `sources.spans`; null when its `<wpt>` is gone, or cannot be told from another. */
  span: number | null;
  ambiguous: boolean;
}

/** A `<wpt>` the last build merged into `survivor` and dropped: it has an id and a registry entry, but no built row. */
interface MergedAway {
  id: string;
  survivor: Joined;
  entry: WaypointRegistryEntry;
  /** Index into `sources.spans`; null when its `<wpt>` is gone since the build, or cannot be told from another. */
  span: number | null;
  ambiguous: boolean;
}

interface Join {
  joined: Joined[];
  mergedAway: MergedAway[];
  /** Span index to the registry id it was claimed for. */
  claimed: Map<number, string>;
}

/**
 * Join every id the last build knows to its `<wpt>`: each built waypoint (the
 * passes of a revisited place share one `<wpt>`), then each merged-away
 * duplicate. The build drops a merged duplicate's row, so its registry entry
 * is all that says where its `<wpt>` is; one with no entry cannot be placed
 * and is not listed, nor is one that still has a row of its own in another list.
 */
function joinToSources(builtWaypoints: BuiltWaypoint[], sources: Sources, trailId: string): Join {
  const entries = new Map((sources.registryEntries[trailId] ?? []).map(e => [e.id, e]));
  const places = new Map<string, Claimant>();
  for (const built of builtWaypoints) {
    const id = registryId(built.id);
    // The first pass names the place; a later pass stands in only when the first has no row.
    if (places.has(id) && built.id !== id) continue;
    const claimant: Claimant = { id, built };
    const entry = entries.get(id);
    if (entry) claimant.entry = entry;
    places.set(id, claimant);
  }
  const claimed = new Map<number, string>();
  const claims = claimSpans([...places.values()], sources, claimed);
  const joined = builtWaypoints.map((built): Joined => {
    const claim = claims.get(registryId(built.id))!;
    const at = claim.at ?? built;
    return { built, name: at.name, lat: at.lat, lon: at.lon, span: claim.span, ambiguous: claim.ambiguous };
  });

  const builtIds = new Set(builtWaypoints.map(b => b.id));
  const merged: { id: string; survivor: Joined; entry: WaypointRegistryEntry }[] = [];
  const seen = new Set<string>();
  for (const survivor of joined) {
    for (const id of survivor.built.mergedIds ?? []) {
      if (builtIds.has(id) || seen.has(id) || registryId(id) !== id) continue;
      const entry = entries.get(id);
      if (!entry) continue;
      seen.add(id);
      merged.push({ id, survivor, entry });
    }
  }
  const mergedClaims = claimSpans(
    merged.map(m => ({ id: m.id, entry: m.entry })),
    sources,
    claimed
  );
  const mergedAway = merged.map((m): MergedAway => {
    const claim = mergedClaims.get(m.id)!;
    return { ...m, span: claim.span, ambiguous: claim.ambiguous };
  });
  return { joined, mergedAway, claimed };
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

const GONE_REASON =
  'Its <wpt> is no longer in the GPX: deleted since the last build (or edited by hand). The next build retires its id; rebuild before editing it. To put it back before that, add a waypoint of its type under its name on its exact position: it is then this waypoint again, with its id (within 100 m of it, the next build hands the id back instead). Whatever else its <wpt> had comes back only from git.';

const AMBIGUOUS_REASON =
  'More than one <wpt> stands on its position under its name and type, so the editor cannot tell which is its: give them names of their own by hand in the GPX (the build cannot tell them apart either), then rebuild.';

/** A merged-away duplicate as a row: its own id, name and position, flagged with the waypoint it merged into. */
function toMergedWaypoint(
  context: TrailContext,
  merged: MergedAway,
  survivor: EditorWaypoint,
  curated: Map<string, string>,
  access: Record<string, AccessEntryLite>,
  sources: Sources
): EditorWaypoint {
  const { id, entry } = merged;
  const span = merged.span === null ? null : sources.spans[merged.span];
  const typeSource = merged.span === null ? null : sources.typed[merged.span];
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
  if (typeSource) waypoint.typeSource = typeSourceText(typeSource, geojsonFile(context));
  if (!span && !merged.ambiguous && !context.readOnlyReason) waypoint.deleted = true;
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
function mergedLockedReason(
  context: TrailContext,
  waypoint: EditorWaypoint,
  survivor: EditorWaypoint,
  ambiguous: boolean
): string {
  if (context.readOnlyReason) return context.readOnlyReason;
  if (waypoint.deleted) return GONE_REASON;
  if (ambiguous) return AMBIGUOUS_REASON;
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

/** A pending waypoint's temporary key: stable while its `<wpt>` is unchanged, and never a valid id. */
function pendingKey(span: GpxWaypointSpan): string {
  const hash = createHash('sha1').update(`${span.lat}|${span.lon}|${span.name}`).digest('hex');
  return `${PENDING_KEY_PREFIX}${hash.slice(0, 10)}`;
}

/**
 * Why a revisited place's later pass (`<id>_2`) is not described or deleted on
 * its own: every pass is built from the first pass's `<wpt>`, and the build
 * applies a curated description to that `<wpt>` before it makes the later
 * passes, so the text is the place's.
 */
function laterPassReason(id: string, name: string, orphanEntry: boolean): string {
  const place = registryId(id);
  const reason = `A later pass of “${name}” (${place}): the route passes this place more than once (${REVISITED_KEY} in trail.json), and every pass is built from the one <wpt>. Its description is the place's and shows on every pass: edit it on ${place}. A move, a rename or a type change made here changes the place, so every pass; to delete the place, delete ${place}.`;
  if (!orphanEntry) return reason;
  return `${reason} ${DESCRIPTIONS_FILENAME} has an entry under ${id}, which the build never applies (it reports it as matching no waypoint): move its text to ${place} by hand and delete that entry.`;
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
  const { built } = joined;
  const span = joined.span === null ? null : sources.spans[joined.span];
  const typeSource = joined.span === null ? null : sources.typed[joined.span];
  const place = registryId(built.id);
  const laterPass = place !== built.id;
  const locked = context.readOnlyReason ?? (span ? undefined : joined.ambiguous ? AMBIGUOUS_REASON : GONE_REASON);
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
    // Curated text is keyed by the place: a later pass shows the first pass's, as the build does.
    description: curated.get(place) ?? '',
    canMove: !locked,
    canRename: !locked,
    canDescribe: !locked && !laterPass,
    canChangeType: !locked,
    // A later pass is built from the first pass's <wpt>: deleting it is deleting the first.
    canDelete: !locked && !laterPass,
  };
  if (typeSource) waypoint.typeSource = typeSourceText(typeSource, geojsonFile(context));
  if (locked) waypoint.lockedReason = locked;
  else if (laterPass) waypoint.lockedReason = laterPassReason(built.id, joined.name, curated.has(built.id));
  if (!span && !joined.ambiguous && !context.readOnlyReason) waypoint.deleted = true;
  const ele = sourceElevation(span);
  if (ele !== undefined) waypoint.ele = ele;
  if (built.distanceFromTrailM !== undefined) waypoint.distanceFromTrailM = built.distanceFromTrailM;
  const sourceText = sourceDescription(span, sources.caltopo, joined);
  if (sourceText) waypoint.sourceDescription = sourceText;
  else if (!curated.has(place) && built.description) waypoint.sourceDescription = built.description;
  const accessEntry = access[place];
  if (accessEntry) {
    waypoint.access = {};
    if (accessEntry.method) waypoint.access.method = accessEntry.method;
    if (accessEntry.store) waypoint.access.store = accessEntry.store;
  }
  const others = joined.span === null ? [] : (sharers.get(joined.span) ?? []).filter(id => id !== built.id);
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
  index: number,
  sources: Sources,
  points: { lat: number; lon: number; dist: number }[],
  starts: ReadonlySet<number>
): EditorWaypoint {
  const span = sources.spans[index];
  const typeSource = sources.typed[index];
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
    typeSource: typeSourceText(typeSource, geojsonFile(context)),
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

/**
 * A `<wpt>` with a live registry entry exactly on it (its name and type too)
 * that the last build here does not list, in a row or among any row's
 * `mergedIds`: the registry is ahead of the generated data. That is a pull
 * that brought a new waypoint with its id but was not followed by a rebuild
 * (the registry is committed, the generated data is built on each machine).
 * It has an id, so it is not pending, and it is listed under that id, locked:
 * the editor does not know its km or lists, and must not edit it as if it had
 * no id to keep.
 */
function toUnbuiltWaypoint(
  context: TrailContext,
  entry: WaypointRegistryEntry,
  index: number,
  curated: Map<string, string>,
  sources: Sources,
  points: { lat: number; lon: number; dist: number }[],
  starts: ReadonlySet<number>
): EditorWaypoint {
  const span = sources.spans[index];
  const typeSource = sources.typed[index];
  const waypoint: EditorWaypoint = {
    id: entry.id,
    notBuilt: true,
    name: entry.name,
    type: typeSource.type,
    builtType: typeSource.type,
    typeSource: typeSourceText(typeSource, geojsonFile(context)),
    lat: entry.lat,
    lon: entry.lon,
    builtLat: entry.lat,
    builtLon: entry.lon,
    builtName: entry.name,
    placements: [],
    sortKm: snapToTrail(entry.lat, entry.lon, points, undefined, starts)?.currentKm ?? 0,
    description: curated.get(entry.id) ?? '',
    canMove: false,
    canRename: false,
    canDescribe: false,
    canChangeType: false,
    canDelete: false,
    lockedReason:
      context.readOnlyReason ??
      `It has the id ${entry.id} in data/waypoint-ids.json, but the last build on this machine does not list it: the generated trail data is older than the registry (a pull that was not followed by a rebuild?). Rebuild, then edit it.`,
  };
  const ele = sourceElevation(span);
  if (ele !== undefined) waypoint.ele = ele;
  const sourceText = sourceDescription(span, sources.caltopo, entry);
  if (sourceText) waypoint.sourceDescription = sourceText;
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

/** The registry entries of one trail on their own: what `assignWaypointIds` reads and changes. */
function trailRegistry(registry: WaypointRegistry, trailId: string): WaypointRegistry {
  return { [trailId]: structuredClone(registry[trailId] ?? []) };
}

/** What `assignWaypointIds` is handed for these sources: every `<wpt>`, in file order, named and typed as the build does. */
function idInputs(sources: Pick<Sources, 'spans' | 'typed'>): WaypointForId[] {
  return sources.spans.map((span, i) => ({
    name: sources.typed[i].cleanedName,
    type: sources.typed[i].type,
    lat: span.lat,
    lon: span.lon,
  }));
}

/**
 * What the editor takes the next build to hand `assignWaypointIds` for a trail
 * directory, from its committed sources alone (no built data is read): the
 * files it reads, and every `<wpt>` in file order with the name and type it
 * expects the build to give it.
 *
 * This is the prediction every "ids kept" check rests on, made with the
 * editor's own reading of the GPX and the CalTopo export rather than the
 * build's. `build-parity.test.ts` runs it beside the build's functions over
 * every committed trail, so a change to how the build names or types a
 * waypoint cannot leave the editor passing an edit the build would re-key.
 */
export function sourceIdInputs(
  paths: EditorPaths,
  dirParam: string
): { trailId: string; gpxFile: string; geojsonFile?: string; inputs: WaypointForId[] } {
  const dir = resolveTrailDir(paths, dirParam);
  const trailDir = path.join(paths.trailsDir, dir);
  const config = trailConfig(paths, dir);
  const gpxFile = gpxFileName(paths, dir, config);
  const geojsonFile = geojsonFileName(paths, dir, config);
  const waypoints = typeWaypoints(
    fs.readFileSync(path.join(trailDir, gpxFile), 'utf-8'),
    geojsonFile ? fs.readFileSync(path.join(trailDir, geojsonFile), 'utf-8') : null
  );
  return {
    trailId: config.id ?? dir.toLowerCase(),
    gpxFile,
    ...(geojsonFile ? { geojsonFile } : {}),
    inputs: idInputs(waypoints),
  };
}

/** The editor's rows for a trail, and which `<wpt>` each stands for. */
interface TrailView {
  rows: EditorWaypoint[];
  /** Row id to the index of its `<wpt>` in `sources.spans`; a row whose `<wpt>` is gone has none. */
  spanOf: Map<string, number>;
}

function buildView(
  context: TrailContext,
  sources: Sources,
  access: Record<string, AccessEntryLite> = readAccess(context.trailDir)
): TrailView {
  const { trailId } = context;
  const curated = new Map(sources.curated.map(d => [d.waypointId, d.description]));
  const { joined, mergedAway, claimed } = joinToSources(collectBuiltWaypoints(context.built), sources, trailId);
  const spanOf = new Map<string, number>();
  const sharers = new Map<number, string[]>();
  for (const j of joined) {
    if (j.span === null) continue;
    spanOf.set(j.built.id, j.span);
    sharers.set(j.span, [...(sharers.get(j.span) ?? []), j.built.id]);
  }
  const points = displayPoints(context.built);
  const starts = routeBreakStarts(context.built.track.breaks, 'displayPoints');
  const built = joined.map(j =>
    toEditorWaypoint(context, j, curated, access, sharers, sources, sortKm(j, points, starts))
  );

  // The <wpt>s the build merged into a near-duplicate (`dedupeWaypoints`): each
  // has an id but no built row, and is listed beside the waypoint it merged into.
  const rows = new Map(built.map(w => [w.id, w]));
  const merged = mergedAway.map(m => {
    if (m.span !== null) spanOf.set(m.id, m.span);
    return toMergedWaypoint(context, m, rows.get(m.survivor.built.id)!, curated, access, sources);
  });
  for (const w of merged) rows.set(w.id, w);
  for (const j of joined) {
    if (j.built.mergedIds?.length) rows.get(j.built.id)!.mergedIds = j.built.mergedIds;
  }
  merged.forEach((w, i) => {
    // Still a duplicate, as the sources stand? Only while the waypoint it
    // merged into is there and the build would chain the two together again.
    const survivor = rows.get(w.mergedInto!)!;
    const group = mergeGroup(rows, survivor.id);
    const stays = !w.deleted && !survivor.deleted && mergesWith(survivor, group, context.dedupeRadiusMeters).has(w.id);
    if (!stays && !w.deleted) w.unmerges = true;
    w.lockedReason = mergedLockedReason(context, w, survivor, mergedAway[i].ambiguous);
  });

  // The <wpt>s nothing was claimed for. One that a listed id could not be told
  // from (twins: that row says so) is accounted for and not listed again. One
  // with a live registry entry exactly on it has an id the last build here
  // does not know. Any other is new since the build, and pending.
  const fits = (index: number, target: JoinTarget): boolean =>
    sources.spans[index].lat === target.lat &&
    sources.spans[index].lon === target.lon &&
    sources.typed[index].cleanedName === target.name &&
    sources.typed[index].type === target.type;
  const entries = sources.registryEntries[trailId] ?? [];
  const entryOf = new Map(entries.map(e => [e.id, e]));
  const unplaced: JoinTarget[] = [
    ...joined
      .filter(j => j.ambiguous)
      .flatMap((j): JoinTarget[] => {
        const entry = entryOf.get(registryId(j.built.id));
        return entry ? [j.built, entry] : [j.built];
      }),
    ...mergedAway.filter(m => m.ambiguous).map(m => m.entry),
  ];
  const listed = new Set([...joined.map(j => registryId(j.built.id)), ...mergedAway.map(m => m.id)]);
  const unbuiltEntries = entries.filter(e => !e.retired && !listed.has(e.id));
  const unbuilt: EditorWaypoint[] = [];
  const pendingSpans: number[] = [];
  sources.spans.forEach((_, index) => {
    if (claimed.has(index) || unplaced.some(target => fits(index, target))) return;
    const entry = unbuiltEntries.find(e => fits(index, e));
    if (!entry) {
      pendingSpans.push(index);
    } else if (!spanOf.has(entry.id)) {
      // Twins under one unbuilt entry: the first stands for it, the rest are not listed.
      spanOf.set(entry.id, index);
      unbuilt.push(toUnbuiltWaypoint(context, entry, index, curated, sources, points, starts));
    }
  });
  const pending = pendingSpans.map(index => {
    const waypoint = toPendingWaypoint(context, index, sources, points, starts);
    spanOf.set(waypoint.id, index);
    return waypoint;
  });

  // Where the build's id matching hands a pending <wpt> an id the registry
  // already holds, say so on both rows: the entry's own row would otherwise
  // claim its id is about to be retired.
  if (pending.length) {
    let nextIds: string[] | null;
    try {
      nextIds = assignWaypointIds(trailId, idInputs(sources), trailRegistry(sources.registryEntries, trailId));
    } catch {
      // The build would stop: a save says why. Nothing can be said about ids here.
      nextIds = null;
    }
    pending.forEach((waypoint, i) => {
      const id = nextIds?.[pendingSpans[i]];
      if (id === undefined || !entryOf.has(id)) return;
      waypoint.takesId = id;
      const owner = rows.get(id);
      if (owner?.deleted && !context.readOnlyReason) {
        const apart = Math.round(haversineDistance(owner.lat, owner.lon, waypoint.lat, waypoint.lon));
        owner.lockedReason = `Its <wpt> is no longer in the GPX: deleted since the last build (or edited by hand). The next build gives its id to “${waypoint.name}”, a <wpt> of its type ${apart} m away, which it reads as this waypoint moved, renamed or put back: the comments keyed to ${id} stay with it. Rebuild before editing either.`;
      }
    });
  }

  // In km order, each merged-away duplicate straight after the waypoint it merged into.
  const ordered = [...built, ...unbuilt, ...pending].sort(
    (a, b) => a.sortKm - b.sortKm || a.name.localeCompare(b.name)
  );
  return { rows: ordered.flatMap(w => [w, ...merged.filter(m => m.mergedInto === w.id)]), spanOf };
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
      config: relative(paths, context.configPath),
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
    waypoints: buildView(context, readSources(paths, context)).rows,
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
      `“${name}” starts with the type prefix “${classified.matchedPrefix ?? ''}”, which the build strips from names (it would show “${classified.cleanedName}”, typed ${classified.type}): leave it off (the type comes from Type).`
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

/**
 * The index of another `<wpt>` on exactly the coordinates `at`, under the
 * build name `at.name`; -1 when there is none. `except` is the `<wpt>` asked
 * about, when it is in `sources` itself.
 *
 * Any number of `<wpt>`s may stand on one position (the CDT's towns hitched
 * from one pass: 18 groups of two to four), so long as each has a name of its
 * own there. Two under one name on one position are what nothing tells apart:
 *  - of one type too, they are twins. The editor joins an id to its `<wpt>` by
 *    coordinates, name and type (`claimSpans`), so it claims neither and locks
 *    both; the build keeps an id on the same three (`assignWaypointIds` stops
 *    on a second waypoint of one type and name within its radius of an entry,
 *    and `dedupeWaypoints` merges the two into one row);
 *  - of different types, the join could tell them apart, but a `<wpt>` that is
 *    not built yet is keyed by its coordinates and name alone (`pendingKey`),
 *    and an added one is read back the same way (`findGpxWaypoint`).
 * Names are compared as the build shows them, so a hand-written `C Flat` and
 * `Flat` are one name.
 */
function namesakeAt(
  sources: Pick<Sources, 'spans' | 'typed'>,
  at: { lat: number; lon: number; name: string },
  except = -1
): number {
  return sources.spans.findIndex(
    (span, i) => i !== except && span.lat === at.lat && span.lon === at.lon && sources.typed[i].cleanedName === at.name
  );
}

/** Why a `<wpt>` cannot stand where `other` does under its name ({@link namesakeAt}), as the type `type`. */
function namesakeError(other: TypeSource, type: string): EditorError {
  const shared = 'Waypoints may share a position (several towns hitched from one pass do), but';
  return new EditorError(
    other.type === type
      ? `A ${type} named “${other.cleanedName}” already stands on exactly this position. ${shared} two of one name and type there are twins: the editor joins an id to its <wpt> by position, name and type, so it could not tell which <wpt> is whose, and the build keeps an id on the same three. Give this one a name of its own. Nothing was written.`
      : `“${other.cleanedName}”, a ${other.type}, already stands on exactly this position. ${shared} each needs a name of its own there: the editor tells them apart by name (a waypoint that is not built yet is keyed by its position and name alone, whatever its type). Give this one a name of its own. Nothing was written.`
  );
}

function kmAway(at: { lat: number; lon: number }, marker: { lat: number; lon: number }): string {
  return (haversineDistance(at.lat, at.lon, marker.lat, marker.lon) / 1000).toFixed(1);
}

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
      ? `A CalTopo marker titled “${marker.title}” in ${geojsonFile(context)}, ${kmAway(at, marker)} km away, would type it as ${marker.type}: the build types a waypoint from the nearest marker with its name. Give it a name of its own.`
      : `The build would type it as ${resolved.type}, not ${type}.`
  );
}

/**
 * Why a `<wpt>` cannot take a name a CalTopo marker already types another
 * `<wpt>` by: the build types every `<wpt>` of a name from the nearest marker
 * with it, however far, so the two would share that marker, and a later move,
 * rename or retype of either could not be made in the marker without changing
 * the other.
 */
function sharedMarkerError(
  context: TrailContext,
  marker: CaltopoMarkerInfo,
  others: readonly GpxWaypointSpan[],
  at: { lat: number; lon: number }
): EditorError {
  return new EditorError(
    `The CalTopo marker “${marker.title}” in ${geojsonFile(context)}, ${kmAway(at, marker)} km away, has this name and also types ${quotedNames(others)}: the build types every <wpt> from the nearest marker with its name (and shows that marker's description), so the two would share it. Give this one a name of its own.`
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

/**
 * Where a new description entry goes: before the first entry that follows it,
 * main-route entries counted first and by km, the rest after and by position.
 * In a file already in that order it lands in order; in one that is not (the
 * bundled files have a few entries out of place) it still goes before the
 * first entry that should come after it, and nothing else moves.
 */
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

/**
 * `descriptions.json` with one entry added, replaced or (for '') removed; null
 * when unchanged. The entry's `name` aid is the author's: it is written on a
 * new entry, and changed on an existing one only when the save renames the
 * waypoint (`renamedTo`).
 */
function describedText(
  context: TrailContext,
  existing: string | null,
  waypoint: EditorWaypoint,
  text: string,
  renamedTo: string | undefined,
  waypoints: Map<string, EditorWaypoint>
): string | null {
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
      const entry = file.descriptions[index];
      file.descriptions[index] =
        renamedTo !== undefined && entry.name !== undefined
          ? { ...entry, name: renamedTo, description: text }
          : { ...entry, description: text };
    } else {
      const at = descriptionOrder(file.descriptions, waypoint.id, waypoints);
      file.descriptions.splice(at, 0, { waypointId: waypoint.id, name: renamedTo ?? waypoint.name, description: text });
    }
  });
  return next === existing ? null : next;
}

/** `descriptions.json` with the entry's `name` aid following a rename; null when unchanged. */
function renamedDescriptionText(existing: string | null, id: string, name: string): string | null {
  if (existing === null) return null;
  const next = editJsonPreservingLayout<CuratedDescriptionsFile>(existing, DESCRIPTIONS_FILENAME, file => {
    for (const d of file.descriptions) if (d.waypointId === id && d.name !== undefined) d.name = name;
  });
  return next === existing ? null : next;
}

/** `descriptions.json` without the entries for `ids`; null when it has none of them. */
function withoutDescriptionsText(existing: string | null, ids: readonly string[]): string | null {
  if (existing === null) return null;
  const next = editJsonPreservingLayout<CuratedDescriptionsFile>(existing, DESCRIPTIONS_FILENAME, file => {
    file.descriptions = file.descriptions.filter(d => !ids.includes(d.waypointId));
  });
  return next === existing ? null : next;
}

/**
 * The registry with the entry of a waypoint's place moved, renamed and/or
 * retyped; null when the place has no entry. Every pass of a revisited place
 * shares the one entry.
 */
function registryText(
  existing: string,
  trailId: string,
  id: string,
  edit: { lat?: number; lon?: number; name?: string; type?: string }
): string | null {
  let found = false;
  const next = editJsonPreservingLayout<WaypointRegistry>(existing, 'waypoint-ids.json', registry => {
    const entry = (registry[trailId] ?? []).find(e => e.id === registryId(id));
    if (!entry) return;
    found = true;
    if (edit.lat !== undefined && edit.lon !== undefined) {
      entry.lat = edit.lat;
      entry.lon = edit.lon;
    }
    if (edit.name !== undefined) entry.name = edit.name;
    if (edit.type !== undefined) entry.type = edit.type;
  });
  return found ? next : null;
}

// ---------------------------------------------------------------------------
// Writing: every file of a save, or none
// ---------------------------------------------------------------------------

/** The file-system calls a save's writes go through; a test passes its own to make one fail. */
export type WriteIo = Pick<typeof fs, 'writeFileSync' | 'copyFileSync' | 'renameSync' | 'rmSync'>;

/** Where a write to `file` lands: the file a symbolic link points to, so the link itself is never replaced. */
function writeTarget(file: string): string {
  let target = file;
  for (let hops = 0; hops < 8; hops++) {
    let link: string;
    try {
      if (!fs.lstatSync(target).isSymbolicLink()) break;
      link = fs.readlinkSync(target);
    } catch {
      // Not there yet: it is created where it is named.
      break;
    }
    target = path.resolve(path.dirname(target), link);
  }
  return target;
}

/**
 * Replace each file with its new text, all of them or none. Every text is
 * first written to a temporary file beside its target (a disk that is full, a
 * directory that is not there or not writable fails here, with nothing
 * changed); each target is then replaced by renaming its temporary file over
 * it, which a file system does in one step. If a rename fails, the files
 * already replaced are put back from the copies kept of them. The temporary
 * names end in `.wpe-tmp` / `.wpe-bak` and start with a dot, so neither the
 * build nor the editor takes one for a GPX or a CalTopo export.
 */
export function commitWrites(writes: readonly { file: string; text: string }[], io: WriteIo = fs): void {
  const staged: { file: string; target: string; temp: string; backup: string | null }[] = [];
  const discard = (file: string | null): void => {
    try {
      if (file) fs.rmSync(file, { force: true });
    } catch {
      // A leftover temporary file is harmless.
    }
  };
  const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));
  try {
    writes.forEach(({ file, text }, n) => {
      const target = writeTarget(file);
      const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}-${n}.wpe-tmp`);
      staged.push({ file, target, temp, backup: null });
      io.writeFileSync(temp, text);
      if (fs.existsSync(target)) fs.chmodSync(temp, fs.statSync(target).mode);
    });
  } catch (error) {
    for (const s of staged) discard(s.temp);
    throw new EditorError(`Could not write the edit (${reason(error)}): nothing was changed.`, 500);
  }
  const replaced: typeof staged = [];
  try {
    for (const s of staged) {
      if (fs.existsSync(s.target)) {
        s.backup = s.temp.replace(/tmp$/, 'bak');
        io.copyFileSync(s.target, s.backup);
      }
      io.renameSync(s.temp, s.target);
      replaced.push(s);
    }
  } catch (error) {
    const stuck: string[] = [];
    for (const s of replaced.reverse()) {
      try {
        if (s.backup) io.renameSync(s.backup, s.target);
        else io.rmSync(s.target, { force: true });
      } catch {
        stuck.push(s.file);
      }
    }
    for (const s of staged) {
      discard(s.temp);
      if (!stuck.includes(s.file)) discard(s.backup);
    }
    throw new EditorError(
      stuck.length
        ? `Could not write the edit (${reason(error)}), and ${stuck.join(', ')} could not be put back as ${stuck.length === 1 ? 'it was' : 'they were'}: restore ${stuck.length === 1 ? 'it' : 'them'} from the .wpe-bak ${stuck.length === 1 ? 'copy' : 'copies'} beside ${stuck.length === 1 ? 'it' : 'them'}, or with git.`
        : `Could not write the edit (${reason(error)}): the files already replaced were put back as they were, so nothing was changed.`,
      500
    );
  }
  for (const s of staged) discard(s.backup);
}

// ---------------------------------------------------------------------------
// Ids: what the next build would do
// ---------------------------------------------------------------------------

interface IdRun {
  registry: WaypointRegistry;
  inputs: WaypointForId[];
}

/**
 * Run the build's id matching (on a copy of the registry) over the sources
 * before and after an edit, and refuse the edit if any waypoint the two share
 * would come out of the next build with a different id: that is a waypoint
 * losing its comments and description. A `<wpt>` that is not built yet has no
 * id to lose, but is refused the id of one that is. `pairs` maps each
 * after-index to the before-index of the same `<wpt>`. Returns the ids before
 * and after, the build's warnings about the after state, and a line for each
 * unbuilt `<wpt>` whose new id would merely be another new one (`reminted`).
 */
function assertIdsKept(
  trailId: string,
  before: IdRun,
  after: IdRun,
  pairs: readonly [number, number][],
  doing: { after: string; retry: string } = { after: 'after this edit', retry: 'make this edit again' }
): { ids: string[]; beforeIds: string[]; warnings: string[]; reminted: string[] } {
  let beforeIds: string[];
  try {
    beforeIds = assignWaypointIds(trailId, before.inputs, trailRegistry(before.registry, trailId));
  } catch (error) {
    throw new EditorError(
      `The sources as they are would already stop the build, so the editor cannot check what this edit does to ids: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const warnings: string[] = [];
  let ids: string[];
  try {
    ids = assignWaypointIds(trailId, after.inputs, trailRegistry(after.registry, trailId), m =>
      warnings.push(m.trim())
    );
  } catch (error) {
    throw new EditorError(`That would stop the next build: ${error instanceof Error ? error.message : String(error)}`);
  }
  const changed = pairs.filter(([a, b]) => ids[a] !== beforeIds[b]);
  // An id the before-run minted belongs to a <wpt> that is not built yet: it
  // has no id, comments or description to lose. What it can do is take a built
  // waypoint's.
  const entries = new Map((before.registry[trailId] ?? []).map(e => [e.id, e]));
  const lost = changed
    .filter(([, b]) => entries.has(beforeIds[b]))
    .map(([a, b]) => `“${after.inputs[a].name}” (${beforeIds[b]} would become ${ids[a]})`);
  if (lost.length) {
    throw new EditorError(
      `That would change the id of ${lost.join(', ')}, orphaning the comments and description keyed to it; the editor will not do that.`
    );
  }
  const unbuilt = changed.flatMap(([a, b]) => {
    const taken = entries.get(ids[a]);
    if (!taken) return [];
    const name = `“${after.inputs[a].name}”`;
    return `${name} is not built yet, so it has no id of its own (the next build would mint it ${beforeIds[b]}): ${doing.after}, the build would read it as “${taken.name}” moved or renamed and give it ${taken.id}, with the comments and description keyed to that id. Rebuild first, so that ${name} has its own id (${beforeIds[b]}), then ${doing.retry}.`;
  });
  if (unbuilt.length) throw new EditorError(`${unbuilt.join(' ')} Nothing was written.`);
  // What is left is a <wpt> with no id yet that would now be minted another new
  // one: nothing is keyed to either, so nothing is lost. A new id is made from
  // the type and position, and the waypoints of one type that are not built yet
  // on one position take theirs in file order, so an edit to one can change the next one's.
  const reminted = changed.map(
    ([a, b]) =>
      `“${after.inputs[a].name}”, not built yet either, will now be minted ${ids[a]} by the next build, not ${beforeIds[b]}: a new id comes from the type and position, and waypoints of one type that share a position take theirs in file order. Nothing is keyed to an id it does not have yet.`
  );
  return { ids, beforeIds, warnings, reminted };
}

/**
 * Refuse a `<wpt>` with no id of its own that the next build would hand a
 * live entry's id: an entry whose own `<wpt>` is gone since the last build is
 * not retired until a build runs, and until then the build's proximity pass
 * reads any `<wpt>` of its type within reach as that waypoint moved or
 * renamed, and gives it the id with its comments. Only the waypoint itself
 * coming back, under its own name, may take it. (A retired entry is safe as it
 * is: the build hands it back to its own name alone.)
 *
 * `was` is the id the `<wpt>` was going to take before this edit, when it
 * was. A `<wpt>` that already stands in for a live entry under another name
 * (renamed by hand in the GPX, to the build) is not edited at all until a
 * rebuild has made it that waypoint: an edit here could not carry the entry
 * with it, and a move out of reach would retire the id it is about to get.
 */
function assertNoLiveIdTaken(
  registry: WaypointRegistry,
  trailId: string,
  nextId: string,
  name: string,
  doing: 'add' | 'edit',
  was?: string
): void {
  const entries = registry[trailId] ?? [];
  const reads = (type: string) =>
    `the build reads a ${type} within ${MATCH_RADIUS_METERS} m of an entry that has lost its <wpt> as that waypoint moved or renamed, and gives it the id with the comments and description keyed to it`;
  const held = was === undefined ? undefined : entries.find(e => e.id === was);
  if (held && !held.retired && held.name !== name) {
    throw new EditorError(
      `The next build gives this <wpt> the id ${held.id} of “${held.name}”, whose own <wpt> is gone since the last build: ${reads(held.type)}. Rebuild before editing it: if it is “${held.name}” renamed by hand, it is then a built waypoint that keeps ${held.id} through an edit; if it is a different place, delete it, rebuild first so ${held.id} is retired, and add it again.`
    );
  }
  const entry = entries.find(e => e.id === nextId);
  if (!entry || entry.retired || entry.name === name) return;
  throw new EditorError(
    `“${entry.name}” (${entry.id}) stood within ${MATCH_RADIUS_METERS} m of this, and its <wpt> is gone since the last build, but its id is not retired until a build runs: ${reads(entry.type)}. Rebuild first so ${entry.id} is retired, then ${doing === 'add' ? 'add this waypoint' : 'make this edit'}. (To restore “${entry.name}” itself, give it that name.)`
  );
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

/**
 * A coordinate as a save writes it, six decimals: a position is rounded once,
 * where it comes in, and that number is what goes in the GPX, the CalTopo
 * marker and the registry, and what an elevation is looked up for.
 */
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
 * folder title means `type`. The caller has made sure the marker types no
 * other waypoint.
 */
function retypedCaltopo(
  context: TrailContext,
  caltopo: CaltopoExport,
  geojsonText: string,
  marker: CaltopoMarkerInfo,
  title: string,
  type: string,
  notes: string[]
): string {
  const file = geojsonFile(context)!;
  const titles = folderTitlesForType(type);
  const folder = caltopo.folders.find(f => titles.includes(f.title.toLowerCase()));
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
 * since the page read it. Everything, the answer included, is worked out
 * before the first byte is written, and the files are then replaced together
 * ({@link commitWrites}), so an error never follows a write.
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
  const access = readAccess(context.trailDir);
  const view = buildView(context, sources, access);
  const byId = new Map(view.rows.map(w => [w.id, w]));
  const current = byId.get(waypointId);
  if (!current) throw new EditorError(`${context.trailId} has no waypoint ${waypointId}`, 404);

  validate(request, current, MAX_DESCRIPTION_LENGTH);
  assertExpected(request.expected, current);

  const newName = request.name?.trim();
  const rename = newName !== undefined && newName !== current.name;
  // A position is rounded once, here, to what is written; one that the page
  // sends back as it read it, or that rounds to where the waypoint is, is no move.
  const asked =
    request.lat !== undefined &&
    request.lon !== undefined &&
    (!sameCoordinate(request.lat, current.lat) || !sameCoordinate(request.lon, current.lon));
  const lat = asked ? writtenCoordinate(request.lat!) : current.lat;
  const lon = asked ? writtenCoordinate(request.lon!) : current.lon;
  const move = asked && (lat !== current.lat || lon !== current.lon);
  const describe = request.description !== undefined && request.description.trim() !== current.description;
  const retype = request.type !== undefined && request.type !== current.type;
  const name = rename ? newName : current.name;
  const place = registryId(current.id);
  const laterPass = !current.pending && place !== current.id;

  const notes: string[] = [];
  // Compute every write before making any, so a refusal (a file whose layout
  // cannot be reproduced, a type that cannot be made safe) leaves nothing half-written.
  const texts: SourceTexts = {
    gpx: sources.gpx,
    geojson: sources.geojson,
    registry: sources.registry,
    descriptions: sources.descriptions,
  };
  let configText = context.configText;
  let elevationNote: string | undefined;
  let nextId: string | null = null;
  /** What the edit does to the id another unbuilt `<wpt>` will be minted. */
  let otherIdNotes: string[] = [];
  const spanIndex = view.spanOf.get(current.id);
  const spanNow = (): GpxWaypointSpan => listGpxWaypoints(texts.gpx)[spanIndex!];

  if (move || rename || retype) {
    if (spanIndex === undefined) throw new EditorError('Its <wpt> is no longer in the GPX: reload the trail', 409);
    const span = sources.spans[spanIndex];
    const typeSource = sources.typed[spanIndex];
    const marker = typeSource.marker;
    const file = geojsonFile(context);
    // Every move, rename and retype is held to one set of rules, whether the
    // waypoint has an id or is still pending.
    if (rename) assertNoTypePrefix(newName);
    if (current.pending && move) assertNearRoute(context, lat, lon);
    // The build types every <wpt> of a name from the nearest marker with it:
    // a marker that types another <wpt> too is never edited for this one.
    const sharers = markerSharers(sources, spanIndex);
    if (retype && marker && sharers.length) {
      throw new EditorError(
        `Its CalTopo marker “${marker.title}” in ${file} also types ${quotedNames(sharers)} (the build takes the nearest marker with the same name), so its folder cannot be changed for this waypoint alone: retyping it would retype those too and cost them their ids. Rename this waypoint first: under a name of its own it is typed by its own <type>.`
      );
    }

    // The GPX: the <name>, the position (and the <ele> that follows it), the <type>.
    let rawName = rename ? renameKeepingPrefix(span.name, name) : span.name;
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
    if (rawName !== span.name) texts.gpx = setGpxWaypointName(texts.gpx, span, rawName);
    if (move) {
      texts.gpx = setGpxWaypointPosition(texts.gpx, spanNow(), lat, lon);
      // An <ele> the <wpt> carries follows it: read from the <wpt> itself, as it now is in the text.
      const rewritten = movedWaypointElevation(texts.gpx, spanNow(), () => elevationAt(context, lat, lon, elevation));
      texts.gpx = rewritten.gpx;
      elevationNote = rewritten.note;
    }
    if (retype && !marker) {
      texts.gpx = setGpxWaypointType(texts.gpx, spanNow(), request.type!);
      notes.push(
        typeSource.by === 'gpx-type'
          ? 'Changed its GPX <type>.'
          : `Added a GPX <type>, which outranks ${typeSource.nameRule === 'known-town' ? 'the known-town list' : 'its name'} in the build.`
      );
    }

    // The CalTopo marker that types it: moved, retitled and refoldered with it, unless it is shared.
    if (marker && texts.geojson !== null && file) {
      if (sharers.length) {
        if (move || rename) {
          const left = [move ? 'where it is' : '', rename ? 'titled as it is' : ''].filter(Boolean).join(' and ');
          notes.push(
            `Left its CalTopo marker “${marker.title}” in ${file} ${left}: it also types ${quotedNames(sharers)} (the build types a <wpt> from the nearest marker with its name).`
          );
        }
      } else {
        let title = marker.title;
        if (move || rename) {
          const edit: { lat?: number; lon?: number; title?: string } = {};
          if (move) Object.assign(edit, { lat, lon });
          if (rename) edit.title = title = renameKeepingPrefix(marker.title, name);
          texts.geojson = editCaltopoMarker(texts.geojson, file, marker, edit);
        }
        if (retype) {
          texts.geojson = retypedCaltopo(context, sources.caltopo!, texts.geojson, marker, title, request.type!, notes);
        }
      }
    } else if (file && (move || rename) && !current.pending) {
      notes.push(`No CalTopo marker named "${current.name}" in ${file}: its type comes from the GPX alone.`);
    }

    // The registry entry of its place. A pending waypoint has none to edit:
    // the next build mints (or hands back) its id.
    if (!current.pending) {
      const registryEdit: { lat?: number; lon?: number; name?: string; type?: string } = {};
      if (move) Object.assign(registryEdit, { lat, lon });
      if (rename) registryEdit.name = name;
      if (retype) registryEdit.type = request.type;
      const registryAfter = registryText(sources.registry, context.trailId, current.id, registryEdit);
      if (registryAfter !== null) texts.registry = registryAfter;
      else notes.push(`${place} has no registry entry of its own; the next build matches it by position.`);
    }

    // The result as the build will see it. First the type: the one meant, or nothing is written.
    const wanted = retype ? request.type! : current.type;
    const resolveAfter = () => {
      const spans = listGpxWaypoints(texts.gpx);
      const caltopo = texts.geojson === null ? null : readCaltopoExport(texts.geojson);
      return { spans, typed: spans.map(s => resolveSourceType(s, caltopo)) };
    };
    let after = resolveAfter();
    if (after.typed[spanIndex].type !== wanted && after.typed[spanIndex].by === 'gpx-name') {
      // Nothing but its name types it now (no marker has the new name, and it
      // has no <type>), and the name would type it otherwise: a <type>, which
      // outranks the name in the build, keeps the type it has.
      const would = after.typed[spanIndex];
      texts.gpx = setGpxWaypointType(texts.gpx, after.spans[spanIndex], wanted);
      notes.push(
        `Added a GPX <type> (${wanted}) to keep its type: ${
          would.nameRule === 'known-town'
            ? `“${name}” is a known town, which the build would otherwise type town`
            : `the build would otherwise type it ${would.type}${marker ? `, now that no CalTopo marker has its name` : ''}`
        }.`
      );
      after = resolveAfter();
    }
    const own = after.typed[spanIndex];
    if (own.cleanedName !== name) {
      throw new EditorError(
        `Under that name the build would show it as “${own.cleanedName}”, not “${name}”: nothing was written.`
      );
    }
    // Another <wpt> may share its position, but not under its name: a move or
    // a rename onto a namesake is refused whatever the types, and so is a
    // retype that would make twins of two a hand edit left there under one name.
    const namesake = namesakeAt(after, { ...after.spans[spanIndex], name }, spanIndex);
    if (namesake !== -1 && (move || rename || after.typed[namesake].type === own.type)) {
      throw namesakeError(after.typed[namesake], own.type);
    }
    const sharedAfter = own.marker
      ? after.spans.filter((_, i) => i !== spanIndex && after.typed[i].marker?.index === own.marker!.index)
      : [];
    if (sharedAfter.length && !(sharers.length && own.marker!.index === marker?.index)) {
      throw sharedMarkerError(context, own.marker!, sharedAfter, { lat, lon });
    }
    if (own.type !== wanted) {
      if (!retype && current.pending) throw typeClashError(context, own, wanted, { lat, lon });
      if (!retype) {
        throw new EditorError(
          `${rename ? 'Under that name' : 'There'} the build would type it ${own.type}, not ${wanted}, and mint it a new id: nothing was written. Its type would come from ${typeSourceText(own, file)}. If ${own.type} is right, change its type in the same save.`
        );
      }
      throw new EditorError(
        `Could not make that type stick: the build would still type it ${own.type}, so nothing was written.`,
        500
      );
    }

    // Then the ids: every <wpt> must come out of the next build with the id it
    // has now, this one included when it has one.
    const registryAfter = JSON.parse(texts.registry) as WaypointRegistry;
    if (!current.pending) {
      // No other <wpt> stands here under this name (the check above), so a live
      // entry that reads exactly as this waypoint now does has lost its own
      // <wpt> since the last build. Its id is not retired until a build runs,
      // and two entries for one <wpt> are twins in the registry: the join
      // could show this waypoint as the deleted one, and the other as back.
      const ghost = (registryAfter[context.trailId] ?? []).find(
        e =>
          !e.retired &&
          e.id !== place &&
          e.name === name &&
          e.type === own.type &&
          e.lat === after.spans[spanIndex].lat &&
          e.lon === after.spans[spanIndex].lon
      );
      if (ghost) {
        throw new EditorError(
          `“${ghost.name}” (${ghost.id}) stood on exactly this position under this name and type, and its <wpt> is gone since the last build, but its id is not retired until a build runs: this edit would leave two registry entries that read the same for the one <wpt>, and neither the editor nor the build could say whose it is. Rebuild first so ${ghost.id} is retired, then make this edit. Nothing was written.`
        );
      }
    }
    const { ids, beforeIds, warnings, reminted } = assertIdsKept(
      context.trailId,
      { registry: sources.registryEntries, inputs: idInputs(sources) },
      { registry: registryAfter, inputs: idInputs(after) },
      after.spans.flatMap((_, i) => (i === spanIndex ? [] : [[i, i] as [number, number]]))
    );
    otherIdNotes = reminted;
    if (current.pending) {
      nextId = ids[spanIndex];
      assertNoLiveIdTaken(sources.registryEntries, context.trailId, nextId, name, 'edit', current.takesId);
      notes.push(...warnings.map(w => `The build will warn: ${w.replace(/^!\s*/, '')}`));
    } else if (ids[spanIndex] !== place) {
      throw new EditorError(
        beforeIds[spanIndex] === place
          ? `The next build would give it id ${ids[spanIndex]} instead of ${place} (its registry entry did not follow): nothing was written.`
          : `As the sources stand the next build would already give it ${beforeIds[spanIndex]} rather than ${place}: its name, type or position no longer matches its registry entry (a hand edit?), and this edit does not mend that, so nothing was written. Put the entry or the <wpt> right by hand, or rebuild and edit the waypoint under the id it then has.`
      );
    }

    // A revisited place is listed in trail.json by name: the list follows the rename, or the build stops.
    if (rename) {
      const stillNamed = after.typed.some((t, i) => i !== spanIndex && t.cleanedName === current.name);
      let renamed: string | null;
      try {
        renamed = renameJsonArrayString(configText, 'trail.json', REVISITED_KEY, current.name, name, stillNamed);
      } catch (error) {
        throw new EditorError(
          `${error instanceof Error ? error.message : String(error)}: the build reads it to tell which waypoints the route passes twice, by name, so a rename may need it changed. Fix it by hand first.`
        );
      }
      if (renamed !== null) {
        configText = renamed;
        notes.push(
          `trail.json lists this place in ${REVISITED_KEY} by name (the route passes it more than once): ${
            stillNamed
              ? `“${name}” was added beside “${current.name}”, which another waypoint still has`
              : `“${current.name}” there is now “${name}”`
          }, so the next build still makes its later passes.`
        );
      }
    }
  }

  if (describe && current.pending) {
    // No id, so no descriptions.json entry: the text is its <desc>, GPX source
    // text the build shows as it is.
    const text = request.description!.trim();
    texts.gpx = setGpxWaypointDesc(texts.gpx, spanNow(), text);
    notes.push(
      text
        ? 'The description went into its GPX <desc>: it has no id for descriptions.json yet. Once it has one, text saved here becomes curated text, which outranks the <desc>.'
        : 'Removed its GPX <desc>.'
    );
  } else if (describe) {
    const text = request.description!.trim();
    texts.descriptions =
      describedText(context, sources.descriptions, current, text, rename ? name : undefined, byId) ??
      sources.descriptions;
  } else if (rename && !current.pending) {
    texts.descriptions = renamedDescriptionText(sources.descriptions, place, name) ?? sources.descriptions;
  }

  // The answer, from the files as they will be: nothing is written unless it can be given.
  const viewAfter = buildView(context, parseSources(context, texts), access);
  const afterId = current.pending
    ? [...viewAfter.spanOf].find(([id, index]) => index === spanIndex && registryId(id) === id)?.[0]
    : waypointId;
  const after = viewAfter.rows.find(w => w.id === afterId);
  if (!after) {
    throw new EditorError(
      'The editor could not work out how the waypoint would be listed after this edit, so nothing was written: reload the trail.',
      500
    );
  }

  const writes: { file: string; text: string }[] = [];
  if (texts.gpx !== sources.gpx) writes.push({ file: context.gpxPath, text: texts.gpx });
  if (texts.geojson !== null && texts.geojson !== sources.geojson) {
    writes.push({ file: context.geojsonPath!, text: texts.geojson });
  }
  if (texts.registry !== sources.registry) writes.push({ file: paths.registryPath, text: texts.registry });
  if (texts.descriptions !== null && texts.descriptions !== sources.descriptions) {
    writes.push({ file: context.descriptionsPath, text: texts.descriptions });
  }
  if (configText !== context.configText) writes.push({ file: context.configPath, text: configText });
  commitWrites(writes);
  const changed = writes.map(w => relative(paths, w.file));

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
  if (rename && current.sharesSourceWith?.length) {
    notes.push(
      `Also renames ${current.sharesSourceWith.join(', ')}: every pass of the place is built from the same <wpt>.`
    );
  }
  if (retype) {
    notes.push(
      current.pending
        ? `Type ${current.type} → ${request.type}.`
        : `Type ${current.type} → ${request.type}; its registry entry's type changed with it, so it keeps id ${place}.`
    );
    notes.push(...retypeNotes(current.type, request.type!));
    if (current.sharesSourceWith?.length) {
      notes.push(`Also retypes ${current.sharesSourceWith.join(', ')}, built from the same <wpt>.`);
    }
  }
  if (nextId !== null) notes.push(idNote(after, sources.registryEntries, context.trailId, nextId));
  else if (move || rename || retype) notes.push('Run Rebuild to see its km, lists and type from the new source.');
  notes.push(...otherIdNotes);

  // The build merges on name, type and distance: an edit to the waypoint that
  // duplicates were merged into can end the merge, and they come back as rows.
  const wasMerged = new Set(view.rows.filter(w => w.mergedInto === current.id && !w.unmerges).map(w => w.id));
  const freed = viewAfter.rows.filter(w => wasMerged.has(w.id) && w.unmerges);
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
      const freedToo = freedByLeaving(byId, current, context.dedupeRadiusMeters);
      if (freedToo.length) notes.push(freedNote(freedToo, into, context.dedupeRadiusMeters));
    } else {
      notes.push(`Under that name the next build still merges it into ${into}.`);
    }
  }
  if (laterPass && (move || rename || retype)) {
    notes.push(`${current.id} is a later pass of ${place}: the edit is to the place, and shows on every pass.`);
  }
  return { waypoint: after, changedFiles: changed, notes };
}

/** Says which other duplicates come back when one leaves a chain the build merged. */
function freedNote(freed: readonly EditorWaypoint[], into: string, radiusMeters: number): string {
  const ids = freed.map(w => w.id).join(', ');
  return `${ids} ${freed.length === 1 ? 'was' : 'were'} merged into ${into} only through this one (each within ${radiusMeters} m of the next): the next build lists ${freed.length === 1 ? 'it' : 'them'} again too, under ${freed.length === 1 ? 'its own id' : 'their own ids'}.`;
}

/**
 * What the next build does for a `<wpt>` that has no id yet: mints `id`, or
 * hands it an entry the registry already holds (`assignWaypointIds` on the
 * sources as saved). A live entry is handed over only to its own name
 * ({@link assertNoLiveIdTaken} refuses the rest): the waypoint restored.
 */
function nextIdNote(registry: WaypointRegistry, trailId: string, id: string): string {
  const entry = (registry[trailId] ?? []).find(e => e.id === id);
  if (!entry) {
    return `Rebuild to give it its id (the next build mints ${id}); until then it is listed as pending, and edits to it go to its <wpt> in the GPX alone.`;
  }
  if (entry.retired) {
    return `The next build will give it the retired id ${id} back: a ${entry.type} of the same name stood here once, and its comments and description come with the id.`;
  }
  return `The next build gives it back the id ${id} of “${entry.name}”, whose <wpt> went since the last build: a ${entry.type} of that name within ${MATCH_RADIUS_METERS} m is the same waypoint restored, and the comments keyed to ${id} come with it.`;
}

/**
 * {@link nextIdNote} for a `<wpt>` just added or edited that had no id, as it
 * is now listed (`row`). One put back on the exact position of a waypoint
 * deleted since the last build, under its name and type, is that waypoint
 * again at once: the editor joins it to the id (`claimSpans`), and no build is
 * needed to hand it back.
 */
function idNote(row: EditorWaypoint, registry: WaypointRegistry, trailId: string, nextId: string): string {
  if (row.pending || row.notBuilt) return nextIdNote(registry, trailId, nextId);
  return `Restored: this is “${row.name}” (${row.id}) again. Its <wpt> stands on the exact position its registry entry has, under its name and type, so it is listed as the waypoint it was and not as pending, and the next build neither mints nor retires an id for it: the comments keyed to ${row.id} are its again.`;
}

// ---------------------------------------------------------------------------
// Adding and deleting
// ---------------------------------------------------------------------------

/**
 * Said on a delete: what adding the waypoint back would and would not restore.
 * `tags` are the children its `<wpt>` had ({@link gpxWaypointChildTags}), and
 * `alsoRemoved` what the delete took from the other files.
 */
function addBackNote(tags: readonly string[], alsoRemoved: readonly string[]): string {
  // An add writes these four itself; whatever else the <wpt> carried only git has.
  const rewritten = ['name', 'type', 'desc', 'ele'];
  const lost = [...new Set(tags.filter(tag => !rewritten.includes(tag)))].map(tag => `<${tag}>`);
  const gone = [
    ...(tags.includes('desc') ? ['its <desc> (unless it is typed in again)'] : []),
    ...(tags.includes('ele') ? ['the <ele> it carried (an add looks one up afresh)'] : []),
    ...(lost.length ? [`${lost.join(', ')}, which an add never writes`] : []),
    ...alsoRemoved,
  ];
  return `Adding it back restores its id, not its <wpt>: an add writes a new <wpt> after the last one, with a name, a type, a position, the description typed and an <ele> it looks up.${
    gone.length ? ` Not restored by that: ${gone.join('; ')}.` : ''
  } git diff shows what the delete removed: to undo it exactly, restore the files from git.`;
}

/**
 * What adding a deleted waypoint back does not bring back. An add writes a new
 * `<wpt>` from what the form gives, and the delete took the old one whole,
 * with whatever was the waypoint's in the other files; nothing here remembers
 * it. `builtDescription` is the text the last build shows for the waypoint,
 * which is still the one it had before the delete.
 */
function restoreGapsNote(builtDescription: string | undefined, description: string, wroteEle: boolean): string {
  const had = builtDescription?.trim();
  const wrote = `the name, type and position given${description ? ', the description typed here as its <desc>' : ''}${wroteEle ? ' and an <ele> looked up for the position' : ''}`;
  // The text typed is the text it had: that much of the old <wpt> is back.
  const sameText = !!had && had === description;
  let text = '';
  if (sameText) {
    text = ' The description typed here is the one the last build shows for it.';
  } else if (had) {
    const excerpt = had.length > 80 ? `${had.slice(0, 80)}…` : had;
    text = ` The last build shows it with a description (“${excerpt}”) that ${description ? 'is not the one typed here' : 'the new <wpt> does not have'}.`;
  }
  return `Only its id is restored, not the <wpt> the delete removed. The new <wpt> has ${wrote}, and stands after the last <wpt> in the file.${text} Still gone, where the old one had them: ${sameText ? '' : 'its <desc> as it was, '}the <ele> it carried, every other child (<extensions>, from which the build reads the off-trail access fields, <cmt>, <sym>, <link>), its ${DESCRIPTIONS_FILENAME} entry, its CalTopo marker and its name in trail.json's ${REVISITED_KEY}. git diff shows each: copy them back from there, or restore the files from git to undo the delete exactly.`;
}

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
 * is refused when that marker already types another `<wpt>` (the two would
 * share it), or would type this one differently.
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
  const lat = writtenCoordinate(rawLat);
  const lon = writtenCoordinate(rawLon);
  const description = request.description === undefined ? '' : request.description;
  if (typeof description !== 'string') throw new EditorError('description must be a string');
  if (description.trim().length > MAX_DESCRIPTION_LENGTH) {
    throw new EditorError(`The description is longer than ${MAX_DESCRIPTION_LENGTH} characters`);
  }
  assertNearRoute(context, lat, lon);

  const sources = readSources(paths, context);
  // It may share its position with other <wpt>s, but not under the name of one of them.
  const namesake = namesakeAt(sources, { lat, lon, name });
  if (namesake !== -1) throw namesakeError(sources.typed[namesake], type);
  const { ele, note: elevationNote } = newWaypointElevation(sources.spans, () =>
    elevationAt(context, lat, lon, elevation)
  );
  const gpx = insertGpxWaypoint(sources.gpx, { lat, lon, name, type, desc: description.trim() || undefined, ele });
  const after = parseSources(context, { ...sources, gpx });
  const added = findGpxWaypoint(after.spans, { lat, lon, name });
  if (!added) throw new EditorError('The new <wpt> could not be read back from the GPX', 500);
  const addedIndex = after.spans.indexOf(added);
  const resolved = after.typed[addedIndex];
  if (resolved.marker) {
    const others = markerSharers(after, addedIndex);
    if (others.length) throw sharedMarkerError(context, resolved.marker, others, { lat, lon });
  }
  if (resolved.type !== type) throw typeClashError(context, resolved, type, { lat, lon });
  const { ids, warnings, reminted } = assertIdsKept(
    context.trailId,
    { registry: sources.registryEntries, inputs: idInputs(sources) },
    { registry: sources.registryEntries, inputs: idInputs(after) },
    sources.spans.map((_, i) => [i < addedIndex ? i : i + 1, i] as [number, number])
  );
  const nextId = ids[addedIndex];
  assertNoLiveIdTaken(sources.registryEntries, context.trailId, nextId, name, 'add');

  // The answer, from the files as they will be: nothing is written unless it can be given.
  // Usually a pending row; the row of a deleted waypoint when it is put back exactly where it was.
  const view = buildView(context, after);
  const key = [...view.spanOf].find(([id, index]) => index === addedIndex && registryId(id) === id)?.[0];
  const waypoint = view.rows.find(w => w.id === key);
  if (!waypoint) {
    throw new EditorError(
      'The editor could not work out how the new waypoint would be listed, so nothing was written: reload the trail.',
      500
    );
  }
  commitWrites([{ file: context.gpxPath, text: gpx }]);

  const notes: string[] = [idNote(waypoint, sources.registryEntries, context.trailId, nextId), elevationNote];
  // A live entry is handed only to its own name (`assertNoLiveIdTaken`): the waypoint
  // deleted since the last build, coming back. The id comes back; its old <wpt> does not.
  const comesBack = (sources.registryEntries[context.trailId] ?? []).find(e => e.id === nextId && !e.retired);
  if (comesBack && !waypoint.notBuilt) {
    const lastBuilt = collectBuiltWaypoints(context.built).find(b => b.id === comesBack.id);
    notes.push(restoreGapsNote(lastBuilt?.description, description.trim(), ele !== undefined));
  }
  if (description.trim()) {
    notes.push(
      resolved.marker?.description
        ? `The description went into its GPX <desc>, but the build shows the description of the CalTopo marker “${resolved.marker.title}”, which has its name, in its place. Once it has an id, curated text saved here outranks both.`
        : 'The description went into its GPX <desc>; once it has an id it can become curated text in descriptions.json.'
    );
  }
  notes.push(...warnings.map(w => `The build will warn: ${w.replace(/^!\s*/, '')}`), ...reminted);
  return { waypoint, changedFiles: [relative(paths, context.gpxPath)], notes };
}

/**
 * Delete a waypoint: its `<wpt>`, the CalTopo marker that typed it (unless
 * that marker types another waypoint too) and its `descriptions.json` entries.
 * The registry entry stays for the next build to mark `retired`: entries are
 * never deleted, and a retired id is never handed to a different place. Until
 * that build the entry is live, and {@link assertNoLiveIdTaken} keeps a
 * waypoint added beside it from being read as this one.
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
  const view = buildView(context, sources);
  const rows = new Map(view.rows.map(w => [w.id, w]));
  const current = rows.get(key);
  if (!current) throw new EditorError(`${context.trailId} has no waypoint ${key}`, 404);
  if (!current.pending && registryId(current.id) !== current.id) {
    throw new EditorError(
      `${current.id} is a later pass of ${registryId(current.id)}, built from the same <wpt>: delete ${registryId(current.id)} to remove the place (every pass goes with it).`
    );
  }
  if (!current.canDelete) throw new EditorError(current.lockedReason ?? 'This waypoint cannot be deleted here');
  assertExpected(request?.expected, current);
  const spanIndex = view.spanOf.get(current.id);
  if (spanIndex === undefined) throw new EditorError('Its <wpt> is no longer in the GPX: reload the trail', 409);
  const span = sources.spans[spanIndex];

  const notes: string[] = [];
  const writes: { file: string; text: string }[] = [];
  const gpx = removeGpxWaypoint(sources.gpx, span);
  writes.push({ file: context.gpxPath, text: gpx });
  let geojson = sources.geojson;
  const marker = current.pending ? undefined : sources.typed[spanIndex].marker;
  if (marker && context.geojsonPath && sources.geojson !== null) {
    const file = path.basename(context.geojsonPath);
    const others = markerSharers(sources, spanIndex);
    if (others.length) {
      notes.push(`Left its CalTopo marker “${marker.title}” in ${file}: it also types ${quotedNames(others)}.`);
    } else {
      geojson = removeCaltopoFeature(sources.geojson, file, marker);
      writes.push({ file: context.geojsonPath, text: geojson });
    }
  }
  const removed = [current.id, ...(current.sharesSourceWith ?? [])];
  if (!current.pending) {
    const text = withoutDescriptionsText(sources.descriptions, removed);
    if (text !== null) writes.push({ file: context.descriptionsPath, text });
  }
  const after = parseSources(context, { ...sources, gpx, geojson });
  const { reminted } = assertIdsKept(
    context.trailId,
    { registry: sources.registryEntries, inputs: idInputs(sources) },
    { registry: sources.registryEntries, inputs: idInputs(after) },
    sources.spans.flatMap((_, i) => (i === spanIndex ? [] : [[i < spanIndex ? i : i - 1, i] as [number, number]])),
    { after: `with “${current.name}” gone`, retry: `delete “${current.name}”` }
  );

  // A revisited place is listed in trail.json by name: once no <wpt> has the
  // name, the build warns on every run that the route no longer passes it twice.
  const listedName = sources.typed[spanIndex].cleanedName;
  if (after.typed.some(t => t.cleanedName === listedName)) {
    const listed = (JSON.parse(context.configText) as Record<string, unknown>)[REVISITED_KEY];
    if (Array.isArray(listed) && listed.includes(listedName)) {
      notes.push(
        `trail.json still lists “${listedName}” in ${REVISITED_KEY}: another waypoint has that name. Take it out by hand if the route no longer passes that one twice.`
      );
    }
  } else {
    let config: string | null;
    try {
      config = removeJsonArrayString(context.configText, 'trail.json', REVISITED_KEY, listedName);
    } catch (error) {
      throw new EditorError(
        `${error instanceof Error ? error.message : String(error)}: the build reads it to tell which waypoints the route passes twice, by name, so a delete may need a name taken out. Fix it by hand first.`
      );
    }
    if (config !== null) {
      writes.push({ file: context.configPath, text: config });
      notes.push(
        `Took “${listedName}” out of ${REVISITED_KEY} in trail.json (the route passed it more than once), so the next build does not warn that it is listed but no longer passed twice.`
      );
    }
  }

  commitWrites(writes);
  const changed = writes.map(w => relative(paths, w.file));
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
    notes.push(
      `Until that build ${current.id} is not retired, and the build would read a ${current.type} added within ${MATCH_RADIUS_METERS} m as this waypoint moved or renamed: the editor refuses such an add until a rebuild, unless it is “${current.name}” itself, added back as a ${current.type}. Within ${MATCH_RADIUS_METERS} m the next build then hands it ${current.id} back; ${
        span.lat === writtenCoordinate(span.lat) && span.lon === writtenCoordinate(span.lon)
          ? `on its exact position (${formatCoordinate(span.lat)}, ${formatCoordinate(span.lon)}) it is ${current.id} again at once`
          : `its <wpt> had more decimals than the six the editor writes, so an add cannot land on its exact position (it was at ${span.latText.trim()}, ${span.lonText.trim()}) and waits for that build`
      }.`
    );
    notes.push(
      addBackNote(gpxWaypointChildTags(sources.gpx, span), [
        ...(geojson !== sources.geojson ? ['its CalTopo marker'] : []),
        ...(writes.some(w => w.file === context.descriptionsPath) ? [`its ${DESCRIPTIONS_FILENAME} entry`] : []),
        ...(writes.some(w => w.file === context.configPath) ? [`its name in trail.json's ${REVISITED_KEY}`] : []),
      ])
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
  notes.push(...reminted);
  return { removed, changedFiles: changed, notes };
}
