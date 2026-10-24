/**
 * The plan as the map and the elevation profile need it.
 *
 * Both surfaces draw the same two things — which markers are stops, and where
 * the day boundaries fall — and both have to cross the same km boundary to do
 * it. A `PlanStop` is stored NOBO-absolute so a plan survives a direction flip
 * untouched (`@lib/plan-direction`), while the guide trail is
 * direction-applied: its waypoints' `totalDistance` counts from whichever end
 * the hiker is walking from. Converting in one place is what stops the map and
 * the profile from disagreeing about which hut tonight is.
 *
 * A plan may also take alternates (`@lib/plan-alternates`). The map then draws
 * the taken alternate as the route, with its places and their stop rings, and
 * the main route it bypasses dashed (as the web plan page does); the profile
 * stays the main route's, so a stop on the alternate is ticked where the
 * hiker is along the stretch it replaces.
 *
 * Pure and React-free, so the conversion is testable without a renderer, a
 * canvas, or a native map.
 */

import { findStopIndex } from '@lib/plan-editor';
import {
  alternateKmToRoute,
  mainKmToRoute,
  type PlanAlternate,
  type PlannedRoute,
} from '@lib/plan-alternates';
import {
  KM_EPSILON,
  stopsToActive,
  toActiveKm,
  toNoboKm,
  type PlanDirection,
} from '@lib/plan-direction';
import type { PlanDocument, PlanStop } from '@lib/plan-types';

/** The minimum of a waypoint this module needs: the map's and the list's shape both fit. */
export interface OverlayWaypoint {
  id?: string;
  name: string;
  totalDistance?: number;
  /**
   * The alternate this place is on (its `totalDistance` then on that
   * alternate's own scale), or absent for the main route.
   */
  alternate?: string;
  /**
   * Its stored (NOBO) km, when the main route's mirror does not give it: a
   * place on an alternate (`plannedAlternateWaypoints`).
   */
  noboKm?: number;
}

/**
 * Feature ids of the waypoints that are stops of the plan.
 *
 * The id is `waypointFeatureId`'s — the bundled waypoint id, or the
 * `name-index` composite the map falls back to for legacy data without one —
 * because that is the id the marker features carry, and the caller's array
 * order is the same one the collection is built from.
 *
 * Matching goes through the shared editor's `findStopIndex` rather than a bare
 * id lookup, so a stop migrated from the km-keyed `PlanState` (no waypoint id
 * at all) still rings its waypoint. The km fallback only looks at stops on the
 * waypoint's own line: an alternate's km overlaps the main route's, so a place
 * on one must never be ringed by a stop on the other at the same km. An id is
 * unambiguous, so it matches on any line — a place both lines share is one
 * marker, ringed whichever line the stop was made on.
 */
export function plannedStopFeatureIds(
  plan: PlanDocument | undefined,
  waypoints: readonly OverlayWaypoint[],
  direction: PlanDirection,
  totalKm: number,
): Set<string> {
  const ids = new Set<string>();
  if (!plan || plan.stops.length === 0) return ids;

  const byId = new Set(plan.stops.map((stop) => stop.waypointId).filter(Boolean));
  const lines = new Map<string | undefined, PlanDocument>();
  const lineOf = (alternate: string | undefined): PlanDocument => {
    let line = lines.get(alternate);
    if (!line) {
      line = { ...plan, stops: plan.stops.filter((stop) => stop.alternate === alternate) };
      lines.set(alternate, line);
    }
    return line;
  };

  waypoints.forEach((wp, i) => {
    const matched =
      (wp.id !== undefined && byId.has(wp.id)) ||
      findStopIndex(lineOf(wp.alternate), {
        waypointId: wp.id,
        km: wp.noboKm ?? toNoboKm(wp.totalDistance ?? 0, direction, totalKm),
      }) !== -1;
    if (matched) ids.add(wp.id ?? `${wp.name}-${i}`);
  });
  return ids;
}

/**
 * Day-boundary km, in the ACTIVE direction, sorted.
 *
 * Every stop ends a day, so the stop km are the boundaries; the trail's own
 * start and end are implicit and are not ticked (the profile already ends
 * there).
 */
export function plannedStopKms(
  plan: PlanDocument | undefined,
  direction: PlanDirection,
  totalKm: number,
  route?: PlannedRoute,
): number[] {
  if (!plan || plan.stops.length === 0) return [];
  // A stop past either end of the trail as it is now (a data update shortened
  // it) is listed by the Plan screen as needing checking, not ticked off the
  // end of the profile.
  const mainKms = plan.stops
    .map((stop) => profileKmOfStop(stop, route))
    .filter((km): km is number => km !== null && km >= -KM_EPSILON && km <= totalKm + KM_EPSILON)
    .map((km) => ({ km }));
  return stopsToActive(mainKms, direction, totalKm)
    .map((stop) => stop.km)
    .sort((a, b) => a - b);
}

/**
 * Where a stop falls on the main route's profile, NOBO km, or null when it is
 * not on the route the plan walks.
 *
 * The profile is the main route's. A stop on an alternate the plan takes is
 * placed at the same fraction of the main stretch that alternate replaces —
 * 3 km into a 10 km alternate over 6 km of main route ticks 1.8 km past the
 * branch — so the ticks keep the plan's order and the day boundary sits
 * between the branch and the rejoin, where the hiker is. Without a `route`
 * every main-route stop is ticked and no alternate stop is.
 */
export function profileKmOfStop(
  stop: Pick<PlanStop, 'km' | 'alternate'>,
  route?: PlannedRoute,
): number | null {
  if (stop.alternate === undefined) {
    if (!route) return stop.km;
    // On a stretch a taken alternate bypasses: not a day of this plan.
    return mainKmToRoute(route, stop.km) === null ? null : stop.km;
  }
  const alternate = route?.alternates.find((a) => a.name === stop.alternate);
  if (!alternate) return null;
  // Past an end of the alternate as it is now: not ticked at the branch or the
  // rejoin, where it is not (`alternateKmToRoute` is null for it too).
  if (route && alternateKmToRoute(route, alternate.name, stop.km) === null) return null;
  const along = Math.min(Math.max((stop.km - alternate.startKm) / alternate.distanceKm, 0), 1);
  return alternate.startKm + along * alternate.mainDistanceKm;
}

/** What the map draws differently for a plan that takes alternates. */
export interface PlannedRouteLines {
  /** Indices into the trail's `alternates` of the ones the plan takes. */
  takenAlternateIndices: ReadonlySet<number>;
  /** The alternates the plan takes (NOBO junctions and length). */
  taken: readonly PlanAlternate[];
  /** The main route those alternates bypass, as km ranges in the ACTIVE direction. */
  bypassedKm: [number, number][];
}

/**
 * The planned route as the map draws it, or null for a plan that takes no
 * alternate (the map then draws the trail exactly as it always has).
 *
 * `route` is built from the trail as stored; the indices hold on the
 * direction-applied trail too, since reversal keeps the alternates' order.
 */
export function plannedRouteLines(
  route: PlannedRoute,
  direction: PlanDirection,
  totalKm: number,
): PlannedRouteLines | null {
  if (route.alternates.length === 0) return null;
  return {
    takenAlternateIndices: new Set(route.alternates.map((a) => a.index)),
    taken: route.alternates,
    bypassedKm: route.alternates.map((a) => {
      const from = toActiveKm(a.startKm, direction, totalKm);
      const to = toActiveKm(a.endKm, direction, totalKm);
      return [Math.min(from, to), Math.max(from, to)];
    }),
  };
}

/** The minimum of an alternate `plannedAlternateWaypoints` needs. */
export interface OverlayAlternate<W> {
  name?: string;
  waypoints?: W[];
}

/**
 * The stored (NOBO) km of a place on an alternate, from its km in the active
 * direction.
 *
 * Reversal does not mirror an alternate's places the way it mirrors the main
 * route's: it turns the alternate round, so a place `along` km into it going
 * NOBO sits at `(total - endKm) + (length - along)` going SOBO. Mirroring that
 * by the main route's `total - km` is right only when the alternate is exactly
 * as long as the stretch it replaces.
 */
export function alternatePlaceNoboKm(
  alternate: Pick<PlanAlternate, 'startKm' | 'endKm' | 'distanceKm'>,
  activeKm: number,
  direction: PlanDirection,
  totalKm: number,
): number {
  if (direction === 'NOBO') return activeKm;
  const along = activeKm - (totalKm - alternate.endKm);
  return alternate.startKm + (alternate.distanceKm - along);
}

/**
 * The places on the alternates the plan takes, tagged with the alternate and
 * their stored km, to draw beside the main route's markers. A place the main
 * route already has (same id) is left out: it is one marker, and
 * `plannedStopFeatureIds` rings it whichever line its stop is on.
 *
 * `alternates` is the guide trail's (direction applied).
 */
export function plannedAlternateWaypoints<W extends { id?: string; totalDistance?: number }>(
  alternates: readonly OverlayAlternate<W>[] | undefined,
  lines: PlannedRouteLines | null,
  mainWaypoints: readonly { id?: string }[],
  direction: PlanDirection,
  totalKm: number,
): (W & { alternate: string; noboKm: number })[] {
  if (!lines || !alternates) return [];
  const seen = new Set(mainWaypoints.map((wp) => wp.id).filter(Boolean));
  const out: (W & { alternate: string; noboKm: number })[] = [];
  for (const taken of lines.taken) {
    const alternate = alternates[taken.index];
    if (!alternate) continue;
    for (const wp of alternate.waypoints ?? []) {
      if (wp.id !== undefined) {
        if (seen.has(wp.id)) continue;
        seen.add(wp.id);
      }
      const noboKm = alternatePlaceNoboKm(taken, wp.totalDistance ?? 0, direction, totalKm);
      out.push({ ...wp, alternate: taken.name, noboKm });
    }
  }
  return out;
}
