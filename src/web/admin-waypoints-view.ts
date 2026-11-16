/**
 * The waypoint editor's pure parts: filtering the list, reading a pasted
 * position, the description voice hints, review marks, and the list and
 * readout markup. No DOM or Leaflet here, so it is tested on its own
 * (`admin-waypoints-view.test.ts`); `admin-waypoints.ts` wires it to the page.
 */

import { haversineDistance } from '@lib/distance';
import { nameMatches } from '@lib/name-filter';
import { waypointTypeLabel } from '@lib/waypoint-taxonomy';
import type { EditorWaypoint, WaypointPlacement } from '../../scripts/lib/waypoint-editor/api-types';
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
}

export function draftOf(w: Pick<EditorWaypoint, 'name' | 'lat' | 'lon' | 'description'>): WaypointDraft {
  return { name: w.name, lat: w.lat, lon: w.lon, description: w.description };
}

const COORD_EPSILON = 1e-9;

/** Which fields a draft changes from the saved waypoint. */
export function draftChanges(
  saved: EditorWaypoint,
  draft: WaypointDraft
): { name: boolean; position: boolean; description: boolean } {
  return {
    name: draft.name.trim() !== saved.name,
    position: Math.abs(draft.lat - saved.lat) > COORD_EPSILON || Math.abs(draft.lon - saved.lon) > COORD_EPSILON,
    description: draft.description.trim() !== saved.description,
  };
}

export function isDirty(saved: EditorWaypoint, draft: WaypointDraft | undefined): boolean {
  if (!draft) return false;
  const c = draftChanges(saved, draft);
  return c.name || c.position || c.description;
}

/** Saved since the last build: its source no longer matches what the build drew. */
export function movedSinceBuild(w: EditorWaypoint): boolean {
  return Math.abs(w.lat - w.builtLat) > COORD_EPSILON || Math.abs(w.lon - w.builtLon) > COORD_EPSILON;
}

export function renamedSinceBuild(w: EditorWaypoint): boolean {
  return w.name !== w.builtName;
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

export type StatusFilter = 'all' | 'no-text' | 'has-text' | 'unreviewed' | 'reviewed' | 'changed' | 'off-route';

export const STATUS_FILTER_LABELS: Record<StatusFilter, string> = {
  all: 'All waypoints',
  'no-text': 'No curated text',
  'has-text': 'Has curated text',
  unreviewed: 'Not reviewed',
  reviewed: 'Reviewed',
  changed: 'Changed since build',
  'off-route': 'Off the route',
};

export interface WaypointFilter {
  query: string;
  /** '' for every type. */
  type: string;
  status: StatusFilter;
}

function isOffRoute(w: EditorWaypoint): boolean {
  return !w.placements.some(p => p.kind === 'main');
}

export function matchesFilter(w: EditorWaypoint, filter: WaypointFilter, marks: ReviewMarks): boolean {
  if (filter.type && w.type !== filter.type) return false;
  if (filter.query && !nameMatches(w.name, filter.query) && w.id !== filter.query.trim()) return false;
  switch (filter.status) {
    case 'no-text':
      return !w.description;
    case 'has-text':
      return !!w.description;
    case 'unreviewed':
      return !isReviewed(marks, w);
    case 'reviewed':
      return isReviewed(marks, w);
    case 'changed':
      return movedSinceBuild(w) || renamedSinceBuild(w);
    case 'off-route':
      return isOffRoute(w);
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

export function rowHtml(w: EditorWaypoint, state: { selected: boolean; dirty: boolean; reviewed: boolean }): string {
  const badges: string[] = [];
  if (state.dirty) badges.push('<span class="wpe-badge wpe-badge-dirty" title="Unsaved changes">unsaved</span>');
  if (movedSinceBuild(w) || renamedSinceBuild(w)) {
    badges.push('<span class="wpe-badge wpe-badge-changed" title="Saved; rebuild to see it in the data">saved</span>');
  }
  if (!w.description)
    badges.push('<span class="wpe-badge wpe-badge-empty" title="No curated description">no text</span>');
  const reviewed = state.reviewed ? '<span class="wpe-reviewed" title="Reviewed">✓</span>' : '';
  const off = w.placements.some(p => p.kind === 'main') ? '' : ' <span class="wpe-muted">off route</span>';
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
