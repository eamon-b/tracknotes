/**
 * The admin queue's route map: draws one community route's stored trail
 * (`GET /v1/admin/community/routes/:id/trail`) so an admin can judge a route
 * the AI review or reports hid, which has no public copy to open.
 *
 * Split in two so the geometry is testable without Leaflet: `adminRouteShapes`
 * turns a trail into coordinate lists, and `drawAdminRouteMap` puts them on a
 * map. The main line is cut at `track.breaks` (`@lib/route-breaks`) and each
 * break is drawn as a dashed link, as on the trail pages. Names are
 * user-supplied and Leaflet tooltips are HTML, so every one is escaped.
 */

import type * as Leaflet from 'leaflet';
import { routeBreakCrossings, splitAtRouteBreaks } from '@lib/route-breaks';
import type { ProcessedTrail } from '@lib/trail-types';
import { themeColor } from './theme';
import { escapeHtml } from './web-utils';

type LatLng = [number, number];

export interface AdminRouteShapes {
  /** The main route, one list per walkable stretch between breaks. */
  main: LatLng[][];
  /** Each break's unwalked straight line, from the last point before it to the first after. */
  breaks: { from: LatLng; to: LatLng; km: number }[];
  /** Alternates, side trips and termini. */
  variants: { name: string; type: string; line: LatLng[] }[];
  waypoints: { name: string; type: string; at: LatLng }[];
  start: LatLng | null;
  end: LatLng | null;
}

const ok = (p: { lat: number; lon: number }): boolean => Number.isFinite(p.lat) && Number.isFinite(p.lon);
const ll = (p: { lat: number; lon: number }): LatLng => [p.lat, p.lon];

export function adminRouteShapes(trail: ProcessedTrail): AdminRouteShapes {
  const display = trail.track.displayPoints;
  // `breaks` index whichever array is drawn; name it rather than infer it.
  const which = display && display.length >= 2 ? 'displayPoints' : 'points';
  const points = which === 'displayPoints' ? display : trail.track.points;
  const main = splitAtRouteBreaks(points, trail.track.breaks, which)
    .map(stretch => stretch.filter(ok).map(ll))
    .filter(line => line.length >= 2);
  const breaks = routeBreakCrossings(points, trail.track.breaks, which)
    .filter(c => ok(c.from) && ok(c.to))
    .map(c => ({ from: ll(c.from), to: ll(c.to), km: c.straightLineKm }));
  const variants = [...(trail.alternates ?? []), ...(trail.sideTrips ?? [])]
    .map(v => ({ name: v.name, type: v.type, line: (v.points ?? []).filter(ok).map(ll) }))
    .filter(v => v.line.length >= 2);
  const waypoints = [...(trail.waypoints ?? []), ...(trail.offTrailWaypoints ?? [])]
    .filter(ok)
    .map(w => ({ name: w.name, type: w.type, at: ll(w) }));
  const all = main.flat();
  return {
    main,
    breaks,
    variants,
    waypoints,
    start: all.length ? all[0] : null,
    end: all.length ? all[all.length - 1] : null,
  };
}

/** Every coordinate the map should fit, or none. */
export function adminRouteBounds(shapes: AdminRouteShapes): LatLng[] {
  return [...shapes.main.flat(), ...shapes.variants.flatMap(v => v.line), ...shapes.waypoints.map(w => w.at)];
}

/** A tooltip's HTML: the user-supplied name and type, escaped. */
export function waypointTooltipHtml(name: string, type: string): string {
  return `${escapeHtml(name || '(no name)')} <span class="community-hint">${escapeHtml(type)}</span>`;
}

/**
 * Draw the trail into `container` and return the map, so the caller can
 * `invalidateSize` it after its box changes or `remove` it.
 */
export function drawAdminRouteMap(L: typeof Leaflet, container: HTMLElement, trail: ProcessedTrail): Leaflet.Map {
  const shapes = adminRouteShapes(trail);
  const map = L.map(container, { scrollWheelZoom: false });
  L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    maxZoom: 17,
    attribution: 'Map data: &copy; OpenStreetMap contributors, SRTM | Map style: &copy; OpenTopoMap',
  }).addTo(map);
  L.control.scale({ metric: true, imperial: false }).addTo(map);

  const routeColor = themeColor('--primary', '#2D6A4F');
  const variantColor = themeColor('--select', '#3b82f6');
  for (const v of shapes.variants) {
    L.polyline(v.line, { color: variantColor, weight: 3, opacity: 0.85, dashArray: '4 6' })
      .bindTooltip(waypointTooltipHtml(v.name, v.type), { sticky: true })
      .addTo(map);
  }
  if (shapes.main.length > 0) L.polyline(shapes.main, { color: routeColor, weight: 4, opacity: 0.9 }).addTo(map);
  for (const b of shapes.breaks) {
    L.polyline([b.from, b.to], { color: '#9e9e9e', weight: 2, opacity: 0.9, dashArray: '6 6' })
      .bindTooltip(`Route break: ${escapeHtml(b.km.toFixed(1))} km, not walked`, { sticky: true })
      .addTo(map);
  }
  for (const w of shapes.waypoints) {
    L.circleMarker(w.at, { radius: 4, color: routeColor, weight: 2, fillColor: '#ffffff', fillOpacity: 1 })
      .bindTooltip(waypointTooltipHtml(w.name, w.type), { direction: 'top', offset: [0, -4] })
      .addTo(map);
  }
  if (shapes.start) {
    L.circleMarker(shapes.start, { radius: 6, color: '#ffffff', weight: 2, fillColor: '#2e7d32', fillOpacity: 1 })
      .bindTooltip('Start')
      .addTo(map);
  }
  if (shapes.end) {
    L.circleMarker(shapes.end, { radius: 6, color: '#ffffff', weight: 2, fillColor: '#c62828', fillOpacity: 1 })
      .bindTooltip('End')
      .addTo(map);
  }

  const bounds = adminRouteBounds(shapes);
  if (bounds.length > 0) map.fitBounds(L.latLngBounds(bounds), { padding: [16, 16] });
  else map.setView([-30, 145], 3);
  return map;
}
