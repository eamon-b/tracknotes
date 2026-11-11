/**
 * The route a plan walks, as a guide trail.
 *
 * A plan may take a trail's alternates (`@lib/plan-alternates`); when it does,
 * every figure the planner shows — day lengths, climb, the places to stop,
 * suggestions, resupply legs — is measured along the main route with those
 * alternates spliced in. This builds that trail from the guide's trail *as
 * stored* (the splice works in NOBO km) and then applies the guide's direction,
 * exactly as `GuideContext` does for the main route.
 *
 * With no alternate taken it is the guide trail itself, so nothing downstream
 * re-renders or recomputes for plans that never take one — unless a POI was
 * found along a variant, which the plan's lists place at its junction or leave
 * out (`plannedRouteTrail`).
 */

import { useMemo } from 'react';
import {
  mainKmToRoute,
  plannedRouteFor,
  plannedRouteTrail,
  type PlannableTrail,
  type PlannedRoute,
} from '@lib/plan-alternates';
import { toActiveKm, toNoboKm, type PlanDirection } from '@lib/plan-direction';
import type { PlanDocument } from '@lib/plan-types';
import { routeBreakStarts } from '@lib/route-breaks';
import type { GuidePosition } from '../../hooks/useGuidePosition';
import { isOffTrail, snapToTrail, type SnapResult } from '@lib/position-on-trail';
import type { TrailJson } from '../../services/trail-assets';
import type { Direction } from '../../state/settings-store';
import { useGuide } from '../guide/GuideContext';
import { resolveGuideTrail } from '../guide/guide-trail';

export interface PlanRoute {
  /** The splice: which alternates, and where everything is in route km. */
  route: PlannedRoute;
  /** The guide trail as the plan walks it, direction applied. */
  trail: TrailJson;
  /** The guide trail as stored (NOBO, no alternate spliced in). */
  baseTrail: TrailJson;
}

/** The trail as stored, in the shape the splice reads. */
export function plannableTrail(trail: TrailJson): PlannableTrail {
  return trail as unknown as PlannableTrail;
}

/**
 * Spliced trails per stored trail object, per route and direction. The Plan
 * screen, the resupply picker and the waypoint screen all ask for the same
 * one; splicing the CDT's 20,000-odd points once per screen mount is waste.
 */
const splicedCache = new WeakMap<TrailJson, WeakMap<PlannedRoute, Map<Direction, TrailJson>>>();

/** Pure half of the hook. */
export function planRouteOf(
  baseTrail: TrailJson,
  guideTrail: TrailJson,
  direction: Direction,
  route: PlannedRoute,
): TrailJson {
  let byRoute = splicedCache.get(baseTrail);
  if (!byRoute) {
    byRoute = new WeakMap();
    splicedCache.set(baseTrail, byRoute);
  }
  let byDirection = byRoute.get(route);
  if (!byDirection) {
    byDirection = new Map();
    byRoute.set(route, byDirection);
  }
  let trail = byDirection.get(direction);
  if (!trail) {
    const spliced = plannedRouteTrail(plannableTrail(baseTrail), route) as unknown as TrailJson;
    // Nothing moved (no alternate taken, no POI on a variant): the guide's own.
    trail = spliced === baseTrail ? guideTrail : resolveGuideTrail(spliced, direction);
    byDirection.set(direction, trail);
  }
  return trail;
}

/**
 * The last fix snapped to a planned route, kept so the panes that ask for the
 * same fix on the same route — the distance strip and the elevation profile
 * are often mounted together — share one scan of it (an exact scan: about
 * 20,000 points on the CDT) rather than each running their own.
 */
let lastSnap: {
  lat: number;
  lon: number;
  trail: TrailJson;
  snap: SnapResult | null;
} | null = null;

/** The fix snapped to the planned route, whatever its off-trail distance. */
function snapFixToRoute(fix: { lat: number; lon: number }, trail: TrailJson): SnapResult | null {
  if (lastSnap && lastSnap.trail === trail && lastSnap.lat === fix.lat && lastSnap.lon === fix.lon)
    return lastSnap.snap;
  const { points, breaks } = trail.track;
  const snap = snapToTrail(fix.lat, fix.lon, points, undefined, routeBreakStarts(breaks, 'points'));
  lastSnap = { lat: fix.lat, lon: fix.lon, trail, snap };
  return snap;
}

/**
 * The active-direction route km of the guide's GPS fix, on the route as
 * planned (`trail`, from `planRouteOf`); null without an on-trail fix.
 *
 * With no alternate taken the guide's own snap is already in route km. With
 * one, the raw fix is snapped to the planned route: the guide's km is along
 * the main route, which runs ahead of or behind the route once it has passed
 * an alternate, and a hiker on the alternate is "off" the main route.
 */
export function routeKmOfFix(
  position: Pick<GuidePosition, 'status' | 'currentKm' | 'position'>,
  route: PlannedRoute,
  trail: TrailJson,
): number | null {
  if (route.alternates.length === 0) return position.status === 'fix' ? position.currentKm : null;
  if (!position.position) return null;
  const snap = snapFixToRoute(position.position, trail);
  return snap && !isOffTrail(snap.offTrailMeters) ? snap.currentKm : null;
}

/**
 * Active-direction route km of an active-direction main-route km, or null when
 * the route as planned does not pass it (a taken alternate bypasses it).
 */
export function mainActiveKmToRoute(
  route: PlannedRoute,
  km: number,
  direction: PlanDirection,
): number | null {
  const routeKm = mainKmToRoute(route, toNoboKm(km, direction, route.mainTotalDistance));
  return routeKm === null ? null : toActiveKm(routeKm, direction, route.totalDistance);
}

/**
 * Where the guide's position is along the route as planned (active direction),
 * for a surface that measures or draws along that route — the distance strip's
 * "Next resupply", the elevation profile's position line.
 *
 * With no alternate taken the guide's own km is the answer, as it always was
 * (an off-trail fix still has the km it snapped to). With one, the fix is
 * snapped to the planned route (breaks respected), and an off-trail fix keeps
 * that km too — a hiker who walks 200 m off a taken alternate into a planned
 * town is still at that town's km — unless the fix is nearer the main route
 * (`offTrailMeters` is the guide's main-route snap) than the planned one. Then
 * the guide's main-route km is carried over when the planned route passes it,
 * and the answer is null when it does not: the hiker is somewhere the plan
 * does not go, such as the main route a taken alternate bypasses. Without a
 * raw fix, the guide's km is carried over the same way.
 */
export function guideKmOnRoute(
  position: Pick<GuidePosition, 'currentKm' | 'offTrailMeters' | 'position'>,
  route: PlannedRoute,
  trail: TrailJson,
  direction: PlanDirection,
): number | null {
  if (route.alternates.length === 0) return position.currentKm;
  const snap = position.position ? snapFixToRoute(position.position, trail) : null;
  if (snap && !isOffTrail(snap.offTrailMeters)) return snap.currentKm;
  const mainOff = position.offTrailMeters;
  // Off both lines: the hiker belongs to whichever is nearer (a tie is a
  // stretch the two share, where either answer is the same place).
  if (snap && (mainOff == null || snap.offTrailMeters <= mainOff)) return snap.currentKm;
  return position.currentKm == null
    ? null
    : mainActiveKmToRoute(route, position.currentKm, direction);
}

export function usePlanRoute(plan: PlanDocument | undefined): PlanRoute {
  const { baseTrail, trail, direction } = useGuide();
  // Cached per trail object and set of alternates, so this is the same object
  // render after render until the plan takes or drops one.
  const route = plannedRouteFor(plannableTrail(baseTrail), plan);
  const routeTrail = useMemo(
    () => planRouteOf(baseTrail, trail, direction, route),
    [baseTrail, trail, direction, route],
  );
  return { route, trail: routeTrail, baseTrail };
}
