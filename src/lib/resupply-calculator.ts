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

export interface ResupplyAnalysis {
  points: ResupplyPoint[];
  gaps: ResupplyGap[];
  longestGapKm: number;
  longestGapDays: number;
  hasResupplyData: boolean;
}

/** Default daily hiking distance for estimating days between resupply */
export const DEFAULT_DAILY_KM = 20;

// The long-carry threshold and the food per day are the hiker's (`PlanThresholds`
// in plan-types), so every function below requires them rather than defaulting.

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
export function calculateFoodWeight(
  days: number,
  gramsPerDay: number,
): FoodCarryEstimate {
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
 */
export interface ResupplyGapOptions {
  /** The hiker's long-carry threshold: a gap of more days is `isLong`. */
  longThresholdDays: number;
  /** Flat km per day for `estimatedDays`; `computeResupplyLegs` replaces those days with Naismith hours. */
  dailyKm?: number;
}

export function computeResupplyGaps(
  points: ResupplyPoint[],
  trailStartKm: number,
  trailEndKm: number,
  opts: ResupplyGapOptions,
): ResupplyGap[] {
  const longThresholdDays = requirePositive(opts.longThresholdDays, 'longThresholdDays', 'computeResupplyGaps');
  const dailyKm = opts.dailyKm ?? DEFAULT_DAILY_KM;
  const effectiveDailyKm = Math.max(1, dailyKm);
  const gaps: ResupplyGap[] = [];

  if (points.length === 0) {
    const dist = trailEndKm - trailStartKm;
    if (dist > 0) {
      const days = Math.ceil(dist / effectiveDailyKm);
      gaps.push({
        fromName: 'Trail Start',
        toName: 'Trail End',
        fromKm: trailStartKm,
        toKm: trailEndKm,
        distanceKm: Math.round(dist * 10) / 10,
        estimatedDays: days,
        isLong: days > longThresholdDays,
      });
    }
    return gaps;
  }

  // Deduplicate points at the same km position
  const deduped = points.filter(
    (p, i) => i === 0 || p.km !== points[i - 1].km,
  );

  // Gap from trail start to first resupply
  const firstDist = deduped[0].km - trailStartKm;
  if (firstDist > 0) {
    const days = Math.ceil(firstDist / effectiveDailyKm);
    gaps.push({
      fromName: 'Trail Start',
      toName: deduped[0].name,
      fromKm: trailStartKm,
      toKm: deduped[0].km,
      distanceKm: Math.round(firstDist * 10) / 10,
      estimatedDays: days,
      isLong: days > longThresholdDays,
    });
  }

  // Gaps between consecutive resupply points
  for (let i = 0; i < deduped.length - 1; i++) {
    const dist = deduped[i + 1].km - deduped[i].km;
    if (dist <= 0) continue;
    const days = Math.ceil(dist / effectiveDailyKm);
    gaps.push({
      fromName: deduped[i].name,
      toName: deduped[i + 1].name,
      fromKm: deduped[i].km,
      toKm: deduped[i + 1].km,
      distanceKm: Math.round(dist * 10) / 10,
      estimatedDays: days,
      isLong: days > longThresholdDays,
    });
  }

  // Gap from last resupply to trail end
  const lastDist = trailEndKm - deduped[deduped.length - 1].km;
  if (lastDist > 0) {
    const days = Math.ceil(lastDist / effectiveDailyKm);
    gaps.push({
      fromName: deduped[deduped.length - 1].name,
      toName: 'Trail End',
      fromKm: deduped[deduped.length - 1].km,
      toKm: trailEndKm,
      distanceKm: Math.round(lastDist * 10) / 10,
      estimatedDays: days,
      isLong: days > longThresholdDays,
    });
  }

  return gaps;
}

/**
 * Full resupply analysis for a trail.
 */
export function analyzeResupply(
  waypoints: PlanWaypoint[],
  totalDistanceKm: number,
  opts: ResupplyGapOptions,
): ResupplyAnalysis {
  const points = extractResupplyPoints(waypoints);
  const hasResupplyData = points.length > 0;

  if (!hasResupplyData) {
    return { points: [], gaps: [], longestGapKm: 0, longestGapDays: 0, hasResupplyData: false };
  }

  const gaps = computeResupplyGaps(points, 0, totalDistanceKm, opts);
  const longestGapKm = gaps.reduce((max, g) => Math.max(max, g.distanceKm), 0);
  const longestGapDays = gaps.reduce((max, g) => Math.max(max, g.estimatedDays), 0);

  return { points, gaps, longestGapKm, longestGapDays, hasResupplyData };
}

/**
 * Correlate resupply points with computed days.
 */
export interface ResupplyDayInfo {
  point: ResupplyPoint;
  arrivalDay: number;
  arrivalDate?: string;
}

export function correlateResupplyWithDays(
  points: ResupplyPoint[],
  days: ComputedDay[],
): ResupplyDayInfo[] {
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
export function findNextResupply(
  waypoints: PlanWaypoint[],
  currentKm: number,
): ResupplyPoint | null {
  const points = extractResupplyPoints(waypoints);
  return points.find(p => p.km > currentKm) ?? null;
}

/**
 * Get food carry estimate for the gap between two resupply points.
 */
export function foodCarryForGap(
  gap: ResupplyGap,
  gramsPerDay: number,
): FoodCarryEstimate {
  return calculateFoodWeight(gap.estimatedDays, gramsPerDay);
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
