/**
 * The plan → map/profile conversion.
 *
 * The bug this exists to prevent: a reversed guide ringing the wrong hut. Stops
 * are stored NOBO-absolute and the guide trail is direction-applied, so every
 * assertion here is really about that one mirror.
 */

import type { PlanDocument } from '@lib/plan-types';
import type { PlannedRoute } from '@lib/plan-alternates';
import {
  alternatePlaceNoboKm,
  plannedAlternateWaypoints,
  plannedRouteLines,
  plannedStopFeatureIds,
  plannedStopKms,
  profileKmOfStop,
} from '../plan-overlay';

const TOTAL = 100;

const WAYPOINTS = [
  { id: 'w_1', name: 'Hut', totalDistance: 20 },
  { id: 'w_2', name: 'Spring', totalDistance: 50 },
  { name: 'Unnamed camp', totalDistance: 80 },
];

function plan(over: Partial<PlanDocument> = {}): PlanDocument {
  return {
    id: 'p1',
    trailId: 'heysen',
    name: 'Heysen',
    direction: 'NOBO',
    startDate: null,
    stops: [{ waypointId: 'w_1', km: 20, name: 'Hut', nights: 1 }],
    updatedAt: 'T',
    version: 1,
    ...over,
  };
}

describe('plannedStopFeatureIds', () => {
  it('rings the waypoint a stop names', () => {
    expect([...plannedStopFeatureIds(plan(), WAYPOINTS, 'NOBO', TOTAL)]).toEqual(['w_1']);
  });

  it('rings nothing for an absent or empty plan', () => {
    expect(plannedStopFeatureIds(undefined, WAYPOINTS, 'NOBO', TOTAL).size).toBe(0);
    expect(plannedStopFeatureIds(plan({ stops: [] }), WAYPOINTS, 'NOBO', TOTAL).size).toBe(0);
  });

  it('follows the mirror when the guide is reversed', () => {
    // SOBO: the hut at NOBO 20 is at active km 80 on the reversed trail.
    const reversedWaypoints = [
      { id: 'w_1', name: 'Hut', totalDistance: 80 },
      { id: 'w_2', name: 'Spring', totalDistance: 50 },
    ];
    expect([...plannedStopFeatureIds(plan(), reversedWaypoints, 'SOBO', TOTAL)]).toEqual(['w_1']);

    // A stop with no waypoint id has only its km to go on, which is where the
    // mirror actually bites: NOBO 20 is the hut going one way and nothing
    // going the other.
    const kmOnly = plan({ stops: [{ km: 20, name: 'Hut', nights: 1 }] });
    expect([...plannedStopFeatureIds(kmOnly, reversedWaypoints, 'SOBO', TOTAL)]).toEqual(['w_1']);
    expect([...plannedStopFeatureIds(kmOnly, reversedWaypoints, 'NOBO', TOTAL)]).toEqual([]);
  });

  it('falls back to the name+index id for a waypoint without one', () => {
    const kmOnly = plan({ stops: [{ km: 80, name: 'Unnamed camp', nights: 1 }] });
    expect([...plannedStopFeatureIds(kmOnly, WAYPOINTS, 'NOBO', TOTAL)]).toEqual([
      'Unnamed camp-2',
    ]);
  });
});

describe('plannedStopKms', () => {
  it('gives the day boundaries in the walking direction, sorted', () => {
    const two = plan({
      stops: [
        { waypointId: 'w_2', km: 50, name: 'Spring', nights: 1 },
        { waypointId: 'w_1', km: 20, name: 'Hut', nights: 1 },
      ],
    });
    expect(plannedStopKms(two, 'NOBO', TOTAL)).toEqual([20, 50]);
    expect(plannedStopKms(two, 'SOBO', TOTAL)).toEqual([50, 80]);
  });

  it('is empty without a plan', () => {
    expect(plannedStopKms(undefined, 'NOBO', TOTAL)).toEqual([]);
  });

  it('leaves out a stop on an alternate, which is not on the main profile', () => {
    const withAlternate = plan({
      alternates: ['Alt: Ridge'],
      stops: [
        { waypointId: 'w_1', km: 20, name: 'Hut', nights: 1 },
        { waypointId: 'w_ridge', km: 35, name: 'Ridge Camp', nights: 1, alternate: 'Alt: Ridge' },
      ],
    });
    expect(plannedStopKms(withAlternate, 'NOBO', TOTAL)).toEqual([20]);
  });
});

describe('alternates the plan takes', () => {
  const withAlternate = plan({
    alternates: ['Alt: Ridge'],
    stops: [
      { waypointId: 'w_1', km: 20, name: 'Hut', nights: 1 },
      // 5 km along the 20 km alternate.
      { waypointId: 'w_ridge', km: 35, name: 'Ridge Camp', nights: 1, alternate: 'Alt: Ridge' },
      { km: 60, name: 'Spare', nights: 1, alternate: 'Alt: Gone' },
    ],
  });

  // Main km 30-40 replaced by a 20 km ridge alternate (the trail's alternates[1]).
  const ridge = {
    name: 'Alt: Ridge',
    index: 1,
    startKm: 30,
    endKm: 40,
    distanceKm: 20,
    mainDistanceKm: 10,
    ascentM: 500,
    descentM: 500,
  };
  const route: PlannedRoute = {
    alternates: [ridge],
    segments: [
      { kind: 'main', fromKm: 0, toKm: 30, routeFromKm: 0 },
      { kind: 'alternate', alternate: ridge, routeFromKm: 30 },
      { kind: 'main', fromKm: 40, toKm: 100, routeFromKm: 50 },
    ],
    totalDistance: 110,
    mainTotalDistance: TOTAL,
  };

  it('ticks a stop on a taken alternate along the main stretch it replaces', () => {
    // 5 of 20 km along → a quarter of the way through main km 30-40.
    expect(plannedStopKms(withAlternate, 'NOBO', TOTAL, route)).toEqual([20, 32.5]);
    expect(plannedStopKms(withAlternate, 'SOBO', TOTAL, route)).toEqual([67.5, 80]);
  });

  it('drops a main-route stop the taken alternate bypasses', () => {
    const bypassed = plan({
      alternates: ['Alt: Ridge'],
      stops: [{ waypointId: 'w_x', km: 35, name: 'Valley Hut', nights: 1 }],
    });
    expect(plannedStopKms(bypassed, 'NOBO', TOTAL, route)).toEqual([]);
  });

  it('ticks no stop past an end of a shortened alternate, nor past the end of the trail', () => {
    // 23 km along a 20 km alternate: not pinned to the rejoin.
    const shortened = plan({
      alternates: ['Alt: Ridge'],
      stops: [
        { km: 53, name: 'Old Ridge End', nights: 1, alternate: 'Alt: Ridge' },
        { km: 104, name: 'Past the End', nights: 1 },
      ],
    });
    expect(profileKmOfStop(shortened.stops[0], route)).toBeNull();
    expect(plannedStopKms(shortened, 'NOBO', TOTAL, route)).toEqual([]);
    expect(plannedStopKms(shortened, 'NOBO', TOTAL)).toEqual([]);
  });

  it('rings a place on the alternate, never a main place at the same km', () => {
    const waypoints = [
      { name: 'Valley camp', totalDistance: 35 },
      { id: 'w_ridge', name: 'Ridge Camp', totalDistance: 35, alternate: 'Alt: Ridge' },
    ];
    expect([...plannedStopFeatureIds(withAlternate, waypoints, 'NOBO', TOTAL)]).toEqual([
      'w_ridge',
    ]);
    const kmOnly = plan({
      stops: [{ km: 35, name: 'Ridge Camp', nights: 1, alternate: 'Alt: Ridge' }],
    });
    const noIds = [
      { name: 'Valley camp', totalDistance: 35 },
      { name: 'Ridge Camp', totalDistance: 35, alternate: 'Alt: Ridge' },
    ];
    expect([...plannedStopFeatureIds(kmOnly, noIds, 'NOBO', TOTAL)]).toEqual(['Ridge Camp-1']);
  });

  it('rings a shared place by id whichever line its stop is on', () => {
    const shared = plan({
      stops: [{ waypointId: 'w_1', km: 30, name: 'Hut', nights: 1, alternate: 'Alt: Ridge' }],
    });
    expect([...plannedStopFeatureIds(shared, WAYPOINTS, 'NOBO', TOTAL)]).toEqual(['w_1']);
  });

  it('describes the lines to draw, in the walking direction', () => {
    expect(plannedRouteLines({ ...route, alternates: [] }, 'NOBO', TOTAL)).toBeNull();
    const lines = plannedRouteLines(route, 'SOBO', TOTAL)!;
    expect([...lines.takenAlternateIndices]).toEqual([1]);
    expect(lines.bypassedKm).toEqual([[60, 70]]);
  });

  it('lists the taken alternates’ places, tagged, without repeating a main place', () => {
    const alternates = [
      { name: 'Alt: Other', waypoints: [{ id: 'w_o', name: 'Other', totalDistance: 12 }] },
      {
        name: 'Alt: Ridge',
        waypoints: [
          { id: 'w_1', name: 'Hut', totalDistance: 30 },
          { id: 'w_ridge', name: 'Ridge Camp', totalDistance: 35 },
        ],
      },
    ];
    const lines = plannedRouteLines(route, 'NOBO', TOTAL);
    expect(plannedAlternateWaypoints(alternates, lines, WAYPOINTS, 'NOBO', TOTAL)).toEqual([
      { id: 'w_ridge', name: 'Ridge Camp', totalDistance: 35, alternate: 'Alt: Ridge', noboKm: 35 },
    ]);
    expect(plannedAlternateWaypoints(alternates, null, WAYPOINTS, 'NOBO', TOTAL)).toEqual([]);
  });

  it('turns a reversed alternate’s place back to its stored km, not the main mirror', () => {
    // The ridge is 20 km against 10 km of main route. Reversed, it starts at
    // active km 60 and is walked from its far end: the place 5 km along it
    // NOBO (stored km 35) is 15 km along it, at active km 75. The main
    // route's mirror would say 25.
    expect(alternatePlaceNoboKm(ridge, 75, 'SOBO', TOTAL)).toBe(35);
    expect(alternatePlaceNoboKm(ridge, 35, 'NOBO', TOTAL)).toBe(35);
  });

  it('rings a km-only stop on a reversed alternate', () => {
    const kmOnly = plan({
      alternates: ['Alt: Ridge'],
      stops: [{ km: 35, name: 'Ridge Camp', nights: 1, alternate: 'Alt: Ridge' }],
    });
    // Direction applied: the guide trail's alternates[1] after reversal.
    const reversedAlternates = [
      { name: 'Alt: Other', waypoints: [] },
      { name: 'Alt: Ridge', waypoints: [{ name: 'Ridge Camp', totalDistance: 75 }] },
    ];
    const lines = plannedRouteLines(route, 'SOBO', TOTAL);
    const onAlternate = plannedAlternateWaypoints(reversedAlternates, lines, [], 'SOBO', TOTAL);
    expect([...plannedStopFeatureIds(kmOnly, onAlternate, 'SOBO', TOTAL)]).toEqual([
      'Ridge Camp-0',
    ]);
  });
});
