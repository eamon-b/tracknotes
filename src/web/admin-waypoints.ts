/**
 * The local waypoint editor (`admin-waypoints.html`): review and correct a
 * bundled trail's waypoints — description, name and position — against a map
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
  type RebuildStatus,
  type WaypointEditRequest,
  type WaypointEditResponse,
} from '../../scripts/lib/waypoint-editor/api-types';
import { adminRouteShapes } from './admin-route-map';
import { loadSession } from './api/session';
import {
  commentCounts,
  commentsCountText,
  commentsSectionHtml,
  loadTrailComments,
  orphanedCommentIds,
  type CommentsState,
} from './admin-waypoints-comments';
import {
  STATUS_FILTER_LABELS,
  draftChanges,
  draftOf,
  externalMapLinks,
  isDirty,
  isReviewed,
  matchesFilter,
  movedSinceBuild,
  nearbyPois,
  parseLatLon,
  placementText,
  readoutText,
  reviewFingerprint,
  reviewStorageKey,
  rowHtml,
  typeCounts,
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
  const described = trail.waypoints.filter(w => w.description).length;
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

  for (const w of trail.waypoints) {
    const dot = Lf.circleMarker([w.lat, w.lon], {
      radius: 6,
      color: '#ffffff',
      weight: 2,
      fillColor: familyColor(w.type),
      fillOpacity: 1,
    })
      .bindTooltip(`${escapeHtml(w.name)} <span class="wpe-muted">${escapeHtml(waypointTypeLabel(w.type))}</span>`, {
        direction: 'top',
        offset: [0, -6],
      })
      .on('click', () => {
        if (state.placing) return;
        select(w.id, { pan: false });
      })
      .addTo(m.dots);
    m.dotById.set(w.id, dot);
  }

  for (const p of trail.pois) {
    Lf.circleMarker([p.lat, p.lon], { radius: 4, color: '#555', weight: 1, fillColor: '#ffd166', fillOpacity: 0.9 })
      .bindTooltip(`${escapeHtml(p.name || '(unnamed)')} <span class="wpe-muted">${escapeHtml(p.category)}</span>`)
      .on('click', () => {
        if (state.placing) {
          setPlacing(false);
          moveDraftTo(p.lat, p.lon);
        }
      })
      .addTo(m.pois);
  }

  const bounds = shapes.main.flat();
  if (bounds.length) m.map.fitBounds(Lf.latLngBounds(bounds), { padding: [20, 20] });
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

function fillPosition(): void {
  const draft = currentDraft();
  if (!draft) return;
  updatePositionFields(draft.lat, draft.lon);
  renderReadout(draft.lat, draft.lon);
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
  $<HTMLInputElement>('wpe-lat').disabled = !w.canMove;
  $<HTMLInputElement>('wpe-lon').disabled = !w.canMove;
  $<HTMLInputElement>('wpe-paste').disabled = !w.canMove;
  $<HTMLInputElement>('wpe-paste').value = '';
  const desc = $<HTMLTextAreaElement>('wpe-desc');
  desc.value = draft.description;
  desc.disabled = !w.canDescribe;
  desc.placeholder = w.sourceDescription
    ? 'No curated text: the source text below is what the app shows.'
    : 'No text yet.';

  const meta: string[] = [
    `<span>${waypointGlyphHtml(w.type)} ${escapeHtml(waypointTypeLabel(w.type))} · <code>${escapeHtml(w.id)}</code></span>`,
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
  $('wpe-meta').innerHTML = meta.join('');

  const source = $<HTMLDetailsElement>('wpe-source');
  source.hidden = !w.sourceDescription;
  $('wpe-source-text').textContent = w.sourceDescription ?? '';
  source.open = !w.description && !!w.sourceDescription;

  $<HTMLInputElement>('wpe-reviewed').checked = isReviewed(state.marks, w);
  fillPosition();
  renderDescriptionAids();
  renderButtons();
  renderComments();
}

function select(id: string | null, options: { pan?: boolean } = {}): void {
  setPlacing(false);
  state.selectedId = id && state.byId.has(id) ? id : null;
  showNotes([]);
  fillForm();
  drawSelection(options.pan ?? true);
  renderList();
  scrollSelectedIntoView();
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
    if (!confirm('Remove the curated description? The source text (if any) shows again.')) return;
  }
  const request: WaypointEditRequest = {
    expected: { name: w.name, lat: w.lat, lon: w.lon, description: w.description },
  };
  if (changes.name) request.name = draft.name.trim();
  if (changes.position) Object.assign(request, { lat: draft.lat, lon: draft.lon });
  if (changes.description) request.description = draft.description.trim();

  state.saving = true;
  renderButtons();
  try {
    const result = await api<WaypointEditResponse>(
      `/trails/${encodeURIComponent(state.trail!.dir)}/waypoints/${encodeURIComponent(w.id)}`,
      { method: 'POST', body: request }
    );
    replaceWaypoint(result.waypoint);
    state.drafts.delete(w.id);
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

function replaceWaypoint(w: EditorWaypoint): void {
  const trail = state.trail;
  if (!trail) return;
  const index = trail.waypoints.findIndex(x => x.id === w.id);
  if (index !== -1) trail.waypoints[index] = w;
  state.byId.set(w.id, w);
  const dot = state.map?.dotById.get(w.id);
  dot?.setLatLng([w.lat, w.lon]);
  dot?.setTooltipContent(
    `${escapeHtml(w.name)} <span class="wpe-muted">${escapeHtml(waypointTypeLabel(w.type))}</span>`
  );
}

// ---------------------------------------------------------------------------
// Hikers' comments (read-only, from the comments API)
// ---------------------------------------------------------------------------

/** One bulk read per trail per page load; Reload replaces it. */
const commentsCache = new Map<string, Promise<CommentsState>>();

function renderComments(): void {
  const w = selected();
  if (!w) return;
  $('wpe-comments-count').textContent = commentsCountText(state.comments, w.id);
  $('wpe-comments-body').innerHTML = commentsSectionHtml(state.comments, w.id, {
    orphaned: orphanedCommentIds(state.comments, new Set(state.byId.keys())),
  });
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
// Trails, changes, rebuild
// ---------------------------------------------------------------------------

async function loadTrail(dir: string, keepSelection?: string | null): Promise<void> {
  banner(null);
  try {
    const trail = await api<EditorTrail>(`/trails/${encodeURIComponent(dir)}`);
    if (state.trail?.id !== trail.id) state.drafts.clear();
    state.trail = trail;
    state.byId = new Map(trail.waypoints.map(w => [w.id, w]));
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
    parts.push(
      `<details${status.state === 'failed' ? ' open' : ''}><summary>${status.warnings.length} warning line(s)</summary><pre class="wpe-log">${escapeHtml(status.warnings.join('\n'))}</pre></details>`
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
  $('wpe-comments-body').addEventListener('click', e => {
    if ((e.target as HTMLElement).closest('[data-comments-reload]') && state.trail) {
      void refreshComments(state.trail.id, true);
    }
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
      if (state.placing) setPlacing(false);
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
