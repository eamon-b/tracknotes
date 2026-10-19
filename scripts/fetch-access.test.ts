import { describe, it, expect } from 'vitest';
import {
  accessAfterRun,
  clusterCandidates,
  isWalkableWay,
  oldestAnswer,
  pauseAfterFailure,
  RateLimitedError,
  retryAfterSeconds,
  searchBox,
  selectCandidates,
  alternateRoute,
  type Candidate,
} from './fetch-access';
import type { TrailAccessEntry, TrailAccessFile } from './lib/trail-access-file';

describe('isWalkableWay', () => {
  it('walks roads and paths, not motorways or ways closed to walkers', () => {
    expect(isWalkableWay({ highway: 'path' })).toBe(true);
    expect(isWalkableWay({ highway: 'trunk' })).toBe(true);
    expect(isWalkableWay({ highway: 'motorway' })).toBe(false);
    expect(isWalkableWay({ highway: 'trunk', foot: 'no' })).toBe(false);
    expect(isWalkableWay({ highway: 'service', access: 'private' })).toBe(false);
    expect(isWalkableWay({ highway: 'track', access: 'no', foot: 'yes' })).toBe(true);
    expect(isWalkableWay({ building: 'yes' })).toBe(false);
  });
});

describe('selectCandidates', () => {
  const track = {
    points: [0, 1, 2].map(i => ({ lat: -34 - i * 0.01, lon: 138, ele: 0, dist: i * 1.112 })),
    displayPoints: [],
    totalDistance: 2.224,
    totalAscent: 0,
    totalDescent: 0,
  };
  const wp = (id: string, lon: number, extra = {}) =>
    ({ id, name: id, type: 'campsite', lat: -34.01, lon, ...extra }) as never;

  it('takes waypoints far enough off the route, and not turn-offs or ones the source placed', () => {
    const trail = {
      track,
      waypoints: [
        wp('w_near', 138.001),
        wp('w_far', 138.01),
        wp('w_turnoff', 138.01, { type: 'campsite-access' }),
        wp('w_given', 138.01, { offTrailKm: 1 }),
        wp('w_ours', 138.02, { offTrailKm: 2.5 }),
        wp('w_note', 138.01, { type: 'junction' }),
      ],
    };
    const ids = selectCandidates(trail as never, 150, new Set(['w_ours'])).map(c => c.id);
    expect(ids).toEqual(['w_far', 'w_ours']);
  });

  it('carries the near-duplicates merged into a waypoint', () => {
    const trail = { track, waypoints: [wp('w_kept', 138.01, { mergedIds: ['w_twin'] })] };
    expect(selectCandidates(trail as never, 150, new Set())[0].mergedIds).toEqual(['w_twin']);
  });

  it("leaves a waypoint on one of the trail's side trips to the side trip", () => {
    const sideTrips = [{ name: 'Spur', type: 'side-trip', points: [{ lat: -34.01, lon: 138 }, { lat: -34.01, lon: 138.02 }] }];
    const trail = { track, sideTrips, waypoints: [wp('w_summit', 138.01)] };
    expect(selectCandidates(trail as never, 150, new Set())).toEqual([]);
  });

  describe('off an alternate', () => {
    // East from km 1.112 of the route for 2.5 km, along latitude -34.01.
    const alternate = {
      name: 'Alt: east',
      type: 'alternate',
      points: [0, 1, 2, 3, 4, 5].map(i => ({ lat: -34.01, lon: 138 + i * 0.006, ele: 0 })),
      waypoints: [],
    };
    // 0.003 deg south of the alternate (334 m), 2.2 km east of the route.
    const below = (id: string, extra = {}) => ({ id, name: id, type: 'campsite', lat: -34.013, lon: 138.024, ...extra });

    it('routes a place the main route did not match to the alternate it is off, with km along it', () => {
      const trail = { track, waypoints: [], alternates: [alternate], offTrailWaypoints: [below('w_camp')] };
      const [camp] = selectCandidates(trail as never, 150, new Set());
      expect(camp.variant).toBe('Alt: east');
      expect(camp.straightLineM).toBeCloseTo(334, -1);
      // 0.024 deg of longitude at 34 deg S from the alternate's start, not trail km.
      expect(camp.nearestKm).toBeCloseTo(2.214, 2);
    });

    it("takes the alternate's own rows too, once each", () => {
      const row = { ...below('w_camp'), totalDistance: 3 };
      const trail = {
        track,
        waypoints: [],
        alternates: [{ ...alternate, waypoints: [row] }],
        offTrailWaypoints: [below('w_camp')],
      };
      expect(selectCandidates(trail as never, 150, new Set()).map(c => c.id)).toEqual(['w_camp']);
    });

    it('leaves a place beyond the match radius of the alternate, or near enough to it, alone', () => {
      const far = { ...below('w_far'), lat: -34.02 };
      const near = { ...below('w_near'), lat: -34.0105 };
      const trail = { track, waypoints: [], alternates: [alternate], offTrailWaypoints: [far, near] };
      expect(selectCandidates(trail as never, 150, new Set())).toEqual([]);
      // A trail with a wider radius (Shikoku's 3 km) reaches the far one.
      const wide = { ...trail, config: { waypointMaxDistance: 3000 } };
      expect(selectCandidates(wide as never, 150, new Set()).map(c => c.id)).toEqual(['w_far']);
    });

    it("leaves the main route's waypoints, turn-offs and places on a side trip to the main route's rules", () => {
      const sideTrips = [{ name: 'Spur', type: 'side-trip', points: [{ lat: -34.013, lon: 138.02 }, { lat: -34.013, lon: 138.03 }] }];
      const trail = {
        track,
        waypoints: [wp('w_main', 138.001, { mergedIds: ['w_twin'] })],
        alternates: [alternate],
        offTrailWaypoints: [below('w_twin'), below('w_turnoff', { type: 'campsite-access' }), below('w_given', { offTrailKm: 1 })],
      };
      expect(selectCandidates(trail as never, 150, new Set())).toEqual([]);
      const onSpur = { ...trail, waypoints: [], offTrailWaypoints: [below('w_camp')], sideTrips };
      expect(selectCandidates(onSpur as never, 150, new Set())).toEqual([]);
    });

    it('routes nothing to an alternate whose name another alternate shares', () => {
      const trail = {
        track,
        waypoints: [],
        alternates: [alternate, { ...alternate, points: alternate.points.map(p => ({ ...p, lat: -34.03 })) }],
        offTrailWaypoints: [below('w_camp')],
      };
      expect(selectCandidates(trail as never, 150, new Set())).toEqual([]);
    });
  });
});

describe('alternateRoute', () => {
  it('measures km from the branch point', () => {
    const route = alternateRoute({ points: [0, 1, 2].map(i => ({ lat: -34 - i * 0.01, lon: 138, ele: 0 })) });
    expect(route.map(p => p.dist)).toEqual([0, expect.closeTo(1.112, 2), expect.closeTo(2.224, 2)]);
  });
});

describe('clusterCandidates', () => {
  const at = (id: string, lat: number, lon: number): Candidate => ({
    id, name: id, lat, lon, straightLineM: 500, nearestKm: 0, ...searchBox(lat, lon, 500),
  });

  it('shares a query between neighbours and keeps distant places apart', () => {
    const clusters = clusterCandidates([at('a', -34, 138), at('b', -34.005, 138.005), at('c', -35, 139)]);
    expect(clusters.map(c => c.members.map(m => m.id))).toEqual([['a', 'b'], ['c']]);
  });
});

describe('accessAfterRun', () => {
  const osm = (name: string, km: number): TrailAccessEntry => ({
    name,
    method: 'osm',
    junction: [-34, 138],
    junctionKm: km,
    offTrailKm: 1,
  });
  const previous: TrailAccessFile = {
    source: 's',
    attribution: 'a',
    fetchedAt: '2026-01-01T00:00:00.000Z',
    endpoint: 'e',
    minDistanceM: 150,
    places: {
      w_a: osm('A', 1),
      w_b: osm('B', 2),
      w_c: osm('C', 3),
      w_hand: { name: 'Hand', method: 'manual', junction: [-34, 138], offTrailKm: 0.5 },
    },
  };

  it('keeps every entry --only left out, and replaces the ones it fetched', () => {
    const fetched = { w_a: osm('A', 1.5) };
    const places = accessAfterRun(previous, fetched, new Set(['w_a']), new Set());
    expect(Object.keys(places).sort()).toEqual(['w_a', 'w_b', 'w_c', 'w_hand']);
    expect(places.w_a.junctionKm).toBe(1.5);
    expect(places.w_b).toBe(previous.places.w_b);
  });

  it('keeps an --only entry whose query failed', () => {
    const places = accessAfterRun(previous, {}, new Set(['w_a']), new Set(['w_a']));
    expect(Object.keys(places).sort()).toEqual(['w_a', 'w_b', 'w_c', 'w_hand']);
  });

  it('drops, on a whole run, entries for places that are no longer candidates', () => {
    const places = accessAfterRun(previous, { w_a: osm('A', 1) }, null, new Set(['w_b']));
    expect(Object.keys(places).sort()).toEqual(['w_a', 'w_b', 'w_hand']);
  });

  it('dates the file by the oldest answer its entries rest on', () => {
    const now = new Date('2026-10-18T00:00:00.000Z');
    const cached = new Date('2026-09-01T00:00:00.000Z');
    const fetched = { w_a: osm('A', 1) };
    const whole = { ...fetched, w_hand: previous.places.w_hand };
    expect(oldestAnswer([now, cached], previous, whole, fetched, now)).toEqual(cached);
    expect(oldestAnswer([], previous, whole, fetched, now)).toEqual(now);
    // A kept entry is as old as the file it came from.
    const partial = accessAfterRun(previous, fetched, new Set(['w_a']), new Set());
    expect(oldestAnswer([now], previous, partial, fetched, now)).toEqual(new Date(previous.fetchedAt));
  });
});

describe('Retry-After', () => {
  it('reads seconds and HTTP dates', () => {
    const now = Date.parse('2026-10-18T00:00:00Z');
    expect(retryAfterSeconds('120', now)).toBe(120);
    expect(retryAfterSeconds('Sun, 18 Oct 2026 00:01:30 GMT', now)).toBe(90);
    expect(retryAfterSeconds('Sat, 17 Oct 2026 00:00:00 GMT', now)).toBe(0);
    expect(retryAfterSeconds(null, now)).toBeNull();
    expect(retryAfterSeconds('soon', now)).toBeNull();
  });

  it('waits as long as the mirror asks, within reason', () => {
    expect(pauseAfterFailure(new Error('HTTP 504'))).toBe(5);
    expect(pauseAfterFailure(new RateLimitedError('429', 45))).toBe(45);
    expect(pauseAfterFailure(new RateLimitedError('429', 0))).toBe(5);
    expect(pauseAfterFailure(new RateLimitedError('429', 3600))).toBe(300);
  });
});
