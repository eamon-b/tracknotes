/**
 * The distance strip's "Next resupply" chip: measured to the next planned
 * stop, with what lies beyond the turn-off — a walk in (timed with the trail)
 * or a ride (named, not timed). Everything around the chip is mocked; the
 * maths underneath (`tripAlongTrail`, `estimateHikingTime`) is real, and so
 * is the route as planned (`use-plan-route`) for a plan taking an alternate.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import type { ResupplyStop, ResupplyTrail } from '@lib/resupply-plan';
import type { PlanDocument } from '@lib/plan-types';
import { DistanceStrip } from '../DistanceStrip';
import { resolveGuideTrail } from '../guide-trail';
import type { TrailJson } from '../../../services/trail-loader';

let mockStops: ResupplyStop[] | null = null;
// When set, the stops are resolved for real against the trail the strip passes,
// so a town only the route as planned has can only appear if that is the one.
let mockSelected: string[] | null = null;
let mockPlan: PlanDocument | undefined;
let mockDirection: 'default' | 'reversed' = 'default';
let mockGuideTrail: unknown;
let mockBaseTrail: unknown;
let mockPosition: { currentKm: number | null; lat: number; lon: number; status: string } = {
  currentKm: 0,
  lat: 0,
  lon: 0,
  status: 'fix',
};

// A flat 50 km line: times are pace alone (4 km/h).
const mockTrail = {
  config: { name: 'Flat' },
  track: {
    totalDistance: 50,
    points: [
      { lat: 0, lon: 0, ele: 0, dist: 0 },
      { lat: 0, lon: 0.45, ele: 0, dist: 50 },
    ],
  },
  waypoints: [],
};

/** Degrees of longitude per km on the equator. */
const DEG_PER_KM = 1 / 111.19492664455873;

/**
 * A flat 50 km main route due east along the equator, a point per km, with a
 * 16 km alternate ("High Route") that leaves at km 10, loops north and rejoins
 * at km 20. Main Town is at main km 30; Alt Town 6 km along the alternate.
 */
const altTrail = {
  config: { name: 'Alt' },
  track: {
    totalDistance: 50,
    points: Array.from({ length: 51 }, (_, km) => ({
      lat: 0,
      lon: km * DEG_PER_KM,
      ele: 0,
      dist: km,
    })),
    breaks: [],
  },
  waypoints: [{ id: 'main-town', name: 'Main Town', type: 'town', totalDistance: 30 }],
  alternates: [
    {
      name: 'High Route',
      type: 'alternate',
      distance: 16,
      startDistance: 10,
      endDistance: 20,
      points: [
        { lat: 0, lon: 10 * DEG_PER_KM, ele: 0 },
        { lat: 6 * DEG_PER_KM, lon: 15 * DEG_PER_KM, ele: 0 },
        { lat: 0, lon: 20 * DEG_PER_KM, ele: 0 },
      ],
      waypoints: [{ id: 'alt-town', name: 'Alt Town', type: 'town', totalDistance: 16 }],
    },
  ],
};

jest.mock('../../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));

jest.mock('../GuideContext', () => ({
  useGuide: () => ({
    trailId: 'flat',
    direction: mockDirection,
    trail: mockGuideTrail,
    baseTrail: mockBaseTrail,
  }),
}));

jest.mock('../GuidePositionContext', () => ({
  useGuidePositionContext: () => ({
    status: mockPosition.status,
    currentKm: mockPosition.currentKm,
    offTrailMeters: 0,
    position: { lat: mockPosition.lat, lon: mockPosition.lon },
    error: null,
    start: jest.fn(),
    stop: jest.fn(),
  }),
}));

jest.mock('../../../state/plans-store', () => ({
  usePlansStore: (selector: (s: unknown) => unknown) => selector({}),
  selectPlan: () => () => mockPlan,
}));

jest.mock('../../../state/settings-store', () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) => selector({ units: 'km' }),
}));

jest.mock('../../plan/plan-inputs-store', () => ({
  usePlanInputsStore: (selector: (s: unknown) => unknown) => selector({}),
  selectPaceBaseKmh: () => () => 4,
}));

jest.mock('../../plan/use-planned-resupply', () => {
  const lib = jest.requireActual<typeof import('@lib/resupply-plan')>('@lib/resupply-plan');
  return {
    usePlannedResupplyStops: (_trailId: string, trail: ResupplyTrail) =>
      mockSelected
        ? lib.resolveResupplyStops(
            lib.listResupplyOptions(lib.resupplyCandidates(trail)),
            mockSelected,
          )
        : mockStops,
  };
});

jest.mock('../../share/use-check-in-share', () => ({ useCheckInShare: () => jest.fn() }));
jest.mock('../../share/ShareIconButton', () => ({ ShareIconButton: () => null }));

function collectText(node: unknown, out: string[]): void {
  if (typeof node === 'string') out.push(node);
  else if (typeof node === 'number') out.push(String(node));
  else if (Array.isArray(node)) node.forEach((n) => collectText(n, out));
}

function allText(tree: ReactTestRenderer): string {
  const texts: string[] = [];
  tree.root.findAll(() => true).forEach((n) => collectText(n.props.children, texts));
  return texts.join(' ');
}

function render(): string {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<DistanceStrip />);
  });
  return allText(tree);
}

const walk = { place: 'Spur Town', walkKm: 2, walkAscentM: 0, walkDescentM: 0, rideKm: 0 };

describe('DistanceStrip — Next resupply', () => {
  beforeEach(() => {
    mockStops = null;
    mockSelected = null;
    mockPlan = undefined;
    mockDirection = 'default';
    mockGuideTrail = mockTrail;
    mockBaseTrail = mockTrail;
    mockPosition = { currentKm: 0, lat: 0, lon: 0, status: 'fix' };
  });

  it('shows no resupply chip until a plan exists', () => {
    expect(render()).not.toContain('resupply');
  });

  it('measures to a stop on the route', () => {
    mockStops = [{ km: 10, name: 'Town', optionIds: ['t'] }];
    const text = render();
    expect(text).toContain('Next resupply');
    // 10 km at 4 km/h.
    expect(text).toContain('10.0 km · ~2 h 30 min');
  });

  it('adds the walk in to an off-trail town, and times it', () => {
    mockStops = [{ km: 10, name: 'Spur Town', optionIds: ['s'], access: walk }];
    // 10 km of trail + 2 km in = 12 km at 4 km/h = 3 h.
    expect(render()).toContain('10.0 km + 2.0 km off trail · ~3 h');
  });

  it('names a hitch beyond the turn-off without timing it', () => {
    mockStops = [
      {
        km: 10,
        name: 'Hitch Town',
        optionIds: ['h'],
        access: { ...walk, walkKm: 0, rideKm: 35, rideMode: 'hitch' },
      },
    ];
    expect(render()).toContain('10.0 km + 35.0 km hitch · ~2 h 30 min');
  });

  it('says so past the last planned stop', () => {
    mockStops = [];
    expect(render()).toContain('No planned resupply ahead');
  });
});

describe('DistanceStrip — Next resupply on a plan taking an alternate', () => {
  const plan = (direction: 'NOBO' | 'SOBO', alternates?: string[]): PlanDocument => ({
    id: 'p',
    trailId: 'flat',
    name: 'Plan',
    direction,
    startDate: null,
    stops: [],
    resupplyStops: ['alt-town', 'main-town'],
    updatedAt: 'T',
    version: 1,
    ...(alternates ? { alternates } : {}),
  });

  beforeEach(() => {
    mockStops = null;
    mockSelected = ['alt-town', 'main-town'];
    mockDirection = 'default';
    mockGuideTrail = altTrail;
    mockBaseTrail = altTrail;
  });

  it('skips a town on an alternate the plan does not take', () => {
    mockPlan = plan('NOBO');
    mockPosition = { currentKm: 5, lat: 0, lon: 5 * DEG_PER_KM, status: 'fix' };
    // Main Town, 25 km on along the main route.
    expect(render()).toContain('Next resupply 25.0 km');
  });

  it('measures to a town on the alternate the plan takes', () => {
    mockPlan = plan('NOBO', ['High Route']);
    mockPosition = { currentKm: 5, lat: 0, lon: 5 * DEG_PER_KM, status: 'fix' };
    // 5 km to the branch, 6 km along the alternate.
    expect(render()).toContain('Next resupply 11.0 km');
  });

  it('places a hiker walking the alternate on it, not on the main route', () => {
    mockPlan = plan('NOBO', ['High Route']);
    // At the alternate's far point (route km 18, past Alt Town at 16). The
    // guide snapped it to main km 15, which would put Alt Town still ahead.
    mockPosition = {
      currentKm: 15,
      lat: 6 * DEG_PER_KM,
      lon: 15 * DEG_PER_KM,
      status: 'off-trail',
    };
    // The 8 km left of the alternate, then 10 km of main route to Main Town.
    expect(render()).toContain('Next resupply 18.0 km');
  });

  it('works walking the other way', () => {
    mockPlan = plan('SOBO', ['High Route']);
    mockDirection = 'reversed';
    // Reversed as the guide reverses it; the plan's route is spliced from the
    // trail as stored.
    mockGuideTrail = resolveGuideTrail(altTrail as unknown as TrailJson, 'reversed');
    // Main km 45 NOBO: 15 km to Main Town (main km 30), then 18 km to the
    // rejoin and 10 km back along the alternate to Alt Town.
    mockPosition = { currentKm: 5, lat: 0, lon: 45 * DEG_PER_KM, status: 'fix' };
    expect(render()).toContain('Next resupply 15.0 km');

    // Past Main Town (main km 28 NOBO), the next stop is Alt Town along the
    // alternate, not the main stretch it bypasses: 8 km to the rejoin and 10 km
    // along it.
    mockPosition = { currentKm: 22, lat: 0, lon: 28 * DEG_PER_KM, status: 'fix' };
    expect(render()).toContain('Next resupply 18.0 km');
  });

  it('says so on the main stretch a taken alternate bypasses', () => {
    mockPlan = plan('NOBO', ['High Route']);
    // Main km 15 is on the bypassed stretch, nearly 4 km from the alternate.
    mockPosition = { currentKm: 15, lat: 0, lon: 15 * DEG_PER_KM, status: 'fix' };
    const text = render();
    expect(text).toContain('Not on your planned route');
    expect(text).not.toContain('Next resupply');
  });
});
