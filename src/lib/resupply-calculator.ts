/**
 * Resupply distance calculator.
 *
 * Identifies resupply points (towns, stores) along a trail and calculates
 * distances between them. Includes food carry weight estimation.
 *
 * Shared between the web planner and the mobile app.
 */

import type { PlanWaypoint, ResupplyGap, ComputedDay } from './plan-types';
import { isResupplyWaypoint } from './waypoint-taxonomy';

export type { ResupplyGap };

export interface ResupplyPoint {
  name: string;
  km: number;
  type: string;
}

export interface FoodCarryEstimate {
  /** Weight in grams */
  weightGrams: number;
  /** Weight in kg (rounded to 1 decimal) */
  weightKg: number;
  /** Number of days of food */
  days: number;
}

// The food per day is the hiker's (`PlanThresholds` in plan-types), so
// `calculateFoodWeight` requires it rather than defaulting. Days and the
// long-carry flag depend on pace and hours too, so they are `computeResupplyLegs`'.

/**
 * Extract resupply points from trail waypoints, sorted by km.
 *
 * Membership is the resupply family in `waypoint-taxonomy`, which is where the
 * reasoning about what counts (and why 'accommodation'/'caravan-park' do not)
 * now lives.
 */
export function extractResupplyPoints(waypoints: PlanWaypoint[]): ResupplyPoint[] {
  return waypoints
    .filter(wp => isResupplyWaypoint(wp.type))
    .map(wp => ({
      name: wp.name ?? 'Resupply',
      km: wp.totalDistance ?? 0,
      type: wp.type ?? 'food',
    }))
    .sort((a, b) => a.km - b.km);
}

/**
 * Calculate food carry weight for a given number of days.
 *
 * @throws RangeError if `gramsPerDay` is not a positive finite number.
 */
export function calculateFoodWeight(days: number, gramsPerDay: number): FoodCarryEstimate {
  requirePositive(gramsPerDay, 'gramsPerDay', 'calculateFoodWeight');
  const weightGrams = Math.round(days * gramsPerDay);
  return {
    weightGrams,
    weightKg: Math.round(weightGrams / 100) / 10,
    days,
  };
}

/**
 * Compute gaps between consecutive resupply points, including trail start/end.
 *
 * With no points at all the whole range is one gap, start to end: the hiker
 * who resupplies nowhere still carries food for every day of it, and that is
 * the carry they most need the figure for. Only an empty range has no gaps.
 *
 * Distances only: how many days a gap takes depends on the hiker's pace and
 * hours, which `computeResupplyLegs` works out from the climb as well.
 */
export function computeResupplyGaps(points: ResupplyPoint[], trailStartKm: number, trailEndKm: number): ResupplyGap[] {
  const gaps: ResupplyGap[] = [];

  if (points.length === 0) {
    const dist = trailEndKm - trailStartKm;
    if (dist > 0) {
      gaps.push({
        fromName: 'Trail Start',
        toName: 'Trail End',
        fromKm: trailStartKm,
        toKm: trailEndKm,
        distanceKm: Math.round(dist * 10) / 10,
      });
    }
    return gaps;
  }

  // Deduplicate points at the same km position
  const deduped = points.filter((p, i) => i === 0 || p.km !== points[i - 1].km);

  // Gap from trail start to first resupply
  const firstDist = deduped[0].km - trailStartKm;
  if (firstDist > 0) {
    gaps.push({
      fromName: 'Trail Start',
      toName: deduped[0].name,
      fromKm: trailStartKm,
      toKm: deduped[0].km,
      distanceKm: Math.round(firstDist * 10) / 10,
    });
  }

  // Gaps between consecutive resupply points
  for (let i = 0; i < deduped.length - 1; i++) {
    const dist = deduped[i + 1].km - deduped[i].km;
    if (dist <= 0) continue;
    gaps.push({
      fromName: deduped[i].name,
      toName: deduped[i + 1].name,
      fromKm: deduped[i].km,
      toKm: deduped[i + 1].km,
      distanceKm: Math.round(dist * 10) / 10,
    });
  }

  // Gap from last resupply to trail end
  const lastDist = trailEndKm - deduped[deduped.length - 1].km;
  if (lastDist > 0) {
    gaps.push({
      fromName: deduped[deduped.length - 1].name,
      toName: 'Trail End',
      fromKm: deduped[deduped.length - 1].km,
      toKm: trailEndKm,
      distanceKm: Math.round(lastDist * 10) / 10,
    });
  }

  return gaps;
}

/**
 * Correlate resupply points with computed days.
 */
export interface ResupplyDayInfo {
  point: ResupplyPoint;
  arrivalDay: number;
  arrivalDate?: string;
}

export function correlateResupplyWithDays(points: ResupplyPoint[], days: ComputedDay[]): ResupplyDayInfo[] {
  return points.map(point => {
    const day = days.find(d => point.km >= d.startKm && point.km <= d.endKm);
    return {
      point,
      arrivalDay: day?.dayNumber ?? 0,
      arrivalDate: day?.date,
    };
  });
}

/**
 * Find the next resupply point from a given position on the trail.
 * Useful for "I need to resupply by day X, which town?" queries.
 */
export function findNextResupply(waypoints: PlanWaypoint[], currentKm: number): ResupplyPoint | null {
  const points = extractResupplyPoints(waypoints);
  return points.find(p => p.km > currentKm) ?? null;
}

/**
 * Reject a pace, hours or threshold figure a caller left out rather than
 * invent one — the one guard for this module and `resupply-plan`.
 */
export function requirePositive(value: number, name: string, fn: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${fn}: ${name} must be a positive number, got ${String(value)}`);
  }
  return value;
}
