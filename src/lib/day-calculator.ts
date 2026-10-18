/**
 * Day calculator engine for the multi-day trip planner.
 *
 * Pure functions: trail + stops → computed days with distance, elevation,
 * water sources, and hiking time estimates.
 *
 * Shared between the web planner and the mobile app. Parameter types are
 * structural so both platforms' trail/stop shapes are accepted as-is:
 * the web StopData ({ km, waypointName }) and the mobile StopData
 * ({ id, waypointName, waypointType, km, customLocation? }) both satisfy
 * PlanStopInput.
 */

import type { SectionConfig, ComputedDay, PlanTrackPoint, PlanWaypoint } from './plan-types';
import {
  calculateElevationBetween,
  findNearestByDistance,
  hasCumulativeElevation,
  NO_BREAK_STARTS,
} from './track-geometry';
import type { ElevationPoint } from './track-geometry';
import { routeBreakStarts } from './route-breaks';
import type { RouteBreak } from './trail-types';
import { isAccessWaypoint, isWaterWaypoint } from './waypoint-taxonomy';
import type { WaypointAccess } from './types';
import { isUnverifiedHikerWaypoint } from './user-waypoints';

/** Trail shape accepted by computeDays (subset of the full Trail interfaces). */
export interface PlanTrail {
  config: { name: string };
  track: {
    points: PlanTrackPoint[];
    totalDistance: number;
    /** Route breaks; the step into each is not walked, so it is not climbed. */
    breaks?: readonly Pick<RouteBreak, 'index' | 'displayIndex'>[];
  };
  waypoints?: PlanWaypoint[];
}

/** Minimal stop shape accepted by computeDays. */
export interface PlanStopInput {
  /** totalDistance position on trail in km */
  km: number;
  waypointName?: string | null;
  customLocation?: { name: string };
  /** The walk between the route and the stop, when it is off the route (`placeWalk`). */
  walk?: PlaceWalk | null;
}

/**
 * The walk between the route and an off-route place, measured walking IN
 * (from the junction to the place). Walking back out covers the same km with
 * the climb and descent swapped.
 */
export interface PlaceWalk {
  km: number;
  ascentM: number;
  descentM: number;
}

/**
 * The longest off-trail distance taken to be walked when the data does not say
 * how it is covered — every one of Te Araroa's. Its turn-offs fall into two
 * groups with a gap between them: 3.1 km and under (Kerikeri 0.7, Mt Potts
 * Lodge 3.0), then 4.5 km and up (Warkworth 6, Te Anau 35). The CDT, whose data
 * does say, walks to a median 4 km and hitches from 6.4 km, so 5 km sits
 * between what gets walked and what gets hitched. A stated mode always wins.
 */
export const WALKED_WHEN_UNSAID_MAX_KM = 5;

/**
 * The walk to a place off the route, or null when there is none to make: the
 * place is on the route, it is a turn-off (the point on the route itself), or
 * it is reached by a ride (a hitch, a shuttle, a boat, or a distance too long
 * to be a walk when the data does not say — `WALKED_WHEN_UNSAID_MAX_KM`).
 */
export function placeWalk(
  place: (WaypointAccess & { type?: string | null }) | null | undefined
): PlaceWalk | null {
  if (!place || isAccessWaypoint(place.type)) return null;
  const km = place.offTrailKm;
  if (typeof km !== 'number' || !Number.isFinite(km) || km <= 0) return null;
  const mode = place.accessMode;
  const walked =
    mode === 'foot' || mode === 'on-trail' || (mode === undefined && km <= WALKED_WHEN_UNSAID_MAX_KM);
  if (!walked) return null;
  const metres = (value: number | undefined) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
  return { km, ascentM: metres(place.offTrailAscentM), descentM: metres(place.offTrailDescentM) };
}

/**
 * How far (km) a plan stop may sit from its waypoint's km and still be at it.
 * A stop is saved at its waypoint's km, so the two differ only by the
 * direction mirror's rounding — or because the data moved the place.
 */
export const STOP_AT_PLACE_KM = 0.05;

/**
 * The walk for a plan stop at `stopKm` (the same km space as `place`) whose
 * waypoint is `place`: `placeWalk`, but only while the stop still sits at the
 * place's km. A stop saved before a data update moved its place (to a junction
 * found over OSM, say) still ends its day at the old km, so it already walks
 * the old way there; adding the walk as well would count both.
 */
export function stopWalk(
  place: (WaypointAccess & { type?: string | null; totalDistance?: number }) | null | undefined,
  stopKm: number
): PlaceWalk | null {
  if (!place || typeof place.totalDistance !== 'number') return null;
  if (Math.abs(place.totalDistance - stopKm) > STOP_AT_PLACE_KM) return null;
  return placeWalk(place);
}

/** A stretch's distance and climb. */
export interface LegTotals {
  distanceKm: number;
  ascentM: number;
  descentM: number;
}

/**
 * A stretch with the walks off the route added: back out from the place it
 * starts at (climbing what the walk in descended) and in to the place it ends
 * at. `offTrailKm` is the part of `distanceKm` walked off the route. The one
 * home of this rule — the day splitter, the suggester, the phone's Stops-list
 * legs and Today rows all add walks through it, so they add up to one day.
 */
export function addPlaceWalks(
  leg: LegTotals,
  walkOut: PlaceWalk | null | undefined,
  walkIn: PlaceWalk | null | undefined
): LegTotals & { offTrailKm: number } {
  const offTrailKm = (walkOut?.km ?? 0) + (walkIn?.km ?? 0);
  return {
    distanceKm: leg.distanceKm + offTrailKm,
    ascentM: leg.ascentM + (walkOut?.descentM ?? 0) + (walkIn?.ascentM ?? 0),
    descentM: leg.descentM + (walkOut?.ascentM ?? 0) + (walkIn?.descentM ?? 0),
    offTrailKm,
  };
}

/**
 * Estimate hiking time using Naismith's rule with Tranter's correction for descent
 * (unrounded). This is the raw internal variant used by the day splitter and the
 * time index, so boundary search does not staircase on the public 0.1 h rounding.
 *
 *   time = distance/baseKmh + ascent/600 + max(0, (descent-300)/600)
 *
 * The descent term's 300 m allowance is *per call* — it is a per-day allowance, so
 * callers must pass whole-day (whole-segment) ascent/descent, never per-point sums.
 *
 * @param baseKmh - flat-ground base speed: the hiker's pace. Required — a
 *   shared calculator never assumes one.
 */
export function estimateHikingHoursRaw(
  distanceKm: number,
  ascentM: number,
  descentM: number,
  baseKmh: number,
): number {
  return distanceKm / baseKmh + ascentM / 600 + Math.max(0, (descentM - 300) / 600);
}

/**
 * Estimate hiking time using Naismith's rule with Tranter's correction for descent:
 *   time = distance/baseKmh + ascent/600 + max(0, (descent-300)/600)
 * Returns hours rounded to 1 decimal.
 *
 * @param baseKmh - flat-ground base speed: the hiker's pace. Required.
 */
export function estimateHikingTime(
  distanceKm: number,
  ascentM: number,
  descentM: number,
  baseKmh: number,
): number {
  const hours = estimateHikingHoursRaw(distanceKm, ascentM, descentM, baseKmh);
  return Math.round(hours * 10) / 10;
}

/**
 * Prefix-sum time index for O(log n) Naismith segment queries.
 *
 * Holds cumulative ascent/descent aligned to a distance-sorted track so that the
 * ascent/descent over any [fromKm, toKm] range can be recovered as a difference of
 * two prefix entries — reproducing exactly what `calculateElevationBetween` computes
 * (nearest-point snapping at each endpoint, no fractional-km interpolation, gain/loss
 * rounded to whole metres per query).
 */
export interface TimeIndex {
  /** The distance-sorted points the index was built from (used for nearest lookup). */
  points: ElevationPoint[];
  /** ascent[i] = cumulative positive elevation change from point 0 to point i. */
  ascent: number[];
  /** descent[i] = cumulative absolute negative elevation change from point 0 to point i. */
  descent: number[];
}

/**
 * Build a prefix-sum time index from a distance-sorted track.
 *
 * Cumulative ascent/descent are accumulated per point-to-point step exactly as
 * `calculateElevationBetween` walks the track (unrounded internally; each *query*
 * rounds its own gain/loss so results match the point-walk to the metre) —
 * including skipping the step into each of `breakStarts`, so pass the same set
 * both are given.
 *
 * When every point carries `cumAscent`/`cumDescent` — the phone's thinned tracks
 * do, computed on the full-resolution track before it was thinned — those are
 * the prefix sums, and `breakStarts` is not consulted. That is the same source
 * `calculateElevationBetween` reads, so the two still agree to the metre.
 */
export function buildTimeIndex(
  points: ElevationPoint[],
  breakStarts: ReadonlySet<number> = NO_BREAK_STARTS,
): TimeIndex {
  const n = points.length;
  const ascent = new Array<number>(n);
  const descent = new Array<number>(n);
  if (n > 0 && points.every(hasCumulativeElevation)) {
    // Rebased on the first point so the array is still a prefix sum from index
    // 0; only differences are ever read, so the base cancels either way.
    const baseAscent = points[0].cumAscent as number;
    const baseDescent = points[0].cumDescent as number;
    for (let i = 0; i < n; i++) {
      ascent[i] = (points[i].cumAscent as number) - baseAscent;
      descent[i] = (points[i].cumDescent as number) - baseDescent;
    }
    return { points, ascent, descent };
  }
  if (n > 0) {
    ascent[0] = 0;
    descent[0] = 0;
    for (let i = 1; i < n; i++) {
      const diff = breakStarts.has(i) ? 0 : points[i].ele - points[i - 1].ele;
      ascent[i] = ascent[i - 1] + (diff > 0 ? diff : 0);
      descent[i] = descent[i - 1] + (diff < 0 ? -diff : 0);
    }
  }
  return { points, ascent, descent };
}

/**
 * Raw Naismith hours over [fromKm, toKm] using the prefix index.
 *
 * Semantics match `estimateHikingHoursRaw(toKm - fromKm, ...calculateElevationBetween(
 * fromKm, toKm, points))` to floating tolerance: endpoints snap to their nearest
 * points, ascent/descent come from the prefix difference over [min, max] index
 * (rounded to whole metres), and the distance term is the caller's km span so the
 * whole-day descent allowance is applied once per query (day-scoped).
 */
export function hoursBetweenIndexed(
  index: TimeIndex,
  fromKm: number,
  toKm: number,
  baseKmh: number,
): number {
  if (index.points.length === 0) return 0;
  const { gain, loss } = climbBetweenIndexed(index, fromKm, toKm);
  return estimateHikingHoursRaw(Math.abs(toKm - fromKm), gain, loss, baseKmh);
}

/**
 * Ascent and descent over [fromKm, toKm] using the prefix index, in whole
 * metres — the same figures `calculateElevationBetween` walks the track for,
 * in O(log n). Zero for an empty index.
 */
export function climbBetweenIndexed(
  index: TimeIndex,
  fromKm: number,
  toKm: number,
): { gain: number; loss: number } {
  const { points, ascent, descent } = index;
  if (points.length === 0) return { gain: 0, loss: 0 };
  const startIdx = findNearestByDistance(points, fromKm);
  const endIdx = findNearestByDistance(points, toKm);
  const lo = Math.min(startIdx, endIdx);
  const hi = Math.max(startIdx, endIdx);
  return {
    gain: Math.round(ascent[hi] - ascent[lo]),
    loss: Math.round(descent[hi] - descent[lo]),
  };
}

/**
 * The km at which cumulative raw hours from `fromKm` reaches `targetHours`.
 *
 * Time is always measured over the whole [fromKm, x] segment (via
 * `hoursBetweenIndexed`), so `fromKm` is treated as the day start and the descent
 * allowance stays day-scoped. `hoursBetweenIndexed(fromKm, ·)` is monotonically
 * non-decreasing in x, so this is a monotonic bisection with a final linear
 * interpolation across the converged bracket. The result is clamped to the track end.
 */
export function kmAtHours(
  index: TimeIndex,
  fromKm: number,
  targetHours: number,
  baseKmh: number,
): number {
  const { points } = index;
  if (points.length === 0) return fromKm;
  const lastKm = points[points.length - 1].dist;
  if (targetHours <= 0) return fromKm;
  if (fromKm >= lastKm) return lastKm;

  const totalHours = hoursBetweenIndexed(index, fromKm, lastKm, baseKmh);
  if (targetHours >= totalHours) return lastKm;

  let lo = fromKm;
  let hi = lastKm;
  let loHours = 0; // hoursBetweenIndexed(fromKm, fromKm) === 0
  let hiHours = totalHours;
  // Bisection: converge the bracket, then linearly interpolate within it. The
  // hours function is piecewise-linear in x (nearest-point snapping holds ascent/
  // descent constant between point midpoints), so interpolation is exact there.
  for (let iter = 0; iter < 60 && hi - lo > 1e-7; iter++) {
    const mid = (lo + hi) / 2;
    const midHours = hoursBetweenIndexed(index, fromKm, mid, baseKmh);
    if (midHours < targetHours) {
      lo = mid;
      loHours = midHours;
    } else {
      hi = mid;
      hiHours = midHours;
    }
  }
  const span = hiHours - loHours;
  if (span <= 0) return lo;
  return lo + ((targetHours - loHours) / span) * (hi - lo);
}

/**
 * Count water sources between two km positions on the trail.
 * Membership is the water family in `waypoint-taxonomy`, less other hikers'
 * shared pins (`isUnverifiedHikerWaypoint`), as in the water-carry calculator.
 */
export function countWaterSources(
  startKm: number,
  endKm: number,
  waypoints: PlanWaypoint[],
): number {
  return waypoints.filter(wp => {
    const km = wp.totalDistance ?? 0;
    return isWaterWaypoint(wp.type) && !isUnverifiedHikerWaypoint(wp) && km > startKm && km <= endKm;
  }).length;
}

/**
 * Insert a stop in km-sorted order. Returns a new array.
 */
export function addStop<T extends { km: number }>(stops: T[], newStop: T): T[] {
  const result = [...stops];
  const idx = result.findIndex(s => s.km > newStop.km);
  if (idx === -1) {
    result.push(newStop);
  } else {
    result.splice(idx, 0, newStop);
  }
  return result;
}

/**
 * Remove a stop by index. Returns a new array.
 */
export function removeStop<T>(stops: T[], index: number): T[] {
  return stops.filter((_, i) => i !== index);
}

/** Resolve a stop's display name. */
function stopDisplayName(stop: PlanStopInput): string {
  return stop.customLocation?.name ?? stop.waypointName ?? 'Stop';
}

/**
 * Compute days from trail data and planned stops.
 *
 * Day 1 starts at trail km 0 (or section start), last day ends at trail total
 * distance (or section end). Each stop boundary creates a day transition.
 * Stops are sorted by km and clamped to the computed range, so out-of-order
 * or out-of-range stops never produce negative day distances.
 *
 * @param trail - Trail data with track points and waypoints
 * @param stops - Planned overnight stops (trail/section start and end are implicit)
 * @param startDate - Optional ISO date string for day 1
 * @param section - Optional section boundaries; when set, scopes computation to the section range
 * @param baseKmh - Naismith flat-ground base speed: the hiker's pace. Required.
 */
export function computeDays(
  trail: PlanTrail,
  stops: PlanStopInput[],
  startDate: string | null | undefined,
  section: SectionConfig | null | undefined,
  baseKmh: number,
): ComputedDay[] {
  const trackPoints = trail.track.points;
  const breakStarts = routeBreakStarts(trail.track.breaks, 'points');
  const waypoints = trail.waypoints ?? [];

  const rangeStartKm = section ? section.startKm : 0;
  const rangeEndKm = section ? section.endKm : trail.track.totalDistance;
  const rangeStartName: string = section
    ? section.startName
    : (waypoints[0]?.name ?? (trail.config.name + ' Start'));
  const rangeEndName: string = section
    ? section.endName
    : (waypoints[waypoints.length - 1]?.name ?? (trail.config.name + ' End'));

  interface Boundary {
    name: string;
    km: number;
    walk: PlaceWalk | null;
  }

  // Sort stops by km and clamp to the range bounds
  const sortedStops = [...stops]
    .sort((a, b) => a.km - b.km)
    .filter(s => s.km > rangeStartKm && s.km < rangeEndKm);

  const boundaries: Boundary[] = [
    { name: rangeStartName, km: rangeStartKm, walk: null },
    ...sortedStops.map(s => ({ name: stopDisplayName(s), km: s.km, walk: s.walk ?? null })),
    { name: rangeEndName, km: rangeEndKm, walk: null },
  ];

  const days: ComputedDay[] = [];

  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    const dayNumber = i + 1;

    // A stop off the route is walked to at the end of the day that reaches
    // it and walked back from at the start of the next: its km, and its climb
    // each way (in climbs ascentM; out climbs what in descended).
    const walkIn = end.walk;
    const walkOut = start.walk;
    const route = calculateElevationBetween(start.km, end.km, trackPoints, breakStarts);
    const walked = addPlaceWalks(
      { distanceKm: end.km - start.km, ascentM: route.gain, descentM: route.loss },
      walkOut,
      walkIn
    );
    const offTrailKm = walked.offTrailKm;
    const distanceKm = Math.round(walked.distanceKm * 10) / 10;
    const gain = walked.ascentM;
    const loss = walked.descentM;
    const hours = estimateHikingTime(distanceKm, gain, loss, baseKmh);
    const water = countWaterSources(start.km, end.km, waypoints);

    let date: string | undefined;
    if (startDate) {
      // Use UTC to avoid timezone shifts
      const d = new Date(startDate + 'T12:00:00Z');
      d.setUTCDate(d.getUTCDate() + i);
      date = d.toISOString().slice(0, 10);
    }

    days.push({
      dayNumber,
      date,
      startName: start.name,
      endName: end.name,
      startKm: start.km,
      endKm: end.km,
      distanceKm,
      ascentM: gain,
      descentM: loss,
      estimatedHours: hours,
      waterSources: water,
      ...(offTrailKm > 0 ? { offTrailKm: Math.round(offTrailKm * 10) / 10 } : {}),
      ...(walkOut ? { walkOut } : {}),
      ...(walkIn ? { walkIn } : {}),
    });
  }

  return days;
}
