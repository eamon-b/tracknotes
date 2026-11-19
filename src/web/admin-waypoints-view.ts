/**
 * The waypoint editor's pure parts: drafts, filtering and stepping through the
 * list, reading a typed or pasted position, snapping to the route's lines, the
 * description voice hints, review marks, and the list and readout markup. No
 * DOM or Leaflet here, so it is tested on its own
 * (`admin-waypoints-view.test.ts`); `admin-waypoints.ts` wires it to the page.
 */

import { haversineDistance } from '@lib/distance';
import { nameMatches } from '@lib/name-filter';
import { classifyWaypoint } from '@lib/waypoint-classifier';
import { firstPassIdOf } from '@lib/waypoint-passes';
import { snapToTrail, type SnapPoint } from '@lib/position-on-trail';
import { WAYPOINT_TYPES, waypointTypeLabel } from '@lib/waypoint-taxonomy';
import type {
  EditorTrail,
  EditorWaypoint,
  WaypointEditResponse,
  WaypointPlacement,
} from '../../scripts/lib/waypoint-editor/api-types';
import { commentBadgeHtml } from './admin-waypoints-comments';
import { waypointFamilyClass, waypointIcon } from './trails/waypoint-icons';
import { escapeHtml } from './web-utils';

// ---------------------------------------------------------------------------
// Drafts: what the form holds for a waypoint before it is saved
// ---------------------------------------------------------------------------

/** The fields of a waypoint the form edits. */
export interface WaypointFields {
  name: string;
  lat: number;
  lon: number;
  description: string;
  type: string;
}

/**
 * What the form holds for a waypoint before it is saved: only the fields the
 * user changed (`lat` and `lon` together). A field that is absent follows the
 * waypoint as the server last gave it, so a reload (a rebuild, a save of
 * another pass of the same place, sources changed through git) never turns a
 * field nobody touched into an edit that would put the old value back.
 */
export type WaypointDraft = Partial<WaypointFields>;

/** The form's fields as the waypoint is saved. */
export function fieldsOf(w: WaypointFields): WaypointFields {
  return { name: w.name, lat: w.lat, lon: w.lon, description: w.description, type: w.type };
}

/** What the form shows for a waypoint: its saved fields, with the draft's over them. */
export function draftValues(saved: WaypointFields, draft: WaypointDraft | undefined): WaypointFields {
  return { ...fieldsOf(saved), ...draft };
}

const COORD_EPSILON = 1e-9;

/** Which fields a draft changes from the saved waypoint. */
export function draftChanges(
  saved: WaypointFields,
  draft: WaypointDraft | undefined
): { name: boolean; position: boolean; description: boolean; type: boolean } {
  const values = draftValues(saved, draft);
  return {
    name: values.name.trim() !== saved.name,
    position: Math.abs(values.lat - saved.lat) > COORD_EPSILON || Math.abs(values.lon - saved.lon) > COORD_EPSILON,
    description: values.description.trim() !== saved.description,
    type: values.type !== saved.type,
  };
}

export function isDirty(saved: WaypointFields, draft: WaypointDraft | undefined): boolean {
  if (!draft) return false;
  const c = draftChanges(saved, draft);
  return c.name || c.position || c.description || c.type;
}

/**
 * `draft` cut down to the fields that differ from `saved`, or undefined when
 * none does. Run on every edit, and again over every draft when the trail is
 * read again, so a draft is rebased onto the waypoint as it now stands.
 */
export function pruneDraft(saved: WaypointFields, draft: WaypointDraft | undefined): WaypointDraft | undefined {
  if (!draft) return undefined;
  const values = draftValues(saved, draft);
  const changes = draftChanges(saved, draft);
  const next: WaypointDraft = {};
  if (changes.name) next.name = values.name;
  if (changes.position) {
    next.lat = values.lat;
    next.lon = values.lon;
  }
  if (changes.description) next.description = values.description;
  if (changes.type) next.type = values.type;
  return Object.keys(next).length ? next : undefined;
}

/**
 * The draft to keep once a save has returned. The form stays live while a save
 * is in flight, so `current` (the draft now) may hold more than `sent` (the
 * draft the request was built from); both were made against `before`. A field
 * the user changed during the save stays an edit, on top of `after` (the
 * waypoint as saved); every other field follows what was saved.
 */
export function draftAfterSave(
  before: WaypointFields,
  after: WaypointFields,
  sent: WaypointDraft | undefined,
  current: WaypointDraft | undefined
): WaypointDraft | undefined {
  const was = draftValues(before, sent);
  const now = draftValues(before, current);
  const edited: WaypointDraft = {};
  if (now.name !== was.name) edited.name = now.name;
  if (now.lat !== was.lat || now.lon !== was.lon) {
    edited.lat = now.lat;
    edited.lon = now.lon;
  }
  if (now.description !== was.description) edited.description = now.description;
  if (now.type !== was.type) edited.type = now.type;
  return pruneDraft(after, edited);
}

/**
 * Whether a save of `before` (answered with `after`) can have changed other
 * rows: another pass of a revisited place is built from the same `<wpt>`, and
 * a merge the build made ties a duplicate to the waypoint it merged into. The
 * page then reads the trail again, so those rows (and what the next save on
 * them expects to find on disk) are not left stale.
 */
export function saveAffectsOtherRows(before: EditorWaypoint, after: EditorWaypoint): boolean {
  return [before, after].some(w => !!w.sharesSourceWith?.length || !!w.mergedInto || !!w.mergedIds?.length);
}

/**
 * The lines shown after a save. Under the saved waypoint's own form they need
 * no name; once another waypoint is selected ("Save & next", or the selection
 * moved on while the save was in flight) each names the waypoint it is about.
 */
export function saveNotes(
  result: Pick<WaypointEditResponse, 'changedFiles' | 'notes'> & { waypoint: { name: string } },
  stillSelected: boolean
): string[] {
  const files = result.changedFiles.join(', ') || 'no file (nothing changed)';
  if (stillSelected) return [`Saved to ${files}.`, ...result.notes];
  const name = `“${result.waypoint.name}”`;
  return [`Saved ${name} to ${files}.`, ...result.notes.map(n => `${name}: ${n}`)];
}

/** Saved since the last build: its source no longer matches what the build drew. */
export function movedSinceBuild(w: EditorWaypoint): boolean {
  return Math.abs(w.lat - w.builtLat) > COORD_EPSILON || Math.abs(w.lon - w.builtLon) > COORD_EPSILON;
}

export function renamedSinceBuild(w: EditorWaypoint): boolean {
  return w.name !== w.builtName;
}

export function retypedSinceBuild(w: EditorWaypoint): boolean {
  return w.type !== w.builtType;
}

/** Saved since the last build in any way, added since it, or in the registry but not in the build on this machine. */
export function changedSinceBuild(w: EditorWaypoint): boolean {
  return (
    !!w.pending || !!w.deleted || !!w.notBuilt || movedSinceBuild(w) || renamedSinceBuild(w) || retypedSinceBuild(w)
  );
}

/**
 * The first pass's id when `id` is a later pass of a revisited place
 * (`<id>_2`), else null. As the server reads it (`registryId`): only a suffix
 * after a whole id counts, so `w_00176641` is an id of its own.
 */
export function laterPassOf(id: string): string | null {
  return firstPassIdOf(id);
}

/**
 * Whether a review mark can be kept for `w`. A pending waypoint has only a
 * temporary key, which a rename or a move changes. One the last build here
 * does not list (`notBuilt`) is locked until a rebuild, with no km and no
 * lists to check it against. Neither counts in the review progress.
 */
export function isReviewable(w: EditorWaypoint): boolean {
  return !w.pending && !w.notBuilt;
}

/**
 * Why the build would not show `name` as typed, or null when it would: it
 * strips a type prefix (`C `, `WT: `, …) from a name, so the server refuses
 * one on a new waypoint and on a rename. Checked in the add form before
 * anything is sent.
 */
export function typePrefixProblem(name: string): string | null {
  const typed = name.trim();
  const classified = classifyWaypoint(typed);
  if (!typed || classified.cleanedName === typed) return null;
  return `“${typed}” starts with the type prefix “${classified.matchedPrefix ?? ''}”, which the build strips from names (it would show “${classified.cleanedName}”): leave it off, the type comes from Type.`;
}

/** What the form says of the other ids built from the same `<wpt>` (the passes of a revisited place). */
export function sharedSourceText(w: EditorWaypoint): string {
  if (!w.sharesSourceWith?.length) return '';
  return `Same <wpt> as ${w.sharesSourceWith.join(', ')}: a move, a rename or a type change here changes the place, so every pass`;
}

/**
 * Whether `w` has curated text (`descriptions.json`). A pending waypoint's
 * `description` is its GPX `<desc>`: source text, never curated.
 */
export function hasCuratedText(w: EditorWaypoint): boolean {
  return !!w.description && !w.pending;
}

/** How the form presents the description box: where its text is saved, and what emptying it does. */
export interface DescriptionField {
  label: string;
  /** Said under the label when the text is not curated text, or is not this row's to edit; '' otherwise. */
  where: string;
  placeholder: string;
  /** Asked before a save that empties a description that had text. */
  removeConfirm: string;
  /** Heading of the source-text box under it. */
  sourceSummary: string;
}

/**
 * A waypoint with an id takes curated text, kept in `descriptions.json` under
 * that id. A pending one has no id, so the box edits its `<desc>` in the GPX
 * instead, and says so: it is source text until a rebuild gives it an id.
 */
export function descriptionField(w: EditorWaypoint): DescriptionField {
  if (w.pending) {
    return {
      label: 'Description: GPX <desc>',
      where: w.canDescribe
        ? 'No id yet, so this is not curated text: it is saved as the <desc> of its <wpt> in the GPX, source text the app shows as it stands. Once a rebuild gives it an id, text saved here goes to descriptions.json and outranks the <desc>.'
        : 'Read-only until a rebuild gives it an id: the build shows the text below in place of its <desc>.',
      placeholder: 'No <desc> in the GPX.',
      removeConfirm: 'Remove its <desc> from the GPX? It has no other description.',
      sourceSummary: 'CalTopo marker text (the build shows this, not the <desc>)',
    };
  }
  if (w.mergedInto) {
    // The app shows no row for it, so no text of its own: the box is locked.
    return {
      label: 'Description',
      where: '',
      placeholder: w.unmerges
        ? 'Locked until a rebuild lists it as a waypoint of its own.'
        : 'A merged duplicate takes no description of its own: describe the waypoint it merged into.',
      removeConfirm: 'Remove the curated description?',
      sourceSummary: w.unmerges
        ? 'Source text (GPX / CalTopo)'
        : 'Source text (GPX / CalTopo): the build appends it to the description of the waypoint it merged into',
    };
  }
  const place = laterPassOf(w.id);
  if (place && !w.canDescribe) {
    // The text is the place's: the build applies it before it makes the passes.
    return {
      label: 'Description: the place’s, read-only here',
      where: `This is a later pass of ${place}. The description is the place's and shows on every pass: edit it on ${place}.`,
      placeholder: `No curated text for the place: write it on ${place}.`,
      removeConfirm: 'Remove the curated description?',
      sourceSummary: 'Source text (GPX / CalTopo)',
    };
  }
  return {
    label: 'Description',
    where: '',
    placeholder: w.sourceDescription ? 'No curated text: the source text below is what the app shows.' : 'No text yet.',
    removeConfirm: 'Remove the curated description? The source text (if any) shows again.',
    sourceSummary: 'Source text (GPX / CalTopo)',
  };
}

/** The list's order, as the server sorts it: by km, then name. */
export function compareWaypoints(a: EditorWaypoint, b: EditorWaypoint): number {
  return a.sortKm - b.sortKm || a.name.localeCompare(b.name);
}

/**
 * The row to go to from `fromId`: the next (`delta` 1) or previous (-1) row of
 * the filtered list, found from the waypoint's place in the whole list `all`,
 * so it is right whether or not `fromId` is itself in the filtered list.
 * It is worked out before an action that may take the row out of the filter
 * (a review mark under "Not reviewed", a saved description under "No curated
 * text", a retype under a type filter) or re-key it, and still answers for a
 * row that has already dropped out. With nothing to start from it is the
 * first row; null when there is no row that way.
 */
export function stepTarget<T extends { id: string }>(
  all: readonly T[],
  visible: (w: T) => boolean,
  fromId: string | null,
  delta: 1 | -1
): string | null {
  const from = fromId === null ? -1 : all.findIndex(w => w.id === fromId);
  if (from === -1) return all.find(visible)?.id ?? null;
  for (let i = from + delta; i >= 0 && i < all.length; i += delta) {
    if (visible(all[i])) return all[i].id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Review marks (per browser)
// ---------------------------------------------------------------------------

type ReviewedContent = Pick<EditorWaypoint, 'name' | 'lat' | 'lon' | 'description' | 'type'>;

function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/** The name, position and description: all that a mark made before type was covered says. */
function contentText(w: ReviewedContent): string {
  return `${w.name}|${w.lat.toFixed(6)}|${w.lon.toFixed(6)}|${w.description}`;
}

/** What marks a fingerprint as covering the type too; a bare hash (base 36, so never with a colon) does not. */
const TYPED_MARK_PREFIX = 't:';

/**
 * A short fingerprint of what was reviewed: the waypoint's name, position,
 * description and type (as the sources have them, not as the last build
 * does). A mark holds while the waypoint still has this content, so an edit
 * pulled from git (or made by anyone else) puts it back in the unreviewed
 * pile; a retype does too, since it changes whether the waypoint counts as
 * water or resupply.
 */
export function reviewFingerprint(w: ReviewedContent): string {
  return `${TYPED_MARK_PREFIX}${fingerprint(`${contentText(w)}|${w.type}`)}`;
}

/** Waypoint id → the fingerprint stored when it was marked reviewed. */
export type ReviewMarks = Record<string, string>;

/**
 * Whether a waypoint's mark still holds. Marks live in each reviewer's
 * `localStorage`, and those made before the type was covered are a bare hash
 * of name, position and description: such a mark is still read as what it
 * was, so it holds until one of those three changes and says nothing about
 * the type. It is replaced by a typed one only when the waypoint is marked
 * again.
 */
export function isReviewed(marks: ReviewMarks, w: EditorWaypoint): boolean {
  const mark: unknown = marks[w.id];
  if (typeof mark !== 'string' || mark === '') return false;
  return mark.includes(':') ? mark === reviewFingerprint(w) : mark === fingerprint(contentText(w));
}

export function reviewStorageKey(trailId: string): string {
  return `tracknotes-waypoint-review-${trailId}`;
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

export type StatusFilter =
  | 'all'
  | 'no-text'
  | 'has-text'
  | 'unreviewed'
  | 'reviewed'
  | 'changed'
  | 'pending'
  | 'merged'
  | 'off-route'
  | 'has-comments';

export const STATUS_FILTER_LABELS: Record<StatusFilter, string> = {
  all: 'All waypoints',
  'no-text': 'No curated text',
  'has-text': 'Has curated text',
  unreviewed: 'Not reviewed',
  reviewed: 'Reviewed',
  changed: 'Changed since build',
  pending: 'Added, pending rebuild',
  merged: 'Merged duplicates (with what they merged into)',
  'off-route': 'Off the route',
  'has-comments': 'Has comments',
};

export interface WaypointFilter {
  query: string;
  /** '' for every type. */
  type: string;
  status: StatusFilter;
}

function isOffRoute(w: EditorWaypoint): boolean {
  // A merged-away duplicate is in no list at all: the build dropped its row.
  // A pending waypoint has no placements yet: where it sits comes from the next build.
  // Nor has one the last build here does not list.
  return !w.mergedInto && !w.pending && !w.notBuilt && !w.placements.some(p => p.kind === 'main');
}

/** In a merge the build made: a duplicate it dropped, or the waypoint it kept in that duplicate's place. */
export function isInMerge(w: EditorWaypoint): boolean {
  return !!w.mergedInto || !!w.mergedIds?.length;
}

export function matchesFilter(
  w: EditorWaypoint,
  filter: WaypointFilter,
  marks: ReviewMarks,
  /** Hikers' comments per waypoint id (`admin-waypoints-comments.ts`); empty until they load. */
  commentCounts: ReadonlyMap<string, number> = new Map()
): boolean {
  if (filter.type && w.type !== filter.type) return false;
  if (filter.query && !nameMatches(w.name, filter.query) && w.id !== filter.query.trim()) return false;
  switch (filter.status) {
    case 'no-text':
      // A merged-away duplicate takes no text of its own: it is not work to do.
      // Nor is one the last build does not list: it is locked until a rebuild.
      return !hasCuratedText(w) && !w.mergedInto && !w.notBuilt;
    case 'has-text':
      return hasCuratedText(w);
    case 'unreviewed':
      return !isReviewed(marks, w);
    case 'reviewed':
      return isReviewed(marks, w);
    case 'changed':
      return changedSinceBuild(w);
    case 'pending':
      return !!w.pending;
    case 'merged':
      return isInMerge(w);
    case 'off-route':
      return isOffRoute(w);
    case 'has-comments':
      return (commentCounts.get(w.id) ?? 0) > 0;
    default:
      return true;
  }
}

/** The types present, most common first, for the type filter. */
export function typeCounts(waypoints: readonly EditorWaypoint[]): { type: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const w of waypoints) counts.set(w.type, (counts.get(w.type) ?? 0) + 1);
  return [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}

// ---------------------------------------------------------------------------
// Pasted positions
// ---------------------------------------------------------------------------

/**
 * A position from whatever was pasted: `-36.12, 148.45`, `-36.12 148.45`, a
 * Google Maps link (a place's pin `!3d-36.12!4d148.45`, else the view's centre
 * `@-36.12,148.45,15z`, or `?q=-36.12,148.45`), an OSM link
 * (`#map=17/-36.12/148.45` or `mlat=…&mlon=…`). Null when it is not one.
 */
export function parseLatLon(input: string): { lat: number; lon: number } | null {
  const text = input.trim();
  const patterns: RegExp[] = [
    /mlat=(-?\d+(?:\.\d+)?)&mlon=(-?\d+(?:\.\d+)?)/,
    // A Google Maps place link carries the pin itself; its `@lat,lon` is only where the view is centred.
    /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/,
    /#map=\d+(?:\.\d+)?\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/,
    /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,
    /[?&](?:q|query|ll)=(-?\d+(?:\.\d+)?)(?:,|%2C)\s*(-?\d+(?:\.\d+)?)/,
    /^(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)$/,
  ];
  for (const pattern of patterns) {
    const m = pattern.exec(text);
    if (!m) continue;
    const lat = Number(m[1]);
    const lon = Number(m[2]);
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      return { lat, lon };
    }
  }
  return null;
}

/**
 * The coordinate a position edit means, given the saved one. The form shows a
 * position at six decimals, and some GPX files hold more (CalTopo writes
 * `138.19241669999997`): a value that is the saved one as shown is the saved
 * one, so retyping what a field shows, or dropping the marker back where it
 * was, is never a move.
 */
export function editedCoordinate(value: number, saved: number): number {
  const shown = Number(value.toFixed(6));
  return shown === Number(saved.toFixed(6)) ? saved : shown;
}

/**
 * One coordinate as typed into the Lat or Lon field: a plain decimal number
 * within `limit` (90 for a latitude, 180 for a longitude). Null for an empty
 * or unparsable field, which must never be read as 0.
 */
export function parseCoordinate(input: string, limit: 90 | 180): number | null {
  const text = input.trim().replace(/^\u2212/, '-');
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) && Math.abs(value) <= limit ? value : null;
}

/** What the Lat and Lon fields of a form hold, read together. */
export interface TypedPosition {
  /** The position they hold, at the six decimals the editor writes; null when they do not hold one. */
  at: { lat: number; lon: number } | null;
  /** Which fields to flag as not holding a coordinate. */
  latInvalid: boolean;
  lonInvalid: boolean;
  /** Why they hold no position, in words; '' when they hold one, or when nothing has been typed yet. */
  problem: string;
}

/**
 * Lat and Lon as typed, for the selected waypoint's form and the add form
 * alike. A field that is empty or unparsable is never read as 0, and one out
 * of range is refused: it is flagged, and `problem` says what it must be.
 *
 * `unplaced` is the add form before it has a position: an empty field is then
 * one still to fill, which is said but not flagged (a field that holds
 * something that is no coordinate is flagged all the same).
 */
export function readTypedPosition(latText: string, lonText: string, unplaced = false): TypedPosition {
  const lat = parseCoordinate(latText, 90);
  const lon = parseCoordinate(lonText, 180);
  const latMissing = unplaced && !latText.trim();
  const lonMissing = unplaced && !lonText.trim();
  const latInvalid = lat === null && !latMissing;
  const lonInvalid = lon === null && !lonMissing;
  const problems = [
    latInvalid ? 'Lat must be a number from -90 to 90' : '',
    lonInvalid ? 'Lon must be a number from -180 to 180' : '',
    // One field filled and the other not yet: half a position.
    latMissing && !lonMissing ? 'Lat is still empty' : '',
    lonMissing && !latMissing ? 'Lon is still empty' : '',
  ];
  return {
    at: lat !== null && lon !== null ? { lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)) } : null,
    latInvalid,
    lonInvalid,
    problem: problems.filter(Boolean).join('; '),
  };
}

/**
 * What the add form still lacks before "Add waypoint" can be pressed, in
 * words; '' when it has a name the build shows as typed, a type and a
 * position. The button is off until then, and this says why.
 */
export function newWaypointNeeds(form: { name: string; type: string; position: TypedPosition }): string {
  const needs: string[] = [];
  if (!form.name.trim()) needs.push('a name');
  else if (typePrefixProblem(form.name)) needs.push('a name without a type prefix');
  if (!form.type) needs.push('a type');
  if (!form.position.at) {
    needs.push(
      form.position.latInvalid || form.position.lonInvalid
        ? 'a Lat and a Lon that are a position'
        : form.position.problem
          ? 'both Lat and Lon'
          : 'a position (click the map, or type or paste one)'
    );
  }
  return needs.length ? `Still needed: ${needs.join('; ')}.` : '';
}

/**
 * What the add form says of the waypoints that already stand on exactly the
 * position it holds, which the map shows as one dot: that the new one will
 * share it, that it will be refused under a name one of them has, or that it
 * puts back a waypoint deleted there since the last build (the same name and
 * type, on the exact position, is that waypoint again). '' when the position
 * is free. The server decides; this says beforehand what it will.
 */
export function newWaypointCompany(
  waypoints: readonly EditorWaypoint[],
  at: { lat: number; lon: number },
  name: string,
  type: string
): string {
  const here = waypoints.filter(w => w.lat === at.lat && w.lon === at.lon);
  if (!here.length) return '';
  const typed = name.trim();
  const standing = here.filter(w => !w.deleted);
  const namesake = standing.find(w => w.name === typed);
  if (namesake) {
    return `“${namesake.name}” already stands on exactly this position: waypoints may share a position, but each needs a name of its own there, so this add would be refused.`;
  }
  const back = here.find(w => w.deleted && w.name === typed && w.type === type);
  if (back) {
    return `This puts “${back.name}” (${back.id}) back: deleted since the last build, and added on its exact position under its name and type it has its id again at once. Only what this form writes comes back with it.`;
  }
  const names = [...new Set(here.map(w => `“${w.name}”${w.deleted ? ' (deleted)' : ''}`))];
  return `${names.length === 1 ? 'A waypoint already stands' : `${names.length} waypoints already stand`} on exactly this position (${names.join(', ')}): the new one will share it, as a <wpt> of its own.`;
}

// ---------------------------------------------------------------------------
// The route's lines: the main route and its alternates and side trips
// ---------------------------------------------------------------------------

/** A line a waypoint can sit on or be snapped to. */
export interface RouteLine {
  /** Null for the main route; otherwise the variant, in words (`side trip “Deurali > Thodung”`). */
  label: string | null;
  /** Its points with cumulative km. */
  points: readonly SnapPoint[];
  /** The first index after each route break (`routeBreakStarts`): the step into one is not trail. */
  breakStarts?: ReadonlySet<number>;
}

/** The nearest point on one line. */
export interface LineSnap {
  label: string | null;
  lat: number;
  lon: number;
  /** km along that line. */
  km: number;
  /** Metres from the position to the line. */
  offM: number;
}

/** An alternate, side trip or terminus in words, without a kind its name already opens with. */
export function variantLabel(v: { name: string; type: string }): string {
  const kind = v.type === 'side-trip' ? 'side trip' : v.type;
  const name = v.name.replace(/^(?:alternate|alternative|side[ -]trip|terminus)\s*[:–-]\s*/i, '');
  return `${kind} “${name || v.name}”`;
}

/** The main route (cut at its breaks) and every variant's line, each with cumulative km. */
export function routeLines(track: EditorTrail['track'], mainBreakStarts: ReadonlySet<number>): RouteLine[] {
  const lines: RouteLine[] = [{ label: null, points: track.points, breakStarts: mainBreakStarts }];
  for (const v of track.variants) {
    let km = 0;
    const points = v.line.map(([lat, lon], i) => {
      if (i > 0) km += haversineDistance(v.line[i - 1][0], v.line[i - 1][1], lat, lon) / 1000;
      return { lat, lon, dist: km };
    });
    if (points.length) lines.push({ label: variantLabel(v), points });
  }
  return lines;
}

function snapToLine(line: RouteLine, lat: number, lon: number): LineSnap | null {
  const snap = snapToTrail(lat, lon, line.points, undefined, line.breakStarts);
  if (!snap) return null;
  const a = line.points[snap.index];
  // `index` starts the segment the snapped point lies on; the step into a route break is never one.
  const b = line.breakStarts?.has(snap.index + 1) ? undefined : line.points[snap.index + 1];
  const span = b ? b.dist - a.dist : 0;
  const t = b && span > 0 ? Math.min(1, Math.max(0, (snap.currentKm - a.dist) / span)) : 0;
  return {
    label: line.label,
    lat: b ? a.lat + (b.lat - a.lat) * t : a.lat,
    lon: b ? a.lon + (b.lon - a.lon) * t : a.lon,
    km: snap.currentKm,
    offM: snap.offTrailMeters,
  };
}

/**
 * Where a position sits against the route: the nearest point on the main
 * route, and the nearest on any line (the main route unless a variant's line
 * is nearer), which is what "Snap to route" moves to. A side-trip waypoint
 * snaps to its side trip, not across country to the main route.
 */
export function nearestLineSnap(
  lines: readonly RouteLine[],
  lat: number,
  lon: number
): { main: LineSnap | null; nearest: LineSnap | null } {
  let main: LineSnap | null = null;
  let nearest: LineSnap | null = null;
  for (const line of lines) {
    const snap = snapToLine(line, lat, lon);
    if (!snap) continue;
    if (line.label === null) main = snap;
    if (!nearest || snap.offM < nearest.offM) nearest = snap;
  }
  return { main, nearest };
}

// ---------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------

export function formatKm(km: number | undefined): string {
  return km === undefined || !Number.isFinite(km) ? '' : km.toFixed(1);
}

/** A distance given in metres: whole metres under a kilometre, kilometres above. */
export function formatDistance(metres: number): string {
  if (Math.round(metres) < 1000) return `${Math.round(metres)} m`;
  const km = metres / 1000;
  return `${km.toFixed(km < 10 ? 2 : 1)} km`;
}

export function placementText(p: WaypointPlacement): string {
  const km = p.km !== undefined ? ` at km ${formatKm(p.km)}` : '';
  switch (p.kind) {
    case 'main':
      return `Main route${km}`;
    case 'off-trail':
      return 'Off the route';
    case 'alternate':
      return `Alternate “${p.variant ?? ''}”${km}`;
    case 'side-trip':
      return `Side trip “${p.variant ?? ''}”${km}`;
    case 'terminus':
      return `Terminus “${p.variant ?? ''}”${km}`;
  }
}

export function waypointGlyphHtml(type: string): string {
  return `<span class="${escapeHtml(waypointFamilyClass(type))}">${waypointIcon(type)}</span>`;
}

export interface RowState {
  selected: boolean;
  dirty: boolean;
  reviewed: boolean;
  comments?: number;
}

/**
 * What is inside a list row. Kept apart from the `<li>` so that an edit can
 * update the one row in place: rebuilding the list between a mousedown and its
 * mouseup (a blur that commits a field does) would swallow the click.
 */
export function rowContentHtml(w: EditorWaypoint, state: RowState): string {
  const badges: string[] = [];
  if (state.dirty) badges.push('<span class="wpe-badge wpe-badge-dirty" title="Unsaved changes">unsaved</span>');
  if (w.pending) {
    const title =
      'Added since the last build: no id until a rebuild, so edits go to its <wpt> in the GPX alone. Its place on the route (main route, a variant, or off it) and its km come from that build.' +
      (w.takesId
        ? ` The next build gives it the id ${w.takesId}, which the registry already holds, with the comments keyed to it.`
        : '');
    badges.push(
      `<span class="wpe-badge wpe-badge-pending" title="${escapeHtml(title)}">pending rebuild${w.takesId ? ` → ${escapeHtml(w.takesId)}` : ''}</span>`
    );
  } else if (w.deleted) {
    badges.push(
      '<span class="wpe-badge wpe-badge-pending" title="Its &lt;wpt&gt; is gone: the next build retires its id, unless a pending waypoint takes it (the form says which)">deleted</span>'
    );
  } else if (w.notBuilt) {
    badges.push(
      '<span class="wpe-badge wpe-badge-pending" title="It has an id in data/waypoint-ids.json, but the last build on this machine does not list it: locked until a rebuild">not built</span>'
    );
  } else if (changedSinceBuild(w)) {
    badges.push('<span class="wpe-badge wpe-badge-changed" title="Saved; rebuild to see it in the data">saved</span>');
  }
  if (w.mergedInto && !w.deleted) {
    const title = w.unmerges
      ? `The last build merged it into ${w.mergedInto}; as the sources stand the next build lists it on its own`
      : `The build merged it into ${w.mergedInto}: it has an id but no row in the app`;
    badges.push(`<span class="wpe-badge wpe-badge-merged" title="${escapeHtml(title)}">merged</span>`);
  } else if (w.mergedIds?.length) {
    badges.push(
      `<span class="wpe-badge wpe-badge-merged-into" title="${escapeHtml(`The build merged ${w.mergedIds.join(', ')} into it`)}">+${w.mergedIds.length} merged</span>`
    );
  }
  if (!w.description && !w.pending && !w.deleted && !w.mergedInto && !w.notBuilt)
    badges.push('<span class="wpe-badge wpe-badge-empty" title="No curated description">no text</span>');
  badges.push(commentBadgeHtml(state.comments));
  const reviewed = state.reviewed ? '<span class="wpe-reviewed" title="Reviewed">✓</span>' : '';
  const off = isOffRoute(w) ? ' <span class="wpe-muted">off route</span>' : '';
  return (
    `<span class="wpe-row-km">${escapeHtml(formatKm(w.sortKm))}</span>` +
    `<span class="wpe-row-glyph" title="${escapeHtml(waypointTypeLabel(w.type))}">${waypointGlyphHtml(w.type)}</span>` +
    `<span class="wpe-row-name">${escapeHtml(w.name)}${off}</span>` +
    `<span class="wpe-row-badges">${badges.join('')}${reviewed}</span>`
  );
}

export function rowHtml(w: EditorWaypoint, state: RowState): string {
  return (
    `<li class="wpe-row${state.selected ? ' is-selected' : ''}" data-id="${escapeHtml(w.id)}" role="option" ` +
    `aria-selected="${state.selected}" tabindex="-1">${rowContentHtml(w, state)}</li>`
  );
}

/**
 * The type select's options: every type the classifier emits (`WAYPOINT_TYPES`),
 * labelled, plus `current` first when it is another vocabulary's (Te Araroa's
 * `gap`-style types are in the list; a foreign one like `ley-note` is not), so
 * the select can show it without offering it for new waypoints.
 */
export function typeOptionsHtml(current: string | null): string {
  const offered = WAYPOINT_TYPES as readonly string[];
  const extra =
    current && !offered.includes(current)
      ? `<option value="${escapeHtml(current)}">${escapeHtml(waypointTypeLabel(current))} (${escapeHtml(current)})</option>`
      : '';
  return (
    extra +
    offered
      .map(t => `<option value="${escapeHtml(t)}">${escapeHtml(waypointTypeLabel(t))} (${escapeHtml(t)})</option>`)
      .join('')
  );
}

/** What deleting `w` does, for the confirm dialog. `comments` is how many hikers' comments are filed under its id, when known. */
export function deleteConfirmText(w: EditorWaypoint, comments?: number): string {
  if (w.pending)
    return `Remove the unbuilt waypoint “${w.name}” from the GPX? It has no id yet, so nothing else changes (a CalTopo marker with its name, if any, stays).`;
  if (w.mergedInto) {
    // The build dropped its row, so the app never showed what is keyed to its id.
    const into = `“${w.builtName}” (${w.mergedInto})`;
    const lines = [
      `Delete the merged duplicate “${w.name}” (${w.id})?`,
      '',
      w.unmerges
        ? `The last build merged it into ${into}, so the app shows no row for it yet; as the sources stand the next build would list it on its own.`
        : `The build merged it into ${into}, ${Math.round(w.mergedDistanceM ?? 0)} m away, so the app shows no row for it: that waypoint stays as it is.`,
      'This removes its <wpt> from the GPX, the CalTopo marker that types it (if any) and any curated description under its id.',
      'Its registry entry stays: the next build marks the id retired, so it never passes to another place.',
      `Comments keyed to ${w.id} are already out of sight, and stay so: the app looks comments up by a row's own id, and this duplicate has had no row since the build began merging it. They stay on the server.`,
    ];
    if (comments) {
      lines.push(
        `It has ${comments === 1 ? '1 comment' : `${comments} comments`}: read ${comments === 1 ? 'it' : 'them'} in the form first, in case a report belongs on ${into}.`
      );
    }
    if (w.description || w.sourceDescription) {
      lines.push(
        `The build appended its description to that of ${into} in the trail data; the next build no longer does.`
      );
    }
    return lines.join('\n');
  }
  const lines = [
    `Delete “${w.name}” (${w.id})?`,
    '',
    'This removes its <wpt> from the GPX, the CalTopo marker that types it (if any) and its curated description.',
    'Its registry entry stays: the next build marks the id retired, so it never passes to another place.',
    `Comments keyed to ${w.id} are orphaned: they stay on the server but no waypoint shows them.`,
  ];
  if (w.sharesSourceWith?.length) {
    lines.push(`Also deletes ${w.sharesSourceWith.join(', ')}: later passes built from the same <wpt>.`);
  }
  if (w.mergedIds?.length) {
    const one = w.mergedIds.length === 1;
    lines.push(
      `The build merged ${w.mergedIds.join(', ')} into it: ${one ? 'that <wpt> stays' : 'those <wpt>s stay'}, so the next build lists ${one ? 'it' : 'them'} again as ${one ? 'a row of its own, under its own id' : 'rows of their own, under their own ids'}. Comments keyed to ${w.id} do not move to ${one ? 'it' : 'them'}. Delete ${one ? 'it' : 'them'} too if the place is gone.`
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Merged near-duplicates (`dedupeWaypoints`)
// ---------------------------------------------------------------------------

function metres(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  return Math.round(haversineDistance(a.lat, a.lon, b.lat, b.lon));
}

/** A waypoint id that selects its row when the page has one (`data-goto`), plain otherwise. */
function idLinkHtml(id: string, known: boolean): string {
  const code = `<code>${escapeHtml(id)}</code>`;
  return known
    ? `<button type="button" class="wpe-link" data-goto="${escapeHtml(id)}" title="Go to this waypoint">${code}</button>`
    : code;
}

/**
 * The form's line on a pending waypoint the next build hands an id the
 * registry already holds (`takesId`), in place of minting one: the id, as a
 * link to the row that has it when there is one (the waypoint whose `<wpt>`
 * went). '' for any other waypoint.
 */
export function takesIdMetaHtml(w: EditorWaypoint, byId: ReadonlyMap<string, EditorWaypoint>): string {
  if (!w.pending || !w.takesId) return '';
  const owner = byId.get(w.takesId);
  const whose = owner ? ` of “${escapeHtml(owner.name)}”` : '';
  return (
    `<span class="wpe-meta-takes-id">The next build gives it the id ${idLinkHtml(w.takesId, !!owner)}${whose}, ` +
    `which the registry already holds, in place of minting one: the comments keyed to that id come with it</span>`
  );
}

// ---------------------------------------------------------------------------
// Waypoints that share a position
// ---------------------------------------------------------------------------

/** The `<wpt>` a row is built from, as far as its id says: a revisited place's passes share one. */
function placeOf(w: EditorWaypoint): string {
  return w.pending ? w.id : (laterPassOf(w.id) ?? w.id);
}

/**
 * The other rows that stand on exactly `w`'s position, in list order: `<wpt>`s
 * of their own on the same coordinates (the CDT's towns hitched from one pass).
 * On the map they are one dot under another, so the form names them. The passes
 * of a revisited place are one `<wpt>`, not company: they are left out.
 */
export function colocatedWith(w: EditorWaypoint, waypoints: readonly EditorWaypoint[]): EditorWaypoint[] {
  const place = placeOf(w);
  return waypoints.filter(o => o.id !== w.id && o.lat === w.lat && o.lon === w.lon && placeOf(o) !== place);
}

/** How many other rows share each row's position ({@link colocatedWith}), for the rows that have company. */
export function colocatedCounts(waypoints: readonly EditorWaypoint[]): Map<string, number> {
  const byPosition = new Map<string, EditorWaypoint[]>();
  for (const w of waypoints) {
    const key = `${w.lat},${w.lon}`;
    byPosition.set(key, [...(byPosition.get(key) ?? []), w]);
  }
  const counts = new Map<string, number>();
  for (const group of byPosition.values()) {
    if (group.length < 2) continue;
    for (const w of group) {
      const others = group.filter(o => placeOf(o) !== placeOf(w)).length;
      if (others) counts.set(w.id, others);
    }
  }
  return counts;
}

/**
 * The row a click on the selected marker goes to: the next of those that
 * share `w`'s position, in list order and round again, so every one of them
 * can be reached from the map. Null when `w` has the position to itself.
 */
export function nextColocatedId(w: EditorWaypoint, waypoints: readonly EditorWaypoint[]): string | null {
  const others = new Set(colocatedWith(w, waypoints).map(o => o.id));
  if (!others.size) return null;
  const group = waypoints.filter(o => o.id === w.id || others.has(o.id));
  return group[(group.findIndex(o => o.id === w.id) + 1) % group.length].id;
}

/**
 * The form's line on the waypoints that share this one's position: each by
 * name, as a link to its row, with its type and whether it is deleted or
 * pending. '' when it has the position to itself.
 */
export function colocatedMetaHtml(w: EditorWaypoint, waypoints: readonly EditorWaypoint[]): string {
  const others = colocatedWith(w, waypoints);
  if (!others.length) return '';
  const items = others.map(o => {
    const state = o.deleted ? ' · deleted' : o.pending ? ' · pending rebuild' : '';
    return (
      `<button type="button" class="wpe-link" data-goto="${escapeHtml(o.id)}" title="Go to this waypoint">${escapeHtml(o.name)}</button>` +
      ` <span class="wpe-muted">· ${escapeHtml(waypointTypeLabel(o.type))}${state}</span>`
    );
  });
  const count = others.length === 1 ? '1 other waypoint shares' : `${others.length} other waypoints share`;
  return (
    `<span class="wpe-meta-colocated">${count} this position, each a &lt;wpt&gt; of its own that an edit here leaves where it is: ` +
    `${items.join('; ')}. On the map they are one dot: click the selected marker to step through them</span>`
  );
}

/**
 * The form's line on a merge the build made: on a merged-away duplicate, the
 * waypoint it merged into and how far apart they are; on that waypoint, the
 * ids merged into it. '' for any other waypoint.
 */
export function mergeMetaHtml(w: EditorWaypoint, byId: ReadonlyMap<string, EditorWaypoint>): string {
  if (w.mergedInto) {
    const survivor = byId.get(w.mergedInto);
    const where = survivor ? ` “${escapeHtml(survivor.name)}”` : '';
    const apart = w.mergedDistanceM === undefined ? '' : `, ${Math.round(w.mergedDistanceM)} m away`;
    return (
      `<span class="wpe-meta-merged">Merged by the last build into${where} ${idLinkHtml(w.mergedInto, !!survivor)}${apart}: no row in the app` +
      (w.unmerges ? '; the next build lists it on its own' : '') +
      `</span>`
    );
  }
  if (!w.mergedIds?.length) return '';
  const items = w.mergedIds.map(id => {
    const duplicate = byId.get(id);
    const state = !duplicate ? '' : duplicate.deleted ? ' (deleted)' : ` (${metres(w, duplicate)} m away)`;
    return `${idLinkHtml(id, !!duplicate)}${state}`;
  });
  return `<span class="wpe-meta-merged">The last build merged into it: ${items.join(', ')}</span>`;
}

/**
 * What to say over a waypoint's comments about a merge: the app looks comments
 * up by a row's own id and never reads `mergedIds`, so comments filed under a
 * merged-away id are shown nowhere in it. Undefined when there is nothing to say.
 */
export function mergeCommentsNote(
  w: EditorWaypoint,
  byId: ReadonlyMap<string, EditorWaypoint>,
  commentCounts: ReadonlyMap<string, number>
): string | undefined {
  if (w.mergedInto) {
    if (!commentCounts.get(w.id)) return undefined;
    const survivor = byId.get(w.mergedInto);
    return `The app does not show these: it looks comments up by a row's own id, and the build merged this waypoint into ${survivor ? `“${survivor.name}” ` : ''}(${w.mergedInto}). A report here may belong on that waypoint.`;
  }
  const hidden = (w.mergedIds ?? []).filter(id => commentCounts.get(id));
  if (!hidden.length) return undefined;
  const total = hidden.reduce((sum, id) => sum + (commentCounts.get(id) ?? 0), 0);
  return `${total === 1 ? '1 more comment is' : `${total} more comments are`} filed under ${hidden.join(', ')}, merged into this waypoint by the build: the app does not show ${total === 1 ? 'it' : 'them'} here. Open ${hidden.length === 1 ? 'that row' : 'those rows'} to read ${total === 1 ? 'it' : 'them'}.`;
}

/**
 * Every id a comment may rightly be filed under on this trail: each row's own,
 * and each id the build merged into a row, so a merged-away id is never
 * reported as lost.
 */
export function knownCommentIds(waypoints: readonly EditorWaypoint[]): Set<string> {
  return new Set(waypoints.flatMap(w => [w.id, ...(w.mergedIds ?? [])]));
}

/** How a waypoint's dot is drawn on the map (Leaflet path options), given its family colour. */
export interface DotStyle {
  radius: number;
  color: string;
  weight: number;
  dashArray: string | undefined;
  fillColor: string;
  fillOpacity: number;
}

/**
 * A built waypoint is a solid dot in its family colour with a white edge. One
 * pending a rebuild has a dashed dark edge. A merged-away duplicate, which the
 * app does not show, is a smaller hollow ring in the family colour.
 */
export function dotStyle(w: EditorWaypoint, familyColor: string): DotStyle {
  if (w.mergedInto) {
    return { radius: 5, color: familyColor, weight: 2, dashArray: '1 4', fillColor: '#ffffff', fillOpacity: 0.7 };
  }
  return {
    radius: 6,
    color: w.pending ? '#222222' : '#ffffff',
    weight: 2,
    dashArray: w.pending ? '2 2' : undefined,
    fillColor: familyColor,
    fillOpacity: 1,
  };
}

/**
 * A dot's tooltip: name and type, for a merged-away duplicate what it merged
 * into, and how many other waypoints lie under it on the same position
 * (`sharing`, from {@link colocatedCounts}). Escaped.
 */
export function dotTooltipHtml(w: EditorWaypoint, sharing = 0): string {
  return (
    `${escapeHtml(w.name)} <span class="wpe-muted">${escapeHtml(waypointTypeLabel(w.type))}` +
    (w.mergedInto ? ` · merged into ${escapeHtml(w.mergedInto)}` : '') +
    (sharing ? ` · ${sharing} more on this position` : '') +
    `</span>`
  );
}

/** The selected marker's tooltip: the name, and where it stands among the waypoints that share its position. Escaped. */
export function markerTooltipHtml(name: string, w: EditorWaypoint, waypoints: readonly EditorWaypoint[]): string {
  const others = colocatedWith(w, waypoints);
  if (!others.length) return escapeHtml(name);
  const group = waypoints.filter(o => o.id === w.id || others.includes(o));
  return `${escapeHtml(name)} <span class="wpe-muted">${group.findIndex(o => o.id === w.id) + 1} of ${group.length} on this position: click for the next</span>`;
}

export interface PositionReadout {
  /** km along the main route at the nearest point. */
  km: number | null;
  /** Metres from the main route. */
  offRouteM: number | null;
  /** The alternate or side trip whose line is nearer than the main route's, and metres from it. */
  nearer?: { label: string; offM: number };
  /** Metres from the saved position. */
  movedM: number;
}

/** The bar under the map: which line the position is measured to, how far from it, and how far it has moved. */
export function readoutText(r: PositionReadout): string {
  const parts: string[] = [];
  if (r.nearer) {
    parts.push(`${formatDistance(r.nearer.offM)} from ${r.nearer.label}`);
    if (r.km !== null && r.offRouteM !== null) {
      parts.push(`${formatDistance(r.offRouteM)} from the main route (nearest at km ${r.km.toFixed(2)})`);
    }
  } else {
    if (r.km !== null) parts.push(`nearest main route km ${r.km.toFixed(2)}`);
    if (r.offRouteM !== null) parts.push(`${formatDistance(r.offRouteM)} from the main route`);
  }
  if (r.movedM >= 0.5) parts.push(`moved ${formatDistance(r.movedM)} from the saved position`);
  return parts.join(' · ');
}

/** The readout for a position against the route's lines. */
export function positionReadout(lines: readonly RouteLine[], lat: number, lon: number, movedM: number): string {
  const { main, nearest } = nearestLineSnap(lines, lat, lon);
  return readoutText({
    km: main ? main.km : null,
    offRouteM: main ? main.offM : null,
    nearer: nearest && nearest.label !== null ? { label: nearest.label, offM: nearest.offM } : undefined,
    movedM,
  });
}

export interface NearbyPoi {
  id: string;
  name: string;
  category: string;
  lat: number;
  lon: number;
  distanceM: number;
}

/** OSM POIs within `radiusM` of a position, nearest first. */
export function nearbyPois(
  pois: readonly { id: string; name: string; category: string; lat: number; lon: number }[],
  at: { lat: number; lon: number },
  radiusM = 400,
  limit = 8
): NearbyPoi[] {
  return pois
    .map(p => ({ ...p, distanceM: haversineDistance(at.lat, at.lon, p.lat, p.lon) }))
    .filter(p => p.distanceM <= radiusM)
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, limit);
}

/** Links for checking a position against other maps. */
export function externalMapLinks(lat: number, lon: number): { label: string; href: string }[] {
  const ll = `${lat.toFixed(6)},${lon.toFixed(6)}`;
  return [
    {
      label: 'OpenStreetMap',
      href: `https://www.openstreetmap.org/?mlat=${lat.toFixed(6)}&mlon=${lon.toFixed(6)}#map=17/${lat.toFixed(6)}/${lon.toFixed(6)}`,
    },
    { label: 'Google Maps', href: `https://www.google.com/maps/search/?api=1&query=${ll}` },
    { label: 'Satellite (Google)', href: `https://www.google.com/maps/@${ll},500m/data=!3m1!1e3` },
  ];
}
