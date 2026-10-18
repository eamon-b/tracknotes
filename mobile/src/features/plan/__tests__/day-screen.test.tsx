/**
 * The Day screen a Plan screen day card opens: the day out of its route params,
 * its rows on the route the plan walks, and the label on the night's stop.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { Text } from 'react-native';
import { newPlan, setStartDate, toggleStop } from '@lib/plan-editor';
import type { ComputedDay, PlanDocument } from '@lib/plan-types';
import { defaultPoiFilterState, type PoiFilterState } from '@lib/poi-display';
import type { TrailJson } from '../../../services/trail-assets';
import { stopCandidateOf, toggleTargetOf } from '../plan-stops';
import { dayRouteParams } from '../today-plan';
import DayScreen from '../../../../app/guide/[trailId]/day';

let mockParams: Record<string, string>;
const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ push: mockPush }),
  Stack: { Screen: () => null },
}));

jest.mock('../../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));

let mockFilter: PoiFilterState;
jest.mock('../../../state/settings-store', () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ units: 'km', poiFilter: mockFilter, setPoiEnabled: jest.fn(), setPoiCategory: jest.fn() }),
  selectPoiFilter: (s: { poiFilter: PoiFilterState }) => s.poiFilter,
}));

jest.mock('../../guide/GuideContext', () => ({ useGuide: () => ({ trailId: 'syn' }) }));

/** 100 km, flat, with a creek at 30 and camps at 5, 20, 60 and 80. */
const mockTrail = {
  config: { id: 'syn', name: 'Syn' },
  track: {
    totalDistance: 100,
    points: Array.from({ length: 101 }, (_, i) => ({ lat: 0, lon: i * 0.009, ele: 100, dist: i })),
  },
  waypoints: [
    { id: 'c0', name: 'Camp 0', lat: 0, lon: 0.045, type: 'campsite', totalDistance: 5, trackIndex: 5 },
    { id: 'c1', name: 'Camp A', lat: 0, lon: 0.18, type: 'campsite', totalDistance: 20, trackIndex: 20 },
    { id: 'wa', name: 'Creek', lat: 0, lon: 0.27, type: 'water', totalDistance: 30, trackIndex: 30 },
    { id: 'c2', name: 'Camp B', lat: 0, lon: 0.54, type: 'campsite', totalDistance: 60, trackIndex: 60 },
    { id: 'c3', name: 'Camp C', lat: 0, lon: 0.72, type: 'campsite', totalDistance: 80, trackIndex: 80 },
  ],
} as unknown as TrailJson;
let mockPlan: PlanDocument;
jest.mock('../use-plan-glance', () => ({
  usePlanBasis: () => ({
    trail: mockTrail,
    plan: mockPlan,
    options: { direction: 'NOBO', baseKmh: 4, dailyHours: 8 },
  }),
}));

/** The saved plan: stops at the waypoints named, starting on `startDate`. */
function planWith(ids: string[], startDate: string | null): PlanDocument {
  let doc = newPlan('syn', 'Syn', 'NOBO', { idFactory: () => 'plan-1' });
  for (const id of ids) {
    const wp = mockTrail.waypoints.find((w) => w.id === id)!;
    doc = toggleStop(doc, toggleTargetOf(stopCandidateOf(wp, 'NOBO', 100)), { totalKm: 100 });
  }
  return startDate ? setStartDate(doc, startDate) : doc;
}

const day: ComputedDay = {
  dayNumber: 4,
  date: '2020-01-02',
  startName: 'Camp A',
  endName: 'Camp B',
  startKm: 20,
  endKm: 60,
  distanceKm: 40,
  ascentM: 0,
  descentM: 0,
  estimatedHours: 9,
  waterSources: 1,
};

const mounted: ReactTestRenderer[] = [];
function render(): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<DayScreen />);
  });
  mounted.push(tree);
  return tree;
}

// Unmounting clears the screen's midnight timer.
afterEach(() => {
  act(() => mounted.splice(0).forEach((tree) => tree.unmount()));
});

const texts = (tree: ReactTestRenderer) =>
  tree.root.findAllByType(Text).map((t) => [t.props.children].flat().join(''));

beforeEach(() => {
  mockPush.mockClear();
  mockFilter = defaultPoiFilterState();
  // The plan the card was opened from: Camp A, then Camp B on day 2.
  mockPlan = planWith(['c1', 'c2'], '2020-01-01');
});

it('lists the day stop to stop and opens a waypoint', () => {
  mockParams = { trailId: 'syn', ...dayRouteParams(day) };
  const tree = render();
  const shown = texts(tree);
  // The plan's own number and date, not the card's.
  expect(shown).toContain('Day 2 · 2020-01-02');
  expect(shown).toContain('Camp A → Camp B');
  expect(shown.filter((s) => ['Camp A', 'Creek', 'Camp B'].includes(s))).toEqual([
    'Camp A',
    'Creek',
    'Camp B',
  ]);
  // Not today's day, and not the trail's end.
  expect(shown).toContain('Overnight');
  expect(shown).not.toContain('Tonight');

  const [creek] = tree.root.findAll(
    (n) =>
      typeof n.props.onPress === 'function' &&
      typeof n.props.accessibilityLabel === 'string' &&
      n.props.accessibilityLabel.startsWith('Creek'),
  );
  act(() => (creek.props.onPress as () => void)());
  expect(mockPush).toHaveBeenCalledWith({
    pathname: '/guide/[trailId]/waypoint/[waypointId]',
    params: { trailId: 'syn', waypointId: 'wa' },
  });
});

it('calls the trail end the finish', () => {
  mockParams = {
    trailId: 'syn',
    ...dayRouteParams({ ...day, startKm: 60, endKm: 100, startName: 'Camp B', endName: 'End' }),
  };
  expect(texts(render())).toContain('Finish');
});

it('says so when the params do not make a day', () => {
  mockParams = { trailId: 'syn', dayNumber: '2' };
  expect(texts(render()).some((s) => s.includes('could not be opened'))).toBe(true);
});

it('shows the plan as it is now, not as the card was', () => {
  // Opened as Camp A → Camp B; then Camp B was taken out and Camp C (km 80)
  // made a stop, from a waypoint screen pushed over this one.
  mockParams = { trailId: 'syn', ...dayRouteParams(day) };
  mockPlan = planWith(['c1', 'c3'], null);
  const shown = texts(render());
  expect(shown).toContain('Camp A → Camp C');
});

it('follows the day from the same stop after the days are renumbered', () => {
  mockParams = { trailId: 'syn', ...dayRouteParams({ ...day, dayNumber: 1, date: '2020-01-01' }) };
  // A stop added before Camp A: the day from Camp A is now day 3, on the 3rd.
  mockPlan = planWith(['c0', 'c1', 'c2'], '2020-01-01');
  const shown = texts(render());
  expect(shown).toContain('Day 3 · 2020-01-03');
  expect(shown).toContain('Camp A → Camp B');
});

it('says when no day starts at that stop any more', () => {
  mockParams = { trailId: 'syn', ...dayRouteParams(day) };
  mockPlan = planWith(['c2'], null);
  expect(texts(render()).some((s) => s.includes('no longer in the plan'))).toBe(true);
});

it('says when the stretch from that stop is not planned yet', () => {
  mockParams = { trailId: 'syn', ...dayRouteParams(day) };
  // Camp B taken out: 80 km from Camp A to the end is too long for a day.
  mockPlan = planWith(['c1'], null);
  const shown = texts(render());
  expect(shown.some((s) => s.startsWith('Not planned yet: from Camp A'))).toBe(true);
  expect(shown).not.toContain('Camp A → Syn End');
});

it('measures the day over the section the Plan screen showed', () => {
  const section = { startKm: 20, endKm: 60, startName: 'Camp A', endName: 'Camp B' };
  mockParams = { trailId: 'syn', ...dayRouteParams({ ...day, dayNumber: 1 }, section) };
  mockPlan = planWith([], null);
  const shown = texts(render());
  expect(shown).toContain('Day 1');
  expect(shown).toContain('Camp A → Camp B');
});

it('drops a section that no longer fits the route', () => {
  // Opened over a 120 km section; the route is now 100 km (an alternate taken).
  const section = { startKm: 0, endKm: 120, startName: 'Old start', endName: 'Old end' };
  mockParams = { trailId: 'syn', ...dayRouteParams({ ...day, startKm: 80, endKm: 120 }, section) };
  mockPlan = planWith(['c1', 'c2', 'c3'], null);
  const shown = texts(render());
  expect(shown).toContain('Camp C → Syn End');
  expect(shown).toContain('Finish');
});
