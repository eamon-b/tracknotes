import { describe, expect, it } from 'vitest';
import { MIN_ELE_SPAN_M, eleBounds } from './elevation-axis';

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
