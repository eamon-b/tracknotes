/**
 * The local waypoint editor (`admin-waypoints.html`): review and correct a
 * bundled trail's waypoints — description, name, type and position, and add or
 * delete them — against a map
 * with satellite imagery and OpenStreetMap's POIs, and write the corrections
 * straight into the trail's source files through the dev server's
 * `/__waypoint-editor` API (`scripts/lib/waypoint-editor/`). Served only by
 * `npm run dev`; the deployed site has neither the page nor the API.
 *
 * Unsaved edits are kept per waypoint while browsing (the list marks them), so
 * a long review can hop between neighbours before saving. A draft holds only
 * the fields that were changed, so a field nobody touched follows the server
 * when the trail is read again. Review marks are per browser and lapse when
 * the waypoint's content changes.
 *
 * The form stays live while a save is in flight: a save captures what it needs
 * before it awaits, and its answer is applied to the waypoint it was for,
 * whatever is selected by then (`save`).
 */

import type * as Leaflet from 'leaflet';
import { haversineDistance } from '@lib/distance';
import { routeBreakStarts } from '@lib/route-breaks';
import { waypointFamily } from '@lib/waypoint-glyphs';
import { waypointTypeLabel } from '@lib/waypoint-taxonomy';
import type { ProcessedTrail } from '@lib/trail-types';
import {
  EDITOR_API_BASE,
  EDITOR_HEADER,
  type ChangedFile,
  type EditorTrail,
  type EditorTrailSummary,
  type EditorWaypoint,
  type NewWaypointRequest,
  type RebuildStatus,
  type WaypointDeleteResponse,
  type WaypointEditRequest,
  type WaypointEditResponse,
} from '../../scripts/lib/waypoint-editor/api-types';
import { adminRouteShapes } from './admin-route-map';
import { loadSession } from './api/session';
import {
  COMMENTS_PAGE_SIZE,
  ORPHAN_IDS_PAGE_SIZE,
  commentCounts,
  commentsCountText,
  commentsSectionHtml,
  commentsStatusText,
  loadTrailComments,
  orphanedCommentIds,
  parseShown,
  revealFor,
  type Reveal,
  type CommentsState,
} from './admin-waypoints-comments';
import {
  STATUS_FILTER_LABELS,
  colocatedCounts,
  colocatedMetaHtml,
  colocatedWith,
  compareWaypoints,
  deleteConfirmText,
  descriptionField,
  dotStyle,
  dotTooltipHtml,
  draftAfterSave,
  draftChanges,
  draftValues,
  editedCoordinate,
  externalMapLinks,
  formatDistance,
  hasCuratedText,
  isDirty,
  isReviewable,
  isReviewed,
  knownCommentIds,
  laterPassOf,
  markerTooltipHtml,
  matchesFilter,
  mergeCommentsNote,
  mergeMetaHtml,
  movedSinceBuild,
  nearbyPois,
  nearestLineSnap,
  nextColocatedId,
  parseCoordinate,
  parseLatLon,
  placementText,
  positionReadout,
  pruneDraft,
  reviewFingerprint,
  reviewStorageKey,
  retypedSinceBuild,
  routeLines,
  rowContentHtml,
  rowHtml,
  saveAffectsOtherRows,
  saveNotes,
  sharedSourceText,
  stepTarget,
  takesIdMetaHtml,
  typeCounts,
  typeOptionsHtml,
  typePrefixProblem,
  waypointGlyphHtml,
  type ReviewMarks,
  type RouteLine,
  type RowState,
  type StatusFilter,
  type WaypointDraft,
  type WaypointFields,
  type WaypointFilter,
} from './admin-waypoints-view';
import { voiceHints } from './description-voice';
import { loadLeaflet } from './landing-map';
import { themeColor } from './theme';
import { escapeHtml } from './web-utils';

type L = typeof Leaflet;

const TRAIL_KEY = 'tracknotes-waypoint-editor-trail';
const BASE_LAYER_KEY = 'tracknotes-waypoint-editor-base';

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
};

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage disabled: the editor still works, it just forgets
  }
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function api<T>(route: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const method = init?.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (method !== 'GET') {
    headers[EDITOR_HEADER] = '1';
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(`${EDITOR_API_BASE}${route}`, {
    method,
    headers,
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Vite answers an unknown route with its HTML page: the plugin is not mounted.
    throw new Error('The editor API did not answer. Open this page from `npm run dev`, not a built site.');
  }
  if (!response.ok) {
    const message = (data as { error?: string } | null)?.error ?? `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return data as T;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface MapState {
  L: L;
  map: Leaflet.Map;
  route: Leaflet.LayerGroup;
  dots: Leaflet.LayerGroup;
  pois: Leaflet.LayerGroup;
  guides: Leaflet.LayerGroup;
  dotById: Map<string, Leaflet.CircleMarker>;
  selected: Leaflet.Marker | null;
}

const state = {
  trails: [] as EditorTrailSummary[],
  trail: null as EditorTrail | null,
  byId: new Map<string, EditorWaypoint>(),
  selectedId: null as string | null,
  drafts: new Map<string, WaypointDraft>(),
  marks: {} as ReviewMarks,
  filter: { query: '', type: '', status: 'all' } as WaypointFilter,
  placing: false,
  /** "New waypoint" mode: undefined when off, null until the map is clicked, then where it goes. */
  adding: undefined as { lat: number; lon: number } | null | undefined,
  newMarker: null as Leaflet.Marker | null,
  saving: false,
  rebuilding: false,
  /** A trail read is in flight (a switch, or a reload of this one). */
  loading: false,
  /** The trail the page was last asked for: an answer for any other is stale. */
  trailWanted: null as string | null,
  map: null as MapState | null,
  /** The main route (cut at its breaks) and each variant's line, to measure and snap to. */
  lines: [] as RouteLine[],
  /** Lat or Lon was typed into and not yet committed (they commit on `change`, or before a shortcut acts). */
  positionTyped: false,
  /** The last draft Discard (or Esc) dropped, so it can be put back. */
  discarded: null as { trailId: string; id: string; draft: WaypointDraft; focusId: string } | null,
  /** Each drawn row's content, so an edit re-renders its one row only when it changed. */
  rowContent: new Map<string, string>(),
  /** Hikers' comments on the current trail (`admin-waypoints-comments.ts`), and their counts per id. */
  comments: { kind: 'loading' } as CommentsState,
  commentCounts: new Map<string, number>() as ReadonlyMap<string, number>,
};

function selected(): EditorWaypoint | null {
  return state.selectedId ? (state.byId.get(state.selectedId) ?? null) : null;
}

/** What the form shows for the selected waypoint: its saved fields with its draft over them. */
function currentValues(): WaypointFields | null {
  const w = selected();
  return w ? draftValues(w, state.drafts.get(w.id)) : null;
}

/** Lay `patch` over the waypoint's draft, keeping only the fields that then differ from the saved waypoint. */
function patchDraft(id: string, patch: WaypointDraft): void {
  const saved = state.byId.get(id);
  if (!saved) return;
  const next = pruneDraft(saved, { ...state.drafts.get(id), ...patch });
  if (next) state.drafts.set(id, next);
  else state.drafts.delete(id);
}

function isVisible(w: EditorWaypoint): boolean {
  return matchesFilter(w, state.filter, state.marks, state.commentCounts);
}

function visibleWaypoints(): EditorWaypoint[] {
  return (state.trail?.waypoints ?? []).filter(isVisible);
}

function anyUnsaved(): boolean {
  return !!state.trail?.waypoints.some(w => isDirty(w, state.drafts.get(w.id)));
}

function loadMarks(trailId: string): ReviewMarks {
  try {
    const parsed: unknown = JSON.parse(storageGet(reviewStorageKey(trailId)) ?? '{}');
    return parsed && typeof parsed === 'object' ? (parsed as ReviewMarks) : {};
  } catch {
    return {};
  }
}

function saveMarks(): void {
  if (state.trail) storageSet(reviewStorageKey(state.trail.id), JSON.stringify(state.marks));
}

function setReviewed(w: EditorWaypoint, reviewed: boolean): void {
  // No mark is kept for a pending waypoint (a temporary key) or one the last build does not list (locked).
  if (!isReviewable(w)) return;
  if (reviewed) state.marks[w.id] = reviewFingerprint(w);
  else delete state.marks[w.id];
  saveMarks();
}

// ---------------------------------------------------------------------------
// Banner and notes
// ---------------------------------------------------------------------------

function banner(message: string | null): void {
  const el = $('wpe-banner');
  el.hidden = !message;
  el.textContent = message ?? '';
}

function showNotes(notes: string[], error = false): void {
  $('wpe-notes').innerHTML = notes.map(n => `<li${error ? ' class="is-error"' : ''}>${escapeHtml(n)}</li>`).join('');
}

/** Notes under the form when a waypoint is selected; in the banner when none is, since the form is then hidden. */
function report(notes: string[], error = false): void {
  if (selected() && state.adding === undefined) showNotes(notes, error);
  else banner(notes.join(' '));
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

function renderFilters(): void {
  const trail = state.trail;
  const typeSelect = $<HTMLSelectElement>('wpe-type');
  const types = trail ? typeCounts(trail.waypoints) : [];
  typeSelect.innerHTML =
    `<option value="">All types</option>` +
    types
      .map(t => `<option value="${escapeHtml(t.type)}">${escapeHtml(waypointTypeLabel(t.type))} (${t.count})</option>`)
      .join('');
  if (!types.some(t => t.type === state.filter.type)) state.filter.type = '';
  typeSelect.value = state.filter.type;
  const statusSelect = $<HTMLSelectElement>('wpe-status');
  statusSelect.innerHTML = (Object.keys(STATUS_FILTER_LABELS) as StatusFilter[])
    .map(s => `<option value="${s}">${escapeHtml(STATUS_FILTER_LABELS[s])}</option>`)
    .join('');
  statusSelect.value = state.filter.status;
}

function rowState(w: EditorWaypoint): RowState {
  return {
    selected: w.id === state.selectedId,
    dirty: isDirty(w, state.drafts.get(w.id)),
    reviewed: isReviewed(state.marks, w),
    comments: state.commentCounts.get(w.id),
  };
}

function renderList(): void {
  const list = $('wpe-list');
  const scroll = list.scrollTop;
  const rows = visibleWaypoints();
  state.rowContent.clear();
  list.innerHTML = rows
    .map(w => {
      const row = rowState(w);
      state.rowContent.set(w.id, rowContentHtml(w, row));
      return rowHtml(w, row);
    })
    .join('');
  list.scrollTop = scroll;
  const total = state.trail?.waypoints.length ?? 0;
  $('wpe-list-count').textContent =
    rows.length === total ? `${total} waypoints` : `${rows.length} of ${total} waypoints`;
  renderProgress();
}

/**
 * Re-render one row where it stands, after an edit to its draft (which never
 * changes which rows the filter shows). The `<li>` itself stays: a field that
 * commits on blur does so between a click's mousedown and mouseup, and a list
 * rebuilt in between would swallow the click.
 */
function updateRow(id: string): void {
  const w = state.byId.get(id);
  const li = [...$('wpe-list').querySelectorAll<HTMLElement>('.wpe-row')].find(row => row.dataset.id === id);
  if (w && li) {
    const row = rowState(w);
    const html = rowContentHtml(w, row);
    if (state.rowContent.get(id) !== html) {
      li.innerHTML = html;
      state.rowContent.set(id, html);
    }
    li.classList.toggle('is-selected', row.selected);
    li.setAttribute('aria-selected', String(row.selected));
  }
  renderProgress();
}

function scrollSelectedIntoView(): void {
  const row = $('wpe-list').querySelector<HTMLElement>('.wpe-row.is-selected');
  row?.scrollIntoView({ block: 'nearest' });
}

function renderProgress(): void {
  const trail = state.trail;
  const el = $('wpe-progress');
  if (!trail) {
    el.textContent = '';
    return;
  }
  // Of the rows a mark can be kept for: a pending waypoint and one the last build does not list take none.
  const reviewable = trail.waypoints.filter(isReviewable);
  const total = reviewable.length;
  const reviewed = reviewable.filter(w => isReviewed(state.marks, w)).length;
  const described = trail.waypoints.filter(hasCuratedText).length;
  const unsaved = trail.waypoints.filter(w => isDirty(w, state.drafts.get(w.id))).length;
  el.innerHTML =
    `<progress max="${total}" value="${reviewed}"></progress>` +
    `<span>${reviewed}/${total} reviewed · ${described} with curated text` +
    (unsaved ? ` · <strong>${unsaved} unsaved</strong>` : '') +
    `</span>`;
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

function familyColor(type: string): string {
  return themeColor(`--wp-${waypointFamily(type)}`, '#5A6B64');
}

/** The one map, made on first use: asked for again while Leaflet is still loading, it is the same one. */
let mapLoading: Promise<MapState> | null = null;

function ensureMap(): Promise<MapState> {
  mapLoading ??= createMap().catch((error: unknown) => {
    mapLoading = null; // let the next trail read try again
    throw error;
  });
  return mapLoading;
}

async function createMap(): Promise<MapState> {
  const Lf = await loadLeaflet();
  const map = Lf.map($('wpe-map'), { zoomControl: true });
  const bases: Record<string, Leaflet.TileLayer> = {
    Topo: Lf.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 17,
      attribution: 'Map data: &copy; OpenStreetMap contributors, SRTM | Map style: &copy; OpenTopoMap',
    }),
    Satellite: Lf.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      {
        maxZoom: 19,
        attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community',
      }
    ),
    OpenStreetMap: Lf.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }),
  };
  const remembered = storageGet(BASE_LAYER_KEY);
  (bases[remembered ?? ''] ?? bases.Topo).addTo(map);
  map.on('baselayerchange', (e: Leaflet.LayersControlEvent) => storageSet(BASE_LAYER_KEY, e.name));
  const route = Lf.layerGroup().addTo(map);
  const pois = Lf.layerGroup();
  const dots = Lf.layerGroup().addTo(map);
  const guides = Lf.layerGroup().addTo(map);
  Lf.control.layers(bases, { 'OSM POIs': pois }, { position: 'topright' }).addTo(map);
  Lf.control.scale({ metric: true, imperial: false }).addTo(map);
  map.on('click', (e: Leaflet.LeafletMouseEvent) => {
    if (state.adding !== undefined) {
      placeNew(e.latlng.lat, e.latlng.lng);
      return;
    }
    if (!state.placing) return;
    setPlacing(false);
    moveDraftTo(e.latlng.lat, e.latlng.lng);
  });
  state.map = { L: Lf, map, route, dots, pois, guides, dotById: new Map(), selected: null };
  return state.map;
}

/** Draw the route, the waypoints and the POIs. `fit` zooms to the whole trail: only when another trail was opened. */
function drawTrail(fit: boolean): void {
  const m = state.map;
  const trail = state.trail;
  if (!m) return;
  const { L: Lf } = m;
  m.route.clearLayers();
  m.dots.clearLayers();
  m.pois.clearLayers();
  m.dotById.clear();
  // No trail (the one asked for could not be read): the map is left empty, not showing the last one.
  if (!trail) return;

  // adminRouteShapes cuts the main line at track.breaks and draws variants.
  const shapes = adminRouteShapes({
    track: { displayPoints: trail.track.points, points: trail.track.points, breaks: trail.track.breaks },
    alternates: trail.track.variants.map(v => ({ ...v, points: v.line.map(([lat, lon]) => ({ lat, lon })) })),
    sideTrips: [],
    waypoints: [],
    offTrailWaypoints: [],
  } as unknown as ProcessedTrail);
  const routeColor = themeColor('--primary', '#2D6A4F');
  const variantColor = themeColor('--select', '#3b82f6');
  for (const v of shapes.variants) {
    Lf.polyline(v.line, { color: variantColor, weight: 3, opacity: 0.8, dashArray: '4 6' })
      .bindTooltip(escapeHtml(v.name), { sticky: true })
      .addTo(m.route);
  }
  if (shapes.main.length) Lf.polyline(shapes.main, { color: routeColor, weight: 4, opacity: 0.85 }).addTo(m.route);
  for (const b of shapes.breaks) {
    Lf.polyline([b.from, b.to], { color: '#9e9e9e', weight: 2, dashArray: '6 6' }).addTo(m.route);
  }

  // Waypoints on one position are one dot under another: each says how many lie under it.
  const sharing = colocatedCounts(trail.waypoints);
  for (const w of trail.waypoints) addDot(m, w, sharing.get(w.id));

  for (const p of trail.pois) {
    Lf.circleMarker([p.lat, p.lon], { radius: 4, color: '#555', weight: 1, fillColor: '#ffd166', fillOpacity: 0.9 })
      .bindTooltip(`${escapeHtml(p.name || '(unnamed)')} <span class="wpe-muted">${escapeHtml(p.category)}</span>`)
      .on('click', () => {
        if (state.adding !== undefined) placeNew(p.lat, p.lon);
        else if (state.placing) {
          setPlacing(false);
          moveDraftTo(p.lat, p.lon);
        }
      })
      .addTo(m.pois);
  }

  const bounds = shapes.main.flat();
  if (fit && bounds.length) m.map.fitBounds(Lf.latLngBounds(bounds), { padding: [20, 20] });
}

/**
 * One waypoint's dot on the map, kept under its id (a pending waypoint's key)
 * in `dotById`. `sharing` is how many other waypoints stand on its position:
 * a click reaches the top dot alone, and the selected marker steps on from there.
 */
function addDot(m: MapState, w: EditorWaypoint, sharing = 0): void {
  const dot = m.L.circleMarker([w.lat, w.lon], dotStyle(w, familyColor(w.type)))
    .bindTooltip(dotTooltipHtml(w, sharing), { direction: 'top', offset: [0, -6] })
    .on('click', () => {
      if (state.placing || state.adding !== undefined) return;
      select(w.id, { pan: false });
    })
    .addTo(m.dots);
  m.dotById.set(w.id, dot);
}

function drawSelection(pan: boolean): void {
  const m = state.map;
  const w = selected();
  const draft = currentValues();
  if (!m) return;
  const { L: Lf } = m;
  m.guides.clearLayers();
  if (m.selected) {
    m.selected.remove();
    m.selected = null;
  }
  for (const [id, dot] of m.dotById) dot.setStyle({ opacity: id === w?.id ? 0 : 1, fillOpacity: id === w?.id ? 0 : 1 });
  if (!w || !draft) return;

  // Where the last build drew it, and where it is saved, when the draft has moved on.
  if (movedSinceBuild(w)) {
    Lf.polyline(
      [
        [w.builtLat, w.builtLon],
        [w.lat, w.lon],
      ],
      { color: '#888', weight: 2, dashArray: '3 5' }
    ).addTo(m.guides);
    Lf.circleMarker([w.builtLat, w.builtLon], { radius: 5, color: '#888', weight: 2, fillOpacity: 0 })
      .bindTooltip('Position in the last build')
      .addTo(m.guides);
  }
  // A merge the build made: a line from a merged-away duplicate to the waypoint it merged into, and back.
  const mergeColor = themeColor('--tint-warn-text', '#8a5a00');
  for (const id of w.mergedInto ? [w.mergedInto] : (w.mergedIds ?? [])) {
    const other = state.byId.get(id);
    if (!other || other.deleted || w.deleted) continue;
    Lf.polyline(
      [
        [w.lat, w.lon],
        [other.lat, other.lon],
      ],
      { color: mergeColor, weight: 2, dashArray: '1 5' }
    )
      .bindTooltip(
        w.mergedInto
          ? `Merged into ${escapeHtml(other.name)} (${escapeHtml(other.id)})`
          : `${escapeHtml(other.id)} merged into this`,
        { sticky: true }
      )
      .addTo(m.guides);
  }
  if (draftChanges(w, state.drafts.get(w.id)).position) {
    Lf.polyline(
      [
        [w.lat, w.lon],
        [draft.lat, draft.lon],
      ],
      { color: themeColor('--select', '#3b82f6'), weight: 2, dashArray: '3 5' }
    ).addTo(m.guides);
    Lf.circleMarker([w.lat, w.lon], { radius: 5, color: themeColor('--select', '#3b82f6'), weight: 2, fillOpacity: 0 })
      .bindTooltip('Saved position')
      .addTo(m.guides);
  }

  const marker = Lf.marker([draft.lat, draft.lon], {
    draggable: w.canMove,
    autoPan: true,
    zIndexOffset: 1000,
    keyboard: false,
    icon: Lf.divIcon({
      className: '',
      html: `<div class="wpe-marker" style="border-color:${familyColor(w.type)}">${waypointGlyphHtml(w.type)}</div>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13],
    }),
  }).addTo(m.map);
  const waypoints = state.trail?.waypoints ?? [];
  marker.bindTooltip(markerTooltipHtml(draft.name, w, waypoints), { direction: 'top', offset: [0, -14] });
  // The marker covers every dot on its position, so a click on it goes to the
  // next waypoint that shares the position (Leaflet fires no click after a drag).
  marker.on('click', () => {
    if (state.placing || state.adding !== undefined) return;
    const next = nextColocatedId(w, waypoints);
    if (next && !draftChanges(w, state.drafts.get(w.id)).position && commitPendingFields())
      select(next, { pan: false });
  });
  marker.on('drag', () => {
    const at = marker.getLatLng();
    updatePositionFields(at.lat, at.lng);
    renderReadout(at.lat, at.lng);
  });
  marker.on('dragend', () => {
    const at = marker.getLatLng();
    moveDraftTo(at.lat, at.lng);
  });
  m.selected = marker;

  if (pan) {
    const at = Lf.latLng(draft.lat, draft.lon);
    if (m.map.getZoom() < 14) m.map.setView(at, 15);
    else if (!m.map.getBounds().pad(-0.15).contains(at)) m.map.panTo(at);
  }
}

function setPlacing(on: boolean): void {
  const w = selected();
  state.placing = on && !!w?.canMove;
  $('wpe-place').setAttribute('aria-pressed', String(state.placing));
  $('wpe-map').classList.toggle('is-placing', state.placing);
}

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

function round6(value: number): number {
  return Number(value.toFixed(6));
}

/** Mark a position field as not holding a position (or clear the mark). */
function flagField(input: HTMLInputElement, invalid: boolean): void {
  if (invalid) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
}

/** Write a position into Lat and Lon, as the draft or a drag has it: nothing typed is pending after that. */
function updatePositionFields(lat: number, lon: number): void {
  const latInput = $<HTMLInputElement>('wpe-lat');
  const lonInput = $<HTMLInputElement>('wpe-lon');
  latInput.value = round6(lat).toString();
  lonInput.value = round6(lon).toString();
  flagField(latInput, false);
  flagField(lonInput, false);
  $('wpe-pos-error').textContent = '';
  state.positionTyped = false;
}

/** The draft's position changed: redraw what follows it. */
function afterMove(id: string, pan: boolean): void {
  fillPosition();
  drawSelection(pan);
  renderButtons();
  updateRow(id);
}

function moveDraftTo(lat: number, lon: number, pan = false): void {
  const w = selected();
  if (!w || !w.canMove) return;
  // At six decimals, as the form shows it; the saved position itself where that is what it comes to.
  patchDraft(w.id, { lat: editedCoordinate(lat, w.lat), lon: editedCoordinate(lon, w.lon) });
  afterMove(w.id, pan);
}

/**
 * Read Lat and Lon as typed and move the draft there. An empty or unparsable
 * field is flagged and moves nothing (`Number('')` is 0, which is a place).
 * False when the fields do not hold a position.
 */
function commitPosition(): boolean {
  const w = selected();
  if (!w || !w.canMove) return true;
  const latInput = $<HTMLInputElement>('wpe-lat');
  const lonInput = $<HTMLInputElement>('wpe-lon');
  const lat = parseCoordinate(latInput.value, 90);
  const lon = parseCoordinate(lonInput.value, 180);
  flagField(latInput, lat === null);
  flagField(lonInput, lon === null);
  if (lat === null || lon === null) {
    $('wpe-pos-error').textContent =
      [
        lat === null ? 'Lat must be a number from -90 to 90' : '',
        lon === null ? 'Lon must be a number from -180 to 180' : '',
      ]
        .filter(Boolean)
        .join('; ') + ': the waypoint has not moved. Esc in the field puts the position back.';
    renderButtons();
    return false;
  }
  moveDraftTo(lat, lon, true);
  return true;
}

/** Whether Lat or Lon is flagged as not holding a position. */
function positionInvalid(): boolean {
  return ['wpe-lat', 'wpe-lon'].some(id => $(id).getAttribute('aria-invalid') === 'true');
}

/**
 * Move the draft to what the paste box holds. Called on a paste, on Enter and
 * when the box loses focus, never on each keystroke: a position typed by hand
 * parses as one from the first digit of its longitude.
 */
function applyPaste(text?: string): boolean {
  const input = $<HTMLInputElement>('wpe-paste');
  const value = text ?? input.value;
  if (!value.trim()) {
    flagField(input, false);
    return true;
  }
  const at = parseLatLon(value);
  flagField(input, !at);
  if (!at) return false;
  input.value = '';
  moveDraftTo(at.lat, at.lon, true);
  return true;
}

/**
 * Commit what is typed but not yet committed (Lat and Lon commit on `change`,
 * the paste box on Enter or blur), so a shortcut pressed with focus still in
 * the field acts on what the form shows. False, with the reason under the
 * form, when a field does not hold a position: the shortcut must then not act.
 */
function commitPendingFields(): boolean {
  const w = selected();
  if (!w || !w.canMove || state.adding !== undefined) return true;
  let ok = applyPaste();
  if (state.positionTyped || positionInvalid()) ok = commitPosition() && ok;
  if (!ok) {
    showNotes(['The position fields do not hold a latitude and longitude. Correct them, or press Esc there.'], true);
  }
  return ok;
}

function renderReadout(lat: number, lon: number): void {
  const w = selected();
  $('wpe-readout').textContent =
    w && state.trail ? positionReadout(state.lines, lat, lon, haversineDistance(w.lat, w.lon, lat, lon)) : '';
}

/** The `<ele>` the waypoint's `<wpt>` has in the GPX, and what a pending move does to it. */
function renderSourceElevation(): void {
  const w = selected();
  const line = $('wpe-ele');
  line.hidden = w?.ele === undefined;
  if (!w || w.ele === undefined) return;
  line.textContent = `GPX <ele>: ${w.ele} m${
    draftChanges(w, state.drafts.get(w.id)).position ? '; saving the move looks it up again for the new position' : ''
  }`;
}

/** The position block from the draft. `keepTyping` leaves Lat and Lon alone while something typed there is uncommitted. */
function fillPosition(keepTyping = false): void {
  const draft = currentValues();
  if (!draft) return;
  if (!(keepTyping && state.positionTyped)) updatePositionFields(draft.lat, draft.lon);
  renderReadout(draft.lat, draft.lon);
  renderSourceElevation();
  $('wpe-links').innerHTML = externalMapLinks(draft.lat, draft.lon)
    .map(l => `<a href="${escapeHtml(l.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(l.label)}</a>`)
    .join('');
  renderNearby();
}

function renderNearby(): void {
  const draft = currentValues();
  const trail = state.trail;
  const w = selected();
  const list = $('wpe-nearby-list');
  if (!draft || !trail || !w) return;
  const near = nearbyPois(trail.pois, draft);
  list.innerHTML = near.length
    ? near
        .map(
          p =>
            `<li><span>${escapeHtml(p.name || '(unnamed)')} <span class="wpe-muted">${escapeHtml(p.category)} · ${Math.round(p.distanceM)} m</span></span>` +
            (w.canMove
              ? `<button type="button" class="wpe-btn wpe-btn-small" data-poi-move="${escapeHtml(p.id)}">Move here</button>`
              : '') +
            `<a class="wpe-btn wpe-btn-small" href="https://www.openstreetmap.org/${escapeHtml(p.id)}" target="_blank" rel="noopener noreferrer">OSM</a></li>`
        )
        .join('')
    : '<li class="wpe-muted">No OpenStreetMap POIs within 400 m.</li>';
}

function renderDescriptionAids(): void {
  const text = $<HTMLTextAreaElement>('wpe-desc').value;
  const max = state.trail?.maxDescriptionLength ?? 4000;
  const count = $('wpe-desc-count');
  // A box that cannot be edited here (a later pass shows the place's text, a
  // locked row its own) takes no limit and no hints: there is nothing to act on.
  const editable = !!selected()?.canDescribe;
  count.textContent = editable ? `${text.trim().length} / ${max}` : '';
  count.classList.toggle('is-over', editable && text.trim().length > max);
  $('wpe-hints').innerHTML = editable
    ? voiceHints(text)
        .map(h => `<li><strong>${escapeHtml(h.match)}</strong>: ${escapeHtml(h.message)}</li>`)
        .join('')
    : '';
}

function renderButtons(): void {
  const w = selected();
  const dirty = w ? isDirty(w, state.drafts.get(w.id)) : false;
  const busy = state.saving || state.rebuilding;
  const moved = !!w && draftChanges(w, state.drafts.get(w.id)).position;
  // A typed position counts before it is committed: a click on Save commits it on the way (blur, then `save`).
  $<HTMLButtonElement>('wpe-save').disabled = !(dirty || state.positionTyped) || busy;
  $<HTMLButtonElement>('wpe-save-next').disabled = busy;
  $<HTMLButtonElement>('wpe-save-next').textContent = dirty ? 'Save & next' : 'Next';
  $<HTMLButtonElement>('wpe-revert').disabled = !dirty;
  const del = $<HTMLButtonElement>('wpe-delete');
  del.disabled = !w?.canDelete || busy;
  const place = w && !w.canDelete && !w.pending ? laterPassOf(w.id) : null;
  del.title = place ? `A later pass of a revisited place: delete the first pass, ${place}` : '';
  $<HTMLButtonElement>('wpe-new').disabled = !state.trail || !!state.trail.readOnlyReason || busy;
  // Also on while a typed position is uncommitted or flagged: it puts the fields back.
  $<HTMLButtonElement>('wpe-reset-pos').disabled = !(moved || state.positionTyped || (!!w && positionInvalid()));
  $<HTMLButtonElement>('wpe-snap').disabled = !w?.canMove;
  $<HTMLButtonElement>('wpe-place').disabled = !w?.canMove;
  $<HTMLButtonElement>('wpe-rebuild').disabled = busy;
  const reload = $<HTMLButtonElement>('wpe-reload');
  // Also on when the trail asked for could not be read (a GPX the build cannot read): it asks again.
  reload.disabled = !(state.trail || state.trailWanted) || busy || state.loading;
  reload.textContent = state.loading && state.trail ? 'Reloading…' : 'Reload trail';
}

/**
 * Write `value` into a text field. With `keepTyping` (a re-render of the form
 * for the waypoint it already shows, after a save or a reload) a field that
 * already says the same thing is left as typed, caret and trailing space included.
 */
function setText(input: HTMLInputElement | HTMLTextAreaElement, value: string, keepTyping: boolean): void {
  if (keepTyping && input.value.trim() === value.trim()) return;
  if (input.value !== value) input.value = value;
}

function fillForm(options: { keepTyping?: boolean } = {}): void {
  const keepTyping = options.keepTyping ?? false;
  const w = selected();
  const draft = currentValues();
  $('wpe-empty').hidden = !!w;
  $('wpe-form').hidden = !w;
  if (!w || !draft) return;

  const locked = $('wpe-locked');
  locked.hidden = !w.lockedReason;
  locked.textContent = w.lockedReason ?? '';

  const name = $<HTMLInputElement>('wpe-name');
  setText(name, draft.name, keepTyping);
  name.disabled = !w.canRename;
  const typeSelect = $<HTMLSelectElement>('wpe-type-select');
  typeSelect.innerHTML = typeOptionsHtml(w.type);
  typeSelect.value = draft.type;
  typeSelect.disabled = !w.canChangeType;
  $('wpe-type-source').textContent = w.typeSource
    ? `Typed by ${w.typeSource}${retypedSinceBuild(w) ? ` (${waypointTypeLabel(w.builtType)} in the last build)` : ''}.`
    : '';
  $<HTMLInputElement>('wpe-lat').disabled = !w.canMove;
  $<HTMLInputElement>('wpe-lon').disabled = !w.canMove;
  const paste = $<HTMLInputElement>('wpe-paste');
  paste.disabled = !w.canMove;
  if (!keepTyping) {
    paste.value = '';
    flagField(paste, false);
  }
  const desc = $<HTMLTextAreaElement>('wpe-desc');
  const field = descriptionField(w);
  setText(desc, draft.description, keepTyping);
  desc.disabled = !w.canDescribe;
  desc.placeholder = field.placeholder;
  $('wpe-desc-label').textContent = field.label;
  $('wpe-desc-where').hidden = !field.where;
  $('wpe-desc-where').textContent = field.where;
  $('wpe-source-summary').textContent = field.sourceSummary;

  const meta: string[] = [
    `<span>${waypointGlyphHtml(w.type)} ${escapeHtml(waypointTypeLabel(w.type))} · ${w.pending ? '<em>no id until the next build</em>' : `<code>${escapeHtml(w.id)}</code>`}</span>`,
    ...w.placements.map(p => `<span>${escapeHtml(placementText(p))}</span>`),
  ];
  if (w.pending && !w.placements.length) {
    meta.push('<span>Its place on the route (main route, a variant, or off it) comes from the next build</span>');
  }
  const takes = takesIdMetaHtml(w, state.byId);
  if (takes) meta.push(takes);
  if (w.notBuilt) {
    meta.push(
      '<span>Not in the last build on this machine: its km and its place on the route come from a rebuild</span>'
    );
  }
  if (w.distanceFromTrailM !== undefined) {
    meta.push(`<span>${escapeHtml(formatDistance(w.distanceFromTrailM))} from the main route in the last build</span>`);
  }
  if (w.access) {
    meta.push(
      `<span>access.json: ${escapeHtml([w.access.method, w.access.store && `store ${w.access.store}`].filter(Boolean).join(', '))}</span>`
    );
  }
  const shared = sharedSourceText(w);
  if (shared) meta.push(`<span>${escapeHtml(shared)}</span>`);
  const colocated = colocatedMetaHtml(w, state.trail?.waypoints ?? []);
  if (colocated) meta.push(colocated);
  const merge = mergeMetaHtml(w, state.byId);
  if (merge) meta.push(merge);
  $('wpe-meta').innerHTML = meta.join('');

  const source = $<HTMLDetailsElement>('wpe-source');
  source.hidden = !w.sourceDescription;
  $('wpe-source-text').textContent = w.sourceDescription ?? '';
  source.open = !hasCuratedText(w) && !!w.sourceDescription;
  $('wpe-use-source').hidden = !w.canDescribe;

  $<HTMLInputElement>('wpe-reviewed').checked = isReviewed(state.marks, w);
  $<HTMLInputElement>('wpe-reviewed').disabled = !isReviewable(w);
  fillPosition(keepTyping);
  renderDescriptionAids();
  renderButtons();
  renderComments();
}

/**
 * Re-render everything about the selection where it stands, after the data
 * under it changed (a save's answer, the trail read again): the notes, the map
 * view and what is being typed are left alone.
 */
function refreshSelection(): void {
  if (state.adding === undefined) fillForm({ keepTyping: true });
  drawSelection(false);
  renderList();
  syncUrl();
}

function select(id: string | null, options: { pan?: boolean } = {}): void {
  setPlacing(false);
  endAdding();
  state.selectedId = id && state.byId.has(id) ? id : null;
  state.positionTyped = false;
  showNotes([]);
  fillForm();
  drawSelection(options.pan ?? true);
  renderList();
  scrollSelectedIntoView();
  syncUrl();
}

/** Keep `?trail=&id=` on the selection, so the address links to it. */
function syncUrl(): void {
  const url = new URL(location.href);
  if (state.trail) url.searchParams.set('trail', state.trail.dir);
  if (state.selectedId) url.searchParams.set('id', state.selectedId);
  else url.searchParams.delete('id');
  history.replaceState(null, '', url);
}

/** Go to the next or previous row of the filtered list, from the selection's place in the whole list. */
function step(delta: 1 | -1): void {
  if (!state.trail || !commitPendingFields()) return;
  const id = stepTarget(state.trail.waypoints, isVisible, state.selectedId, delta);
  if (id) select(id);
}

function onFormInput(): void {
  const w = selected();
  if (!w) return;
  patchDraft(w.id, {
    name: $<HTMLInputElement>('wpe-name').value,
    description: $<HTMLTextAreaElement>('wpe-desc').value,
    type: $<HTMLSelectElement>('wpe-type-select').value,
  });
  renderDescriptionAids();
  renderButtons();
  updateRow(w.id);
}

/**
 * Snap to the nearest of the route's lines: the main route, or an alternate
 * or side trip when its line is nearer, so a side-trip waypoint is not carried
 * across country to the main route. Never onto the straight line of a route break.
 */
function snapToRoute(): void {
  const w = selected();
  const at = currentValues();
  if (!w || !at || !w.canMove) return;
  const { nearest } = nearestLineSnap(state.lines, at.lat, at.lon);
  if (nearest) moveDraftTo(nearest.lat, nearest.lon, true);
}

// ---------------------------------------------------------------------------
// Discarding a draft, undoably
// ---------------------------------------------------------------------------

/** Drop the selected waypoint's unsaved edits, keeping them for Undo. */
function discardDraft(): void {
  const w = selected();
  const trail = state.trail;
  if (!w || !trail) return;
  const draft = state.drafts.get(w.id);
  state.drafts.delete(w.id);
  fillForm();
  drawSelection(false);
  updateRow(w.id);
  if (!draft) return;
  state.discarded = { trailId: trail.id, id: w.id, draft, focusId: document.activeElement?.id ?? '' };
  $('wpe-notes').innerHTML =
    `<li>Discarded the unsaved edits to “${escapeHtml(w.name)}”. ` +
    `<button type="button" class="wpe-btn wpe-btn-small" data-undo-discard>Undo</button></li>`;
}

/** Put the last discarded draft back, over the waypoint as it now stands. */
function undoDiscard(): void {
  const kept = state.discarded;
  if (!kept || state.trail?.id !== kept.trailId || !state.byId.has(kept.id)) return;
  state.discarded = null;
  if (state.selectedId !== kept.id) select(kept.id);
  patchDraft(kept.id, kept.draft);
  showNotes([]);
  fillForm();
  drawSelection(false);
  updateRow(kept.id);
  // The Undo button is gone: focus goes back to where the discard was made from.
  (document.getElementById(kept.focusId) ?? $('wpe-revert')).focus();
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

/**
 * Save the selected waypoint's draft. Everything the save needs is fixed
 * before it awaits (which waypoint, the request, the draft it was built from,
 * where "next" is), because the form stays live meanwhile: the answer is
 * applied to that waypoint whatever is selected by then, edits made during
 * the save stay as a draft on top of it, and the notes name the waypoint when
 * they land under another one's form.
 */
async function save(goNext: boolean): Promise<void> {
  if (state.saving || !commitPendingFields()) return;
  const trail = state.trail;
  const w = selected();
  if (!trail || !w) return;
  const id = w.id;
  const sent = state.drafts.get(id);
  // Where "next" is, in the list as it stands: the save may take this row out of the filter, or re-key it.
  const nextId = goNext ? stepTarget(trail.waypoints, isVisible, id, 1) : null;
  if (!sent || !isDirty(w, sent)) {
    if (!goNext) return;
    setReviewed(w, true);
    if (nextId) select(nextId);
    else refreshSelection();
    return;
  }
  const changes = draftChanges(w, sent);
  const values = draftValues(w, sent);
  const movedM = haversineDistance(w.lat, w.lon, values.lat, values.lon);
  if (changes.position && movedM > 2000 && !confirm(`Move “${w.name}” ${(movedM / 1000).toFixed(1)} km?`)) return;
  if (changes.description && !values.description.trim() && w.description) {
    if (!confirm(descriptionField(w).removeConfirm)) return;
  }
  const request: WaypointEditRequest = {
    expected: { name: w.name, lat: w.lat, lon: w.lon, description: w.description, type: w.type },
  };
  if (changes.name) request.name = values.name.trim();
  if (changes.type) request.type = values.type;
  if (changes.position) Object.assign(request, { lat: values.lat, lon: values.lon });
  if (changes.description) request.description = values.description.trim();

  state.saving = true;
  renderButtons();
  try {
    const result = await api<WaypointEditResponse>(
      `/trails/${encodeURIComponent(trail.dir)}/waypoints/${encodeURIComponent(id)}`,
      { method: 'POST', body: request }
    );
    if (state.trailWanted !== trail.dir || state.trail?.id !== trail.id) {
      // Another trail was opened meanwhile: the save is on disk, and nothing here is about it any more.
      // Said in the banner, and again once that trail has landed (which resets the banner).
      const said = `On ${trail.name}: ${saveNotes(result, false).join(' ')}`;
      if (state.loading) bannerAfterLoad = said;
      banner(said);
      void refreshChanges();
      return;
    }
    const saved = result.waypoint;
    // Whatever was typed during the save stays an edit, on top of what was saved.
    const kept = draftAfterSave(w, saved, sent, state.drafts.get(id));
    // Reviewed is the waypoint's own mark (its checkbox sets it at once), read
    // for this id: never the checkbox, which may be another waypoint's by now.
    const markReviewed = goNext || isReviewed(state.marks, w);
    // A renamed or moved pending waypoint comes back under a new temporary key:
    // the row, the dot, the selection and the address follow it, and nothing
    // (draft, review mark, what "Show more" revealed) stays under the old one.
    replaceWaypoint(saved, id);
    state.drafts.delete(id);
    if (kept) state.drafts.set(saved.id, kept);
    if (saved.id !== id) {
      if (state.selectedId === id) state.selectedId = saved.id;
      if (id in state.marks) {
        delete state.marks[id];
        saveMarks();
      }
      if (state.discarded?.id === id) state.discarded = null;
      if (revealed.comments?.key === commentsRevealKey(trail.id, id)) {
        // A save keeps what is revealed: it is the same waypoint under its new key.
        revealed.comments = { ...revealed.comments, key: commentsRevealKey(trail.id, saved.id) };
      }
    }
    if (markReviewed) setReviewed(saved, true);
    void refreshChanges();

    // Only move on if the saved waypoint is still the one selected.
    let stillSelected = state.selectedId === saved.id;
    if (goNext && stillSelected && nextId && state.byId.has(nextId)) {
      select(nextId);
      stillSelected = false;
    } else {
      refreshSelection();
    }
    report(saveNotes(result, stillSelected));
    // Another pass of the same place, or the other half of a merge, changed on
    // disk with it: read the trail again so those rows are not left stale.
    if (saveAffectsOtherRows(w, saved)) await loadTrail(trail.dir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report([state.selectedId === id ? message : `“${w.name}” was not saved: ${message}`], true);
  } finally {
    state.saving = false;
    renderButtons();
    renderNewButtons();
  }
}

/** Put the saved waypoint in place of the one the page held as `previousId` (its id, unless a pending one was re-keyed). */
function replaceWaypoint(w: EditorWaypoint, previousId = w.id): void {
  const trail = state.trail;
  if (!trail) return;
  const index = trail.waypoints.findIndex(x => x.id === previousId);
  if (index !== -1) trail.waypoints[index] = w;
  if (previousId !== w.id) state.byId.delete(previousId);
  state.byId.set(w.id, w);
  // A pending waypoint is listed by the km nearest its own position, which a move changes.
  if (w.pending) trail.waypoints.sort(compareWaypoints);
  const m = state.map;
  if (!m) return;
  m.dotById.get(previousId)?.remove();
  m.dotById.delete(previousId);
  addDot(m, w, colocatedWith(w, trail.waypoints).length);
}

// ---------------------------------------------------------------------------
// Hikers' comments (read-only, from the comments API)
// ---------------------------------------------------------------------------

/** One bulk read per trail per page load; Reload replaces it. */
const commentsCache = new Map<string, Promise<CommentsState>>();

/**
 * What "Show more" has revealed: of the selected waypoint's comments (one page
 * again when another waypoint is selected), and of the trail's orphaned ids.
 */
const revealed = { comments: null as Reveal | null, orphans: null as Reveal | null };

/** The list `revealed.comments` is about: one waypoint's comments (a pending waypoint's key changes with it). */
function commentsRevealKey(trailId: string, waypointId: string): string {
  return `${trailId}/${waypointId}`;
}

/**
 * Render the Comments section for the selected waypoint. The section is
 * replaced whole, so focus on its reload control is handed to the new one,
 * and it is not a live region: `announce` puts one short line in the status
 * region instead (after a load, a Reload or "Show more"), and a plain
 * re-render (a selection, a keystroke's re-fill) says nothing.
 */
function renderComments(announce = false): void {
  const w = selected();
  if (!w || !state.trail) return;
  revealed.comments = revealFor(revealed.comments, commentsRevealKey(state.trail.id, w.id), COMMENTS_PAGE_SIZE);
  revealed.orphans = revealFor(revealed.orphans, state.trail.id, ORPHAN_IDS_PAGE_SIZE);
  $('wpe-comments-count').textContent = commentsCountText(state.comments, w.id);
  const body = $('wpe-comments-body');
  const active = document.activeElement;
  const hadFocus = active instanceof HTMLElement && body.contains(active) && active.matches('[data-comments-reload]');
  body.innerHTML = commentsSectionHtml(state.comments, w.id, {
    // A merged-away id is live (it is in its survivor's mergedIds, and has a row here), not lost.
    orphaned: orphanedCommentIds(state.comments, knownCommentIds(state.trail.waypoints)),
    shown: revealed.comments.shown,
    orphansShown: revealed.orphans.shown,
    note: mergeCommentsNote(w, state.byId, state.commentCounts),
  });
  if (hadFocus) body.querySelector<HTMLElement>('[data-comments-reload]')?.focus();
  $('wpe-comments-status').textContent = announce
    ? commentsStatusText(state.comments, w.id, revealed.comments.shown)
    : '';
}

/**
 * "Show more" / "Show all" on the comments or the orphaned ids. The re-render
 * removes the button that had focus, so focus moves to the first item revealed.
 */
function showMore(list: keyof typeof revealed, itemSelector: string, value: string | undefined): void {
  const shown = parseShown(value);
  const current = revealed[list];
  if (shown === null || !current) return;
  const body = $('wpe-comments-body');
  const before = body.querySelectorAll(itemSelector).length;
  revealed[list] = { key: current.key, shown };
  renderComments(true);
  const first = body.querySelectorAll<HTMLElement>(itemSelector)[before];
  if (first) {
    first.tabIndex = -1;
    first.focus();
  }
}

async function refreshComments(trailId: string, reload = false): Promise<void> {
  if (reload) commentsCache.delete(trailId);
  let pending = commentsCache.get(trailId);
  if (!pending) {
    pending = loadTrailComments(trailId, { session: loadSession() });
    commentsCache.set(trailId, pending);
  }
  state.comments = { kind: 'loading' };
  state.commentCounts = new Map();
  renderComments(reload);
  const result = await pending;
  if (result.kind === 'error') commentsCache.delete(trailId); // retry on the next load
  // An answer for a trail the page has left, or one a later Reload has replaced, is stale.
  if (state.trail?.id !== trailId || (commentsCache.get(trailId) ?? pending) !== pending) return;
  state.comments = result;
  state.commentCounts = commentCounts(result);
  renderComments(true);
  renderList();
}

// ---------------------------------------------------------------------------
// Adding and deleting
// ---------------------------------------------------------------------------

function startAdding(): void {
  if (!state.trail || state.trail.readOnlyReason) return;
  select(null);
  state.adding = null;
  $('wpe-empty').hidden = true;
  $('wpe-new-form').hidden = false;
  $('wpe-new').setAttribute('aria-pressed', 'true');
  $('wpe-map').classList.add('is-placing');
  const typeSelect = $<HTMLSelectElement>('wpe-new-type');
  if (!typeSelect.options.length) typeSelect.innerHTML = typeOptionsHtml(null);
  $('wpe-new-notes').innerHTML = '';
  $('wpe-new-where').textContent = 'Click the map (or an OSM POI) to place it; drag the marker to adjust.';
  renderNewButtons();
  $('wpe-new-name').focus();
}

/** Leave "New waypoint" mode, dropping its marker and form. */
function endAdding(): void {
  if (state.adding === undefined) return;
  state.adding = undefined;
  state.newMarker?.remove();
  state.newMarker = null;
  $('wpe-new-form').hidden = true;
  $('wpe-new').setAttribute('aria-pressed', 'false');
  $('wpe-map').classList.remove('is-placing');
  $('wpe-empty').hidden = !!selected();
}

function placeNew(lat: number, lon: number): void {
  const m = state.map;
  const trail = state.trail;
  if (!m || !trail || state.adding === undefined) return;
  state.adding = { lat: round6(lat), lon: round6(lon) };
  if (!state.newMarker) {
    const marker = m.L.marker([lat, lon], { draggable: true, zIndexOffset: 1000, keyboard: false })
      .bindTooltip('New waypoint', { direction: 'top', offset: [0, -30] })
      .addTo(m.map);
    marker.on('dragend', () => {
      const where = marker.getLatLng();
      placeNew(where.lat, where.lng);
    });
    state.newMarker = marker;
  } else {
    state.newMarker.setLatLng([lat, lon]);
  }
  const where = positionReadout(state.lines, lat, lon, 0);
  $('wpe-new-where').textContent = `${state.adding.lat}, ${state.adding.lon}${where ? ` · ${where}` : ''}`;
  renderNewButtons();
}

function renderNewButtons(): void {
  const name = $<HTMLInputElement>('wpe-new-name');
  // A name the build would strip a type prefix from is refused by the server: say so before it is sent.
  const problem = typePrefixProblem(name.value);
  flagField(name, !!problem);
  $('wpe-new-name-error').textContent = problem ?? '';
  const ready = !!state.adding && !!name.value.trim() && !problem;
  $<HTMLButtonElement>('wpe-new-add').disabled = !ready || state.saving || state.rebuilding;
}

async function addNew(): Promise<void> {
  const trail = state.trail;
  const at = state.adding;
  if (!trail || !at || state.saving || typePrefixProblem($<HTMLInputElement>('wpe-new-name').value)) return;
  const request: NewWaypointRequest = {
    name: $<HTMLInputElement>('wpe-new-name').value.trim(),
    type: $<HTMLSelectElement>('wpe-new-type').value,
    lat: at.lat,
    lon: at.lon,
  };
  const description = $<HTMLTextAreaElement>('wpe-new-desc').value.trim();
  if (description) request.description = description;
  state.saving = true;
  renderNewButtons();
  try {
    const result = await api<WaypointEditResponse>(`/trails/${encodeURIComponent(trail.dir)}/waypoints`, {
      method: 'POST',
      body: request,
    });
    $<HTMLInputElement>('wpe-new-name').value = '';
    $<HTMLTextAreaElement>('wpe-new-desc').value = '';
    endAdding();
    // The map stays where it is: the new waypoint is where it was just clicked.
    await loadTrail(trail.dir, { select: result.waypoint.id });
    report([`Added to ${result.changedFiles.join(', ')}.`, ...result.notes]);
    void refreshChanges();
  } catch (error) {
    $('wpe-new-notes').innerHTML =
      `<li class="is-error">${escapeHtml(error instanceof Error ? error.message : String(error))}</li>`;
  } finally {
    state.saving = false;
    renderNewButtons();
    renderButtons();
  }
}

async function deleteSelected(): Promise<void> {
  const w = selected();
  const trail = state.trail;
  if (!w || !trail || !w.canDelete || state.saving) return;
  if (!confirm(deleteConfirmText(w, state.commentCounts.get(w.id)))) return;
  // The neighbour to land on, worked out before the row goes.
  const next = stepTarget(trail.waypoints, isVisible, w.id, 1) ?? stepTarget(trail.waypoints, isVisible, w.id, -1);
  state.saving = true;
  renderButtons();
  try {
    const result = await api<WaypointDeleteResponse>(
      `/trails/${encodeURIComponent(trail.dir)}/waypoints/${encodeURIComponent(w.id)}`,
      {
        method: 'DELETE',
        body: { expected: { name: w.name, lat: w.lat, lon: w.lon, description: w.description, type: w.type } },
      }
    );
    for (const id of result.removed) {
      state.drafts.delete(id);
      delete state.marks[id];
    }
    saveMarks();
    await loadTrail(trail.dir, { select: next });
    report([`Deleted “${w.name}” from ${result.changedFiles.join(', ')}.`, ...result.notes]);
    void refreshChanges();
  } catch (error) {
    showNotes([error instanceof Error ? error.message : String(error)], true);
  } finally {
    state.saving = false;
    renderButtons();
  }
}

// ---------------------------------------------------------------------------
// Trails, changes, rebuild
// ---------------------------------------------------------------------------

/** Counts trail reads, so that an answer which is no longer the latest asked for is dropped. */
let trailRequests = 0;
/** The last trail read failed and said so in the banner: the next one that works clears it. */
let trailReadFailed = false;
/** Something to say in the banner once the trail being read has landed (a save that returned meanwhile). */
let bannerAfterLoad: string | null = null;

/**
 * Read a trail and show it. Opening another trail starts afresh. Reading the
 * one already open again (Reload trail, a rebuild, an add or delete, a save
 * that touched other rows) keeps the working state: the map view, the list's
 * scroll, the selection (unless `select` names another), what is being typed,
 * and every draft, rebased field by field onto the waypoints as they now are.
 */
async function loadTrail(dir: string, options: { select?: string | null } = {}): Promise<void> {
  const request = ++trailRequests;
  state.trailWanted = dir;
  state.loading = true;
  renderButtons();
  let trail: EditorTrail;
  try {
    trail = await api<EditorTrail>(`/trails/${encodeURIComponent(dir)}`);
  } catch (error) {
    if (request !== trailRequests) return;
    state.loading = false;
    if (state.trail?.dir !== dir) {
      state.trail = null;
      state.byId.clear();
      state.drafts.clear();
      state.lines = [];
      renderList();
      select(null);
      drawTrail(false);
      renderTrailFiles();
    }
    // A failed re-read leaves the trail as the page has it, drafts included.
    renderButtons();
    trailReadFailed = true;
    banner(error instanceof Error ? error.message : String(error));
    return;
  }
  // A later read was asked for (another trail picked, a reload): this answer is stale.
  if (request !== trailRequests) return;
  state.loading = false;
  const same = state.trail?.id === trail.id;
  if (!same) {
    state.drafts.clear();
    state.discarded = null;
  }
  state.trail = trail;
  state.byId = new Map(trail.waypoints.map(w => [w.id, w]));
  // Rebase each draft onto its waypoint as it now is: an edit the sources have caught up with is no longer one.
  // A draft outlives its waypoint when a rebuild gives a pending one its id (or retires a deleted one).
  for (const [id, draft] of [...state.drafts]) {
    const w = state.byId.get(id);
    const next = w ? pruneDraft(w, draft) : undefined;
    if (next) state.drafts.set(id, next);
    else state.drafts.delete(id);
  }
  state.lines = routeLines(trail.track, routeBreakStarts(trail.track.breaks, 'displayPoints'));
  state.marks = loadMarks(trail.id);
  storageSet(TRAIL_KEY, dir);
  $<HTMLSelectElement>('wpe-trail').value = dir;
  // A re-read of the same trail leaves the banner alone: it may hold the notes of what led to it.
  if (!same || trailReadFailed || bannerAfterLoad) {
    banner([bannerAfterLoad, trail.readOnlyReason].filter(Boolean).join(' ') || null);
  }
  trailReadFailed = false;
  bannerAfterLoad = null;
  if (!same) void refreshComments(trail.id);
  renderFilters();
  renderTrailFiles();
  const mapReady = !!state.map;
  if (mapReady) drawTrail(!same);
  const wanted = 'select' in options ? (options.select ?? null) : same ? state.selectedId : null;
  const id = wanted && state.byId.has(wanted) ? wanted : null;
  if (same && id === state.selectedId) refreshSelection();
  else select(id, { pan: !same });
  renderButtons();
  if (!mapReady) {
    // The first trail: the list and the form are live while Leaflet loads, so
    // draw whatever is open and selected once it has, not what was when it began.
    try {
      await ensureMap();
    } catch (error) {
      banner(`The map did not load: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    drawTrail(true);
    drawSelection(true);
  }
}

/** The Changed files drawer's line on which source files a save on the open trail may write. */
function renderTrailFiles(): void {
  const trail = state.trail;
  const el = $('wpe-trail-files');
  // Nothing is written on a read-only trail.
  el.hidden = !trail || !!trail.readOnlyReason;
  if (!trail || trail.readOnlyReason) return;
  const { gpx, geojson, descriptions, registry, config } = trail.files;
  const code = (file: string) => `<code>${escapeHtml(file)}</code>`;
  el.innerHTML =
    `A save on ${escapeHtml(trail.name)} writes ${[gpx, geojson, descriptions, registry]
      .filter((file): file is string => !!file)
      .map(code)
      .join(', ')}` +
    (config ? `, and ${code(config)} when a rename changes a name in its <code>revisitedWaypoints</code>.` : '.');
}

async function refreshChanges(): Promise<void> {
  try {
    const files = await api<ChangedFile[]>('/changes');
    $('wpe-changes-count').textContent = String(files.length);
    $('wpe-changes-list').innerHTML = files.length
      ? files.map(f => `<li>${escapeHtml(f.status)} ${escapeHtml(f.path)}</li>`).join('')
      : '<li class="wpe-muted">No changes to the trail data.</li>';
  } catch {
    // the drawer just goes stale; saving reports its own errors
  }
}

function renderRebuild(status: RebuildStatus): void {
  const el = $('wpe-rebuild-status');
  if (status.state === 'idle') {
    el.innerHTML = '';
    return;
  }
  const lost = [
    ...status.minted.map(c => ({ ...c, how: 'minted (new id)' })),
    ...status.retired.map(c => ({ ...c, how: 'retired' })),
  ];
  const parts = [
    `<h2>Rebuild: ${escapeHtml(status.state)}${status.finishedAt ? ` at ${escapeHtml(new Date(status.finishedAt).toLocaleTimeString())}` : '…'}</h2>`,
  ];
  if (lost.length) {
    parts.push(
      `<div class="wpe-banner"><strong>Ids changed.</strong> These waypoints got a new id or lost theirs, which orphans comments and descriptions keyed to the old one. Check them before committing (see docs/architecture/trail-data.md):<ul>` +
        lost
          .map(
            c =>
              `<li>${escapeHtml(c.trailId)}: ${escapeHtml(c.name)} (${escapeHtml(c.type)}, <code>${escapeHtml(c.id)}</code>) ${escapeHtml(c.how)}</li>`
          )
          .join('') +
        `</ul></div>`
    );
  } else if (status.state === 'succeeded') {
    parts.push('<p class="wpe-muted">No waypoint ids were minted or retired.</p>');
  }
  if (status.warnings.length) {
    // Open: the build's id-minting warnings are its only report of a new id beside another waypoint.
    parts.push(
      `<details open><summary>${status.warnings.length} warning line(s)</summary><pre class="wpe-log">${escapeHtml(status.warnings.join('\n'))}</pre></details>`
    );
  }
  parts.push(
    `<details${status.state === 'failed' ? ' open' : ''}><summary>Build output</summary><pre class="wpe-log">${escapeHtml(status.log)}</pre></details>`
  );
  el.innerHTML = parts.join('');
}

async function rebuild(): Promise<void> {
  if (state.rebuilding || state.saving) return;
  const unsaved = state.trail?.waypoints.filter(w => isDirty(w, state.drafts.get(w.id))).length ?? 0;
  if (
    unsaved &&
    !confirm(`${unsaved} waypoint(s) have unsaved changes, which the rebuild will not include. Rebuild anyway?`)
  )
    return;
  await followRebuild(() => api<RebuildStatus>('/rebuild', { method: 'POST' }));
}

/**
 * Show a rebuild until it ends: the drawer open with its report as it grows,
 * saves and a second rebuild off, and the trail read again when it is done.
 * `first` gives the status to start from: the answer to starting one, or the
 * status of one found already running when the page was opened.
 */
async function followRebuild(first: () => Promise<RebuildStatus>): Promise<void> {
  if (state.rebuilding) return;
  state.rebuilding = true;
  renderButtons();
  renderNewButtons();
  const drawer = $('wpe-changes');
  drawer.hidden = false;
  $('wpe-changes-btn').setAttribute('aria-expanded', 'true');
  $('wpe-rebuild').textContent = 'Rebuilding…';
  try {
    let status = await first();
    renderRebuild(status);
    while (status.state === 'running') {
      await new Promise(resolve => setTimeout(resolve, 1500));
      status = await api<RebuildStatus>('/rebuild');
      renderRebuild(status);
    }
    if (state.trail) await loadTrail(state.trail.dir);
  } catch (error) {
    banner(error instanceof Error ? error.message : String(error));
  } finally {
    state.rebuilding = false;
    $('wpe-rebuild').textContent = 'Rebuild trail data';
    renderButtons();
    renderNewButtons();
    void refreshChanges();
  }
}

/**
 * On page load: a rebuild that is running is followed as if this page had
 * started it, and the last one's report is put back in the drawer. The page
 * can be reloaded mid-rebuild (by hand, or by Vite when one of the page's own
 * source files is edited), and the report of minted and retired ids must not
 * be lost with it.
 */
async function resumeRebuild(): Promise<void> {
  let status: RebuildStatus;
  try {
    status = await api<RebuildStatus>('/rebuild');
  } catch {
    return; // the first save or rebuild says what is wrong
  }
  if (status.state === 'running') await followRebuild(() => Promise.resolve(status));
  else renderRebuild(status);
}

function toggleDrawer(buttonId: string, drawerId: string): void {
  const drawer = $(drawerId);
  drawer.hidden = !drawer.hidden;
  $(buttonId).setAttribute('aria-expanded', String(!drawer.hidden));
  if (drawerId === 'wpe-changes' && !drawer.hidden) void refreshChanges();
  state.map?.map.invalidateSize();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function wire(): void {
  $<HTMLSelectElement>('wpe-trail').addEventListener('change', e => {
    const dir = (e.target as HTMLSelectElement).value;
    if (anyUnsaved() && !confirm('Discard the unsaved changes on this trail?')) {
      (e.target as HTMLSelectElement).value = state.trail!.dir;
      return;
    }
    void loadTrail(dir, { select: null });
  });
  $('wpe-reload').addEventListener('click', () => {
    // The open trail again, or the one asked for that could not be read.
    const dir = state.trail?.dir ?? state.trailWanted;
    if (dir && !state.saving && !state.rebuilding) void loadTrail(dir);
  });
  $<HTMLInputElement>('wpe-search').addEventListener('input', e => {
    state.filter.query = (e.target as HTMLInputElement).value;
    renderList();
  });
  $<HTMLSelectElement>('wpe-type').addEventListener('change', e => {
    state.filter.type = (e.target as HTMLSelectElement).value;
    renderList();
  });
  $<HTMLSelectElement>('wpe-status').addEventListener('change', e => {
    state.filter.status = (e.target as HTMLSelectElement).value as StatusFilter;
    renderList();
  });
  $('wpe-list').addEventListener('click', e => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.wpe-row');
    if (row?.dataset.id) select(row.dataset.id);
  });

  $('wpe-name').addEventListener('input', onFormInput);
  $('wpe-type-select').addEventListener('change', onFormInput);
  $('wpe-delete').addEventListener('click', () => void deleteSelected());
  $('wpe-new').addEventListener('click', () => (state.adding === undefined ? startAdding() : endAdding()));
  $('wpe-new-cancel').addEventListener('click', () => endAdding());
  $('wpe-new-name').addEventListener('input', renderNewButtons);
  $('wpe-new-form').addEventListener('submit', e => {
    e.preventDefault();
    void addNew();
  });
  $('wpe-desc').addEventListener('input', onFormInput);
  for (const id of ['wpe-lat', 'wpe-lon']) {
    // Typed, not yet committed: `change` commits it, and so does any shortcut before it acts.
    $(id).addEventListener('input', () => {
      state.positionTyped = true;
      renderButtons();
    });
    $(id).addEventListener('change', () => void commitPosition());
    // `change` does not fire when the field is left holding what it held on focus (typed over
    // and typed back): commit then too, so nothing typed stays pending once the field is left.
    $(id).addEventListener('blur', () => {
      if (state.positionTyped) commitPosition();
    });
  }
  const paste = $<HTMLInputElement>('wpe-paste');
  // A paste applies at once; text typed by hand applies on Enter or when the box is left.
  paste.addEventListener('paste', e => {
    const text = e.clipboardData?.getData('text') ?? '';
    if (!parseLatLon(text)) return;
    e.preventDefault();
    applyPaste(text);
  });
  paste.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault(); // not the form's submit
    applyPaste();
  });
  paste.addEventListener('change', () => void applyPaste());
  paste.addEventListener('input', () => {
    if (!paste.value.trim() || parseLatLon(paste.value)) flagField(paste, false);
  });
  $('wpe-nearby-list').addEventListener('click', e => {
    const button = (e.target as HTMLElement).closest<HTMLElement>('[data-poi-move]');
    const poi = state.trail?.pois.find(p => p.id === button?.dataset.poiMove);
    if (poi) moveDraftTo(poi.lat, poi.lon);
  });
  $('wpe-meta').addEventListener('click', e => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('[data-goto]')?.dataset.goto;
    if (id && state.byId.has(id)) select(id);
  });
  $('wpe-comments-body').addEventListener('click', e => {
    const target = e.target as HTMLElement;
    const reload = target.closest('[data-comments-reload]');
    if (reload && reload.getAttribute('aria-disabled') !== 'true' && state.trail) {
      void refreshComments(state.trail.id, true);
    }
    const comments = target.closest<HTMLElement>('[data-comments-show]');
    if (comments) showMore('comments', '.wpe-comment', comments.dataset.commentsShow);
    const orphans = target.closest<HTMLElement>('[data-orphans-show]');
    if (orphans) showMore('orphans', '.wpe-orphan-id', orphans.dataset.orphansShow);
  });
  $('wpe-use-source').addEventListener('click', () => {
    const w = selected();
    if (!w?.sourceDescription) return;
    $<HTMLTextAreaElement>('wpe-desc').value = w.sourceDescription;
    onFormInput();
    $('wpe-desc').focus();
  });
  $<HTMLInputElement>('wpe-reviewed').addEventListener('change', e => {
    const w = selected();
    if (!w) return;
    setReviewed(w, (e.target as HTMLInputElement).checked);
    renderList();
  });
  $('wpe-form').addEventListener('submit', e => {
    e.preventDefault();
    void save(false);
  });
  $('wpe-save-next').addEventListener('click', () => void save(true));
  $('wpe-revert').addEventListener('click', discardDraft);
  $('wpe-notes').addEventListener('click', e => {
    if ((e.target as HTMLElement).closest('[data-undo-discard]')) undoDiscard();
  });
  $('wpe-reset-pos').addEventListener('click', () => {
    const w = selected();
    if (!w) return;
    // Back to the saved position; also clears a typed position that was never one.
    patchDraft(w.id, { lat: w.lat, lon: w.lon });
    afterMove(w.id, true);
  });
  $('wpe-place').addEventListener('click', () => setPlacing(!state.placing));
  $('wpe-snap').addEventListener('click', snapToRoute);
  $('wpe-rebuild').addEventListener('click', () => void rebuild());
  $('wpe-changes-btn').addEventListener('click', () => toggleDrawer('wpe-changes-btn', 'wpe-changes'));
  $('wpe-help-btn').addEventListener('click', () => toggleDrawer('wpe-help-btn', 'wpe-help'));

  document.addEventListener('keydown', e => {
    const mod = e.ctrlKey || e.metaKey;
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void save(false);
    } else if (mod && e.key === 'Enter') {
      e.preventDefault();
      void save(true);
    } else if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      step(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.altKey && e.code === 'KeyR') {
      e.preventDefault();
      const box = $<HTMLInputElement>('wpe-reviewed');
      // Off for a waypoint that takes no mark (pending, or not in the last build).
      if (box.disabled) return;
      box.checked = !box.checked;
      box.dispatchEvent(new Event('change'));
    } else if (e.altKey && e.code === 'KeyP') {
      e.preventDefault();
      setPlacing(!state.placing);
    } else if (e.key === 'Escape') {
      // Esc that cancels an IME composition (Shikoku's Japanese names) is not ours.
      if (e.isComposing || e.keyCode === 229) return;
      if (state.adding !== undefined) endAdding();
      else if (state.placing) setPlacing(false);
      else if (e.target === $('wpe-lat') || e.target === $('wpe-lon') || e.target === $('wpe-paste')) {
        // Put back what was typed there, not the whole draft.
        $<HTMLInputElement>('wpe-paste').value = '';
        flagField($<HTMLInputElement>('wpe-paste'), false);
        fillPosition();
        renderButtons();
      } else if (!typing || e.target === $('wpe-desc') || e.target === $('wpe-name')) discardDraft();
    } else if (e.key === '/' && !typing) {
      e.preventDefault();
      $('wpe-search').focus();
    }
  });

  window.addEventListener('beforeunload', e => {
    if (anyUnsaved()) e.preventDefault();
  });
}

async function boot(): Promise<void> {
  wire();
  try {
    state.trails = await api<EditorTrailSummary[]>('/trails');
  } catch (error) {
    banner(error instanceof Error ? error.message : String(error));
    return;
  }
  const select = $<HTMLSelectElement>('wpe-trail');
  select.innerHTML = state.trails
    .map(
      t =>
        `<option value="${escapeHtml(t.dir)}">${escapeHtml(t.name)}${t.readOnlyReason ? ' (read only)' : ''}${t.built ? '' : ' (not built)'}</option>`
    )
    .join('');
  const params = new URLSearchParams(location.search);
  const wanted = params.get('trail') ?? storageGet(TRAIL_KEY);
  const dir = state.trails.find(t => t.dir === wanted)?.dir ?? state.trails[0]?.dir;
  if (!dir) return;
  select.value = dir;
  void refreshChanges();
  await loadTrail(dir, { select: params.get('id') });
  void resumeRebuild();
}

void boot();
