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
 * a long review can hop between neighbours before saving. Review marks are per
 * browser and lapse when the waypoint's content changes.
 */

import type * as Leaflet from 'leaflet';
import { haversineDistance } from '@lib/distance';
import { routeBreakStarts } from '@lib/route-breaks';
import { snapToTrail } from '@lib/position-on-trail';
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
  loadTrailComments,
  orphanedCommentIds,
  parseShown,
  revealFor,
  type Reveal,
  type CommentsState,
} from './admin-waypoints-comments';
import {
  STATUS_FILTER_LABELS,
  compareWaypoints,
  deleteConfirmText,
  descriptionField,
  dotStyle,
  dotTooltipHtml,
  draftChanges,
  draftOf,
  externalMapLinks,
  hasCuratedText,
  isDirty,
  isReviewed,
  knownCommentIds,
  matchesFilter,
  mergeCommentsNote,
  mergeMetaHtml,
  movedSinceBuild,
  nearbyPois,
  parseLatLon,
  placementText,
  readoutText,
  reviewFingerprint,
  reviewStorageKey,
  retypedSinceBuild,
  rowHtml,
  typeCounts,
  typeOptionsHtml,
  voiceHints,
  waypointGlyphHtml,
  type ReviewMarks,
  type StatusFilter,
  type WaypointDraft,
  type WaypointFilter,
} from './admin-waypoints-view';
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
  map: null as MapState | null,
  breakStarts: new Set<number>() as ReadonlySet<number>,
  /** Hikers' comments on the current trail (`admin-waypoints-comments.ts`), and their counts per id. */
  comments: { kind: 'loading' } as CommentsState,
  commentCounts: new Map<string, number>() as ReadonlyMap<string, number>,
};

function selected(): EditorWaypoint | null {
  return state.selectedId ? (state.byId.get(state.selectedId) ?? null) : null;
}

function currentDraft(): WaypointDraft | null {
  const w = selected();
  if (!w) return null;
  return state.drafts.get(w.id) ?? draftOf(w);
}

function setDraft(id: string, draft: WaypointDraft): void {
  const saved = state.byId.get(id);
  if (saved && !isDirty(saved, draft)) state.drafts.delete(id);
  else state.drafts.set(id, draft);
}

function visibleWaypoints(): EditorWaypoint[] {
  return (state.trail?.waypoints ?? []).filter(w => matchesFilter(w, state.filter, state.marks, state.commentCounts));
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
  // A pending waypoint has only a temporary key, which a rename or a move changes: nothing is kept under it.
  if (w.pending) return;
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

function renderList(): void {
  const list = $('wpe-list');
  const scroll = list.scrollTop;
  const rows = visibleWaypoints();
  list.innerHTML = rows
    .map(w =>
      rowHtml(w, {
        selected: w.id === state.selectedId,
        dirty: isDirty(w, state.drafts.get(w.id)),
        reviewed: isReviewed(state.marks, w),
        comments: state.commentCounts.get(w.id),
      })
    )
    .join('');
  list.scrollTop = scroll;
  const total = state.trail?.waypoints.length ?? 0;
  $('wpe-list-count').textContent =
    rows.length === total ? `${total} waypoints` : `${rows.length} of ${total} waypoints`;
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
  const total = trail.waypoints.length;
  const reviewed = trail.waypoints.filter(w => isReviewed(state.marks, w)).length;
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

async function ensureMap(): Promise<MapState> {
  if (state.map) return state.map;
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

function drawTrail(): void {
  const m = state.map;
  const trail = state.trail;
  if (!m || !trail) return;
  const { L: Lf } = m;
  m.route.clearLayers();
  m.dots.clearLayers();
  m.pois.clearLayers();
  m.dotById.clear();

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

  for (const w of trail.waypoints) addDot(m, w);

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
  if (bounds.length) m.map.fitBounds(Lf.latLngBounds(bounds), { padding: [20, 20] });
}

/** One waypoint's dot on the map, kept under its id (a pending waypoint's key) in `dotById`. */
function addDot(m: MapState, w: EditorWaypoint): void {
  const dot = m.L.circleMarker([w.lat, w.lon], dotStyle(w, familyColor(w.type)))
    .bindTooltip(dotTooltipHtml(w), { direction: 'top', offset: [0, -6] })
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
  const draft = currentDraft();
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
  if (draftChanges(w, draft).position) {
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
  marker.bindTooltip(escapeHtml(draft.name), { direction: 'top', offset: [0, -14] });
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

function updatePositionFields(lat: number, lon: number): void {
  $<HTMLInputElement>('wpe-lat').value = round6(lat).toString();
  $<HTMLInputElement>('wpe-lon').value = round6(lon).toString();
}

function moveDraftTo(lat: number, lon: number): void {
  const w = selected();
  const draft = currentDraft();
  if (!w || !draft || !w.canMove) return;
  setDraft(w.id, { ...draft, lat: round6(lat), lon: round6(lon) });
  fillPosition();
  drawSelection(false);
  renderButtons();
  renderList();
}

function renderReadout(lat: number, lon: number): void {
  const w = selected();
  const trail = state.trail;
  if (!w || !trail) {
    $('wpe-readout').textContent = '';
    return;
  }
  const snap = snapToTrail(lat, lon, trail.track.points, undefined, state.breakStarts);
  $('wpe-readout').textContent = readoutText({
    km: snap ? snap.currentKm : null,
    offRouteM: snap ? snap.offTrailMeters : null,
    movedM: haversineDistance(w.lat, w.lon, lat, lon),
  });
}

/** The `<ele>` the waypoint's `<wpt>` has in the GPX, and what a pending move does to it. */
function renderSourceElevation(): void {
  const w = selected();
  const draft = currentDraft();
  const line = $('wpe-ele');
  line.hidden = w?.ele === undefined;
  if (!w || !draft || w.ele === undefined) return;
  line.textContent = `GPX <ele>: ${w.ele} m${
    draftChanges(w, draft).position ? '; saving the move looks it up again for the new position' : ''
  }`;
}

function fillPosition(): void {
  const draft = currentDraft();
  if (!draft) return;
  updatePositionFields(draft.lat, draft.lon);
  renderReadout(draft.lat, draft.lon);
  renderSourceElevation();
  $('wpe-links').innerHTML = externalMapLinks(draft.lat, draft.lon)
    .map(l => `<a href="${escapeHtml(l.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(l.label)}</a>`)
    .join('');
  renderNearby();
}

function renderNearby(): void {
  const draft = currentDraft();
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
  count.textContent = `${text.trim().length} / ${max}`;
  count.classList.toggle('is-over', text.trim().length > max);
  $('wpe-hints').innerHTML = voiceHints(text)
    .map(h => `<li><strong>${escapeHtml(h.match)}</strong>: ${escapeHtml(h.message)}</li>`)
    .join('');
}

function renderButtons(): void {
  const w = selected();
  const dirty = w ? isDirty(w, state.drafts.get(w.id)) : false;
  const busy = state.saving || state.rebuilding;
  $<HTMLButtonElement>('wpe-save').disabled = !dirty || busy;
  $<HTMLButtonElement>('wpe-save-next').disabled = busy;
  $<HTMLButtonElement>('wpe-save-next').textContent = dirty ? 'Save & next' : 'Next';
  $<HTMLButtonElement>('wpe-revert').disabled = !dirty;
  const del = $<HTMLButtonElement>('wpe-delete');
  del.disabled = !w?.canDelete || busy;
  del.title = w && !w.canDelete && /_\d+$/.test(w.id) ? 'A later pass of a revisited place: delete the first pass' : '';
  $<HTMLButtonElement>('wpe-new').disabled = !state.trail || !!state.trail.readOnlyReason || busy;
  $<HTMLButtonElement>('wpe-reset-pos').disabled = !(
    w &&
    state.drafts.get(w.id) &&
    draftChanges(w, state.drafts.get(w.id)!).position
  );
  $<HTMLButtonElement>('wpe-snap').disabled = !w?.canMove;
  $<HTMLButtonElement>('wpe-place').disabled = !w?.canMove;
  $<HTMLButtonElement>('wpe-rebuild').disabled = state.rebuilding;
}

function fillForm(): void {
  const w = selected();
  const draft = currentDraft();
  $('wpe-empty').hidden = !!w;
  $('wpe-form').hidden = !w;
  if (!w || !draft) return;

  const locked = $('wpe-locked');
  locked.hidden = !w.lockedReason;
  locked.textContent = w.lockedReason ?? '';

  const name = $<HTMLInputElement>('wpe-name');
  name.value = draft.name;
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
  $<HTMLInputElement>('wpe-paste').disabled = !w.canMove;
  $<HTMLInputElement>('wpe-paste').value = '';
  const desc = $<HTMLTextAreaElement>('wpe-desc');
  const field = descriptionField(w);
  desc.value = draft.description;
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
  if (w.distanceFromTrailKm !== undefined)
    meta.push(`<span>${(w.distanceFromTrailKm * 1000).toFixed(0)} m from the route in the last build</span>`);
  if (w.access) {
    meta.push(
      `<span>access.json: ${escapeHtml([w.access.method, w.access.store && `store ${w.access.store}`].filter(Boolean).join(', '))}</span>`
    );
  }
  if (w.sharesSourceWith?.length)
    meta.push(`<span>Same &lt;wpt&gt; as ${escapeHtml(w.sharesSourceWith.join(', '))}</span>`);
  const merge = mergeMetaHtml(w, state.byId);
  if (merge) meta.push(merge);
  $('wpe-meta').innerHTML = meta.join('');

  const source = $<HTMLDetailsElement>('wpe-source');
  source.hidden = !w.sourceDescription;
  $('wpe-source-text').textContent = w.sourceDescription ?? '';
  source.open = !hasCuratedText(w) && !!w.sourceDescription;
  $('wpe-use-source').hidden = !w.canDescribe;

  $<HTMLInputElement>('wpe-reviewed').checked = isReviewed(state.marks, w);
  $<HTMLInputElement>('wpe-reviewed').disabled = !!w.pending;
  fillPosition();
  renderDescriptionAids();
  renderButtons();
  renderComments();
}

function select(id: string | null, options: { pan?: boolean } = {}): void {
  setPlacing(false);
  endAdding();
  state.selectedId = id && state.byId.has(id) ? id : null;
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

function step(delta: number): void {
  const rows = visibleWaypoints();
  if (!rows.length) return;
  const index = rows.findIndex(w => w.id === state.selectedId);
  const next = index === -1 ? 0 : Math.min(rows.length - 1, Math.max(0, index + delta));
  select(rows[next].id);
}

function onFormInput(): void {
  const w = selected();
  const draft = currentDraft();
  if (!w || !draft) return;
  const next = {
    ...draft,
    name: $<HTMLInputElement>('wpe-name').value,
    description: $<HTMLTextAreaElement>('wpe-desc').value,
    type: $<HTMLSelectElement>('wpe-type-select').value,
  };
  setDraft(w.id, next);
  renderDescriptionAids();
  renderButtons();
  renderList();
}

function onLatLonInput(): void {
  const lat = Number($<HTMLInputElement>('wpe-lat').value);
  const lon = Number($<HTMLInputElement>('wpe-lon').value);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
  const w = selected();
  const draft = currentDraft();
  if (!w || !draft) return;
  setDraft(w.id, { ...draft, lat: round6(lat), lon: round6(lon) });
  drawSelection(true);
  renderReadout(lat, lon);
  renderSourceElevation();
  renderNearby();
  renderButtons();
  renderList();
}

function snapToRoute(): void {
  const draft = currentDraft();
  const trail = state.trail;
  if (!draft || !trail) return;
  const points = trail.track.points;
  const snap = snapToTrail(draft.lat, draft.lon, points, undefined, state.breakStarts);
  if (!snap) return;
  const a = points[snap.index];
  const b = points[Math.min(points.length - 1, snap.index + 1)];
  const span = b.dist - a.dist;
  const t = span > 0 ? Math.min(1, Math.max(0, (snap.currentKm - a.dist) / span)) : 0;
  moveDraftTo(a.lat + (b.lat - a.lat) * t, a.lon + (b.lon - a.lon) * t);
  drawSelection(true);
}

async function save(goNext: boolean): Promise<void> {
  const w = selected();
  const draft = state.drafts.get(w?.id ?? '');
  if (!w || state.saving) return;
  if (!draft || !isDirty(w, draft)) {
    if (goNext) {
      setReviewed(w, true);
      step(1);
    }
    return;
  }
  const changes = draftChanges(w, draft);
  const movedM = haversineDistance(w.lat, w.lon, draft.lat, draft.lon);
  if (changes.position && movedM > 2000 && !confirm(`Move “${w.name}” ${(movedM / 1000).toFixed(1)} km?`)) return;
  if (changes.description && !draft.description.trim() && w.description) {
    if (!confirm(descriptionField(w).removeConfirm)) return;
  }
  const request: WaypointEditRequest = {
    expected: { name: w.name, lat: w.lat, lon: w.lon, description: w.description, type: w.type },
  };
  if (changes.name) request.name = draft.name.trim();
  if (changes.type) request.type = draft.type;
  if (changes.position) Object.assign(request, { lat: draft.lat, lon: draft.lon });
  if (changes.description) request.description = draft.description.trim();

  state.saving = true;
  renderButtons();
  try {
    const result = await api<WaypointEditResponse>(
      `/trails/${encodeURIComponent(state.trail!.dir)}/waypoints/${encodeURIComponent(w.id)}`,
      { method: 'POST', body: request }
    );
    // A renamed or moved pending waypoint comes back under a new temporary key:
    // the row, the dot, the selection and the address follow it, and nothing
    // (draft, review mark, what "Show more" revealed) stays under the old one.
    const previousId = w.id;
    replaceWaypoint(result.waypoint, previousId);
    state.drafts.delete(previousId);
    if (result.waypoint.id !== previousId) {
      if (state.selectedId === previousId) state.selectedId = result.waypoint.id;
      if (previousId in state.marks) {
        delete state.marks[previousId];
        saveMarks();
      }
      const trailId = state.trail!.id;
      if (revealed.comments?.key === commentsRevealKey(trailId, previousId)) {
        // A save keeps what is revealed: it is the same waypoint under its new key.
        revealed.comments = { ...revealed.comments, key: commentsRevealKey(trailId, result.waypoint.id) };
      }
      syncUrl();
    }
    if (goNext || $<HTMLInputElement>('wpe-reviewed').checked) setReviewed(result.waypoint, true);
    void refreshChanges();
    if (goNext) {
      step(1);
      showNotes(result.notes.map(n => `${result.waypoint.name}: ${n}`));
    } else {
      fillForm();
      drawSelection(false);
      renderList();
      showNotes([`Saved to ${result.changedFiles.join(', ') || 'no file (nothing changed)'}.`, ...result.notes]);
    }
  } catch (error) {
    showNotes([error instanceof Error ? error.message : String(error)], true);
  } finally {
    state.saving = false;
    renderButtons();
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
  addDot(m, w);
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

function renderComments(): void {
  const w = selected();
  if (!w || !state.trail) return;
  revealed.comments = revealFor(revealed.comments, commentsRevealKey(state.trail.id, w.id), COMMENTS_PAGE_SIZE);
  revealed.orphans = revealFor(revealed.orphans, state.trail.id, ORPHAN_IDS_PAGE_SIZE);
  $('wpe-comments-count').textContent = commentsCountText(state.comments, w.id);
  $('wpe-comments-body').innerHTML = commentsSectionHtml(state.comments, w.id, {
    // A merged-away id is live (it is in its survivor's mergedIds, and has a row here), not lost.
    orphaned: orphanedCommentIds(state.comments, knownCommentIds(state.trail.waypoints)),
    shown: revealed.comments.shown,
    orphansShown: revealed.orphans.shown,
    note: mergeCommentsNote(w, state.byId, state.commentCounts),
  });
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
  renderComments();
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
  renderComments();
  const result = await pending;
  if (result.kind === 'error') commentsCache.delete(trailId); // retry on the next load
  if (state.trail?.id !== trailId) return;
  state.comments = result;
  state.commentCounts = commentCounts(result);
  renderComments();
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
  const snap = snapToTrail(lat, lon, trail.track.points, undefined, state.breakStarts);
  $('wpe-new-where').textContent =
    `${state.adding.lat}, ${state.adding.lon}` +
    (snap
      ? ` · nearest route km ${snap.currentKm.toFixed(2)} · ${Math.round(snap.offTrailMeters)} m from the route`
      : '');
  renderNewButtons();
}

function renderNewButtons(): void {
  const ready = !!state.adding && !!$<HTMLInputElement>('wpe-new-name').value.trim();
  $<HTMLButtonElement>('wpe-new-add').disabled = !ready || state.saving || state.rebuilding;
}

async function addNew(): Promise<void> {
  const trail = state.trail;
  const at = state.adding;
  if (!trail || !at || state.saving) return;
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
    await loadTrail(trail.dir, result.waypoint.id);
    showNotes([`Added to ${result.changedFiles.join(', ')}.`, ...result.notes]);
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
  const rows = visibleWaypoints();
  const index = rows.findIndex(x => x.id === w.id);
  const next = rows[index + 1] ?? rows[index - 1] ?? null;
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
    await loadTrail(trail.dir, next?.id ?? null);
    const notes = [`Deleted from ${result.changedFiles.join(', ')}.`, ...result.notes];
    if (state.selectedId) showNotes(notes);
    else banner(notes.join(' '));
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

async function loadTrail(dir: string, keepSelection?: string | null): Promise<void> {
  banner(null);
  try {
    const trail = await api<EditorTrail>(`/trails/${encodeURIComponent(dir)}`);
    if (state.trail?.id !== trail.id) state.drafts.clear();
    state.trail = trail;
    state.byId = new Map(trail.waypoints.map(w => [w.id, w]));
    // A draft outlives its waypoint when a rebuild gives a pending one its id (or retires a deleted one).
    for (const id of [...state.drafts.keys()]) if (!state.byId.has(id)) state.drafts.delete(id);
    state.breakStarts = routeBreakStarts(trail.track.breaks, 'displayPoints');
    state.marks = loadMarks(trail.id);
    storageSet(TRAIL_KEY, dir);
    if (trail.readOnlyReason) banner(trail.readOnlyReason);
    void refreshComments(trail.id);
    renderFilters();
    await ensureMap();
    drawTrail();
    select(keepSelection && state.byId.has(keepSelection) ? keepSelection : null);
  } catch (error) {
    state.trail = null;
    state.byId.clear();
    renderList();
    select(null);
    banner(error instanceof Error ? error.message : String(error));
  }
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
  if (state.rebuilding) return;
  const unsaved = state.trail?.waypoints.filter(w => isDirty(w, state.drafts.get(w.id))).length ?? 0;
  if (
    unsaved &&
    !confirm(`${unsaved} waypoint(s) have unsaved changes, which the rebuild will not include. Rebuild anyway?`)
  )
    return;
  state.rebuilding = true;
  renderButtons();
  const drawer = $('wpe-changes');
  drawer.hidden = false;
  $('wpe-changes-btn').setAttribute('aria-expanded', 'true');
  $('wpe-rebuild').textContent = 'Rebuilding…';
  try {
    let status = await api<RebuildStatus>('/rebuild', { method: 'POST' });
    renderRebuild(status);
    while (status.state === 'running') {
      await new Promise(resolve => setTimeout(resolve, 1500));
      status = await api<RebuildStatus>('/rebuild');
      renderRebuild(status);
    }
    if (state.trail) await loadTrail(state.trail.dir, state.selectedId);
  } catch (error) {
    banner(error instanceof Error ? error.message : String(error));
  } finally {
    state.rebuilding = false;
    $('wpe-rebuild').textContent = 'Rebuild trail data';
    renderButtons();
    void refreshChanges();
  }
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
    const dirty = state.trail?.waypoints.some(w => isDirty(w, state.drafts.get(w.id)));
    if (dirty && !confirm('Discard the unsaved changes on this trail?')) {
      (e.target as HTMLSelectElement).value = state.trail!.dir;
      return;
    }
    void loadTrail(dir);
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
  $('wpe-lat').addEventListener('change', onLatLonInput);
  $('wpe-lon').addEventListener('change', onLatLonInput);
  $<HTMLInputElement>('wpe-paste').addEventListener('input', e => {
    const input = e.target as HTMLInputElement;
    const at = parseLatLon(input.value);
    input.setCustomValidity(input.value && !at ? 'Not a position' : '');
    if (at) {
      moveDraftTo(at.lat, at.lon);
      drawSelection(true);
      input.value = '';
    }
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
    if (target.closest('[data-comments-reload]') && state.trail) {
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
  $('wpe-revert').addEventListener('click', () => {
    const w = selected();
    if (!w) return;
    state.drafts.delete(w.id);
    fillForm();
    drawSelection(false);
    renderList();
  });
  $('wpe-reset-pos').addEventListener('click', () => {
    const w = selected();
    const draft = currentDraft();
    if (!w || !draft) return;
    setDraft(w.id, { ...draft, lat: w.lat, lon: w.lon });
    fillPosition();
    drawSelection(true);
    renderButtons();
    renderList();
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
      box.checked = !box.checked;
      box.dispatchEvent(new Event('change'));
    } else if (e.altKey && e.code === 'KeyP') {
      e.preventDefault();
      setPlacing(!state.placing);
    } else if (e.key === 'Escape') {
      if (state.adding !== undefined) endAdding();
      else if (state.placing) setPlacing(false);
      else if (!typing || e.target === $('wpe-desc') || e.target === $('wpe-name')) $('wpe-revert').click();
    } else if (e.key === '/' && !typing) {
      e.preventDefault();
      $('wpe-search').focus();
    }
  });

  window.addEventListener('beforeunload', e => {
    if (state.trail?.waypoints.some(w => isDirty(w, state.drafts.get(w.id)))) e.preventDefault();
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
  await loadTrail(dir, params.get('id'));
}

void boot();
