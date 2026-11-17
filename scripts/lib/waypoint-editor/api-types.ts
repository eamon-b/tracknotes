/**
 * The wire types between the local waypoint editor page
 * (`src/web/admin-waypoints.ts`) and its dev-server API
 * (`scripts/lib/waypoint-editor/vite-plugin.ts`). Types and two constants, no
 * Node imports, so the page can import it without pulling Node code into the
 * bundle.
 */

import type { RouteBreak } from '../../../src/lib/trail-types';

/** Every route the API answers lives under this prefix. */
export const EDITOR_API_BASE = '/__waypoint-editor';

/**
 * Sent on every write, so that a plain form post or a link cannot be one. It
 * is one check of several: what keeps another page open in the same browser
 * from driving the editor is the API's `Host` and `Origin` checks
 * (`requestRefusal` in `vite-plugin.ts`).
 */
export const EDITOR_HEADER = 'X-Waypoint-Editor';

export type LatLng = [number, number];

export interface EditorTrailSummary {
  /** Directory under `data/trails/`. */
  dir: string;
  id: string;
  name: string;
  /** Why nothing on this trail can be edited here, when that is so. */
  readOnlyReason?: string;
  /** False when `build:trails` has not produced this trail's JSON yet. */
  built: boolean;
}

export type PlacementKind = 'main' | 'off-trail' | 'alternate' | 'side-trip' | 'terminus';

/** One list a waypoint appears in, from the last build. */
export interface WaypointPlacement {
  kind: PlacementKind;
  /** The alternate's, side trip's or terminus's name. */
  variant?: string;
  /** Main-route km, or km along the variant. */
  km?: number;
}

/** Prefix of a pending waypoint's temporary key: a colon, which no stable id has (`ID_PATTERN`). */
export const PENDING_KEY_PREFIX = 'new:';

export interface EditorWaypoint {
  /**
   * Stable id (`data/waypoint-ids.json`): comments and descriptions are keyed by it.
   * A pending waypoint (added since the last build) has no id yet: this is then a
   * temporary key starting with {@link PENDING_KEY_PREFIX}, never sent anywhere
   * that keys by id. The key is a hash of its name and position, so it changes
   * when either does.
   */
  id: string;
  /**
   * Added to the GPX since the last build: the next build mints its id. Until
   * then every edit goes to its `<wpt>` and nowhere that keys by id.
   */
  pending?: boolean;
  /** Its `<wpt>` is gone from the GPX since the last build (deleted here, or edited by hand): the next build retires its id. */
  deleted?: boolean;
  /**
   * The last build merged this `<wpt>` into a same-name, same-type neighbour
   * (`dedupeWaypoints`) and dropped its row: this is the id of the waypoint that
   * survived. It keeps its own id and registry entry, but the app shows no row
   * for it, so nothing keyed to its id (comments, a description) is shown there.
   */
  mergedInto?: string;
  /** For a merged-away duplicate: metres between it and the waypoint it merged into, as the sources stand. */
  mergedDistanceM?: number;
  /**
   * For a merged-away duplicate: the sources no longer make it a duplicate of
   * that waypoint (renamed, or that waypoint is gone), so the next build lists
   * it as a waypoint of its own, under its id.
   */
  unmerges?: boolean;
  /** Ids of the near-duplicates the last build merged into this waypoint (each is listed with `mergedInto`). */
  mergedIds?: string[];
  /** Name as the build shows it (any `C ` / `WT: ` prefix removed). */
  name: string;
  /** The type the sources give it now (a type change saved since the build included). */
  type: string;
  /** The type in the last build. */
  builtType: string;
  /** What decides its type, in words (`the CalTopo folder "Huts"`, `its GPX <type>`, …). */
  typeSource?: string;
  /** Position in the source files now (moves saved since the build included). */
  lat: number;
  lon: number;
  /** Position in the last build, to tell a saved move that awaits a rebuild. */
  builtLat: number;
  builtLon: number;
  builtName: string;
  /** Its `<wpt>`'s `<ele>` in the GPX now, in metres, when it has one (the build does not read it). */
  ele?: number;
  placements: WaypointPlacement[];
  /** Main-route km, or the km of the nearest point on the main route; for ordering. */
  sortKm: number;
  /** From the last build, for an off-trail place: metres to the nearest point of the main track. */
  distanceFromTrailM?: number;
  /**
   * Curated text from `descriptions.json`, '' when there is none. For a pending
   * waypoint, which has no id to key a curated text by, its GPX `<desc>`: source
   * text, edited in the GPX.
   */
  description: string;
  /**
   * The GPX / CalTopo text the build shows when there is no curated text. For a
   * pending waypoint, only a CalTopo marker's text (which the build shows in
   * place of the `<desc>`).
   */
  sourceDescription?: string;
  canMove: boolean;
  canRename: boolean;
  canDescribe: boolean;
  canChangeType: boolean;
  canDelete: boolean;
  /** Why some or all of the edits above are off, when they are. */
  lockedReason?: string;
  /** `access.json`'s entry for this place: a move can leave its walk stale. */
  access?: { method?: string; store?: string };
  /** Other ids built from the same `<wpt>` (a revisited place's `_2`): a move moves them too. */
  sharesSourceWith?: string[];
}

export interface EditorPoi {
  id: string;
  name: string;
  category: string;
  lat: number;
  lon: number;
}

export interface EditorTrail {
  dir: string;
  id: string;
  name: string;
  readOnlyReason?: string;
  /** Repo-relative paths of the files a save may write. */
  files: { gpx: string; geojson?: string; descriptions: string; registry: string };
  /** Route geometry from the last build, enough to draw and snap to. */
  track: {
    /** `track.displayPoints` with cumulative km. */
    points: { lat: number; lon: number; dist: number }[];
    /** `track.breaks`: `displayIndex` indexes `points` here. */
    breaks: RouteBreak[] | undefined;
    variants: { name: string; type: string; line: LatLng[] }[];
  };
  waypoints: EditorWaypoint[];
  pois: EditorPoi[];
  /** When the trail's JSON was last built (ISO). */
  builtAt: string;
  /** Longest description `descriptions.json` accepts. */
  maxDescriptionLength: number;
}

export interface WaypointExpected {
  name: string;
  lat: number;
  lon: number;
  description: string;
  /** Checked when sent. */
  type?: string;
}

export interface WaypointEditRequest {
  /** What the page last read, so an edit made elsewhere since is not overwritten. */
  expected: WaypointExpected;
  name?: string;
  lat?: number;
  lon?: number;
  /**
   * '' removes the curated text (the source text then shows again). On a
   * pending waypoint this is its GPX `<desc>`, and '' removes that.
   */
  description?: string;
  /** One of `WAYPOINT_TYPES`: changes the source the build types it from and its registry entry's type. */
  type?: string;
}

/** A new waypoint: a `<wpt>` the next build mints an id for. */
export interface NewWaypointRequest {
  name: string;
  /** One of `WAYPOINT_TYPES`. */
  type: string;
  lat: number;
  lon: number;
  /** Written as the `<wpt>`'s `<desc>` (it has no id for `descriptions.json` yet). */
  description?: string;
}

export interface WaypointDeleteRequest {
  expected: WaypointExpected;
}

export interface WaypointDeleteResponse {
  /** Ids (or the pending key) that are gone from the sources: a revisited place's later passes go with it. */
  removed: string[];
  changedFiles: string[];
  notes: string[];
}

export interface WaypointEditResponse {
  /**
   * The waypoint as saved. A pending waypoint that was renamed or moved comes
   * back under a new temporary key (`id`): the page drops the old one.
   */
  waypoint: EditorWaypoint;
  /** Repo-relative paths written. */
  changedFiles: string[];
  /** Things to know or do because of this edit. */
  notes: string[];
}

export interface RegistryChange {
  trailId: string;
  id: string;
  name: string;
  type: string;
}

export interface RebuildStatus {
  state: 'idle' | 'running' | 'succeeded' | 'failed';
  startedAt?: string;
  finishedAt?: string;
  /** The build's output: all of a normal build's, the last part of a longer one. */
  log: string;
  /**
   * Every warning and error line of the build, from its whole output and in
   * the order printed (so the id-minting warnings appear where they happened
   * and again under the build's summary), then why a failed build stopped.
   * Filled in as the build runs.
   */
  warnings: string[];
  /** Ids the rebuild minted or retired: either means a waypoint lost its id (and its comments). */
  minted: RegistryChange[];
  retired: RegistryChange[];
}

export interface ChangedFile {
  path: string;
  /** `git status --porcelain` code, e.g. ` M` or `??`. */
  status: string;
}

export interface ApiError {
  error: string;
}
