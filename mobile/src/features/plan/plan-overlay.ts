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
 * the main route it bypasses dashed (as the web plan page does). The profile
 * plots the route as planned (`use-plan-route`, as the web plan page plots
 * it), so its stops are ticked at their route km, and the other panes' focus
 * windows — main-route km — are carried across (`mainWindowToRoute`,
 * `routeWindowToMain`).
 *
 * Pure and React-free, so the conversion is testable without a renderer, a
 * canvas, or a native map.
 */

import { findStopIndex } from '@lib/plan-editor';
import {
  mainKmToRoute,
  routeKmToPlan,
  stopRouteKm,
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
 *
 * With a `route` the km are route km and `totalKm` must be the route's length
 * (`route.totalDistance`) — the profile plots the route as planned — so a stop
 * on a taken alternate is ticked where it is along it. Without one they are
 * main-route km: every main-route stop is ticked and no alternate stop is.
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
  const noboKms = plan.stops
    .map((stop) => profileKmOfStop(stop, route))
    .filter((km): km is number => km !== null && km >= -KM_EPSILON && km <= totalKm + KM_EPSILON)
    .map((km) => ({ km }));
  return stopsToActive(noboKms, direction, totalKm)
    .map((stop) => stop.km)
    .sort((a, b) => a - b);
}

/**
 * Where a stop falls on the profile, NOBO km, or null when it is not on the
 * route the plan walks.
 *
 * With a `route` this is the stop's route km (`@lib/plan-alternates`
 * `stopRouteKm`): a stop on a taken alternate is placed along it, and one on a
 * stretch a taken alternate bypasses, on an alternate the plan does not take,
 * or past an end of a shortened alternate has none. Without a `route` every
 * main-route stop is at its own km and no alternate stop is placed.
 */
export function profileKmOfStop(
  stop: Pick<PlanStop, 'km' | 'alternate'>,
  route?: PlannedRoute,
): number | null {
  if (!route) return stop.alternate === undefined ? stop.km : null;
  return stopRouteKm(route, stop);
}

/** A km range, as the guide's focus windows and the profile's zoom are. */
export interface KmRange {
  startKm: number;
  endKm: number;
}

/**
 * Route km (NOBO) of a main-route km (NOBO), for a range rather than a place:
 * a km on a stretch a taken alternate bypasses goes to the same fraction of the
 * way along the alternate, so a range reaching into the bypassed stretch still
 * covers the ground the hiker was looking at. Past either end: clamped.
 */
function mainKmToRouteSpan(route: PlannedRoute, km: number): number {
  const onRoute = mainKmToRoute(route, km);
  if (onRoute !== null) return onRoute;
  for (const segment of route.segments) {
    if (segment.kind !== 'alternate') continue;
    const a = segment.alternate;
    if (km < a.startKm || km > a.endKm) continue;
    const along = a.mainDistanceKm > 0 ? (km - a.startKm) / a.mainDistanceKm : 0;
    return segment.routeFromKm + along * a.distanceKm;
  }
  return km <= 0 ? 0 : route.totalDistance;
}

/**
 * The inverse of `mainKmToRouteSpan`: a km on a taken alternate goes to the
 * same fraction of the main stretch it replaces.
 */
function routeKmToMainSpan(route: PlannedRoute, routeKm: number): number {
  const position = routeKmToPlan(route, routeKm);
  if (position.alternate === undefined) return position.km;
  const a = route.alternates.find((alt) => alt.name === position.alternate);
  if (!a) return position.km;
  const along = a.distanceKm > 0 ? (position.km - a.startKm) / a.distanceKm : 0;
  return a.startKm + along * a.mainDistanceKm;
}

/** Both ends of an active-direction range through a NOBO conversion, re-sorted. */
function convertRange(
  range: KmRange,
  direction: PlanDirection,
  fromTotal: number,
  toTotal: number,
  convert: (noboKm: number) => number,
): KmRange {
  const a = toActiveKm(convert(toNoboKm(range.startKm, direction, fromTotal)), direction, toTotal);
  const b = toActiveKm(convert(toNoboKm(range.endKm, direction, fromTotal)), direction, toTotal);
  return { startKm: Math.min(a, b), endKm: Math.max(a, b) };
}

/**
 * A main-route focus window (the map's and the list's, active direction) as a
 * window on the route as planned (the profile's, active direction). The
 * identity when the plan takes no alternate.
 */
export function mainWindowToRoute(
  window: KmRange,
  route: PlannedRoute,
  direction: PlanDirection,
): KmRange {
  if (route.alternates.length === 0) return window;
  return convertRange(window, direction, route.mainTotalDistance, route.totalDistance, (km) =>
    mainKmToRouteSpan(route, km),
  );
}

/** The profile's window on the route as planned, as a main-route focus window. */
export function routeWindowToMain(
  window: KmRange,
  route: PlannedRoute,
  direction: PlanDirection,
): KmRange {
  if (route.alternates.length === 0) return window;
  return convertRange(window, direction, route.totalDistance, route.mainTotalDistance, (km) =>
    routeKmToMainSpan(route, km),
  );
}

/**
 * Main-route km ranges (NOBO) — a saved custom route's on-trail spans — as
 * ranges on the route as planned (NOBO). The part of a range on a stretch a
 * taken alternate bypasses is not on that route and is dropped, so a range
 * across the alternate is split either side of it.
 */
export function mainRangesToRoute(ranges: readonly KmRange[], route: PlannedRoute): KmRange[] {
  if (route.alternates.length === 0) return [...ranges];
  const out: KmRange[] = [];
  for (const range of ranges) {
    for (const segment of route.segments) {
      if (segment.kind !== 'main') continue;
      const lo = Math.max(range.startKm, segment.fromKm);
      const hi = Math.min(range.endKm, segment.toKm);
      if (hi - lo <= KM_EPSILON) continue;
      out.push({
        startKm: segment.routeFromKm + (lo - segment.fromKm),
        endKm: segment.routeFromKm + (hi - segment.fromKm),
      });
    }
  }
  return out;
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
