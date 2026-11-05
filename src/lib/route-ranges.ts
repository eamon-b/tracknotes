/**
 * Drawing a km range of the route: a planned day, a resupply leg.
 *
 * Every map that colours part of the route by what the plan does there has
 * the same three steps to take, and the same ways to get them wrong: find the
 * points nearest the two km, take the points between them, and cut that run
 * wherever a route break falls inside it (a ferry, an unbridged river), so the
 * gap is never drawn as trail. This is those steps, once, for the web plan page
 * and the phone's guide map.
 *
 * The km are those of the points handed in. Callers pass the route as the plan
 * walks it — its alternates spliced in (`@lib/plan-alternates`
 * `plannedRouteTrail`) and its direction applied — so a range on a taken
 * alternate is drawn along the alternate, and a range is never measured on a
 * scale the points do not use. Neighbouring ranges that share a km share the
 * point nearest it, so their lines meet.
 *
 * Platform-neutral: no Leaflet, no MapLibre, no DOM.
 */

import { routeBreakStarts, sliceAcrossRouteBreaks } from './route-breaks';
import { findNearestByDistance, type DistancePoint } from './track-geometry';
import type { RouteBreak } from './trail-types';

/**
 * The points between two km (either order), one run per stretch the range
 * crosses. Runs of fewer than two points — a range that starts or ends right
 * at a break — are left out: there is no line to draw.
 *
 * `breakStarts` must be indexed against `points`: `routeBreakStarts(breaks,
 * 'points')` for the full-resolution track, `'displayPoints'` for the map copy.
 */
export function routeRunsBetweenKm<P extends DistancePoint>(
  points: readonly P[],
  breakStarts: ReadonlySet<number>,
  fromKm: number,
  toKm: number
): P[][] {
  if (points.length < 2) return [];
  // findNearestByDistance takes a mutable array type; it only reads it.
  const pts = points as P[];
  const from = findNearestByDistance(pts, fromKm);
  const to = findNearestByDistance(pts, toKm);
  return sliceAcrossRouteBreaks(points, from, to, breakStarts).filter(run => run.length >= 2);
}

/** A km range of the route, as a plan's leg or day gives one. */
export interface KmRange {
  fromKm: number;
  toKm: number;
}

/** One range's line: which range it is, and the runs that draw it. */
export interface RangeLine<P> {
  /** Index into the ranges passed in, so the line and its table row agree. */
  index: number;
  fromKm: number;
  toKm: number;
  /** One run per stretch the range crosses; empty when it is shorter than a step. */
  runs: P[][];
}

/**
 * The line of each range over a track, split at its route breaks.
 *
 * `which` names the array to draw — `displayPoints` (the simplified map copy,
 * falling back to `points` when a track has none) or `points` — and the breaks
 * are read against that same array, which is the one way to get a split wrong.
 */
export function rangeLines<P extends DistancePoint>(
  track: { points: P[]; displayPoints?: P[]; breaks?: readonly Pick<RouteBreak, 'index' | 'displayIndex'>[] },
  ranges: readonly KmRange[],
  which: 'points' | 'displayPoints'
): RangeLine<P>[] {
  const useDisplay = which === 'displayPoints' && Array.isArray(track.displayPoints) && track.displayPoints.length > 0;
  const points = useDisplay ? track.displayPoints! : track.points;
  const breakStarts = routeBreakStarts(track.breaks, useDisplay ? 'displayPoints' : 'points');
  return ranges.map((range, index) => ({
    index,
    fromKm: range.fromKm,
    toKm: range.toKm,
    runs: routeRunsBetweenKm(points, breakStarts, range.fromKm, range.toKm),
  }));
}
