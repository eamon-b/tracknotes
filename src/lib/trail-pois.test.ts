import { describe, it, expect } from 'vitest';
import { buildRouteScale, trailKmFor } from './trail-pois';
import type { TrackPoint } from './trail-types';

describe('buildRouteScale', () => {
  it('flattens a 150,000-point track without one call per point', () => {
    // JavaScriptCore (Safari) refuses a call with more than 65,536 arguments,
    // which `kmScale.push(...km)` became on a long import. V8 does not, so the
    // limit is imposed here.
    const N = 150_000;
    const points: TrackPoint[] = Array.from({ length: N }, (_, i) => ({
      lat: -34 + i * 1e-6,
      lon: 138,
      ele: 0,
      dist: i * 0.0001,
    }));

    const realPush = Array.prototype.push;
    Array.prototype.push = function (this: unknown[], ...items: unknown[]) {
      if (items.length > 65536) throw new RangeError('Maximum call stack size exceeded.');
      return realPush.apply(this, items);
    };
    let scale;
    try {
      scale = buildRouteScale({
        track: { points, displayPoints: points, totalDistance: 15, totalAscent: 0, totalDescent: 0 },
        alternates: [],
        sideTrips: [],
      });
    } finally {
      Array.prototype.push = realPush;
    }

    expect(scale.kmScale).toHaveLength(N);
    expect(scale.kmScale[N - 1]).toBeCloseTo((N - 1) * 0.0001, 9);
  });
});

describe('buildRouteScale with route breaks', () => {
  it('searches each stretch on its own, so no corridor or placement crosses a break', () => {
    // Two stretches either side of a ferry: points 0-2, then 3-5.
    const points: TrackPoint[] = [0, 1, 2, 10, 11, 12].map((x, i) => ({
      lat: -41,
      lon: 174 + x * 0.01,
      ele: 0,
      dist: [0, 1, 2, 2, 3, 4][i],
    }));
    const scale = buildRouteScale({
      track: {
        points,
        displayPoints: points,
        totalDistance: 4,
        totalAscent: 0,
        totalDescent: 0,
        breaks: [{ index: 3, displayIndex: 3, km: 2, straightLineKm: 6, fromTrack: 'North', toTrack: 'South' }],
      },
      alternates: [],
      sideTrips: [],
    });
    expect(scale.polylines).toHaveLength(2);
    expect(scale.polylines.map(p => p.length)).toEqual([3, 3]);
    expect(scale.kmScale).toEqual([0, 1, 2, 2, 3, 4]);
    // The last point of the first stretch ends a polyline: there is no segment 2 → 3.
    expect([...scale.breaks]).toEqual([2]);
    // A POI the library puts just past that point is not interpolated over the water.
    expect(trailKmFor({ segmentIndex: 2, t: 0.5, distanceAlongRoute: 99 }, scale)).toBe(2);
  });
});
