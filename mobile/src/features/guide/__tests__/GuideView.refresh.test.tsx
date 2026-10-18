/**
 * The guide's stop refresh (`GuideView`): a data update can move a place a plan
 * stop was saved at, and the guide moves the stop with it — but never from
 * data older than the plan was last saved against, which would move the stop
 * back and sync that over the newer device's correction (issue 143). The panes
 * are stubbed; the plan store is the real one with `apply`/`hydrate` replaced.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import type { PlanDocument } from '@lib/plan-types';
import { GuideView } from '../GuideView';
import { useGuide } from '../GuideContext';
import { usePlansStore } from '../../../state/plans-store';

jest.mock('../../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));
jest.mock('expo-router', () => ({ useFocusEffect: () => {} }));
jest.mock('../../../sync/connectivity', () => ({ useCommentSync: () => {} }));
jest.mock('../../../state/favorites-store', () => ({
  useFavoritesStore: { getState: () => ({ hydrate: async () => {} }) },
}));
jest.mock('../GuideContext', () => ({ useGuide: jest.fn() }));
jest.mock('../GuideFocusContext', () => ({
  GuideFocusProvider: ({ children }: { children: React.ReactNode }) => children,
  useGuideFocus: () => ({ pane: 'map', switchPane: () => {}, showOnMap: () => {} }),
}));
jest.mock('../../map/MapPane', () => ({ MapPane: () => null }));
jest.mock('../../elevation/ElevationPane', () => ({ ElevationPane: () => null }));
jest.mock('../WaypointListPane', () => ({ WaypointListPane: () => null }));
jest.mock('../DistanceStrip', () => ({ DistanceStrip: () => null }));
jest.mock('../DirectionToggle', () => ({ DirectionToggle: () => null }));
jest.mock('../SegmentedControl', () => ({ SegmentedControl: () => null }));

const TRAIL_ID = 'shikoku';
const PHONE_DATA = '2026-10-10T00:00:00.000Z';

/** The trail as this phone has it: Maekawa Campground at km 111.93. */
const BASE_TRAIL = {
  config: { id: TRAIL_ID, name: 'Shikoku' },
  track: { points: [], displayPoints: [], totalDistance: 200, totalAscent: 0, totalDescent: 0 },
  waypoints: [{ id: 'w_maekawa', name: 'Maekawa Campground', type: 'campsite', totalDistance: 111.93 }],
};

function planWithMaekawaAt(km: number, dataUpdatedAt?: string): PlanDocument {
  return {
    id: 'plan-1',
    trailId: TRAIL_ID,
    name: '',
    direction: 'NOBO',
    startDate: null,
    stops: [{ waypointId: 'w_maekawa', km, name: 'Maekawa Campground', nights: 1 }],
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...(dataUpdatedAt ? { dataUpdatedAt } : {}),
    version: 1,
  };
}

let apply: jest.Mock;
let mounted: ReactTestRenderer | null = null;

beforeEach(() => {
  (useGuide as jest.Mock).mockReturnValue({
    trailId: TRAIL_ID,
    trail: BASE_TRAIL,
    baseTrail: BASE_TRAIL,
    direction: 'default',
    dataUpdatedAt: PHONE_DATA,
  });
  apply = jest.fn(async (trailId: string, edit: (p: PlanDocument) => PlanDocument) => {
    const next = edit(usePlansStore.getState().byTrail[trailId]!);
    usePlansStore.setState((s) => ({ byTrail: { ...s.byTrail, [trailId]: next } }));
    return next;
  });
  usePlansStore.setState({ byTrail: {}, apply: apply as never, hydrate: (async () => {}) as never });
});

afterEach(() => {
  const tree = mounted;
  mounted = null;
  if (tree) act(() => tree.unmount());
});

async function mountWith(plan: PlanDocument | undefined): Promise<void> {
  usePlansStore.setState({ byTrail: { [TRAIL_ID]: plan } });
  await act(async () => {
    mounted = TestRenderer.create(<GuideView />);
    await new Promise((resolve) => setImmediate(resolve));
  });
}

const storedPlan = () => usePlansStore.getState().byTrail[TRAIL_ID];

describe('GuideView stop refresh', () => {
  it('moves a stop to where its place now is, once', async () => {
    await mountWith(planWithMaekawaAt(114.52));
    expect(apply).toHaveBeenCalledTimes(1);
    expect(storedPlan()?.stops[0].km).toBe(111.93);
  });

  it('leaves a plan whose stops are at their places alone', async () => {
    await mountWith(planWithMaekawaAt(111.93));
    expect(apply).not.toHaveBeenCalled();
  });

  it('leaves a stop alone when the plan was saved against newer data than the guide shows', async () => {
    // The web corrected Maekawa on data newer than this phone's: 111.93 there
    // is 114.52 here, and moving it would undo the correction for everyone.
    (useGuide as jest.Mock).mockReturnValue({
      trailId: TRAIL_ID,
      trail: BASE_TRAIL,
      baseTrail: { ...BASE_TRAIL, waypoints: [{ ...BASE_TRAIL.waypoints[0], totalDistance: 114.52 }] },
      direction: 'default',
      dataUpdatedAt: '2026-09-01T00:00:00.000Z',
    });
    await mountWith(planWithMaekawaAt(111.93, PHONE_DATA));
    expect(apply).not.toHaveBeenCalled();
    expect(storedPlan()?.stops[0].km).toBe(111.93);
  });

  it('moves it when the guide data is at least as new as the plan', async () => {
    await mountWith(planWithMaekawaAt(114.52, PHONE_DATA));
    expect(storedPlan()?.stops[0].km).toBe(111.93);
  });

  it('does nothing without a plan', async () => {
    await mountWith(undefined);
    expect(apply).not.toHaveBeenCalled();
  });
});
