/**
 * The Day screen a Plan screen day card opens: the day out of its route params,
 * its rows on the route the plan walks, and the label on the night's stop.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { Text } from 'react-native';
import type { ComputedDay } from '@lib/plan-types';
import { defaultPoiFilterState, type PoiFilterState } from '@lib/poi-display';
import type { TrailJson } from '../../../services/trail-assets';
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
jest.mock('../../../state/plans-store', () => ({
  selectPlan: () => () => null,
  usePlansStore: (selector: (s: unknown) => unknown) => selector({}),
}));

/** 100 km, flat, with a creek at 30 and camps at 20 and 60. */
const mockTrail = {
  config: { id: 'syn', name: 'Syn' },
  track: {
    totalDistance: 100,
    points: Array.from({ length: 101 }, (_, i) => ({ lat: 0, lon: i * 0.009, ele: 100, dist: i })),
  },
  waypoints: [
    { id: 'c1', name: 'Camp A', lat: 0, lon: 0.18, type: 'campsite', totalDistance: 20, trackIndex: 20 },
    { id: 'wa', name: 'Creek', lat: 0, lon: 0.27, type: 'water', totalDistance: 30, trackIndex: 30 },
    { id: 'c2', name: 'Camp B', lat: 0, lon: 0.54, type: 'campsite', totalDistance: 60, trackIndex: 60 },
  ],
} as unknown as TrailJson;
jest.mock('../use-plan-route', () => ({ usePlanRoute: () => ({ trail: mockTrail }) }));

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

function render(): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<DayScreen />);
  });
  return tree;
}

const texts = (tree: ReactTestRenderer) =>
  tree.root.findAllByType(Text).map((t) => [t.props.children].flat().join(''));

beforeEach(() => {
  mockPush.mockClear();
  mockFilter = defaultPoiFilterState();
});

it('lists the day stop to stop and opens a waypoint', () => {
  mockParams = { trailId: 'syn', ...dayRouteParams(day) };
  const tree = render();
  const shown = texts(tree);
  expect(shown).toContain('Day 4 · 2020-01-02');
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
