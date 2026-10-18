/**
 * "Show on map" from a screen above the guide.
 *
 * The waypoint, POI, Today, Day and Plan screens sit on the guide stack above the three-pane guide, so it
 * cannot reach the map pane's camera directly. It leaves a request here and
 * dismisses back to the guide; the guide takes the request when it regains
 * focus (`GuideView`) and hands it to `showOnMap`. Keyed by trail, and taken
 * at most once, so a request can never move another guide's map or replay.
 */

import type { MapPoint } from './GuideFocusContext';

const targets = new Map<string, MapPoint>();

/** Ask the trail's guide to centre its map on a place next time it is shown. */
export function requestMapTarget(trailId: string, point: MapPoint): void {
  targets.set(trailId, point);
}

/** The trail's pending request, removed as it is read; null when there is none. */
export function takeMapTarget(trailId: string): MapPoint | null {
  const point = targets.get(trailId) ?? null;
  targets.delete(trailId);
  return point;
}

/**
 * Where "Show on map" takes the map for a place: its own position (not where
 * the route passes it) and, for an off-route place with a routed walk, the way
 * in from the junction (`offTrailPath`), which the map dots and frames.
 */
export function mapPointOf(place: {
  lat: number;
  lon: number;
  offTrailPath?: readonly (readonly [number, number])[];
}): MapPoint {
  return place.offTrailPath
    ? { lat: place.lat, lon: place.lon, accessPath: place.offTrailPath }
    : { lat: place.lat, lon: place.lon };
}
