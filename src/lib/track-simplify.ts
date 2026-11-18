/**
 * Target-point-count track simplification and coordinate truncation.
 *
 * Lifted verbatim (behaviour-wise) from `scripts/build-mobile-trails.ts`, which
 * now imports it back. The runtime GPX importer uses the same budgets so an
 * imported trail costs the same on a phone as a bundled one.
 *
 * The simplification itself is `gpx-optimizer`'s `douglasPeuckerIndices`;
 * this module adds the point budget and the truncation for built track points
 * (`{lat, lon, ele, dist}`).
 */

import { douglasPeuckerIndices } from './gpx-optimizer';
import type { TrackPoint } from './trail-types';

/** The minimum a point needs for simplification: a position. */
export interface LatLonPoint {
  lat: number;
  lon: number;
}

/**
 * Douglas-Peucker simplification (`douglasPeuckerIndices`). Returns references
 * to the original point objects (never copies), so callers can key off identity.
 */
export function simplifyTrack<T extends LatLonPoint>(points: T[], tolerance: number): T[] {
  if (points.length <= 2) return points;
  return douglasPeuckerIndices(points, tolerance).map(i => points[i]);
}

/**
 * Simplify points to approximately `targetCount` using Douglas-Peucker with a
 * binary search over the tolerance (1m..500m, 20 iterations, stops once within
 * 10% of the target).
 */
export function simplifyToTarget<T extends LatLonPoint>(points: T[], targetCount: number): T[] {
  if (points.length <= targetCount) return points;

  // Binary search for the right tolerance
  let lo = 1; // 1 meter
  let hi = 500; // 500 meters
  let best = points;

  for (let iter = 0; iter < 20; iter++) {
    const mid = (lo + hi) / 2;
    const result = simplifyTrack(points, mid);

    if (result.length > targetCount) {
      lo = mid;
    } else {
      hi = mid;
      best = result;
    }

    // Close enough (within 10%)
    if (Math.abs(result.length - targetCount) < targetCount * 0.1) {
      best = result;
      break;
    }
  }

  return best;
}

/**
 * Truncate coordinate precision.
 * lat/lon: 6 decimal places (~0.1m), ele: 1 decimal, dist: 1 decimal.
 *
 * `cumAscent`/`cumDescent` are carried through when present (a thinned track's
 * pre-computed climb — see `annotateCumulativeElevation`) and rounded to whole
 * metres: every reader takes a *difference* of two of them, so the worst a
 * rounded pair costs is a metre, and the asset keeps five digits per point
 * instead of fifteen.
 */
export function truncatePoint(p: TrackPoint): TrackPoint {
  const out: TrackPoint = {
    lat: Math.round(p.lat * 1e6) / 1e6,
    lon: Math.round(p.lon * 1e6) / 1e6,
    ele: Math.round(p.ele * 10) / 10,
    dist: Math.round(p.dist * 10) / 10,
  };
  if (typeof p.cumAscent === 'number' && typeof p.cumDescent === 'number') {
    out.cumAscent = Math.round(p.cumAscent);
    out.cumDescent = Math.round(p.cumDescent);
  }
  return out;
}

export function truncatePoints(points: TrackPoint[]): TrackPoint[] {
  return points.map(truncatePoint);
}
