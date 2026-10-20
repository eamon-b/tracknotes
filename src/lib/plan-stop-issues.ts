/**
 * Plan stops the current trail data no longer explains.
 *
 * A stop is stored by waypoint id and km (`PlanStop`), and the trail it was
 * saved against can change under it: a place deleted or re-keyed, the track
 * shortened, an alternate renamed, removed or cut short. `refreshStopKms`
 * moves a stop whose place merely moved; everything it cannot fix used to
 * fall out of sight — a stop past the new end of the trail dropped out of the
 * days (its rest nights with it), a stop on a vanished alternate was hidden
 * from the route view for good, one past a shortened alternate's end was
 * clamped to its branch or rejoin — or carried on silently at a km its place
 * no longer has.
 *
 * `planStopIssues` names each such stop and why, so both planners can keep it
 * on screen and tell the hiker. It never edits the plan: the stop keeps its
 * stored km until the hiker moves or removes it (the app informs, it does not
 * decide).
 *
 * RN-safe: no DOM, no Node.
 */

import { isStopAtPlace } from './day-calculator';
import { KM_EPSILON } from './plan-direction';
import { planDataIsCurrent } from './plan-editor';
import type { PlanDocument, PlanStop } from './plan-types';
import {
  ALTERNATE_END_SLACK_KM,
  buildPlannedRoute,
  mainKmToRoute,
  plannableAlternates,
  stopRouteKm,
  stopsHiddenOnRoute,
  type PlannableTrail,
  type PlannedRoute,
} from './plan-alternates';
import { USER_WAYPOINT_ID_PREFIX } from './user-waypoints';

/**
 * Why a stop needs checking:
 * - `waypoint-missing`: its place is not in the trail data on its line any more;
 * - `waypoint-moved`: its place moved, but another stop already sits at the
 *   new km, so it was not moved with it (`refreshStopKms`);
 * - `off-route`: its km is past an end of the trail as it is now;
 * - `alternate-missing`: it is on an alternate the trail no longer offers;
 * - `off-alternate`: it is past an end of its alternate as it is now;
 * - `not-on-route`: the route the plan walks does not pass it (a stretch a
 *   taken alternate bypasses, or an alternate the plan does not take);
 * - `duplicate`: another stop is at the same place on the route;
 * - `newer-data`: the plan was saved against newer trail data than this
 *   device has, so the data cannot say whether the stop is right.
 */
export type StopIssueReason =
  | 'waypoint-missing'
  | 'waypoint-moved'
  | 'off-route'
  | 'alternate-missing'
  | 'off-alternate'
  | 'not-on-route'
  | 'duplicate'
  | 'newer-data';

/** One stop that needs checking. */
export interface StopIssue {
  /** The stop as stored (NOBO km, its `alternate`), unchanged. */
  stop: PlanStop;
  reason: StopIssueReason;
  /**
   * The stop's km on the route the plan walks (NOBO route km) when it still
   * ends a day there, else null. A placed stop stays in its day card with a
   * warning; an unplaced one has nowhere on the route, so it is listed apart
   * and its nights are not in the dates.
   */
  routeKm: number | null;
}

/** The trail as stored (NOBO km, alternates unspliced) — what both planners hold. */
export interface StopIssuesTrail extends PlannableTrail {
  offTrailWaypoints?: Array<{ id?: string }>;
}

export interface PlanStopIssuesOptions {
  /** The route `plan` walks on `trail`; built here when absent. */
  route?: PlannedRoute;
  /**
   * When this trail data was published. Data older than the plan was last
   * saved against (`planDataIsCurrent`) cannot judge its stops: every issue is
   * then reported as `newer-data`. Omit when the data time is not known.
   */
  dataUpdatedAt?: string | null;
}

/**
 * The stops of a stored plan that need checking against `trail`, in the
 * plan's stop order. Empty when every stop is where the data says it is.
 *
 * Hiker waypoints (`hw_` ids) are never reported missing: they are the
 * hiker's own places, loaded beside the trail on the phone and not at all on
 * the web, so their absence from a trail object says nothing.
 */
export function planStopIssues(
  plan: PlanDocument,
  trail: StopIssuesTrail,
  opts: PlanStopIssuesOptions = {},
): StopIssue[] {
  if (plan.stops.length === 0) return [];
  const route = opts.route ?? buildPlannedRoute(trail, plan.alternates);
  const total = trail.track.totalDistance;
  const alternates = new Map(plannableAlternates(trail).map(a => [a.name, a]));

  const placesOn = (places: ReadonlyArray<{ id?: string; totalDistance?: number }> | undefined) => {
    const byId = new Map<string, number | undefined>();
    for (const place of places ?? []) {
      if (place.id && !byId.has(place.id)) byId.set(place.id, place.totalDistance);
    }
    return byId;
  };
  const main = placesOn(trail.waypoints);
  // A stop can be made at an off-route place too: it is still in the data.
  for (const place of trail.offTrailWaypoints ?? []) {
    if (place.id && !main.has(place.id)) main.set(place.id, undefined);
  }
  const onAlternate = new Map<string, Map<string, number | undefined>>();
  for (const variant of trail.alternates ?? []) {
    if (!onAlternate.has(variant.name)) onAlternate.set(variant.name, placesOn(variant.waypoints));
  }

  const hidden = new Set(stopsHiddenOnRoute(plan, route));
  const stale = opts.dataUpdatedAt !== undefined && !planDataIsCurrent(plan, opts.dataUpdatedAt);

  const issues: StopIssue[] = [];
  for (const stop of plan.stops) {
    const routeKm = hidden.has(stop) ? null : stopRouteKm(route, stop);
    const reason = routeKm === null
      ? unplacedReason(stop, route, total, alternates)
      : placeReason(stop, stop.alternate === undefined ? main : onAlternate.get(stop.alternate));
    if (reason) issues.push({ stop, reason: stale ? 'newer-data' : reason, routeKm });
  }
  return issues;
}

/** Why a stop the route view leaves out has no place on it. */
function unplacedReason(
  stop: PlanStop,
  route: PlannedRoute,
  total: number,
  alternates: ReadonlyMap<string, { startKm: number; distanceKm: number }>,
): StopIssueReason {
  if (stop.alternate !== undefined) {
    const alternate = alternates.get(stop.alternate);
    if (!alternate) return 'alternate-missing';
    const along = stop.km - alternate.startKm;
    if (along < -ALTERNATE_END_SLACK_KM || along > alternate.distanceKm + ALTERNATE_END_SLACK_KM) {
      return 'off-alternate';
    }
    return route.alternates.some(a => a.name === stop.alternate) ? 'duplicate' : 'not-on-route';
  }
  if (stop.km < -KM_EPSILON || stop.km > total + KM_EPSILON) return 'off-route';
  return mainKmToRoute(route, stop.km) === null ? 'not-on-route' : 'duplicate';
}

/** Why a stop still on the route does not match its place, or null when it does. */
function placeReason(
  stop: PlanStop,
  places: ReadonlyMap<string, number | undefined> | undefined,
): StopIssueReason | null {
  const id = stop.waypointId;
  if (!id || id.startsWith(USER_WAYPOINT_ID_PREFIX)) return null;
  if (!places?.has(id)) return 'waypoint-missing';
  const km = places.get(id);
  if (typeof km === 'number' && Number.isFinite(km) && !isStopAtPlace(km, stop.km)) return 'waypoint-moved';
  return null;
}

/** What each reason says to the hiker, the same on the web and the phone. */
const REASON_TEXT: Record<StopIssueReason, string> = {
  'waypoint-missing': 'This place is no longer in the trail data',
  'waypoint-moved': 'This place has moved, and another stop is already where it is now',
  'off-route': 'Past the end of the updated trail',
  'alternate-missing': 'On an alternate that is no longer in the trail data',
  'off-alternate': 'Past the end of its alternate in the updated trail data',
  'not-on-route': 'Not on the route this plan walks',
  duplicate: 'At the same place as another stop',
  'newer-data': 'Saved against newer trail data than this device has — update the trail data to check it',
};

export function stopIssueText(reason: StopIssueReason): string {
  return REASON_TEXT[reason];
}

/**
 * The one notice above the plan, or null when nothing needs checking. Says
 * when nights are left out of the dates, because that moves every later date.
 */
export function stopIssuesNotice(issues: readonly StopIssue[]): string | null {
  if (issues.length === 0) return null;
  const head = issues.length === 1
    ? '1 stop needs checking after a trail data update'
    : `${issues.length} stops need checking after a trail data update`;
  const unplacedNights = issues
    .filter(issue => issue.routeKm === null)
    .reduce((sum, issue) => sum + Math.max(0, Number(issue.stop.nights) || 0), 0);
  if (unplacedNights === 0) return `${head}.`;
  return `${head}. ${unplacedNights === 1 ? '1 night is' : `${unplacedNights} nights are`} left out of the dates until you move or remove ${issues.length === 1 ? 'it' : 'them'}.`;
}
