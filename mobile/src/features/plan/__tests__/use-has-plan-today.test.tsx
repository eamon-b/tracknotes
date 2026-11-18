/**
 * The guide header's Today button asks only whether the plan has a day dated
 * today (`useHasPlanToday`), and agrees with the Today screen's `todayPlan`.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { newPlan, setStartDate, toggleStop } from '@lib/plan-editor';
import type { PlanDocument } from '@lib/plan-types';
import type { TrailJson } from '../../../services/trail-assets';
import { useHasPlanToday } from '../use-today-plan';
import { stopCandidateOf, toggleTargetOf } from '../plan-stops';
import type { PlanBasis } from '../use-plan-glance';

let mockBasis: PlanBasis;
jest.mock('../use-plan-glance', () => ({
  ...jest.requireActual('../use-plan-glance'),
  usePlanBasis: () => mockBasis,
}));

function trail(): TrailJson {
  const points = Array.from({ length: 101 }, (_, i) => ({
    lat: 0,
    lon: i * 0.001,
    ele: 100,
    dist: i,
  }));
  return {
    config: {
      id: 'syn',
      name: 'Synthetic',
      shortName: 'SYN',
      region: 'Test',
      lengthKm: 100,
      direction: { default: 'Northbound', reversed: 'Southbound' },
    },
    waypoints: [
      { id: 'c1', name: 'Camp A', lat: 0, lon: 0, type: 'campsite', totalDistance: 25 },
      { id: 'c2', name: 'Camp B', lat: 0, lon: 0, type: 'campsite', totalDistance: 50 },
      { id: 'c3', name: 'Camp C', lat: 0, lon: 0, type: 'campsite', totalDistance: 75 },
    ],
    track: { points, displayPoints: points, totalDistance: 100, totalAscent: 0, totalDescent: 0 },
  };
}

function planWith(t: TrailJson, startDate: string | null): PlanDocument {
  let doc = newPlan('syn', 'Synthetic', 'NOBO', { idFactory: () => 'plan-1' });
  for (const wp of t.waypoints) {
    doc = toggleStop(doc, toggleTargetOf(stopCandidateOf(wp, 'NOBO', 100)), { totalKm: 100 });
  }
  return startDate ? setStartDate(doc, startDate) : doc;
}

function hasToday(startDate: string | null): boolean {
  const t = trail();
  mockBasis = {
    plan: planWith(t, startDate),
    options: { direction: 'NOBO', baseKmh: 4, dailyHours: 8 },
    trail: t,
  };
  let result: boolean | undefined;
  function Probe() {
    result = useHasPlanToday();
    return null;
  }
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<Probe />);
  });
  act(() => tree.unmount());
  return result!;
}

describe('useHasPlanToday', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date(2026, 9, 11, 12, 0) });
  });
  afterEach(() => jest.useRealTimers());

  it('is true on a walking day dated today', () => {
    expect(hasToday('2026-10-10')).toBe(true);
  });

  it('is false before the start date, after the last day, and with no start date', () => {
    expect(hasToday('2026-10-12')).toBe(false);
    expect(hasToday('2026-09-01')).toBe(false);
    expect(hasToday(null)).toBe(false);
  });
});
