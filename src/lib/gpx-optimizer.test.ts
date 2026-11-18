import { describe, it, expect } from 'vitest';
import {
  removeElevationSpikes,
  smoothElevation,
  calculateElevationStats,
  cumulativeElevationChange,
  douglasPeuckerIndices,
  GPX_OPTIMIZER_DEFAULTS,
} from './gpx-optimizer';
import type { GpxPoint } from './types';

/** The kept points themselves, as `simplifyTrack` returns them. */
function douglasPeucker(points: GpxPoint[], tolerance: number): GpxPoint[] {
  return points.length <= 2 ? points : douglasPeuckerIndices(points, tolerance).map(i => points[i]);
}

describe('douglasPeucker', () => {
  it('should return same points when 2 or fewer points', () => {
    const points: GpxPoint[] = [
      { lat: -37.8136, lon: 144.9631, ele: 50, time: null },
      { lat: -37.82, lon: 144.97, ele: 60, time: null },
    ];

    const result = douglasPeucker(points, 10);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(points[0]);
    expect(result[1]).toEqual(points[1]);
  });

  it('should preserve endpoints', () => {
    const points: GpxPoint[] = [
      { lat: -37.8136, lon: 144.9631, ele: 50, time: null },
      { lat: -37.815, lon: 144.965, ele: 55, time: null },
      { lat: -37.82, lon: 144.97, ele: 60, time: null },
    ];

    const result = douglasPeucker(points, 1000);

    expect(result[0]).toEqual(points[0]);
    expect(result[result.length - 1]).toEqual(points[points.length - 1]);
  });

  it('should remove collinear points within tolerance', () => {
    // Three collinear points (in a straight line)
    const points: GpxPoint[] = [
      { lat: -37.8136, lon: 144.9631, ele: 0, time: null },
      { lat: -37.8168, lon: 144.9665, ele: 0, time: null }, // midpoint
      { lat: -37.82, lon: 144.97, ele: 0, time: null },
    ];

    const result = douglasPeucker(points, 100);

    // Should reduce to just endpoints
    expect(result).toHaveLength(2);
  });

  it('should preserve points outside tolerance', () => {
    // L-shaped path - middle point should be preserved
    const points: GpxPoint[] = [
      { lat: -37.8136, lon: 144.9631, ele: 0, time: null },
      { lat: -37.8136, lon: 145.0, ele: 0, time: null }, // significant deviation
      { lat: -37.82, lon: 145.0, ele: 0, time: null },
    ];

    const result = douglasPeucker(points, 10);

    // Should preserve all points due to large deviation
    expect(result).toHaveLength(3);
  });

  it('should handle switchback pattern', () => {
    // Switchback pattern - should preserve turn points
    const points: GpxPoint[] = [
      { lat: -37.8, lon: 144.9, ele: 0, time: null },
      { lat: -37.8001, lon: 144.901, ele: 0, time: null },
      { lat: -37.8002, lon: 144.902, ele: 0, time: null },
      { lat: -37.8, lon: 144.903, ele: 0, time: null }, // turn
      { lat: -37.7998, lon: 144.902, ele: 0, time: null },
      { lat: -37.7997, lon: 144.901, ele: 0, time: null },
      { lat: -37.8, lon: 144.9, ele: 0, time: null }, // back to start
    ];

    const result = douglasPeucker(points, 5);

    // Should preserve enough points to maintain switchback shape
    expect(result.length).toBeGreaterThanOrEqual(3);
    expect(result.length).toBeLessThan(points.length);
  });
});

describe('GPX_OPTIMIZER_DEFAULTS', () => {
  it('holds the elevation-cleaning defaults buildTrail applies', () => {
    expect(GPX_OPTIMIZER_DEFAULTS).toEqual({ spikeThreshold: 50, elevationSmoothingWindow: 7 });
  });
});

describe('removeElevationSpikes', () => {
  it('should return same points when less than 3 points', () => {
    const singlePoint: GpxPoint[] = [{ lat: -37.8136, lon: 144.9631, ele: 50, time: null }];
    expect(removeElevationSpikes(singlePoint, 50)).toHaveLength(1);
    expect(removeElevationSpikes(singlePoint, 50)[0].ele).toBe(50);

    const twoPoints: GpxPoint[] = [
      { lat: -37.8136, lon: 144.9631, ele: 50, time: null },
      { lat: -37.82, lon: 144.97, ele: 150, time: null },
    ];
    const result = removeElevationSpikes(twoPoints, 50);
    expect(result).toHaveLength(2);
    expect(result[0].ele).toBe(50);
    expect(result[1].ele).toBe(150); // Not modified - need 3+ points to detect spikes
  });

  it('should not modify points within threshold', () => {
    const points: GpxPoint[] = [
      { lat: -37.8136, lon: 144.9631, ele: 50, time: null },
      { lat: -37.815, lon: 144.965, ele: 55, time: null },
      { lat: -37.82, lon: 144.97, ele: 60, time: null },
    ];

    const result = removeElevationSpikes(points, 50);

    expect(result[0].ele).toBe(50);
    expect(result[1].ele).toBe(55);
    expect(result[2].ele).toBe(60);
  });

  it('should interpolate elevation spikes linearly', () => {
    const points: GpxPoint[] = [
      { lat: -37.8136, lon: 144.9631, ele: 100, time: null },
      { lat: -37.815, lon: 144.965, ele: 200, time: null }, // spike (+100m)
      { lat: -37.82, lon: 144.97, ele: 105, time: null },
    ];

    const result = removeElevationSpikes(points, 50);

    expect(result[0].ele).toBe(100);
    // Spike should be interpolated halfway between 100 and 105
    expect(result[1].ele).toBeCloseTo(102.5, 1);
    expect(result[2].ele).toBe(105);
  });

  it('should handle isolated spikes in sequence', () => {
    // Create a pattern with two isolated spikes separated by valid points
    // Each spike is higher than BOTH its immediate neighbors
    const points: GpxPoint[] = [
      { lat: -37.81, lon: 144.96, ele: 100, time: null }, // valid
      { lat: -37.811, lon: 144.961, ele: 250, time: null }, // spike: 250 > 100 and 250 > 102
      { lat: -37.812, lon: 144.962, ele: 102, time: null }, // valid
      { lat: -37.813, lon: 144.963, ele: 103, time: null }, // valid
      { lat: -37.814, lon: 144.964, ele: 280, time: null }, // spike: 280 > 103 and 280 > 105
      { lat: -37.815, lon: 144.965, ele: 105, time: null }, // valid
    ];

    const result = removeElevationSpikes(points, 50);

    expect(result[0].ele).toBe(100);
    // First spike interpolated between 100 and 102
    expect(result[1].ele).toBeCloseTo(101, 0);
    expect(result[2].ele).toBe(102);
    expect(result[3].ele).toBe(103);
    // Second spike interpolated between 103 and 105
    expect(result[4].ele).toBeCloseTo(104, 0);
    expect(result[5].ele).toBe(105);
  });

  it('should not treat gradual elevation changes as spikes', () => {
    // This tests the case where elevation steadily increases then drops -
    // the middle points should NOT be treated as spikes since they're part
    // of a consistent trend, not isolated outliers
    const points: GpxPoint[] = [
      { lat: -37.81, lon: 144.96, ele: 100, time: null },
      { lat: -37.812, lon: 144.962, ele: 200, time: null }, // +100 from prev
      { lat: -37.814, lon: 144.964, ele: 300, time: null }, // +100 from prev
      { lat: -37.816, lon: 144.966, ele: 105, time: null }, // -195 from prev
    ];

    const result = removeElevationSpikes(points, 50);

    // Point 1 is NOT a spike: it's higher than point 0 but LOWER than point 2
    // (different directions), so it's part of a climb, not an outlier
    expect(result[0].ele).toBe(100);
    expect(result[1].ele).toBe(200); // Not modified - part of upward trend

    // Point 2 IS a spike: it's higher than BOTH neighbors (300 vs 200 and 105)
    // So it should be interpolated between 200 and 105
    expect(result[2].ele).toBeCloseTo(152.5, 0); // midpoint between 200 and 105

    expect(result[3].ele).toBe(105);
  });

  it('should handle downward spikes (dips)', () => {
    // Test that the algorithm also catches downward spikes (valleys)
    const points: GpxPoint[] = [
      { lat: -37.81, lon: 144.96, ele: 200, time: null },
      { lat: -37.812, lon: 144.962, ele: 50, time: null }, // dip: 50 < 200 and 50 < 195
      { lat: -37.814, lon: 144.964, ele: 195, time: null },
    ];

    const result = removeElevationSpikes(points, 50);

    expect(result[0].ele).toBe(200);
    // Dip should be interpolated between 200 and 195
    expect(result[1].ele).toBeCloseTo(197.5, 1);
    expect(result[2].ele).toBe(195);
  });

  it('should preserve endpoints even if they look like spikes', () => {
    // First and last points should never be modified since they can't be
    // compared to both neighbors
    const points: GpxPoint[] = [
      { lat: -37.81, lon: 144.96, ele: 500, time: null }, // high start
      { lat: -37.812, lon: 144.962, ele: 100, time: null },
      { lat: -37.814, lon: 144.964, ele: 600, time: null }, // high end
    ];

    const result = removeElevationSpikes(points, 50);

    // Endpoints should be preserved exactly
    expect(result[0].ele).toBe(500);
    expect(result[2].ele).toBe(600);
    // Middle point is a dip, should be interpolated
    expect(result[1].ele).toBeCloseTo(550, 0);
  });

  it('should handle all points at same elevation', () => {
    const points: GpxPoint[] = [
      { lat: -37.81, lon: 144.96, ele: 100, time: null },
      { lat: -37.812, lon: 144.962, ele: 100, time: null },
      { lat: -37.814, lon: 144.964, ele: 100, time: null },
      { lat: -37.816, lon: 144.966, ele: 100, time: null },
    ];

    const result = removeElevationSpikes(points, 50);

    // All points should remain unchanged
    result.forEach(p => expect(p.ele).toBe(100));
  });
});

describe('smoothElevation', () => {
  it('should return same points when fewer than window size', () => {
    const points: GpxPoint[] = [
      { lat: -37.8136, lon: 144.9631, ele: 50, time: null },
      { lat: -37.82, lon: 144.97, ele: 60, time: null },
    ];

    const result = smoothElevation(points, 5);

    expect(result).toEqual(points);
  });

  it('should smooth elevation data with moving average', () => {
    const points: GpxPoint[] = [
      { lat: -37.81, lon: 144.96, ele: 100, time: null },
      { lat: -37.811, lon: 144.961, ele: 100, time: null },
      { lat: -37.812, lon: 144.962, ele: 150, time: null }, // outlier
      { lat: -37.813, lon: 144.963, ele: 100, time: null },
      { lat: -37.814, lon: 144.964, ele: 100, time: null },
    ];

    const result = smoothElevation(points, 3);

    // Middle point should be smoothed
    expect(result[2].ele).toBeLessThan(150);
    expect(result[2].ele).toBeGreaterThan(100);
  });

  it('should preserve coordinates while smoothing', () => {
    const points: GpxPoint[] = [
      { lat: -37.81, lon: 144.96, ele: 100, time: '2024-01-01T10:00:00Z' },
      { lat: -37.811, lon: 144.961, ele: 110, time: '2024-01-01T10:01:00Z' },
      { lat: -37.812, lon: 144.962, ele: 120, time: '2024-01-01T10:02:00Z' },
    ];

    const result = smoothElevation(points, 3);

    expect(result[0].lat).toBe(-37.81);
    expect(result[0].lon).toBe(144.96);
    expect(result[0].time).toBe('2024-01-01T10:00:00Z');
  });
});

describe('calculateElevationStats', () => {
  it('should return zero for empty or single point', () => {
    expect(calculateElevationStats([])).toEqual({ gain: 0, loss: 0 });
    expect(calculateElevationStats([{ lat: 0, lon: 0, ele: 100, time: null }])).toEqual({ gain: 0, loss: 0 });
  });

  it('should calculate elevation gain', () => {
    const points: GpxPoint[] = [
      { lat: 0, lon: 0, ele: 100, time: null },
      { lat: 0, lon: 0, ele: 110, time: null },
      { lat: 0, lon: 0, ele: 120, time: null },
    ];

    const stats = calculateElevationStats(points);

    expect(stats.gain).toBe(20);
    expect(stats.loss).toBe(0);
  });

  it('should calculate elevation loss', () => {
    const points: GpxPoint[] = [
      { lat: 0, lon: 0, ele: 120, time: null },
      { lat: 0, lon: 0, ele: 110, time: null },
      { lat: 0, lon: 0, ele: 100, time: null },
    ];

    const stats = calculateElevationStats(points);

    expect(stats.gain).toBe(0);
    expect(stats.loss).toBe(20);
  });

  it('should calculate both gain and loss', () => {
    const points: GpxPoint[] = [
      { lat: 0, lon: 0, ele: 100, time: null },
      { lat: 0, lon: 0, ele: 150, time: null }, // +50 gain
      { lat: 0, lon: 0, ele: 130, time: null }, // -20 loss
      { lat: 0, lon: 0, ele: 160, time: null }, // +30 gain
    ];

    const stats = calculateElevationStats(points);

    expect(stats.gain).toBe(80);
    expect(stats.loss).toBe(20);
  });

  it('should filter out changes below threshold', () => {
    const points: GpxPoint[] = [
      { lat: 0, lon: 0, ele: 100, time: null },
      { lat: 0, lon: 0, ele: 101, time: null }, // +1, below threshold
      { lat: 0, lon: 0, ele: 102, time: null }, // +1, below threshold
      { lat: 0, lon: 0, ele: 110, time: null }, // +8, above default threshold (3)
    ];

    const stats = calculateElevationStats(points, 3);

    // The +1 steps are not lost: they count once the climb from the last
    // counted elevation (100) reaches the threshold, so the whole 10 m is in.
    expect(stats.gain).toBe(10);
  });

  it('keeps a dense, smooth climb that no single step reaches the threshold on', () => {
    // 1,000 m up and back down in 0.5 m steps, the shape of a smoothed
    // 5,000-point import. A per-step threshold counted none of it.
    const points = [
      ...Array.from({ length: 2001 }, (_, i) => ({ ele: 100 + i * 0.5 })),
      ...Array.from({ length: 2000 }, (_, i) => ({ ele: 1100 - (i + 1) * 0.5 })),
    ];
    const stats = calculateElevationStats(points, 3);
    expect(stats.gain).toBeGreaterThanOrEqual(997);
    expect(stats.gain).toBeLessThanOrEqual(1000);
    expect(stats.loss).toBeGreaterThanOrEqual(997);
  });

  it('ignores wiggles inside the threshold band however often they repeat', () => {
    const points = Array.from({ length: 1000 }, (_, i) => ({ ele: 100 + (i % 2) * 2 }));
    expect(calculateElevationStats(points, 3)).toEqual({ gain: 0, loss: 0 });
  });

  it('is the plain sum of every step at threshold 0', () => {
    const eles = [100, 101.5, 101, 104, 103.2, 103.2, 110, 95];
    const points = eles.map(ele => ({ ele }));
    let gain = 0;
    let loss = 0;
    for (let i = 1; i < eles.length; i++) {
      const d = eles[i] - eles[i - 1];
      if (d > 0) gain += d;
      else loss += Math.abs(d);
    }
    expect(calculateElevationStats(points, 0)).toEqual({ gain, loss });
  });

  it('does not climb the step into a route break', () => {
    const points = [{ ele: 0 }, { ele: 10 }, { ele: 500 }, { ele: 510 }];
    expect(calculateElevationStats(points, 3, new Set([2]))).toEqual({ gain: 20, loss: 0 });
  });
});

describe('douglasPeuckerIndices', () => {
  it('names the kept points by index, so a retraced coordinate keeps its own pass', () => {
    // Out and back: the outward and return passes share every coordinate.
    const out = Array.from({ length: 50 }, (_, i) => ({ lat: -34 + i * 0.001, lon: 138 + (i % 7) * 0.0003 }));
    const points = [...out, ...out.slice(0, -1).reverse()];
    const kept = douglasPeuckerIndices(points, 5);
    expect(kept[0]).toBe(0);
    expect(kept[kept.length - 1]).toBe(points.length - 1);
    for (let i = 1; i < kept.length; i++) expect(kept[i]).toBeGreaterThan(kept[i - 1]);
    expect(
      douglasPeucker(
        points.map(p => ({ ...p, ele: 0, time: null })),
        5
      )
    ).toHaveLength(kept.length);
  });
});

describe('cumulativeElevationChange', () => {
  it('ends on the calculateElevationStats totals', () => {
    const points = [100, 101, 102, 110, 108, 104, 105].map(ele => ({ ele }));
    const { ascent, descent } = cumulativeElevationChange(points, 3);
    expect(ascent).toEqual([0, 0, 0, 10, 10, 10, 10]);
    expect(descent).toEqual([0, 0, 0, 0, 0, 6, 6]);
    expect(calculateElevationStats(points, 3)).toEqual({ gain: 10, loss: 6 });
  });
});

describe('edge cases', () => {
  it('douglasPeucker with single point returns that point', () => {
    const points: GpxPoint[] = [{ lat: -37.8136, lon: 144.9631, ele: 50, time: null }];
    const result = douglasPeucker(points, 10);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(points[0]);
  });

  it('douglasPeucker with empty array returns empty array', () => {
    const result = douglasPeucker([], 10);
    expect(result).toHaveLength(0);
  });

  it('douglasPeucker with very large tolerance reduces to endpoints', () => {
    const points: GpxPoint[] = [];
    for (let i = 0; i < 100; i++) {
      points.push({
        lat: -37 + i * 0.001 + Math.sin(i) * 0.0001,
        lon: 144 + i * 0.001 + Math.cos(i) * 0.0001,
        ele: 50,
        time: null,
      });
    }
    const result = douglasPeucker(points, 1_000_000);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(points[0]);
    expect(result[result.length - 1]).toEqual(points[points.length - 1]);
  });

  it('douglasPeucker with zero tolerance keeps all points', () => {
    const points: GpxPoint[] = [
      { lat: -37.8136, lon: 144.9631, ele: 50, time: null },
      { lat: -37.814, lon: 144.964, ele: 55, time: null },
      { lat: -37.815, lon: 144.965, ele: 60, time: null },
    ];
    const result = douglasPeucker(points, 0);
    expect(result).toHaveLength(3);
  });

  it('calculateElevationStats with empty array returns zeros', () => {
    const stats = calculateElevationStats([]);
    expect(stats.gain).toBe(0);
    expect(stats.loss).toBe(0);
  });

  it('removeElevationSpikes with empty array returns empty', () => {
    expect(removeElevationSpikes([], 50)).toHaveLength(0);
  });

  it('smoothElevation with empty array returns empty', () => {
    expect(smoothElevation([], 5)).toHaveLength(0);
  });
});
