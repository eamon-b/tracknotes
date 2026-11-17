/**
 * The waypoint editor's pure parts: filtering the list, reading a pasted
 * position, the description voice hints, review marks, and the list and
 * readout markup. No DOM or Leaflet here, so it is tested on its own
 * (`admin-waypoints-view.test.ts`); `admin-waypoints.ts` wires it to the page.
 */

import { haversineDistance } from '@lib/distance';
import { nameMatches } from '@lib/name-filter';
import { WAYPOINT_TYPES, waypointTypeLabel } from '@lib/waypoint-taxonomy';
import type { EditorWaypoint, WaypointPlacement } from '../../scripts/lib/waypoint-editor/api-types';
import { commentBadgeHtml } from './admin-waypoints-comments';
import { waypointFamilyClass, waypointIcon } from './trails/waypoint-icons';
import { escapeHtml } from './web-utils';

// ---------------------------------------------------------------------------
// Drafts: what the form holds for a waypoint before it is saved
// ---------------------------------------------------------------------------

export interface WaypointDraft {
  name: string;
  lat: number;
  lon: number;
  description: string;
  type: string;
}

export function draftOf(w: Pick<EditorWaypoint, 'name' | 'lat' | 'lon' | 'description' | 'type'>): WaypointDraft {
  return { name: w.name, lat: w.lat, lon: w.lon, description: w.description, type: w.type };
}

const COORD_EPSILON = 1e-9;

/** Which fields a draft changes from the saved waypoint. */
export function draftChanges(
  saved: EditorWaypoint,
  draft: WaypointDraft
): { name: boolean; position: boolean; description: boolean; type: boolean } {
  return {
    name: draft.name.trim() !== saved.name,
    position: Math.abs(draft.lat - saved.lat) > COORD_EPSILON || Math.abs(draft.lon - saved.lon) > COORD_EPSILON,
    description: draft.description.trim() !== saved.description,
    type: draft.type !== saved.type,
  };
}

export function isDirty(saved: EditorWaypoint, draft: WaypointDraft | undefined): boolean {
  if (!draft) return false;
  const c = draftChanges(saved, draft);
  return c.name || c.position || c.description || c.type;
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

/** Saved since the last build in any way, or added since it. */
export function changedSinceBuild(w: EditorWaypoint): boolean {
  return !!w.pending || !!w.deleted || movedSinceBuild(w) || renamedSinceBuild(w) || retypedSinceBuild(w);
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
  /** Said under the label when the text is not curated text; '' otherwise. */
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
      where:
        'No id yet, so this is not curated text: it is saved as the <desc> of its <wpt> in the GPX, source text the app shows as it stands. Once a rebuild gives it an id, text saved here goes to descriptions.json and outranks the <desc>.',
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

// ---------------------------------------------------------------------------
// Review marks (per browser)
// ---------------------------------------------------------------------------

/**
 * A short fingerprint of what was reviewed. A mark holds while the waypoint
 * still has this content, so an edit pulled from git (or made by anyone else)
 * puts it back in the unreviewed pile.
 */
export function reviewFingerprint(w: Pick<EditorWaypoint, 'name' | 'lat' | 'lon' | 'description'>): string {
  const text = `${w.name}|${w.lat.toFixed(6)}|${w.lon.toFixed(6)}|${w.description}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

export type ReviewMarks = Record<string, string>;

export function isReviewed(marks: ReviewMarks, w: EditorWaypoint): boolean {
  return marks[w.id] === reviewFingerprint(w);
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
  return !w.mergedInto && !w.placements.some(p => p.kind === 'main');
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
      return !hasCuratedText(w) && !w.mergedInto;
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
 * Google Maps link (`@-36.12,148.45,15z` or `?q=-36.12,148.45`), an OSM link
 * (`#map=17/-36.12/148.45` or `mlat=…&mlon=…`). Null when it is not one.
 */
export function parseLatLon(input: string): { lat: number; lon: number } | null {
  const text = input.trim();
  const patterns: RegExp[] = [
    /mlat=(-?\d+(?:\.\d+)?)&mlon=(-?\d+(?:\.\d+)?)/,
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

// ---------------------------------------------------------------------------
// Voice hints
// ---------------------------------------------------------------------------

export interface VoiceHint {
  /** The words that tripped it, as written. */
  match: string;
  message: string;
}

/**
 * Soft checks against the house voice (`scripts/lib/waypoint-descriptions.ts`):
 * descriptions state what is there and never instruct the walker or address
 * them as "you". Hints only; nothing is blocked.
 */
export function voiceHints(text: string): VoiceHint[] {
  const hints: VoiceHint[] = [];
  const seen = new Set<string>();
  const add = (match: string, message: string) => {
    const key = `${match.toLowerCase()}|${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    hints.push({ match, message });
  };
  for (const m of text.matchAll(/\b(you|your|you're|you'll|yourself|yours)\b/gi)) {
    add(m[0], 'Addresses the walker: describe the place instead.');
  }
  for (const m of text.matchAll(/\b(should|must|need to|needs to|be sure|make sure|recommended?|advisable)\b/gi)) {
    add(m[0], 'Tells the walker what to do: say what is there and let them decide.');
  }
  const imperative =
    /(?:^|[.!?]\s+)(Treat|Fill|Carry|Check|Bring|Ensure|Avoid|Remember|Plan|Consider|Allow|Expect|Take|Don't|Do not|Beware|Stock up|Top up|Head)\b/g;
  for (const m of text.matchAll(imperative)) {
    add(m[1], 'Starts an instruction: describe the facility or the water instead.');
  }
  if (/\s{2,}/.test(text.trim())) add('double space', 'Has a double space or a blank line.');
  if (text.trim() && !/[.!?)"”]$/.test(text.trim())) add('ending', 'Does not end with a full stop.');
  return hints;
}

// ---------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------

export function formatKm(km: number | undefined): string {
  return km === undefined || !Number.isFinite(km) ? '' : km.toFixed(1);
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

export function rowHtml(
  w: EditorWaypoint,
  state: { selected: boolean; dirty: boolean; reviewed: boolean; comments?: number }
): string {
  const badges: string[] = [];
  if (state.dirty) badges.push('<span class="wpe-badge wpe-badge-dirty" title="Unsaved changes">unsaved</span>');
  if (w.pending) {
    badges.push(
      '<span class="wpe-badge wpe-badge-pending" title="Added since the last build: no id until a rebuild, so edits go to its &lt;wpt&gt; in the GPX alone">pending rebuild</span>'
    );
  } else if (w.deleted) {
    badges.push(
      '<span class="wpe-badge wpe-badge-pending" title="Its &lt;wpt&gt; is gone: the next build retires its id">deleted</span>'
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
  if (!w.description && !w.pending && !w.deleted && !w.mergedInto)
    badges.push('<span class="wpe-badge wpe-badge-empty" title="No curated description">no text</span>');
  badges.push(commentBadgeHtml(state.comments));
  const reviewed = state.reviewed ? '<span class="wpe-reviewed" title="Reviewed">✓</span>' : '';
  const off = isOffRoute(w) ? ' <span class="wpe-muted">off route</span>' : '';
  return (
    `<li class="wpe-row${state.selected ? ' is-selected' : ''}" data-id="${escapeHtml(w.id)}" role="option" ` +
    `aria-selected="${state.selected}" tabindex="-1">` +
    `<span class="wpe-row-km">${escapeHtml(formatKm(w.sortKm))}</span>` +
    `<span class="wpe-row-glyph" title="${escapeHtml(waypointTypeLabel(w.type))}">${waypointGlyphHtml(w.type)}</span>` +
    `<span class="wpe-row-name">${escapeHtml(w.name)}${off}</span>` +
    `<span class="wpe-row-badges">${badges.join('')}${reviewed}</span>` +
    `</li>`
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

/** A dot's tooltip: name and type, and for a merged-away duplicate what it merged into. Escaped. */
export function dotTooltipHtml(w: EditorWaypoint): string {
  return (
    `${escapeHtml(w.name)} <span class="wpe-muted">${escapeHtml(waypointTypeLabel(w.type))}` +
    (w.mergedInto ? ` · merged into ${escapeHtml(w.mergedInto)}` : '') +
    `</span>`
  );
}

export interface PositionReadout {
  /** km along the main route at the nearest point. */
  km: number | null;
  /** Metres from the route. */
  offRouteM: number | null;
  /** Metres from the saved position. */
  movedM: number;
}

export function readoutText(r: PositionReadout): string {
  const parts: string[] = [];
  if (r.km !== null) parts.push(`nearest route km ${r.km.toFixed(2)}`);
  if (r.offRouteM !== null) parts.push(`${Math.round(r.offRouteM)} m from the route`);
  if (r.movedM >= 0.5) parts.push(`moved ${Math.round(r.movedM)} m from the saved position`);
  return parts.join(' · ');
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
