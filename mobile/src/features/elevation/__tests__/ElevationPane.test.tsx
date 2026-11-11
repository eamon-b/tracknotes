/**
 * The pane's POI wiring: which markers reach the profile, and where a tap on
 * one goes.
 *
 * `ElevationProfile` is mocked to a props recorder — Skia, gestures and layout
 * are the profile's own tests' business; what matters here is the 60 km gate on
 * the POI ticks and the two tap destinations.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { ElevationPane } from '../ElevationPane';
import type { ElevationProfileProps } from '../ElevationProfile';
import type { TrailPOI } from '@lib/trail-types';
import type { TrailJson } from '../../../services/trail-loader';
import type { PlanDocument } from '@lib/plan-types';
import { resolveGuideTrail } from '../../guide/guide-trail';

jest.mock('../../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
  useReduceMotion: () => false,
}));

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock('../../guide/GuideContext', () => ({
  useGuide: () => ({
    trailId: 'heysen',
    trail: mockGuideTrail ?? mockTrail,
    baseTrail: mockBaseTrail ?? mockTrail,
    direction: mockDirection,
  }),
}));

jest.mock('../../guide/GuidePositionContext', () => ({
  useGuidePositionContext: () => mockPosition,
}));

jest.mock('../../../state/plans-store', () => ({
  usePlansStore: (selector: (s: unknown) => unknown) => selector({}),
  selectPlan: () => () => mockPlan,
  selectResupplyStops: () => () => mockPlan?.resupplyStops,
}));

jest.mock('../../../state/settings-store', () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) => selector({ units: 'km' }),
}));

jest.mock('../../../state/favorites-store', () => ({
  useFavoritesStore: (selector: (s: unknown) => unknown) => selector({ byTrail: {} }),
}));

jest.mock('../../routes/routes-store', () => ({
  useRoutesStore: (selector: (s: unknown) => unknown) =>
    selector({ activePointsByTrail: { heysen: mockActivePoints } }),
}));

jest.mock('../../guide/use-visible-pois', () => ({
  useVisiblePois: () => mockVisiblePois,
}));

// Props of the most recent ElevationProfile render.
const mockProfileProps: ElevationProfileProps[] = [];
jest.mock('../ElevationProfile', () => ({
  ElevationProfile: (props: ElevationProfileProps) => {
    mockProfileProps.push(props);
    return null;
  },
}));

function poi(overrides: Partial<TrailPOI> = {}): TrailPOI {
  return {
    id: 9,
    type: 'node',
    category: 'water',
    lat: -35,
    lon: 138,
    name: 'Rain tank',
    tags: {},
    distanceAlongTrail: 30,
    distanceFromTrail: 0.1,
    ...overrides,
  };
}

const mockTrail = {
  track: {
    totalDistance: 100,
    displayPoints: Array.from({ length: 101 }, (_, i) => ({
      lat: 0,
      lon: 0,
      dist: i,
      ele: 100 + i,
    })),
  },
  waypoints: [{ id: 'w_camp', name: 'Ridge Camp', type: 'campsite', totalDistance: 12 }],
} as unknown as TrailJson;

let mockVisiblePois: TrailPOI[] = [];
let mockDirection: 'default' | 'reversed' = 'default';
let mockPlan: PlanDocument | undefined;
let mockGuideTrail: TrailJson | undefined;
let mockBaseTrail: TrailJson | undefined;
let mockPosition: {
  status: string;
  currentKm: number | null;
  position: { lat: number; lon: number } | null;
} = { status: 'no-permission', currentKm: null, position: null };
let mockActivePoints: { kind: 'snap'; lat: number; lon: number; km: number }[] | undefined;

function render(): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<ElevationPane />);
  });
  return tree;
}

/** The props of the last profile render. */
function lastProps(): ElevationProfileProps {
  return mockProfileProps[mockProfileProps.length - 1];
}

describe('ElevationPane POI ticks', () => {
  beforeEach(() => {
    mockProfileProps.length = 0;
    mockPush.mockClear();
    mockVisiblePois = [poi()];
  });

  it('withholds POI markers while the whole 100 km trail is in view', () => {
    const tree = render();
    expect(lastProps().waypoints?.map((w) => w.id)).toEqual(['w_camp']);
    act(() => tree.unmount());
  });

  it('appends them once the window is 60 km or narrower', () => {
    const tree = render();
    act(() => lastProps().onWindowChange({ startKm: 10, endKm: 70 }));
    expect(lastProps().waypoints).toEqual([
      expect.objectContaining({ id: 'w_camp' }),
      // Elevation sampled off the track at km 30.
      { id: 'node-9', kind: 'poi', type: 'water', totalDistance: 30, elevation: 130 },
    ]);

    // …and drops them again when the walker zooms back out.
    act(() => lastProps().onWindowChange({ startKm: 0, endKm: 100 }));
    expect(lastProps().waypoints?.map((w) => w.id)).toEqual(['w_camp']);
    act(() => tree.unmount());
  });

  it('passes nothing extra when the filter hides every POI', () => {
    mockVisiblePois = [];
    const tree = render();
    act(() => lastProps().onWindowChange({ startKm: 10, endKm: 20 }));
    expect(lastProps().waypoints?.map((w) => w.id)).toEqual(['w_camp']);
    act(() => tree.unmount());
  });

  it('routes a POI tap to the POI screen and a waypoint tap to the waypoint screen', () => {
    const tree = render();
    act(() => lastProps().onWaypointTap?.('node-9', 'poi'));
    expect(mockPush).toHaveBeenLastCalledWith({
      pathname: '/guide/[trailId]/poi/[poiKey]',
      params: { trailId: 'heysen', poiKey: 'node-9' },
    });

    act(() => lastProps().onWaypointTap?.('w_camp', 'waypoint'));
    expect(mockPush).toHaveBeenLastCalledWith({
      pathname: '/guide/[trailId]/waypoint/[waypointId]',
      params: { trailId: 'heysen', waypointId: 'w_camp' },
    });
    act(() => tree.unmount());
  });
});

/** Whether the chip shows its hint, i.e. no readout is on screen. */
function hintShown(tree: ReactTestRenderer): boolean {
  return (
    tree.root.findAll(
      (n) =>
        n.props.children === 'Tap to read off · pinch to zoom (up/down for height) · drag to pan',
    ).length > 0
  );
}

describe('ElevationPane elevation axis', () => {
  beforeEach(() => {
    mockProfileProps.length = 0;
    mockVisiblePois = [];
    mockDirection = 'default';
    mockActivePoints = undefined;
  });

  function press(tree: ReactTestRenderer, label: string) {
    const [button] = tree.root.findAll(
      (n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function',
    );
    act(() => (button.props.onPress as () => void)());
  }

  it('opens on 0 m to just above the high point, whatever the km window', () => {
    // The fixture climbs 100 → 200 m.
    const tree = render();
    expect(lastProps().eleWindow).toEqual({ minM: 0, maxM: 200 });
    act(() => lastProps().onWindowChange({ startKm: 10, endKm: 20 }));
    expect(lastProps().eleWindow).toEqual({ minM: 0, maxM: 200 });
    act(() => tree.unmount());
  });

  it('stretches and flattens from the floor, and resets with the zoom', () => {
    const tree = render();
    press(tree, 'Stretch elevation');
    expect(lastProps().eleWindow.minM).toBe(0);
    expect(lastProps().eleWindow.maxM).toBeCloseTo(200 / 1.5, 6);

    press(tree, 'Reset zoom');
    expect(lastProps().eleWindow).toEqual({ minM: 0, maxM: 200 });

    press(tree, 'Flatten elevation');
    expect(lastProps().eleWindow).toEqual({ minM: 0, maxM: 300 });
    act(() => tree.unmount());
  });
});

describe('ElevationPane across a direction flip', () => {
  beforeEach(() => {
    mockProfileProps.length = 0;
    mockVisiblePois = [];
    mockDirection = 'default';
    mockActivePoints = undefined;
  });

  it('mirrors the zoom window so it stays on the same stretch of ground', () => {
    const tree = render();
    act(() => lastProps().onWindowChange({ startKm: 10, endKm: 30 }));
    act(() => lastProps().onScrub?.({ km: 20, ele: 120 }));
    expect(hintShown(tree)).toBe(false);

    mockDirection = 'reversed';
    act(() => tree.update(<ElevationPane />));
    expect(lastProps().window).toEqual({ startKm: 70, endKm: 90 });
    // The readout named a km of the old numbering; it is cleared, not kept.
    expect(hintShown(tree)).toBe(true);
    act(() => tree.unmount());
  });

  it('shades a saved route over the km it was drawn at, in either direction', () => {
    // Saved NOBO-absolute: km 10 → 20.
    mockActivePoints = [
      { kind: 'snap', lat: 0, lon: 0, km: 10 },
      { kind: 'snap', lat: 0, lon: 0, km: 20 },
    ];
    const tree = render();
    expect(lastProps().highlightRanges).toEqual([{ startKm: 10, endKm: 20 }]);

    mockDirection = 'reversed';
    act(() => tree.update(<ElevationPane />));
    expect(lastProps().highlightRanges).toEqual([{ startKm: 80, endKm: 90 }]);
    act(() => tree.unmount());
  });
});

/** Degrees of longitude (or latitude) per km on the equator. */
const DEG_PER_KM = 1 / 111.19492664455873;
/** How far north the alternate's far point is: two 10 km legs over 10 km of main route. */
const APEX_NORTH_KM = Math.sqrt(75);

/**
 * A 100 km main route due east along the equator (a point per km, climbing
 * 100 → 200 m) with a 20 km "Ridge" alternate that leaves at km 30, climbs to
 * 500 m at a point north of the main route and rejoins at km 40.
 */
function mainPoints() {
  return Array.from({ length: 101 }, (_, km) => ({
    lat: 0,
    lon: km * DEG_PER_KM,
    ele: 100 + km,
    dist: km,
  }));
}
const altBase = {
  config: { name: 'Ridge test' },
  track: { totalDistance: 100, points: mainPoints(), displayPoints: mainPoints(), breaks: [] },
  waypoints: [
    { id: 'w_camp', name: 'Ridge Camp', type: 'campsite', totalDistance: 12 },
    { id: 'w_valley', name: 'Valley Hut', type: 'hut', totalDistance: 35 },
    { id: 'w_town', name: 'Town', type: 'town', totalDistance: 60 },
  ],
  alternates: [
    {
      name: 'Ridge',
      type: 'alternate',
      distance: 20,
      startDistance: 30,
      endDistance: 40,
      elevation: { ascent: 370, descent: 360 },
      points: [
        { lat: 0, lon: 30 * DEG_PER_KM, ele: 130 },
        { lat: APEX_NORTH_KM * DEG_PER_KM, lon: 35 * DEG_PER_KM, ele: 500 },
        { lat: 0, lon: 40 * DEG_PER_KM, ele: 140 },
      ],
      waypoints: [{ id: 'w_ridge', name: 'Ridge Top', type: 'campsite', totalDistance: 40 }],
    },
  ],
} as unknown as TrailJson;

function ridgePlan(direction: 'NOBO' | 'SOBO', alternates?: string[]): PlanDocument {
  return {
    id: 'p',
    trailId: 'heysen',
    name: 'Plan',
    direction,
    startDate: null,
    stops: [
      { waypointId: 'w_camp', km: 12, name: 'Ridge Camp', nights: 1 },
      // 10 km along the alternate: its far point.
      { waypointId: 'w_ridge', km: 40, name: 'Ridge Top', nights: 1, alternate: 'Ridge' },
      { waypointId: 'w_town', km: 60, name: 'Town', nights: 1 },
    ],
    updatedAt: 'T',
    version: 1,
    ...(alternates ? { alternates } : {}),
  };
}

const atRidgeTop = {
  status: 'off-trail',
  currentKm: 35,
  position: { lat: APEX_NORTH_KM * DEG_PER_KM, lon: 35 * DEG_PER_KM },
};

const round3 = (km: number) => Math.round(km * 1000) / 1000;

describe('ElevationPane on a plan taking an alternate', () => {
  beforeEach(() => {
    mockProfileProps.length = 0;
    mockVisiblePois = [];
    mockDirection = 'default';
    mockActivePoints = undefined;
    mockBaseTrail = altBase;
    mockGuideTrail = altBase;
    mockPosition = { status: 'no-permission', currentKm: null, position: null };
  });

  afterAll(() => {
    mockBaseTrail = undefined;
    mockGuideTrail = undefined;
    mockPlan = undefined;
  });

  it('plots the main route while the plan takes no alternate', () => {
    mockPlan = ridgePlan('NOBO');
    const tree = render();
    const props = lastProps();
    expect(props.totalKm).toBe(100);
    expect(props.waypoints?.map((w) => w.id)).toEqual(['w_camp', 'w_valley', 'w_town']);
    // The alternate's stop is not on this plan's route.
    expect(props.stopKms).toEqual([12, 60]);
    act(() => tree.unmount());
  });

  it('plots the route as planned, with stops at their true km, walking NOBO', () => {
    mockPlan = ridgePlan('NOBO', ['Ridge']);
    mockActivePoints = [
      { kind: 'snap', lat: 0, lon: 0, km: 20 },
      { kind: 'snap', lat: 0, lon: 0, km: 50 },
    ];
    mockPosition = atRidgeTop;
    const tree = render();
    const props = lastProps();
    // 100 km of main route, less the 10 km bypassed, plus the 20 km alternate.
    expect(props.totalKm).toBeCloseTo(110, 6);
    expect(props.window).toEqual({ startKm: 0, endKm: props.totalKm });
    // It climbs the ridge, and the bypassed valley's hut is gone.
    expect(Math.max(...props.points.map((p) => p.ele))).toBe(500);
    // The elevation axis is fitted to the route as planned, ridge included.
    expect(props.eleWindow.maxM).toBeGreaterThanOrEqual(500);
    expect(props.waypoints?.map((w) => [w.id, round3(w.totalDistance ?? -1)])).toEqual([
      ['w_camp', 12],
      ['w_ridge', 40],
      ['w_town', 70],
    ]);
    expect(props.stopKms?.map(round3)).toEqual([12, 40, 70]);
    // The hiker on the ridge is at its far point, not at main km 35.
    expect(props.currentKm).toBeCloseTo(40, 1);
    // The saved route's spans, less the stretch the alternate bypasses.
    expect(props.highlightRanges).toEqual([
      { startKm: 20, endKm: 30 },
      { startKm: 50, endKm: 60 },
    ]);
    act(() => tree.unmount());
  });

  it('plots the route as planned walking SOBO', () => {
    mockDirection = 'reversed';
    mockGuideTrail = resolveGuideTrail(altBase, 'reversed');
    mockPlan = ridgePlan('SOBO', ['Ridge']);
    mockActivePoints = [
      { kind: 'snap', lat: 0, lon: 0, km: 20 },
      { kind: 'snap', lat: 0, lon: 0, km: 50 },
    ];
    mockPosition = { ...atRidgeTop, currentKm: 65 };
    const tree = render();
    const props = lastProps();
    expect(props.totalKm).toBeCloseTo(110, 6);
    expect(Math.max(...props.points.map((p) => p.ele))).toBe(500);
    expect(props.waypoints?.map((w) => [w.id, round3(w.totalDistance ?? -1)])).toEqual([
      ['w_town', 40],
      ['w_ridge', 70],
      ['w_camp', 98],
    ]);
    expect(props.stopKms?.map(round3)).toEqual([40, 70, 98]);
    expect(props.currentKm).toBeCloseTo(70, 1);
    expect(
      props.highlightRanges?.map((r) => ({ startKm: round3(r.startKm), endKm: round3(r.endKm) })),
    ).toEqual([
      { startKm: 80, endKm: 90 },
      { startKm: 50, endKm: 60 },
    ]);
    act(() => tree.unmount());
  });

  it('draws no position on the main stretch the alternate bypasses', () => {
    mockPlan = ridgePlan('NOBO', ['Ridge']);
    mockPosition = { status: 'fix', currentKm: 35, position: { lat: 0, lon: 35 * DEG_PER_KM } };
    const tree = render();
    expect(lastProps().currentKm).toBeNull();
    act(() => tree.unmount());
  });
});
