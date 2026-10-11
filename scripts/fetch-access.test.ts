import { describe, it, expect } from 'vitest';
import { clusterCandidates, isWalkableWay, searchBox, selectCandidates, type Candidate } from './fetch-access';

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

  it("leaves a waypoint on one of the trail's side trips to the side trip", () => {
    const sideTrips = [{ name: 'Spur', type: 'side-trip', points: [{ lat: -34.01, lon: 138 }, { lat: -34.01, lon: 138.02 }] }];
    const trail = { track, sideTrips, waypoints: [wp('w_summit', 138.01)] };
    expect(selectCandidates(trail as never, 150, new Set())).toEqual([]);
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
