/**
 * An off-route place's walk in from the route (`offTrailPath`, the way
 * `fetch-access` found over OSM, `[lat, lon]` junction → place) as a dotted
 * Leaflet line, shared by the trail viewer and the plan page so the walk reads
 * the same on both. Only for drawing: every figure for the walk is measured
 * already (`@lib/day-calculator` `placeWalk`).
 */

import type * as Leaflet from 'leaflet';
declare const L: typeof Leaflet;

/** True when the path has a line to draw. */
export function hasAccessPath(path: Array<[number, number]> | undefined): path is Array<[number, number]> {
  return Array.isArray(path) && path.length >= 2;
}

/** The dotted walk in `color`, over a faint white casing so it reads on busy town tiles. */
export function accessPathLayer(path: Array<[number, number]>, color: string): Leaflet.LayerGroup {
  return L.layerGroup([
    L.polyline(path, { color: '#ffffff', weight: 6, opacity: 0.7, interactive: false }),
    L.polyline(path, {
      color,
      weight: 4,
      opacity: 0.9,
      dashArray: '1 8',
      lineCap: 'round',
      interactive: false,
    }),
  ]);
}
