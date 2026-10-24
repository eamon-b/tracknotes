/**
 * The landing page's map overview (issue #163): one marker per trail at its
 * start — curated trails from `data/generated/index.json` (`start`), community
 * routes from the public list (`start`) — each linking to the trail's page.
 *
 * Kept light on purpose. No route's track is downloaded, and Leaflet itself
 * (the same unpkg build, with the same SRI hash, as the trail pages) is only
 * fetched once the map's container comes near the viewport, so a reader who
 * never scrolls to it pays nothing but this module.
 *
 * The pure half (`*MapPoint`, `mapPopupHtml`) is tested in landing-map.test.ts;
 * `mountLandingMap` wires it to Leaflet. Names are user-supplied for community
 * routes: everything that reaches popup or tooltip HTML goes through
 * `escapeHtml`.
 */

import type * as Leaflet from 'leaflet';
import type { CommunityRouteSummary } from '@lib/community-types';
import { communityRouteHref } from './api/community';
import { UNVERIFIED_EXPLANATION, VERIFIED_EXPLANATION, placeLabel } from './community-labels';
import { onThemeChange, themeColor } from './theme';
import { escapeHtml } from './web-utils';

/** Curated, or a community route by its public status. */
export type LandingMapKind = 'curated' | 'verified' | 'unverified';

export interface LandingMapPoint {
  id: string;
  kind: LandingMapKind;
  name: string;
  lat: number;
  lon: number;
  /** Relative to the site root (the landing page's directory). */
  href: string;
  lengthKm: number;
  /** "Victoria, Australia"; "" when unknown. */
  place: string;
  submittedBy: string | null;
}

/** What a curated index entry needs to be placed (see `CuratedTrailEntry`). */
export interface CuratedMapInput {
  id: string;
  name: string;
  lengthKm: number;
  country?: string | null;
  states?: string[];
  start?: { lat: number; lon: number } | null;
}

/** A usable WGS84 position. Anything else (absent, NaN, out of range) is skipped. */
export function isLatLon(value: unknown): value is { lat: number; lon: number } {
  if (typeof value !== 'object' || value === null) return false;
  const { lat, lon } = value as { lat?: unknown; lon?: unknown };
  return (
    typeof lat === 'number' &&
    typeof lon === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180 &&
    // (0, 0) is a placeholder, not a trailhead (the worker's fallback bbox).
    !(lat === 0 && lon === 0)
  );
}

/**
 * The marker for a curated trail, or null when its index entry has no start
 * (an index built before `start` was added).
 */
export function curatedMapPoint(trail: CuratedMapInput): LandingMapPoint | null {
  if (!isLatLon(trail.start)) return null;
  return {
    id: trail.id,
    kind: 'curated',
    name: trail.name,
    lat: trail.start.lat,
    lon: trail.start.lon,
    href: `./trails/${encodeURIComponent(trail.id)}/`,
    lengthKm: trail.lengthKm,
    place: placeLabel(trail.country, trail.states),
    submittedBy: null,
  };
}

/**
 * The marker for a community route: its start, else the centre of its bbox,
 * else null (a list entry without either is left off the map, not the list).
 */
export function communityMapPoint(route: CommunityRouteSummary): LandingMapPoint | null {
  let at: { lat: number; lon: number } | null = isLatLon(route.start) ? route.start : null;
  if (!at && Array.isArray(route.bbox) && route.bbox.length === 4) {
    const [minLon, minLat, maxLon, maxLat] = route.bbox;
    const centre = { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 };
    if (isLatLon(centre)) at = centre;
  }
  if (!at) return null;
  return {
    id: route.id,
    kind: route.status === 'verified' ? 'verified' : 'unverified',
    name: route.name,
    lat: at.lat,
    lon: at.lon,
    href: `./${communityRouteHref(route.id)}`,
    lengthKm: route.lengthKm,
    place: placeLabel(route.country, route.state ? [route.state] : []),
    submittedBy: route.submittedBy ?? null,
  };
}

/** Every placeable marker, curated first so community markers draw on top. */
export function landingMapPoints(
  curated: readonly CuratedMapInput[],
  community: readonly CommunityRouteSummary[]
): LandingMapPoint[] {
  const points: LandingMapPoint[] = [];
  for (const t of curated) {
    const p = curatedMapPoint(t);
    if (p) points.push(p);
  }
  // Verified last, so a verified route is not buried under an unverified one.
  const ordered = [...community].sort((a, b) => Number(a.status === 'verified') - Number(b.status === 'verified'));
  for (const r of ordered) {
    const p = communityMapPoint(r);
    if (p) points.push(p);
  }
  return points;
}

/**
 * The points with western longitudes moved east by 360° when that spans less
 * of the globe — trails in Japan, Australia, New Zealand and the US then fit
 * a Pacific-centred view rather than a whole-world one. Leaflet draws a
 * longitude past 180 on the next world copy, so a marker stays where it is.
 */
export function unwrapLongitudes(points: readonly LandingMapPoint[]): LandingMapPoint[] {
  if (points.length < 2) return [...points];
  const span = (lons: number[]) => Math.max(...lons) - Math.min(...lons);
  const plain = points.map(p => p.lon);
  const shifted = plain.map(lon => (lon < 0 ? lon + 360 : lon));
  if (span(shifted) >= span(plain)) return [...points];
  return points.map(p => (p.lon < 0 ? { ...p, lon: p.lon + 360 } : p));
}

function kmText(km: number): string {
  return Number.isFinite(km) ? `${Number(km.toFixed(1)).toString()} km` : '— km';
}

/** The popup: the name as a link to the trail's page, its badge, length and place. */
export function mapPopupHtml(point: LandingMapPoint): string {
  const badge =
    point.kind === 'verified'
      ? `<span class="list-badge list-badge-verified" title="${escapeHtml(VERIFIED_EXPLANATION)}">Verified</span>`
      : point.kind === 'unverified'
        ? `<span class="list-badge list-badge-unverified" title="${escapeHtml(UNVERIFIED_EXPLANATION)}">Unverified</span>`
        : '';
  const meta = [kmText(point.lengthKm), point.place, point.submittedBy ? `by ${point.submittedBy}` : '']
    .filter(s => s !== '')
    .map(s => escapeHtml(s))
    .join(' · ');
  return `<div class="landing-map-popup"><a class="landing-map-popup-title" href="${escapeHtml(point.href)}">${escapeHtml(point.name)}</a>${badge}<div class="landing-map-popup-meta">${meta}</div></div>`;
}

/** The hover label: the name only, escaped (Leaflet tooltips are HTML). */
export function mapTooltipHtml(point: LandingMapPoint): string {
  return escapeHtml(point.name);
}

// ---------------------------------------------------------------------------
// Leaflet, loaded on demand
// ---------------------------------------------------------------------------

type LeafletModule = typeof Leaflet;

/** The trail pages' Leaflet build: same version and SRI hashes as their templates. */
const LEAFLET_CSS = {
  href: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  integrity: 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=',
};
const LEAFLET_JS = {
  src: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  integrity: 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=',
};

let leafletLoad: Promise<LeafletModule> | null = null;

function globalLeaflet(): LeafletModule | undefined {
  return (globalThis as { L?: LeafletModule }).L;
}

/** Inject Leaflet's stylesheet and script once; resolves with the global `L`. */
export function loadLeaflet(doc: Document = document): Promise<LeafletModule> {
  const existing = globalLeaflet();
  if (existing) return Promise.resolve(existing);
  if (leafletLoad) return leafletLoad;
  leafletLoad = new Promise<LeafletModule>((resolve, reject) => {
    const css = doc.createElement('link');
    css.rel = 'stylesheet';
    css.href = LEAFLET_CSS.href;
    css.integrity = LEAFLET_CSS.integrity;
    css.crossOrigin = '';
    // Before the site's own sheets, so styles.css's Leaflet theming still wins.
    const firstSheet = doc.head.querySelector('link[rel="stylesheet"]');
    doc.head.insertBefore(css, firstSheet);

    const script = doc.createElement('script');
    script.src = LEAFLET_JS.src;
    script.integrity = LEAFLET_JS.integrity;
    script.crossOrigin = '';
    script.async = true;
    script.onload = () => {
      const L = globalLeaflet();
      if (L) resolve(L);
      else reject(new Error('Leaflet loaded without defining L'));
    };
    script.onerror = () => reject(new Error('Leaflet failed to load'));
    doc.head.appendChild(script);
  }).catch((err: unknown) => {
    leafletLoad = null; // let a later attempt retry
    throw err;
  });
  return leafletLoad;
}

// ---------------------------------------------------------------------------
// The map itself
// ---------------------------------------------------------------------------

export interface LandingMapHandle {
  /** Show these markers (the filtered set); redraws once the map exists. */
  update(points: readonly LandingMapPoint[]): void;
}

export interface LandingMapDeps {
  loadLeaflet?: () => Promise<LeafletModule>;
  /** How far below the viewport the map starts loading. */
  rootMargin?: string;
}

function markerStyle(kind: LandingMapKind): Leaflet.CircleMarkerOptions {
  const surface = themeColor('--surface', '#ffffff');
  switch (kind) {
    case 'curated':
      return { radius: 7, color: surface, weight: 2, fillColor: themeColor('--primary', '#2D6A4F'), fillOpacity: 0.95 };
    case 'verified':
      return { radius: 6, color: surface, weight: 2, fillColor: themeColor('--select', '#3b82f6'), fillOpacity: 0.95 };
    case 'unverified':
      return { radius: 5, color: themeColor('--select', '#3b82f6'), weight: 2.5, fillColor: surface, fillOpacity: 0.9 };
  }
}

/** Roughly Australia and New Zealand, for a map with nothing to fit to. */
const FALLBACK_VIEW: { center: [number, number]; zoom: number } = { center: [-30, 145], zoom: 3 };

function createView(L: LeafletModule, container: HTMLElement) {
  const map = L.map(container, {
    // A page that scrolls past the map must not get stuck in it: no wheel
    // zoom, and on a phone one finger scrolls the page (two pinch-zoom).
    scrollWheelZoom: false,
    dragging: !L.Browser.mobile,
    worldCopyJump: true,
    minZoom: 1,
  });
  L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    maxZoom: 17,
    attribution: 'Map data: &copy; OpenStreetMap contributors, SRTM | Map style: &copy; OpenTopoMap',
  }).addTo(map);
  const layer = L.layerGroup().addTo(map);
  const markers: { marker: Leaflet.CircleMarker; kind: LandingMapKind }[] = [];
  let lastKey = '';

  onThemeChange(() => {
    for (const { marker, kind } of markers) marker.setStyle(markerStyle(kind));
  });

  return {
    draw(given: readonly LandingMapPoint[]) {
      map.invalidateSize();
      const points = unwrapLongitudes(given);
      // Refit only when the set changed, so a re-render with the same filter
      // does not undo the reader's panning.
      const key = points.map(p => p.id).join('\n');
      if (key === lastKey && markers.length > 0) return;
      lastKey = key;
      layer.clearLayers();
      markers.length = 0;
      for (const p of points) {
        const marker = L.circleMarker([p.lat, p.lon], markerStyle(p.kind))
          .bindTooltip(mapTooltipHtml(p), { direction: 'top', offset: [0, -6] })
          .bindPopup(mapPopupHtml(p));
        marker.addTo(layer);
        markers.push({ marker, kind: p.kind });
      }
      if (points.length > 0) {
        map.fitBounds(L.latLngBounds(points.map(p => [p.lat, p.lon] as [number, number])), {
          padding: [28, 28],
          maxZoom: 9,
        });
      } else {
        map.setView(FALLBACK_VIEW.center, FALLBACK_VIEW.zoom);
      }
    },
  };
}

/**
 * Attach the overview to `container`. Leaflet is loaded the first time the
 * container nears the viewport (at once where IntersectionObserver is
 * missing); until then `update` only remembers the latest markers.
 */
export function mountLandingMap(container: HTMLElement, deps: LandingMapDeps = {}): LandingMapHandle {
  const load = deps.loadLeaflet ?? (() => loadLeaflet(container.ownerDocument));
  let points: readonly LandingMapPoint[] = [];
  let view: ReturnType<typeof createView> | null = null;
  let started = false;

  const start = () => {
    if (started) return;
    started = true;
    container.classList.add('landing-map-loading');
    load()
      .then(L => {
        container.classList.remove('landing-map-loading');
        view = createView(L, container);
        view.draw(points);
      })
      .catch(() => {
        container.classList.remove('landing-map-loading');
        container.innerHTML =
          '<p class="landing-map-error">The map could not be loaded. Check your connection, or try disabling content blockers.</p>';
      });
  };

  const IO = (globalThis as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver;
  if (IO) {
    const observer = new IO(
      entries => {
        if (entries.some(e => e.isIntersecting)) {
          observer.disconnect();
          start();
        }
      },
      { rootMargin: deps.rootMargin ?? '300px 0px' }
    );
    observer.observe(container);
  } else {
    start();
  }

  return {
    update(next) {
      points = next;
      view?.draw(points);
    },
  };
}
