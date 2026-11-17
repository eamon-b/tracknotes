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
 * Sent on every write: a custom header makes a cross-site `fetch` need a CORS
 * preflight the dev server never grants, so another page open in the same
 * browser cannot drive the editor.
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
   * that keys by id.
   */
  id: string;
  /** Added to the GPX since the last build: the next build mints its id. */
  pending?: boolean;
  /** Its `<wpt>` is gone from the GPX since the last build (deleted here, or edited by hand): the next build retires its id. */
  deleted?: boolean;
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
  /** From the last build, for an off-trail place. */
  distanceFromTrailKm?: number;
  /** Curated text from `descriptions.json`, '' when there is none. */
  description: string;
  /** The GPX / CalTopo text the build shows when there is no curated text. */
  sourceDescription?: string;
  canMove: boolean;
  canRename: boolean;
  canDescribe: boolean;
  canChangeType: boolean;
  canDelete: boolean;
  /** Why moving, renaming or retyping is off, when it is. */
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
  /** '' removes the curated text (the source text then shows again). */
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
  /** The last part of the build's output. */
  log: string;
  /** Warning lines from the build. */
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
