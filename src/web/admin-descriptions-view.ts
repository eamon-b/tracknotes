/**
 * The live description editor's pure parts (`admin-descriptions.html`): which
 * waypoints a trail has, how each one's three texts compare, which synced rows
 * are live edits the file does not match (drift), the export that carries
 * those back into the file, and the row markup. No DOM here, so it is tested
 * on its own (`admin-descriptions-view.test.ts`); `admin-descriptions.ts`
 * wires it to the page.
 *
 * Three texts per waypoint:
 *
 *  - **file** — its entry in the trail's `descriptions.json` as this site was
 *    built (the committed source of truth, which *Upload descriptions* pushes);
 *  - **bundled** — the description in the trail JSON the site serves (the file
 *    text when there is one, else the GPX / CalTopo text);
 *  - **synced** — the comments API's row (`GET /v1/trails/:id/descriptions`),
 *    absent, live text, or `''` (cleared). A phone shows `synced || bundled`:
 *    a cleared row falls back to the bundled text, it does not blank it.
 *
 * A synced row also says which tool last changed its text (`source`): `live`
 * is this page, `upload` is `scripts/upload-descriptions.ts`. That is what
 * tells the two ways a synced row can differ from the file apart:
 *
 *  - written **live**: drift. The edit is on the API only, and the next upload
 *    of this trail replaces it with the file's text, so it must be committed;
 *  - written by an **upload**: the file is the newer one (a merged change whose
 *    *Upload descriptions* run has not been approved or run yet). Nothing to
 *    commit, and exporting it would write old text over the file.
 */

import type { DescriptionSource, WaypointDescription } from '@lib/comments-api-types';
import { snapToTrail } from '@lib/position-on-trail';
import { routeBreakStarts } from '@lib/route-breaks';
import type { ProcessedTrail } from '@lib/trail-types';
import { MAX_DESCRIPTION_LENGTH } from '@lib/waypoint-description-limits';
import { waypointTypeLabel } from '@lib/waypoint-taxonomy';
import { voiceHints, type VoiceHint } from './admin-waypoints-view';
import { escapeHtml } from './web-utils';

export { MAX_DESCRIPTION_LENGTH };

// ---------------------------------------------------------------------------
// The trail's waypoints
// ---------------------------------------------------------------------------

export type Placement = 'main' | 'variant' | 'off-trail' | 'unknown';

/** One waypoint with an id, as the site's trail JSON has it. */
export interface TrailWaypoint {
  id: string;
  name: string;
  type: string;
  placement: Placement;
  /** The alternate or side trip it is on, for `variant`. */
  variant?: string;
  /** Main-route km (a variant's absolute km; an off-trail one's nearest route km). */
  km: number;
  /** Its description in the trail JSON ('' when none). */
  bundled: string;
}

type TrailForDescriptions = Pick<ProcessedTrail, 'waypoints' | 'offTrailWaypoints' | 'alternates' | 'sideTrips'> & {
  track: Pick<ProcessedTrail['track'], 'points' | 'displayPoints' | 'breaks'>;
};

/**
 * Every waypoint with an id, once each: main route first in km order, then the
 * rest (alternates, side trips, off-trail) by their place along the route —
 * the order the local editor files new `descriptions.json` entries in.
 */
export function trailWaypoints(trail: TrailForDescriptions): TrailWaypoint[] {
  const seen = new Set<string>();
  const out: TrailWaypoint[] = [];
  const add = (w: TrailWaypoint): void => {
    if (!w.id || seen.has(w.id)) return;
    seen.add(w.id);
    out.push(w);
  };
  for (const w of trail.waypoints ?? []) {
    if (!w.id) continue;
    add({ id: w.id, name: w.name, type: w.type, placement: 'main', km: w.totalDistance, bundled: w.description ?? '' });
  }
  for (const variant of [...(trail.alternates ?? []), ...(trail.sideTrips ?? [])]) {
    for (const w of variant.waypoints ?? []) {
      if (!w.id) continue;
      add({
        id: w.id,
        name: w.name,
        type: w.type,
        placement: 'variant',
        variant: variant.name,
        km: w.totalDistance,
        bundled: w.description ?? '',
      });
    }
  }
  const usesDisplay = (trail.track.displayPoints?.length ?? 0) > 0;
  const points = usesDisplay ? trail.track.displayPoints! : (trail.track.points ?? []);
  const starts = routeBreakStarts(trail.track.breaks, usesDisplay ? 'displayPoints' : 'points');
  for (const w of trail.offTrailWaypoints ?? []) {
    if (!w.id) continue;
    const km = snapToTrail(w.lat, w.lon, points, undefined, starts)?.currentKm ?? 0;
    add({ id: w.id, name: w.name, type: w.type, placement: 'off-trail', km, bundled: w.description ?? '' });
  }
  const rank = (w: TrailWaypoint): number => (w.placement === 'main' ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || a.km - b.km);
}

/**
 * The first pass's id when `id` is a later pass of a revisited place
 * (`<id>_2`, `<id>_3`; `revisitedWaypoints` in `trail.json`), given the
 * trail's ids. The build mints the suffix after it applies `descriptions.json`,
 * which is keyed by the first pass's id: every pass is bundled with that
 * entry's text, and an entry for a suffixed id matches no waypoint.
 */
export function firstPassIdOf(id: string, ids: ReadonlySet<string>): string | null {
  const match = /^(.+)_(\d+)$/.exec(id);
  return match && Number(match[2]) >= 2 && ids.has(match[1]) ? match[1] : null;
}

// ---------------------------------------------------------------------------
// descriptions.json
// ---------------------------------------------------------------------------

/** One entry of `descriptions.json` (`scripts/lib/waypoint-descriptions.ts`). */
export interface CuratedEntry {
  waypointId: string;
  name?: string;
  description: string;
  [key: string]: unknown;
}

export interface CuratedFile {
  trailId: string;
  note?: string;
  descriptions: CuratedEntry[];
  [key: string]: unknown;
}

/** The parsed file, or null when the text is absent or not a descriptions file. */
export function parseCuratedFile(text: string | null): CuratedFile | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as Partial<CuratedFile>;
    if (typeof value !== 'object' || value === null || !Array.isArray(value.descriptions)) return null;
    return value as CuratedFile;
  } catch {
    return null;
  }
}

/** The trail directory a `data/trails/<dir>/descriptions.json` glob key names. */
export function trailDirOf(globKey: string): string | null {
  const match = /(?:^|\/)data\/trails\/([^/]+)\/[^/]+$/.exec(globKey);
  return match ? match[1] : null;
}

/**
 * The trail directory whose build id is `trailId` (`AAWT` builds `aawt`), from
 * a glob of each `data/trails/*\/trail.json`'s `id`, or null.
 */
export function trailDirFor(trailId: string, ids: Record<string, string | undefined>): string | null {
  for (const [key, id] of Object.entries(ids)) {
    const dir = trailDirOf(key);
    if (dir && id === trailId) return dir;
  }
  return null;
}

/** Where the file lives in the repository. */
export function filePath(dir: string | null, trailId: string): string {
  return `data/trails/${dir ?? `<${trailId} directory>`}/descriptions.json`;
}

/**
 * Trails whose waypoints, descriptions included, are built outside this
 * repository, and where. Te Araroa's come from the `te-araroa-data` package
 * (`npm run sync:te-araroa`): the local waypoint editor refuses to edit it,
 * and a lasting fix to one of its descriptions is made upstream.
 */
const UPSTREAM_TRAILS: Record<string, string> = { te_araroa: 'te-araroa-data' };

/** What the page knows about a trail's `descriptions.json`, for its wording. */
export interface FileContext {
  /** Where the file is, or would be created, in the repository. */
  path: string;
  /**
   * The trail has a `descriptions.json` in this site's build. *Upload
   * descriptions* only visits trails that have one, so without it no upload
   * ever replaces or withdraws this trail's synced text.
   */
  hasFile: boolean;
  /** Set when the trail's descriptions are not curated in this repository: the package they come from. */
  upstream?: string;
}

export function fileContext(trailId: string, dir: string | null, fileText: string | null): FileContext {
  const hasFile = fileText !== null;
  // A trail that does have a file is curated here, whatever this list says.
  const upstream = hasFile ? undefined : UPSTREAM_TRAILS[trailId];
  return { path: filePath(dir, trailId), hasFile, ...(upstream ? { upstream } : {}) };
}

// ---------------------------------------------------------------------------
// Rows: the three texts and how they compare
// ---------------------------------------------------------------------------

/**
 * - `in-sync`: the synced text is the file's.
 * - `drift`: a live write the file does not match — a live edit, or a live
 *   clear of an id the file lists. The next upload of this trail undoes it.
 * - `awaiting`: an uploaded row the file no longer matches — the file is
 *   newer, and its *Upload descriptions* run has not been approved or run.
 * - `unknown`: a row that differs from the file on an API that does not say
 *   what wrote it (a worker that predates the marker): neither of the above
 *   can be claimed.
 * - `cleared`: a cleared synced row the file has no entry for; the phone shows
 *   the bundled text.
 * - `pending`: a file entry the API does not hold yet (the upload has not run).
 * - `bundled`: no curated text anywhere; the phone shows the GPX / CalTopo text, if any.
 */
export type SyncState = 'in-sync' | 'drift' | 'awaiting' | 'unknown' | 'cleared' | 'pending' | 'bundled';

export interface DescriptionRow extends TrailWaypoint {
  /** Its `descriptions.json` text, when the file lists it. */
  file?: string;
  /** The synced row's text ('' = cleared), when the API has one. */
  synced?: string;
  syncedAt?: string;
  /** Which tool last changed the synced text; absent with no row, or when the API does not say. */
  source?: DescriptionSource;
  state: SyncState;
  /** On a later pass of a revisited place (`<id>_2`): the first pass's id. */
  firstPassId?: string;
  /** On the first pass of a revisited place: its later passes' ids. */
  laterPassIds?: string[];
}

function stateOf(
  file: string | undefined,
  live: Pick<WaypointDescription, 'description' | 'source'> | undefined
): SyncState {
  if (!live) return file !== undefined ? 'pending' : 'bundled';
  if (live.description === (file ?? '')) return live.description === '' ? 'cleared' : 'in-sync';
  if (live.source === 'live') return 'drift';
  return live.source === 'upload' ? 'awaiting' : 'unknown';
}

/**
 * Join the trail's waypoints, the file and the synced set. A synced row for an
 * id the trail no longer has is kept as an `unknown`-placement row at the end,
 * so drift on it is not hidden.
 */
export function buildRows(
  waypoints: readonly TrailWaypoint[],
  file: CuratedFile | null,
  synced: readonly WaypointDescription[]
): DescriptionRow[] {
  const fileById = new Map((file?.descriptions ?? []).map(e => [e.waypointId, e.description.trim()]));
  const syncedById = new Map(synced.map(s => [s.waypointId, s]));
  const ids = new Set(waypoints.map(w => w.id));
  const laterPasses = new Map<string, string[]>();
  for (const w of waypoints) {
    const first = firstPassIdOf(w.id, ids);
    if (first) laterPasses.set(first, [...(laterPasses.get(first) ?? []), w.id]);
  }
  const join = (id: string): Partial<DescriptionRow> & Pick<DescriptionRow, 'state'> => {
    const fileText = fileById.get(id);
    const live = syncedById.get(id);
    const firstPassId = firstPassIdOf(id, ids);
    const later = laterPasses.get(id);
    return {
      ...(fileText === undefined ? {} : { file: fileText }),
      ...(live === undefined ? {} : { synced: live.description, syncedAt: live.updatedAt }),
      ...(live?.source === undefined ? {} : { source: live.source }),
      state: stateOf(fileText, live),
      ...(firstPassId ? { firstPassId } : {}),
      ...(later ? { laterPassIds: later } : {}),
    };
  };
  const rows: DescriptionRow[] = waypoints.map(w => ({ ...w, ...join(w.id) }));
  for (const live of synced) {
    if (ids.has(live.waypointId)) continue;
    rows.push({
      id: live.waypointId,
      name: '(not in this trail’s data)',
      type: 'waypoint',
      placement: 'unknown',
      km: Number.POSITIVE_INFINITY,
      bundled: '',
      ...join(live.waypointId),
    });
  }
  return rows;
}

/** What a phone shows for the waypoint now: the synced text, else the bundled. */
export function shownText(row: Pick<DescriptionRow, 'synced' | 'bundled'>): string {
  return row.synced ? row.synced : row.bundled;
}

/** True when the synced and bundled texts both exist and differ (what the phone shows is not the bundle's). */
export function syncedDiffersFromBundled(row: Pick<DescriptionRow, 'synced' | 'bundled'>): boolean {
  return !!row.synced && row.synced !== row.bundled;
}

/** A drift row that is a live clear of an id the file lists, not a live edit. */
export function isLiveClear(row: Pick<DescriptionRow, 'state' | 'synced'>): boolean {
  return row.state === 'drift' && row.synced === '';
}

export const STATE_LABELS: Record<SyncState, string> = {
  'in-sync': 'in sync',
  drift: 'drift',
  awaiting: 'awaiting upload',
  unknown: 'origin unknown',
  cleared: 'cleared',
  pending: 'not uploaded',
  bundled: 'bundled only',
};

/** The badge on a row: its state, with a live clear told apart from a live edit. */
export function stateLabel(row: Pick<DescriptionRow, 'state' | 'synced'>): string {
  return isLiveClear(row) ? 'drift: cleared live' : STATE_LABELS[row.state];
}

/** What the uploads do, or do not do, to a live edit on this trail. */
function liveEditFate(row: DescriptionRow, ctx: FileContext): string {
  if (!ctx.hasFile) {
    return 'This trail has no descriptions.json, so no upload touches it: it stays on phones until it is changed or cleared here.';
  }
  return row.file !== undefined
    ? 'The next upload replaces it with the descriptions.json text.'
    : 'The next upload withdraws it (descriptions.json has no entry), and phones fall back to the bundled text.';
}

/** What a row's state means, and what the next *Upload descriptions* run does to it, in words. */
export function nextUploadText(row: DescriptionRow, ctx: FileContext): string {
  switch (row.state) {
    case 'drift':
      if (row.synced === '') {
        return 'Cleared live, but descriptions.json still has an entry: phones show the bundled text now, and the next upload re-sends the file’s text. To remove the description for good, delete its entry from the file.';
      }
      if (row.firstPassId) {
        return `A live edit on a later pass, which descriptions.json cannot hold. ${liveEditFate(row, ctx)}`;
      }
      if (row.placement === 'unknown') {
        return `A live edit on an id this trail no longer has: no waypoint shows it, and it cannot be committed. ${liveEditFate(row, ctx)}`;
      }
      if (ctx.upstream) {
        return `A live edit. This trail’s descriptions are built upstream in ${ctx.upstream}, not in this repository: make the lasting fix there, and clear this synced text once a build carries it. No upload touches this trail, so it stays on phones until then.`;
      }
      return ctx.hasFile
        ? `A live edit that descriptions.json does not match. ${liveEditFate(row, ctx)} Commit it to the file to keep it.`
        : `A live edit, held only by the API. ${liveEditFate(row, ctx)} To keep it in the repository, commit it by creating the file.`;
    case 'awaiting':
      if (!ctx.hasFile) {
        return 'Uploaded text on a trail that has no descriptions.json now: no upload changes or withdraws it. Clear it here if it should go.';
      }
      if (row.synced === '') {
        return 'An earlier upload withdrew this, and descriptions.json lists it again: the Upload descriptions run that re-sends it has not been approved or run yet. Nothing to commit.';
      }
      return row.file !== undefined
        ? 'descriptions.json has newer text than the API: the Upload descriptions run that sends it has not been approved or run yet. Nothing to commit.'
        : 'descriptions.json no longer has this entry: the Upload descriptions run that withdraws it has not been approved or run yet. Nothing to commit.';
    case 'unknown':
      return 'The synced row differs from descriptions.json, and this API does not say whether a live edit or an upload wrote it (its worker predates that marker). If it is a live edit, commit it by hand: the export leaves it out. If the file is the newer one, the next upload replaces it.';
    case 'cleared':
      return 'Cleared: phones show the bundled text.';
    case 'pending':
      return 'In descriptions.json but not on the API yet: the Upload descriptions run has not been approved or run.';
    case 'in-sync':
      return row.source === 'live'
        ? 'The synced text is the descriptions.json text. It was written live and has been committed since; the next upload marks it uploaded.'
        : 'The synced text is the descriptions.json text.';
    default:
      return 'No curated text: phones show the bundled text.';
  }
}

/**
 * What a revisited place's row must say, whatever its state: phones look each
 * pass up by its own id, and only the first pass's text can be committed.
 */
export function passNote(row: Pick<DescriptionRow, 'firstPassId' | 'laterPassIds'>): string {
  if (row.firstPassId) {
    return `A later pass of a revisited place (first pass: ${row.firstPassId}). descriptions.json is keyed by the first pass’s id, and the build gives every pass that entry’s text, so a live edit here reaches phones on this pass only and cannot be committed to the file. For a lasting fix, edit the first pass and commit that.`;
  }
  if (row.laterPassIds?.length) {
    return `The first pass of a revisited place (also ${row.laterPassIds.join(', ')}). A descriptions.json entry for this id is the text the build gives every pass, but phones look each pass up by its own id: an urgent live edit has to be made on each pass, and only this one can be committed.`;
  }
  return '';
}

/** What to tell an admin about to save a live edit on this row: where it goes next. */
export function liveEditAdvice(row: DescriptionRow, ctx: FileContext): string {
  if (row.firstPassId) {
    return `This is a later pass of a revisited place: the edit reaches phones on this pass only and cannot be committed to descriptions.json. Make the lasting fix on the first pass (${row.firstPassId}).`;
  }
  if (ctx.upstream) {
    return `It is a live edit. This trail’s descriptions are built upstream in ${ctx.upstream}: make the lasting fix there, then clear this synced text.`;
  }
  return ctx.hasFile
    ? 'It is a live edit: commit it to descriptions.json too (the export above), or the next Upload descriptions run overwrites it.'
    : 'It is a live edit, held only by the API: this trail has no descriptions.json, so no upload overwrites it, and it is not in the repository until it is committed (the export above creates the file).';
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export type RowFilter = 'all' | 'drift' | 'awaiting' | 'synced' | 'differs' | 'curated' | 'none';

export const ROW_FILTER_LABELS: Record<RowFilter, string> = {
  all: 'All waypoints',
  drift: 'Drift (live edits descriptions.json does not match)',
  awaiting: 'Awaiting upload (descriptions.json is newer)',
  synced: 'Has a synced row',
  differs: 'Synced differs from bundled',
  curated: 'In descriptions.json',
  none: 'No description at all',
};

export function matchesRow(row: DescriptionRow, filter: RowFilter, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q && !row.name.toLowerCase().includes(q) && row.id !== q) return false;
  switch (filter) {
    case 'drift':
      return row.state === 'drift';
    case 'awaiting':
      return row.state === 'awaiting';
    case 'synced':
      return row.synced !== undefined;
    case 'differs':
      return syncedDiffersFromBundled(row);
    case 'curated':
      return row.file !== undefined;
    case 'none':
      return !shownText(row);
    default:
      return true;
  }
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

export interface DraftCheck {
  /** The text as it would be sent (trimmed, as the API stores it). */
  text: string;
  length: number;
  tooLong: boolean;
  hints: VoiceHint[];
}

/** Length against `MAX_DESCRIPTION_LENGTH` and the house-voice hints, for the edit box. */
export function checkDraft(raw: string): DraftCheck {
  const text = raw.trim();
  return { text, length: text.length, tooLong: text.length > MAX_DESCRIPTION_LENGTH, hints: voiceHints(text) };
}

// ---------------------------------------------------------------------------
// Export: carry the live edits back into descriptions.json
// ---------------------------------------------------------------------------

/**
 * The rows an export carries into the file: live edits only. Never a row an
 * upload wrote (the file is the newer one there), never a live clear (the
 * entry stays until someone deletes it), never an id the trail has lost, and
 * never a later pass (`<id>_2`), which the build cannot apply.
 */
export function exportableDrift(rows: readonly DescriptionRow[]): DescriptionRow[] {
  return rows.filter(r => r.state === 'drift' && !!r.synced && r.placement !== 'unknown' && !r.firstPassId);
}

/** The note a new file starts with (the local editor writes the same one). */
export const NEW_FILE_NOTE =
  'Curated waypoint descriptions, keyed by the stable ids in data/waypoint-ids.json. Applied by scripts/build-trails.ts (overriding any description from the GPX/GeoJSON source) and uploadable to the comments API with scripts/upload-descriptions.ts. Main-route entries come first in km order; off-trail, alternate and side-trip entries follow by their position along the route.';

/**
 * `descriptions.json` with every exportable live edit written in: an existing
 * entry keeps its place and other fields, and a new one goes where the local
 * editor would put it (main route by km, then the rest). Every other entry is
 * left exactly as the file has it. Written as the committed files are
 * (two-space JSON, trailing newline), so a `git diff` after dropping it in
 * shows only the carried text.
 */
export function exportFileText(trailId: string, fileText: string | null, rows: readonly DescriptionRow[]): string {
  const file: CuratedFile = parseCuratedFile(fileText) ?? { trailId, note: NEW_FILE_NOTE, descriptions: [] };
  const order = new Map(rows.map((r, i) => [r.id, i]));
  for (const row of exportableDrift(rows)) {
    const text = row.synced!;
    const index = file.descriptions.findIndex(e => e.waypointId === row.id);
    if (index !== -1) {
      file.descriptions[index] = { ...file.descriptions[index], description: text };
      continue;
    }
    const mine = order.get(row.id)!;
    const at = file.descriptions.findIndex(e => (order.get(e.waypointId) ?? -1) > mine);
    const entry: CuratedEntry = { waypointId: row.id, name: row.name, description: text };
    file.descriptions.splice(at === -1 ? file.descriptions.length : at, 0, entry);
  }
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** The live edits as `descriptions.json` entries, to paste over (or beside) the file's. */
export function patchSnippet(rows: readonly DescriptionRow[]): string {
  const entries = exportableDrift(rows).map(r => ({ waypointId: r.id, name: r.name, description: r.synced! }));
  return JSON.stringify(entries, null, 2);
}

// ---------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------

function multiline(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, '<br>');
}

function placementText(row: DescriptionRow): string {
  const km = Number.isFinite(row.km) ? ` · km ${row.km.toFixed(1)}` : '';
  switch (row.placement) {
    case 'main':
      return `Main route${km}`;
    case 'variant':
      return `${row.variant ?? 'Variant'}${km}`;
    case 'off-trail':
      return `Off the route${km ? ` (near${km.slice(2)})` : ''}`;
    default:
      return 'Not in the trail data';
  }
}

function textCell(label: string, text: string | undefined, empty: string, cls = ''): string {
  const body = text ? `<p class="desc-text">${multiline(text)}</p>` : `<p class="desc-empty">${escapeHtml(empty)}</p>`;
  return `<div class="desc-cell${cls ? ` ${cls}` : ''}"><h4>${escapeHtml(label)}</h4>${body}</div>`;
}

/** "live edit" / "upload" for a synced row's heading; nothing when the API does not say. */
function sourceText(source: DescriptionSource | undefined): string {
  if (source === 'live') return 'live edit';
  return source === 'upload' ? 'upload' : '';
}

export interface RowOptions {
  canEdit: boolean;
  editing: boolean;
  draft?: string;
  /**
   * Set after a save was refused because the row changed since the page read
   * it: the row as the server has it now (null: no synced row any more).
   */
  conflict?: WaypointDescription | null;
  ctx: FileContext;
}

/** One waypoint: its texts side by side, its state, and the edit controls. */
export function rowHtml(row: DescriptionRow, opts: RowOptions): string {
  const id = escapeHtml(row.id);
  const stamp = [row.syncedAt?.slice(0, 10), sourceText(row.source)].filter(Boolean).join(', ');
  const syncedLabel = stamp ? `Synced (${stamp})` : 'Synced';
  const synced =
    row.synced === undefined
      ? textCell(syncedLabel, undefined, 'No synced row.')
      : row.synced === ''
        ? textCell(syncedLabel, undefined, 'Cleared: phones show the bundled text.', 'is-cleared')
        : textCell(syncedLabel, row.synced, '', syncedDiffersFromBundled(row) ? 'is-different' : '');
  const fileCell =
    row.file !== undefined && row.file !== row.bundled ? textCell('descriptions.json', row.file, '') : '';
  const editor = opts.editing ? editorHtml(row, opts.draft ?? shownText(row), opts.conflict) : '';
  const actions = opts.canEdit
    ? `<div class="admin-row-actions">${
        opts.editing
          ? ''
          : `<button type="button" class="community-btn" data-action="edit" data-id="${id}">Edit synced text</button>`
      }${
        row.synced
          ? `<button type="button" class="community-btn is-danger" data-action="clear" data-id="${id}">Clear synced text</button>`
          : ''
      }</div>`
    : '';
  const pass = passNote(row);
  const passBadge = row.firstPassId ? ' <span class="desc-badge desc-badge-pass">later pass</span>' : '';
  return `
    <article class="admin-row desc-row desc-state-${row.state}${row.state === 'drift' ? ' admin-row-attention' : ''}" data-row="${id}">
      <h3>${escapeHtml(row.name)} <span class="community-hint">(${escapeHtml(waypointTypeLabel(row.type))})</span>
        <span class="desc-badge desc-badge-${row.state}">${escapeHtml(stateLabel(row))}</span>${passBadge}</h3>
      <p class="community-hint">${escapeHtml(placementText(row))} · <code>${id}</code></p>
      <div class="desc-compare">
        ${textCell('Bundled (site and app data)', row.bundled, 'No bundled description.')}
        ${synced}
        ${fileCell}
      </div>
      <p class="desc-next community-hint">${escapeHtml(nextUploadText(row, opts.ctx))}</p>
      ${pass ? `<p class="desc-pass community-hint">${escapeHtml(pass)}</p>` : ''}
      ${editor}
      ${actions}
      <p class="import-error" data-error="${id}" hidden></p>
    </article>`;
}

/** The server's row, shown above a draft whose save it refused. */
function conflictHtml(current: WaypointDescription | null): string {
  const what =
    current === null
      ? '<p class="desc-empty">The synced row is gone.</p>'
      : current.description === ''
        ? '<p class="desc-empty">Cleared: phones show the bundled text.</p>'
        : `<p class="desc-text">${multiline(current.description)}</p>`;
  const when = current
    ? ` (${escapeHtml(
        [`saved ${current.updatedAt.slice(0, 16).replace('T', ' ')} UTC`, sourceText(current.source)]
          .filter(Boolean)
          .join(', ')
      )})`
    : '';
  return `
        <div class="desc-conflict" role="alert" data-conflict>
          <p><strong>Not saved: this synced text changed after this page read it.</strong> Your draft is kept in the box below. On the server now${when}:</p>
          ${what}
          <p>Save again to replace it with your draft, or Cancel to leave it as it is.</p>
        </div>`;
}

/** The edit box: the text, its count, the voice hints and Save / Cancel. */
export function editorHtml(
  row: Pick<DescriptionRow, 'id'>,
  draft: string,
  conflict?: WaypointDescription | null
): string {
  const id = escapeHtml(row.id);
  return `
      <div class="desc-editor" data-editor="${id}">${conflict === undefined ? '' : conflictHtml(conflict)}
        <label class="community-hint" for="desc-draft-${id}">New synced text (reaches every phone on its next sync)</label>
        <textarea class="community-input desc-draft" id="desc-draft-${id}" data-draft="${id}" rows="6">${escapeHtml(draft)}</textarea>
        <div class="desc-draft-status" data-status="${id}">${draftStatusHtml(checkDraft(draft))}</div>
        <div class="admin-row-actions">
          <button type="button" class="community-btn is-primary" data-action="save" data-id="${id}">Save synced text</button>
          <button type="button" class="community-btn" data-action="cancel" data-id="${id}">Cancel</button>
        </div>
      </div>`;
}

/** The count and hints under the edit box. */
export function draftStatusHtml(check: DraftCheck): string {
  const count = `<span class="${check.tooLong ? 'desc-too-long' : 'community-hint'}">${check.length} / ${MAX_DESCRIPTION_LENGTH}${
    check.tooLong ? ' — too long' : ''
  }</span>`;
  const hints = check.hints.length
    ? `<ul class="desc-hints">${check.hints
        .map(h => `<li><strong>${escapeHtml(h.match)}</strong>: ${escapeHtml(h.message)}</li>`)
        .join('')}</ul>`
    : '';
  return count + hints;
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/**
 * The summary over the list: counts, the drift warning (live edits to commit,
 * and what the uploads do to them on this trail) with the export, and the rows
 * that merely wait for an upload, which are never called drift.
 */
export function summaryHtml(rows: readonly DescriptionRow[], ctx: FileContext): string {
  const count = (s: SyncState): number => rows.filter(r => r.state === s).length;
  const edits = exportableDrift(rows).length;
  const clears = rows.filter(isLiveClear).length;
  const laterPass = rows.filter(r => r.state === 'drift' && !!r.synced && !!r.firstPassId).length;
  const lostIds = rows.filter(
    r => r.state === 'drift' && !!r.synced && r.placement === 'unknown' && !r.firstPassId
  ).length;
  const awaiting = count('awaiting');
  const unknown = count('unknown');
  const counts =
    `${rows.length} waypoints · ${count('in-sync')} in sync · ${count('drift')} drift · ${awaiting} awaiting upload · ` +
    `${count('pending')} not uploaded · ${count('cleared')} cleared${unknown ? ` · ${unknown} origin unknown` : ''}`;

  const notes: string[] = [];
  if (awaiting) {
    notes.push(
      ctx.hasFile
        ? `${awaiting} ${plural(awaiting, 'row waits', 'rows wait')} for an Upload descriptions run: descriptions.json is newer than the API there. That is not drift, there is nothing to commit, and the export leaves ${plural(awaiting, 'it', 'them')} out.`
        : `${awaiting} uploaded ${plural(awaiting, 'row is', 'rows are')} left from when this trail had a descriptions.json: no upload changes ${plural(awaiting, 'it', 'them')} now.`
    );
  }
  if (unknown) {
    notes.push(
      `${unknown} synced ${plural(unknown, 'row differs', 'rows differ')} from descriptions.json, and this API does not say whether a live edit or an upload wrote ${plural(unknown, 'it', 'them')} (its worker predates that marker), so ${plural(unknown, 'it is', 'they are')} neither counted as drift nor exported. A live edit saved now is not recognised as one later: commit it by hand.`
    );
  }
  const notesHtml = notes.map(n => `<p class="community-hint">${escapeHtml(n)}</p>`).join('');

  if (count('drift') === 0) {
    return `<p class="import-note">${escapeHtml(counts)}. No drift: no live edit is waiting to be committed.</p>${notesHtml}`;
  }

  const them = plural(edits, 'it', 'them');
  let headline = '';
  if (edits > 0 && ctx.upstream) {
    headline = `<p><strong>${edits} live ${plural(edits, 'edit', 'edits')} on this trail.</strong>
        Its descriptions are built upstream in ${escapeHtml(ctx.upstream)} and are not curated in this repository, so there is no descriptions.json to commit ${them} to: make the lasting fix there, and clear the synced text once a build carries it.
        No <em>Upload descriptions</em> run touches this trail, so ${plural(edits, 'it stays', 'they stay')} on phones until then.</p>`;
  } else if (edits > 0 && ctx.hasFile) {
    headline = `<p><strong>${edits} live ${plural(edits, 'edit is', 'edits are')} not in descriptions.json.</strong>
        The next <em>Upload descriptions</em> run (any merged change to any trail’s descriptions.json) overwrites ${them} with the file’s text.
        Commit ${them} to <code>${escapeHtml(ctx.path)}</code> first.</p>`;
  } else if (edits > 0) {
    headline = `<p><strong>${edits} live ${plural(edits, 'edit is', 'edits are')} held only by the API.</strong>
        This trail has no descriptions.json, so no <em>Upload descriptions</em> run touches it: ${plural(edits, 'it stays', 'they stay')} on phones until changed or cleared here.
        To keep ${them} in the repository, commit ${them} by creating <code>${escapeHtml(ctx.path)}</code> (the download below).
        Once that file exists, uploads make the API match it, and a live edit it lacks is overwritten.</p>`;
  }
  const extras: string[] = [];
  if (clears) {
    extras.push(
      `${clears} ${plural(clears, 'waypoint was', 'waypoints were')} cleared live while descriptions.json still lists ${plural(clears, 'it', 'them')}: the next upload re-sends the file’s text. If a description should go for good, delete its entry from the file.`
    );
  }
  if (laterPass) {
    extras.push(
      `${laterPass} live ${plural(laterPass, 'edit is', 'edits are')} on a later pass of a revisited place, which descriptions.json cannot hold: the export leaves ${plural(laterPass, 'it', 'them')} out. Make the lasting fix on the first pass.`
    );
  }
  if (lostIds) {
    extras.push(
      `${lostIds} live ${plural(lostIds, 'edit is', 'edits are')} on ${plural(lostIds, 'an id', 'ids')} this trail no longer has, which the export leaves out.`
    );
  }
  const exportable = edits > 0 && !ctx.upstream;
  const buttons = exportable
    ? `<div class="community-actions">
        <button type="button" class="community-btn is-primary" id="desc-download">Download ${
          ctx.hasFile ? 'updated' : 'a new'
        } descriptions.json</button>
        <button type="button" class="community-btn" id="desc-copy">Copy the changed entries</button>
      </div>`
    : '';
  return `
    <div class="desc-drift" role="status">
      ${headline}
      ${extras.map(e => `<p>${escapeHtml(e)}</p>`).join('')}
      <p class="community-hint">${escapeHtml(counts)}</p>
      ${notesHtml}
      ${buttons}
    </div>`;
}
