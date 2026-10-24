import { describe, it, expect } from 'vitest';
import { DEFAULT_PLAN_THRESHOLDS, PLAN_THRESHOLD_BOUNDS, clampPlanThreshold, usablePlanThreshold } from './plan-types';

describe('planning thresholds', () => {
  it('start each input inside its own range', () => {
    for (const key of Object.keys(DEFAULT_PLAN_THRESHOLDS) as (keyof typeof DEFAULT_PLAN_THRESHOLDS)[]) {
      const { min, max } = PLAN_THRESHOLD_BOUNDS[key];
      expect(DEFAULT_PLAN_THRESHOLDS[key]).toBeGreaterThanOrEqual(min);
      expect(DEFAULT_PLAN_THRESHOLDS[key]).toBeLessThanOrEqual(max);
    }
  });

  it('clamp into range, and give an unusable figure its initial value', () => {
    expect(clampPlanThreshold('longCarryDays', 0)).toBe(PLAN_THRESHOLD_BOUNDS.longCarryDays.min);
    expect(clampPlanThreshold('foodGramsPerDay', 1e6)).toBe(PLAN_THRESHOLD_BOUNDS.foodGramsPerDay.max);
    expect(clampPlanThreshold('dryStretchKm', 22.5)).toBe(22.5);
    expect(clampPlanThreshold('dryStretchKm', Number.NaN)).toBe(DEFAULT_PLAN_THRESHOLDS.dryStretchKm);
  });

  it('accept only a stored figure an input could have produced', () => {
    expect(usablePlanThreshold('dryStretchKm', 20)).toBe(20);
    expect(usablePlanThreshold('dryStretchKm', 0)).toBeUndefined();
    expect(usablePlanThreshold('foodGramsPerDay', '680')).toBeUndefined();
    expect(usablePlanThreshold('longCarryDays', Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});
