import { describe, expect, it } from 'vitest';
import { MIN_ELE_SPAN_M, eleAxis, eleBounds } from './elevation-axis';

const pts = (...eles: number[]) => eles.map(ele => ({ ele }));

describe('eleBounds', () => {
  it('runs from 0 m to just above the high point, whatever the low point', () => {
    expect(eleBounds(pts(1200, 1380, 1250))).toEqual({ floorM: 0, ceilingM: 1400 });
    expect(eleBounds(pts(5, 43, 12))).toEqual({ floorM: 0, ceilingM: 50 });
  });

  it('drops below 0 m only for a track that does', () => {
    expect(eleBounds(pts(-28, 10)).floorM).toBe(-28);
    expect(eleBounds(pts(-312, 10)).floorM).toBe(-320);
  });

  it('keeps a minimum span and skips missing heights', () => {
    expect(eleBounds(pts(0, 0))).toEqual({ floorM: 0, ceilingM: MIN_ELE_SPAN_M });
    expect(eleBounds(pts(NaN, 320))).toEqual({ floorM: 0, ceilingM: 320 });
  });
});

describe('eleAxis', () => {
  it('raises the top to the next labelled line, so the high point is never above the last label', () => {
    // A 1,380 m high point: ceiling 1,400 m, step 500 m.
    expect(eleAxis(eleBounds(pts(200, 1380)), 4)).toEqual({
      minM: 0,
      maxM: 1500,
      ticks: [0, 500, 1000, 1500],
    });
  });

  it('keeps a ceiling that already sits on a line', () => {
    expect(eleAxis({ floorM: 0, ceilingM: 400 }, 4)).toEqual({
      minM: 0,
      maxM: 400,
      ticks: [0, 100, 200, 300, 400],
    });
  });

  it('starts below 0 m only with the floor', () => {
    const axis = eleAxis({ floorM: -30, ceilingM: 50 }, 4);
    expect(axis.minM).toBe(-30);
    expect(axis.ticks[0]).toBe(-20);
    expect(axis.maxM).toBeGreaterThanOrEqual(50);
  });
});
