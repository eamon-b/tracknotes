/**
 * The live description editor's pure parts (`admin-descriptions.html`): which
 * waypoints a trail has, how each one's three texts compare, the drift between
 * the synced set and `descriptions.json`, the export that carries the synced
 * text back into the file, and the row markup. No DOM here, so it is tested on
 * its own (`admin-descriptions-view.test.ts`); `admin-descriptions.ts` wires it
 * to the page.
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
 * Drift is synced text that is not the file's: the next upload replaces it with
 * the file's text (or withdraws it), so a live edit must be committed too.
 */

import type { WaypointDescription } from '@lib/comments-api-types';
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

// ---------------------------------------------------------------------------
// Rows: the three texts and how they compare
// ---------------------------------------------------------------------------

/**
 * - `in-sync`: the synced text is the file's.
 * - `drift`: live synced text the file does not have — the next upload replaces it.
 * - `cleared`: a cleared synced row; the phone shows the bundled text.
 * - `pending`: a file entry the API does not hold yet (the upload has not run).
 * - `bundled`: no curated text anywhere; the phone shows the GPX / CalTopo text, if any.
 */
export type SyncState = 'in-sync' | 'drift' | 'cleared' | 'pending' | 'bundled';

export interface DescriptionRow extends TrailWaypoint {
  /** Its `descriptions.json` text, when the file lists it. */
  file?: string;
  /** The synced row's text ('' = cleared), when the API has one. */
  synced?: string;
  syncedAt?: string;
  state: SyncState;
}

function stateOf(file: string | undefined, synced: string | undefined): SyncState {
  if (synced !== undefined && synced !== '') return synced === file ? 'in-sync' : 'drift';
  if (synced === '') return 'cleared';
  return file !== undefined ? 'pending' : 'bundled';
}

/**
 * Join the trail's waypoints, the file and the synced set. A synced row for an
 * id the trail no longer has is kept as an `unknown` row at the end, so drift
 * on it is not hidden.
 */
export function buildRows(
  waypoints: readonly TrailWaypoint[],
  file: CuratedFile | null,
  synced: readonly WaypointDescription[]
): DescriptionRow[] {
  const fileById = new Map((file?.descriptions ?? []).map(e => [e.waypointId, e.description.trim()]));
  const syncedById = new Map(synced.map(s => [s.waypointId, s]));
  const rows: DescriptionRow[] = waypoints.map(w => {
    const fileText = fileById.get(w.id);
    const live = syncedById.get(w.id);
    return {
      ...w,
      ...(fileText === undefined ? {} : { file: fileText }),
      ...(live === undefined ? {} : { synced: live.description, syncedAt: live.updatedAt }),
      state: stateOf(fileText, live?.description),
    };
  });
  const known = new Set(waypoints.map(w => w.id));
  for (const live of synced) {
    if (known.has(live.waypointId)) continue;
    const fileText = fileById.get(live.waypointId);
    rows.push({
      id: live.waypointId,
      name: '(not in this trail’s data)',
      type: 'waypoint',
      placement: 'unknown',
      km: Number.POSITIVE_INFINITY,
      bundled: '',
      ...(fileText === undefined ? {} : { file: fileText }),
      synced: live.description,
      syncedAt: live.updatedAt,
      state: stateOf(fileText, live.description),
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

export const STATE_LABELS: Record<SyncState, string> = {
  'in-sync': 'in sync',
  drift: 'drift',
  cleared: 'cleared',
  pending: 'not uploaded',
  bundled: 'bundled only',
};

/** What the next *Upload descriptions* run does to this row, in words. */
export function nextUploadText(row: DescriptionRow): string {
  switch (row.state) {
    case 'drift':
      return row.file !== undefined
        ? 'The next upload replaces this synced text with the descriptions.json text. Commit it to the file to keep it.'
        : 'The next upload withdraws this synced text (descriptions.json has no entry), and phones fall back to the bundled text. Commit it to the file to keep it.';
    case 'cleared':
      return row.file !== undefined
        ? 'Cleared live: phones show the bundled text, and the next upload re-sends the descriptions.json text.'
        : 'Cleared: phones show the bundled text.';
    case 'pending':
      return 'In descriptions.json but not on the API yet: the Upload descriptions run has not been approved.';
    case 'in-sync':
      return 'The synced text is the descriptions.json text.';
    default:
      return 'No curated text: phones show the bundled text.';
  }
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export type RowFilter = 'all' | 'drift' | 'synced' | 'differs' | 'curated' | 'none';

export const ROW_FILTER_LABELS: Record<RowFilter, string> = {
  all: 'All waypoints',
  drift: 'Drift (synced text not in descriptions.json)',
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
// Export: carry the drift back into descriptions.json
// ---------------------------------------------------------------------------

/** The rows an export carries into the file: drift on a waypoint the trail has. */
export function exportableDrift(rows: readonly DescriptionRow[]): DescriptionRow[] {
  return rows.filter(r => r.state === 'drift' && r.placement !== 'unknown');
}

/** The note a new file starts with (the local editor writes the same one). */
export const NEW_FILE_NOTE =
  'Curated waypoint descriptions, keyed by the stable ids in data/waypoint-ids.json. Applied by scripts/build-trails.ts (overriding any description from the GPX/GeoJSON source) and uploadable to the comments API with scripts/upload-descriptions.ts. Main-route entries come first in km order; off-trail, alternate and side-trip entries follow by their position along the route.';

/**
 * `descriptions.json` with every exportable drift row's synced text written
 * in: an existing entry keeps its place and other fields, and a new one goes
 * where the local editor would put it (main route by km, then the rest).
 * Written as the committed files are (two-space JSON, trailing newline), so a
 * `git diff` after dropping it in shows only the carried text.
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

/** The drift rows as `descriptions.json` entries, to paste over (or beside) the file's. */
export function patchSnippet(rows: readonly DescriptionRow[]): string {
  const entries = exportableDrift(rows).map(r => ({ waypointId: r.id, name: r.name, description: r.synced! }));
  return JSON.stringify(entries, null, 2);
}

/** Where the file lives in the repository. */
export function filePath(dir: string | null, trailId: string): string {
  return `data/trails/${dir ?? `<${trailId} directory>`}/descriptions.json`;
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

/** One waypoint: its texts side by side, its state, and the edit controls. */
export function rowHtml(row: DescriptionRow, opts: { canEdit: boolean; editing: boolean; draft?: string }): string {
  const id = escapeHtml(row.id);
  const syncedLabel = row.syncedAt ? `Synced (${row.syncedAt.slice(0, 10)})` : 'Synced';
  const synced =
    row.synced === undefined
      ? textCell(syncedLabel, undefined, 'No synced row.')
      : row.synced === ''
        ? textCell(syncedLabel, undefined, 'Cleared: phones show the bundled text.', 'is-cleared')
        : textCell(syncedLabel, row.synced, '', syncedDiffersFromBundled(row) ? 'is-different' : '');
  const fileCell =
    row.file !== undefined && row.file !== row.bundled ? textCell('descriptions.json', row.file, '') : '';
  const editor = opts.editing ? editorHtml(row, opts.draft ?? shownText(row)) : '';
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
  return `
    <article class="admin-row desc-row desc-state-${row.state}${row.state === 'drift' ? ' admin-row-attention' : ''}" data-row="${id}">
      <h3>${escapeHtml(row.name)} <span class="community-hint">(${escapeHtml(waypointTypeLabel(row.type))})</span>
        <span class="desc-badge desc-badge-${row.state}">${escapeHtml(STATE_LABELS[row.state])}</span></h3>
      <p class="community-hint">${escapeHtml(placementText(row))} · <code>${id}</code></p>
      <div class="desc-compare">
        ${textCell('Bundled (site and app data)', row.bundled, 'No bundled description.')}
        ${synced}
        ${fileCell}
      </div>
      <p class="desc-next community-hint">${escapeHtml(nextUploadText(row))}</p>
      ${editor}
      ${actions}
      <p class="import-error" data-error="${id}" hidden></p>
    </article>`;
}

/** The edit box: the text, its count, the voice hints and Save / Cancel. */
export function editorHtml(row: Pick<DescriptionRow, 'id'>, draft: string): string {
  const id = escapeHtml(row.id);
  return `
      <div class="desc-editor" data-editor="${id}">
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

/** The summary over the list: counts, and the drift warning with the export. */
export function summaryHtml(rows: readonly DescriptionRow[], path: string): string {
  const count = (s: SyncState): number => rows.filter(r => r.state === s).length;
  const drift = exportableDrift(rows).length;
  const unknownDrift = rows.filter(r => r.state === 'drift' && r.placement === 'unknown').length;
  const counts = `${rows.length} waypoints · ${count('in-sync')} in sync · ${count('drift')} drift · ${count(
    'pending'
  )} not uploaded · ${count('cleared')} cleared`;
  if (drift === 0 && unknownDrift === 0) {
    return `<p class="import-note">${escapeHtml(counts)}. No drift: every synced text is in descriptions.json.</p>`;
  }
  const unknown = unknownDrift
    ? ` ${unknownDrift} more ${unknownDrift === 1 ? 'is' : 'are'} on ids this trail no longer has, which the export leaves out.`
    : '';
  return `
    <div class="desc-drift" role="status">
      <p><strong>${drift} synced description${drift === 1 ? ' is' : 's are'} not in descriptions.json.</strong>
        The next <em>Upload descriptions</em> run (any merged change to a descriptions.json) overwrites ${
          drift === 1 ? 'it' : 'them'
        } with the file’s text.
        Commit ${drift === 1 ? 'it' : 'them'} to <code>${escapeHtml(path)}</code> first.${escapeHtml(unknown)}</p>
      <p class="community-hint">${escapeHtml(counts)}</p>
      <div class="community-actions">
        <button type="button" class="community-btn is-primary" id="desc-download"${drift ? '' : ' disabled'}>Download updated descriptions.json</button>
        <button type="button" class="community-btn" id="desc-copy"${drift ? '' : ' disabled'}>Copy the changed entries</button>
      </div>
    </div>`;
}
