/**
 * A scrollToIndex that lands before the rows are measured is retried once
 * layout settles: with the position and animation it was asked for, against
 * the rows on screen then, and never after the pane has gone.
 */

import React from 'react';
import { FlatList } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer, type TestInstance } from 'react-test-renderer';
import { WaypointListPane } from '../WaypointListPane';
import type { TrailJson } from '../../../services/trail-loader';

jest.mock('../../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));

const mockPush = jest.fn();
let mockPosition: { currentKm: number | null; status: string } = {
  currentKm: null,
  status: 'no-permission',
};
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
}));

/** The trail the guide context serves (the pane's own, set by `render`). */
let mockGuideTrail: unknown;

jest.mock('../GuideContext', () => ({
  useGuide: () => ({
    trailId: 'heysen',
    direction: 'default',
    baseTrail: mockGuideTrail,
    trail: mockGuideTrail,
  }),
}));

jest.mock('../GuidePositionContext', () => ({
  useGuidePositionContext: () => mockPosition,
}));

jest.mock('../../../state/favorites-store', () => ({
  useFavoritesStore: (selector: (s: unknown) => unknown) => selector({ byTrail: {} }),
}));

jest.mock('../../../state/settings-store', () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) => selector({ units: 'km' }),
}));

jest.mock('../use-water-status', () => ({
  useWaterStatus: () => new Map(),
}));

jest.mock('../use-visible-pois', () => ({
  useVisiblePois: jest.fn(() => []),
}));

const trail = {
  track: { totalDistance: 30, points: [] },
  waypoints: [
    { id: 'w_start', name: 'Trailhead', type: 'trailhead', totalDistance: 0 },
    { id: 'w_creek', name: 'Kennedy Creek', type: 'creek', totalDistance: 12 },
    { id: 'w_camp', name: 'Ridge Camp', type: 'campsite', totalDistance: 20 },
    { id: 'w_hut', name: 'Stone Hut', type: 'hut', totalDistance: 24 },
  ],
} as unknown as TrailJson;

function render(): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    mockGuideTrail = trail;
    tree = TestRenderer.create(<WaypointListPane trail={trail} />);
  });
  act(() => {
    jest.runOnlyPendingTimers();
  });
  return tree;
}

/** The list's own failure callback, as FlatList would call it. */
function failScroll(tree: ReactTestRenderer, index: number): void {
  const list = tree.root.findAll(
    (n: TestInstance) => typeof n.props.onScrollToIndexFailed === 'function',
  )[0];
  act(() => {
    (list.props.onScrollToIndexFailed as (info: unknown) => void)({
      index,
      averageItemLength: 50,
      highestMeasuredFrameIndex: 0,
    });
  });
}

describe('WaypointListPane scrollToIndex retry', () => {
  let scrollToIndex: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    mockPosition = { currentKm: 20, status: 'fix' };
    scrollToIndex = jest.spyOn(FlatList.prototype, 'scrollToIndex').mockImplementation(() => {});
    jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    mockPosition = { currentKm: null, status: 'no-permission' };
  });

  it('retries the request as it was made', () => {
    const tree = render();
    const button = tree.root.findAll(
      (n: TestInstance) =>
        n.props.accessibilityLabel === 'Scroll to my position' &&
        typeof n.props.onPress === 'function',
    )[0];
    scrollToIndex.mockClear();
    act(() => (button.props.onPress as () => void)());
    const [first] = scrollToIndex.mock.calls[0] as [{ index: number }];
    scrollToIndex.mockClear();

    failScroll(tree, first.index);
    act(() => {
      jest.advanceTimersByTime(200);
    });
    expect(scrollToIndex).toHaveBeenCalledWith({
      index: first.index,
      viewPosition: 0.3,
      animated: true,
    });
  });

  it('does not retry after the pane unmounts', () => {
    const tree = render();
    failScroll(tree, 1);
    act(() => tree.unmount());
    scrollToIndex.mockClear();
    jest.advanceTimersByTime(200);
    expect(scrollToIndex).not.toHaveBeenCalled();
  });
});
