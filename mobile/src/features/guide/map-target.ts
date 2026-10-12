/**
 * "Show on map" from a screen above the guide.
 *
 * The waypoint screen sits on the guide stack above the three-pane guide, so it
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
