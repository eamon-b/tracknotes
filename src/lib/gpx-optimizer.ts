/**
 * Track simplification (Douglas-Peucker) and elevation cleaning for
 * `trail-ingest`: spike removal, moving-average smoothing and the hysteresis
 * climb count every trail's ascent/descent comes from.
 */
import type { GpxPoint } from './types';
import { EARTH_RADIUS_METERS } from './distance';

/** The elevation-cleaning defaults `buildTrail` applies when a caller names none. */
export const GPX_OPTIMIZER_DEFAULTS: { readonly spikeThreshold: number; readonly elevationSmoothingWindow: number } = {
  spikeThreshold: 50, // 50 meters - max valid elevation change between points
  elevationSmoothingWindow: 7, // 7 points moving average
};

/**
 * Calculate perpendicular distance from a point to a line segment
 * Used by Douglas-Peucker algorithm
 *
 * Note: Uses equirectangular approximation which works well for short distances
 * but may be inaccurate for:
 * - Points near poles (latitude > 80°)
 * - Very long segments (>100km)
 * - Tracks crossing the 180° meridian
 *
 * @param point - The point to measure distance from
 * @param lineStart - Start of the line segment
 * @param lineEnd - End of the line segment
 * @returns Perpendicular distance in meters
 */
function perpendicularDistance(
  point: { lat: number; lon: number },
  lineStart: { lat: number; lon: number },
  lineEnd: { lat: number; lon: number }
): number {
  // Convert to cartesian coordinates for calculation
  const toRadians = (deg: number) => (deg * Math.PI) / 180;

  // Use equirectangular approximation for short distances
  const lat1 = toRadians(lineStart.lat);
  const lat2 = toRadians(lineEnd.lat);
  const latP = toRadians(point.lat);

  const lon1 = toRadians(lineStart.lon);
  const lon2 = toRadians(lineEnd.lon);
  const lonP = toRadians(point.lon);

  // Project to flat surface (equirectangular approximation)
  const x1 = lon1 * Math.cos((lat1 + lat2) / 2) * EARTH_RADIUS_METERS;
  const y1 = lat1 * EARTH_RADIUS_METERS;
  const x2 = lon2 * Math.cos((lat1 + lat2) / 2) * EARTH_RADIUS_METERS;
  const y2 = lat2 * EARTH_RADIUS_METERS;
  const xP = lonP * Math.cos((lat1 + lat2) / 2) * EARTH_RADIUS_METERS;
  const yP = latP * EARTH_RADIUS_METERS;

  // Line length squared
  const lineLengthSquared = (x2 - x1) ** 2 + (y2 - y1) ** 2;

  if (lineLengthSquared === 0) {
    // Line start and end are the same point
    return Math.sqrt((xP - x1) ** 2 + (yP - y1) ** 2);
  }

  // Project point onto line
  const t = Math.max(0, Math.min(1, ((xP - x1) * (x2 - x1) + (yP - y1) * (y2 - y1)) / lineLengthSquared));

  const projX = x1 + t * (x2 - x1);
  const projY = y1 + t * (y2 - y1);

  return Math.sqrt((xP - projX) ** 2 + (yP - projY) ** 2);
}

/**
 * Douglas-Peucker line simplification (iterative, with an explicit stack
 * instead of recursion so a >50k-point trail cannot overflow it): the indices
 * of the points kept within `tolerance` metres of the line, ascending.
 *
 * For callers that have to carry something per point across the
 * simplification (cumulative km, say). Matching the kept points back by
 * coordinate cannot do that: an out-and-back or a loop passes the same
 * coordinate twice, and whichever pass a lookup lands on, half of those points
 * come back with the other pass's km.
 */
export function douglasPeuckerIndices(points: { lat: number; lon: number }[], tolerance: number): number[] {
  if (points.length <= 2) {
    return points.map((_, i) => i);
  }

  // Track which points to keep
  const keep: boolean[] = new Array(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;

  // Use explicit stack instead of recursion to avoid stack overflow
  const stack: [number, number][] = [[0, points.length - 1]];

  while (stack.length > 0) {
    const [start, end] = stack.pop()!;

    let maxDist = 0;
    let maxIndex = start;

    for (let i = start + 1; i < end; i++) {
      const dist = perpendicularDistance(points[i], points[start], points[end]);
      if (dist > maxDist) {
        maxDist = dist;
        maxIndex = i;
      }
    }

    if (maxDist > tolerance) {
      keep[maxIndex] = true;
      stack.push([start, maxIndex]);
      stack.push([maxIndex, end]);
    }
  }

  const kept: number[] = [];
  for (let i = 0; i < keep.length; i++) {
    if (keep[i]) kept.push(i);
  }
  return kept;
}

/**
 * Remove elevation spikes that exceed physical possibility
 * Uses linear interpolation between valid points when spikes are detected
 *
 * A spike is identified when a point deviates significantly from BOTH its
 * neighbors - i.e., it goes up (or down) sharply and then returns. This
 * distinguishes true spikes from legitimate elevation changes.
 *
 * @param points - Array of GPS points with elevation data
 * @param spikeThreshold - Maximum valid elevation change in meters between consecutive points
 * @returns Array of points with spikes interpolated
 */
export function removeElevationSpikes(points: GpxPoint[], spikeThreshold: number): GpxPoint[] {
  if (points.length < 3) return points;

  // Identify spike points: a point is a spike if it deviates significantly
  // from BOTH neighbors in the same direction (up from both or down from both)
  const isSpike: boolean[] = new Array(points.length).fill(false);

  for (let i = 1; i < points.length - 1; i++) {
    const prevEle = points[i - 1].ele;
    const currEle = points[i].ele;
    const nextEle = points[i + 1].ele;

    const diffFromPrev = currEle - prevEle;
    const diffFromNext = currEle - nextEle;

    // It's a spike if:
    // 1. The point is significantly higher (or lower) than BOTH neighbors
    // 2. Both differences exceed the threshold
    // 3. Both differences are in the same direction (both positive or both negative)
    const sameDirection = (diffFromPrev > 0 && diffFromNext > 0) || (diffFromPrev < 0 && diffFromNext < 0);
    const exceedsThreshold = Math.abs(diffFromPrev) > spikeThreshold && Math.abs(diffFromNext) > spikeThreshold;

    if (sameDirection && exceedsThreshold) {
      isSpike[i] = true;
    }
  }

  // Second pass: interpolate spikes
  const result: GpxPoint[] = [];
  for (let i = 0; i < points.length; i++) {
    if (!isSpike[i]) {
      result.push({ ...points[i] });
    } else {
      // Find previous valid point
      let prevIdx = i - 1;
      while (prevIdx >= 0 && isSpike[prevIdx]) {
        prevIdx--;
      }

      // Find next valid point
      let nextIdx = i + 1;
      while (nextIdx < points.length && isSpike[nextIdx]) {
        nextIdx++;
      }

      let interpolatedEle: number;
      if (prevIdx >= 0 && nextIdx < points.length) {
        // Interpolate between previous and next valid points
        const prevEle = points[prevIdx].ele;
        const nextEle = points[nextIdx].ele;
        const weight = (i - prevIdx) / (nextIdx - prevIdx);
        interpolatedEle = prevEle + weight * (nextEle - prevEle);
      } else if (prevIdx >= 0) {
        // No valid point ahead, use previous
        interpolatedEle = points[prevIdx].ele;
      } else if (nextIdx < points.length) {
        // No valid point before, use next
        interpolatedEle = points[nextIdx].ele;
      } else {
        // All points are spikes (shouldn't happen), keep original
        interpolatedEle = points[i].ele;
      }

      result.push({
        ...points[i],
        ele: interpolatedEle,
      });
    }
  }

  return result;
}

/**
 * Apply moving average smoothing to elevation data
 *
 * @param points - Array of GPS points with elevation data
 * @param windowSize - Number of points to include in moving average window
 * @returns Array of points with smoothed elevations
 */
export function smoothElevation(points: GpxPoint[], windowSize: number): GpxPoint[] {
  if (points.length < windowSize) return points;

  const halfWindow = Math.floor(windowSize / 2);
  const result: GpxPoint[] = [];

  for (let i = 0; i < points.length; i++) {
    const start = Math.max(0, i - halfWindow);
    const end = Math.min(points.length - 1, i + halfWindow);

    let elevationSum = 0;
    let count = 0;

    for (let j = start; j <= end; j++) {
      elevationSum += points[j].ele;
      count++;
    }

    result.push({
      ...points[i],
      ele: elevationSum / count,
    });
  }

  return result;
}

/**
 * Calculate elevation gain and loss for a track
 * Uses threshold to filter out noise
 *
 * The threshold is a hysteresis band, not a per-step filter: the change is
 * measured from the last counted elevation (the anchor), and once it reaches
 * the threshold the whole change is credited and the anchor moves. Filtering
 * each step on its own throws away a real climb whenever the samples are dense
 * enough that no single step reaches the threshold - a smoothed 5,000-point
 * import of the Overland Track read 260 m of its 1,729 m. A threshold of 0 is
 * the plain sum of every step.
 *
 * @param points - Array of GPS points with elevation data
 * @param threshold - Minimum elevation change in meters to count (default: 3m)
 * @param breakStarts - Indices of points that start a new stretch after a
 *   route break: the step into one is not walked, so it is not climbed either
 * @returns Object containing total gain and loss in meters
 */
export function calculateElevationStats<P extends { ele: number }>(
  points: P[],
  threshold: number = 3, // 3 meter threshold for counting elevation changes
  breakStarts?: ReadonlySet<number>
): { gain: number; loss: number } {
  if (points.length < 2) return { gain: 0, loss: 0 };
  const { ascent, descent } = cumulativeElevationChange(points, threshold, breakStarts);
  return { gain: ascent[ascent.length - 1], loss: descent[descent.length - 1] };
}

/**
 * The running gain and loss of {@link calculateElevationStats} at every point,
 * so the climb between any two points is the difference of the two entries and
 * the segments between waypoints add up to exactly the track's total.
 */
export function cumulativeElevationChange<P extends { ele: number }>(
  points: P[],
  threshold: number = 3,
  breakStarts?: ReadonlySet<number>
): { ascent: number[]; descent: number[] } {
  const ascent = new Array<number>(points.length);
  const descent = new Array<number>(points.length);
  if (points.length === 0) return { ascent, descent };

  let gain = 0;
  let loss = 0;
  let anchor = points[0].ele;
  ascent[0] = 0;
  descent[0] = 0;

  for (let i = 1; i < points.length; i++) {
    if (breakStarts?.has(i)) {
      // The other side of a ferry starts its own count.
      anchor = points[i].ele;
    } else {
      const diff = points[i].ele - anchor;
      if (diff >= threshold && diff > 0) {
        gain += diff;
        anchor = points[i].ele;
      } else if (-diff >= threshold && diff < 0) {
        loss -= diff;
        anchor = points[i].ele;
      }
    }
    ascent[i] = gain;
    descent[i] = loss;
  }

  return { ascent, descent };
}
