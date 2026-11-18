import { describe, it, expect } from 'vitest';
import {
  reverseAlternates,
  transformSideTrips,
  type ReversibleVariant,
  type VariantWaypointKmFields,
} from './variant-reverse';

type TestWaypoint = VariantWaypointKmFields & {
  name?: string;
  type?: string;
  lat?: number;
  lon?: number;
  elevation?: number;
};

type ParentedVariant = ReversibleVariant & {
  name?: string;
  startTrackIndex?: number;
  endTrackIndex?: number;
  parent?: { name: string; index: number };
};

function makeWaypoint(overrides: Partial<TestWaypoint> = {}): TestWaypoint {
  return {
    name: 'WP',
    type: 'poi',
    distance: 0,
    totalDistance: 0,
    ascent: 0,
    descent: 0,
    totalAscent: 0,
    totalDescent: 0,
    variantTrackIndex: 0,
    ...overrides,
  };
}

describe('reverseAlternates', () => {
  it('moves a junction residual to the other end without leaving an undefined key behind', () => {
    const [reversed] = reverseAlternates<ReversibleVariant>(
      [{ startDistance: 10, endDistance: 30, startOffsetMeters: 700 }],
      100
    );
    expect(reversed.endOffsetMeters).toBe(700);
    expect(reversed).not.toHaveProperty('startOffsetMeters');

    const [other] = reverseAlternates<ReversibleVariant>(
      [{ startDistance: 10, endDistance: 30, endOffsetMeters: 900 }],
      100
    );
    expect(other.startOffsetMeters).toBe(900);
    expect(other).not.toHaveProperty('endOffsetMeters');
  });

  it('swaps start and end distances', () => {
    const reversed = reverseAlternates([{ startDistance: 10, endDistance: 30 }], 100);
    expect(reversed[0].startDistance).toBe(70);
    expect(reversed[0].endDistance).toBe(90);
  });

  it('recomputes waypoint absolute km for the reversed walk', () => {
    // 15km alternate branching at km 10, rejoining at km 30 of a 100km trail.
    // Waypoint 5km along the variant → absolute km 15.
    const reversed = reverseAlternates(
      [
        {
          distance: 15,
          startDistance: 10,
          endDistance: 30,
          points: [{}, {}, {}],
          waypoints: [
            makeWaypoint({
              distance: 5,
              totalDistance: 15,
              ascent: 120,
              descent: 30,
              totalAscent: 120,
              totalDescent: 30,
              variantTrackIndex: 1,
            }),
          ],
        },
      ],
      100
    );

    const wp = reversed[0].waypoints![0];
    expect(reversed[0].startDistance).toBe(70);
    expect(wp.totalDistance).toBe(80); // 70 + (15 - 5)
    expect(wp.distance).toBe(10);
    expect(wp.ascent).toBe(30);
    expect(wp.descent).toBe(120);
    expect(wp.variantTrackIndex).toBe(1); // 3 points: 2 - 1
  });

  it('reverses waypoint order for multi-waypoint alternates', () => {
    const reversed = reverseAlternates(
      [
        {
          distance: 10,
          startDistance: 20,
          endDistance: 32,
          points: [],
          waypoints: [
            makeWaypoint({ name: 'First', distance: 2, totalDistance: 22 }),
            makeWaypoint({ name: 'Second', distance: 6, totalDistance: 28 }),
          ],
        },
      ],
      100
    );
    const names = reversed[0].waypoints!.map(w => (w as { name: string }).name);
    expect(names).toEqual(['Second', 'First']);
    expect(reversed[0].waypoints![0].totalDistance).toBe(70); // 68 + (10 - 8)
    expect(reversed[0].waypoints![1].totalDistance).toBe(76); // 68 + (10 - 2)
    expect(reversed[0].waypoints![1].distance).toBe(6);
  });

  it('moves a junction on a parent alternate along the parent, not about the main route', () => {
    // Parent: branches at main km 10, rejoins at 40, 25 km long. The child
    // leaves it 7.8 km along (absolute 17.8, no startTrackIndex: not on the
    // main route) and rejoins the main route at km 40.
    const parent: ParentedVariant = { name: 'Parent', startDistance: 10, endDistance: 40, distance: 25 };
    const child: ParentedVariant = {
      name: 'Child',
      distance: 5,
      startDistance: 17.8,
      endDistance: 40,
      endTrackIndex: 400,
      parent: { name: 'Parent', index: 0 },
      points: [{}, {}],
      waypoints: [makeWaypoint({ distance: 1.2, totalDistance: 19 })],
    };
    const [rParent, rChild] = reverseAlternates([parent, child], 100);

    expect(rParent.startDistance).toBe(60);
    expect(rParent.endDistance).toBe(90);
    // Walked the other way the child leaves the main route at 100 - 40 and
    // rejoins the parent 25 - 7.8 km along its reversed walk.
    expect(rChild.startDistance).toBe(60);
    expect(rChild.endDistance).toBe(77.2);
    expect(rChild.parent).toEqual({ name: 'Parent', index: 0 });
    expect(rChild.waypoints![0].totalDistance).toBe(63.8); // 60 + (5 - 1.2)
  });

  it('moves a rejoin on a parent along it while a main-route branch mirrors', () => {
    const parent: ParentedVariant = { name: 'Parent', startDistance: 100, endDistance: 300, distance: 350 };
    const child: ParentedVariant = {
      name: 'Child',
      distance: 60,
      startDistance: 250,
      startTrackIndex: 2500,
      endDistance: 290, // 190 km along the parent
      parent: { name: 'Parent', index: 0 },
    };
    const [rParent, rChild] = reverseAlternates([parent, child], 1000);
    expect(rParent.startDistance).toBe(700);
    expect(rChild.startDistance).toBe(860); // 700 + 350 - 190
    expect(rChild.endDistance).toBe(750);
  });

  it('mirrors an end that is on the main route even when its km falls inside the parent', () => {
    const parent: ParentedVariant = { name: 'Parent', startDistance: 10, endDistance: 40, distance: 25 };
    const child: ParentedVariant = {
      name: 'Child',
      distance: 5,
      startDistance: 20,
      startTrackIndex: 200,
      endDistance: 30,
      endTrackIndex: 300,
      parent: { name: 'Parent', index: 0 },
    };
    const [, rChild] = reverseAlternates([parent, child], 100);
    expect(rChild.startDistance).toBe(70);
    expect(rChild.endDistance).toBe(80);
  });

  it('carries a chain of nested alternates through every parent', () => {
    const grand: ParentedVariant = { name: 'G', startDistance: 10, endDistance: 50, distance: 30 };
    const parent: ParentedVariant = {
      name: 'P',
      startDistance: 20, // 10 km along G
      endDistance: 50,
      endTrackIndex: 500,
      distance: 15,
      parent: { name: 'G', index: 0 },
    };
    const child: ParentedVariant = {
      name: 'C',
      startDistance: 25, // 5 km along P
      endDistance: 50,
      endTrackIndex: 500,
      distance: 4,
      parent: { name: 'P', index: 1 },
    };
    const [rGrand, rParent, rChild] = reverseAlternates([grand, parent, child], 100);
    expect(rGrand.startDistance).toBe(50);
    expect(rParent.startDistance).toBe(50);
    expect(rParent.endDistance).toBe(70); // 50 + 30 - 10
    expect(rChild.startDistance).toBe(50);
    expect(rChild.endDistance).toBe(60); // 50 + 15 - 5
  });

  it('takes the other alternate an end fits when it is past the named parent', () => {
    // The CDT's Lake Solitude cross-country: named for the alternate its branch
    // is on, rejoining a different one.
    const big: ParentedVariant = { name: 'Big', startDistance: 100, endDistance: 300, distance: 350 };
    const parent: ParentedVariant = {
      name: 'Parent',
      startDistance: 180, // on Big
      endDistance: 290,
      endTrackIndex: 2900,
      distance: 60,
      parent: { name: 'Big', index: 0 },
    };
    const child: ParentedVariant = {
      name: 'Child',
      startDistance: 239.9, // 59.9 km along Parent
      endDistance: 241.5, // past Parent's end: 141.5 km along Big
      distance: 5,
      parent: { name: 'Parent', index: 1 },
    };
    const [rBig, rParent, rChild] = reverseAlternates([big, parent, child], 1000);
    expect(rBig.startDistance).toBe(700);
    expect(rParent.startDistance).toBe(710);
    expect(rChild.startDistance).toBe(908.5); // 700 + 350 - 141.5
    expect(rChild.endDistance).toBe(710.1); // 710 + 60 - 59.9
  });

  it('mirrors an end whose point is nowhere near the parent line', () => {
    const line = (lat: number) => [
      { lat, lon: 140 },
      { lat, lon: 140.3 },
    ];
    const parent: ParentedVariant = {
      name: 'Parent',
      startDistance: 10,
      endDistance: 40,
      distance: 25,
      points: line(-30),
    };
    const child: ParentedVariant = {
      name: 'Child',
      startDistance: 17.8,
      endDistance: 40,
      endTrackIndex: 400,
      distance: 5,
      parent: { name: 'Parent', index: 0 },
      points: line(-31), // 110 km away
    };
    const [, rChild] = reverseAlternates([parent, child], 100);
    expect(rChild.endDistance).toBe(82.2);
  });

  it('does not loop on alternates that name each other as parent', () => {
    // The CDT's Stoney Indian Pass and Ptarmigan Tunnel bypass: one rejoins
    // where the other branches.
    const a: ParentedVariant = {
      name: 'A',
      startDistance: 14.89,
      startTrackIndex: 282,
      endDistance: 38.97,
      distance: 24.1,
      parent: { name: 'B', index: 1 },
    };
    const b: ParentedVariant = {
      name: 'B',
      startDistance: 38.97,
      endDistance: 54.31,
      endTrackIndex: 877,
      distance: 21.9,
      parent: { name: 'A', index: 0 },
    };
    const [rA, rB] = reverseAlternates([a, b], 100);
    expect(rB.startDistance).toBe(45.69);
    expect(rA.startDistance).toBe(67.59); // 45.69 + 21.9 - 0
    expect(rA.endDistance).toBe(85.11);
    expect(rB.endDistance).toBeCloseTo(67.61, 2); // 67.59 + 24.1 - 24.08
  });

  it('moves a junction residual to the end it now belongs to', () => {
    const loose: ReversibleVariant = {
      distance: 5,
      startDistance: 10,
      endDistance: 30,
      startOffsetMeters: 900,
    };
    const reversed = reverseAlternates([loose], 100);
    expect(reversed[0].startOffsetMeters).toBeUndefined();
    expect(reversed[0].endOffsetMeters).toBe(900);
  });

  it('mirrors an alternate attached at its start only, still read from that junction', () => {
    // The Bibbulmun's "Alt: hitch into Denmark": leaves at km 909.53 of
    // 981.6 and never rejoins. Reversal used to leave it at 909.53.
    const hitch: ReversibleVariant = {
      distance: 12,
      startDistance: 909.53,
      startOffsetMeters: 600,
      points: [{ i: 0 }, { i: 1 }, { i: 2 }],
      waypoints: [makeWaypoint({ distance: 12, totalDistance: 921.53, variantTrackIndex: 2 })],
    };
    const [reversed] = reverseAlternates([hitch], 981.6);

    expect(reversed.startDistance).toBe(72.07);
    expect(reversed).not.toHaveProperty('endDistance');
    // The junction is still the branch point, so nothing about the walk out
    // from it changes.
    expect(reversed.points).toEqual(hitch.points);
    expect(reversed.startOffsetMeters).toBe(600);
    expect(reversed.waypoints![0].totalDistance).toBe(84.07);
    expect(reversed.waypoints![0].variantTrackIndex).toBe(2);
  });

  it('turns an alternate attached at its end only into one read from that junction', () => {
    // Written by an ingest from before such variants were turned round: the
    // junction is the last point, and the waypoint km count from points[0].
    const dangling: ReversibleVariant = {
      distance: 8,
      endDistance: 1122.77,
      endOffsetMeters: 900,
      points: [{ i: 0 }, { i: 1 }, { i: 2 }],
      waypoints: [
        makeWaypoint({ name: 'Free end', distance: 0, totalDistance: 0, ascent: 0, descent: 0, variantTrackIndex: 0 }),
        makeWaypoint({
          name: 'Near junction',
          distance: 7.5,
          totalDistance: 7.5,
          ascent: 300,
          descent: 20,
          variantTrackIndex: 2,
        }),
      ],
    };
    const [reversed] = reverseAlternates([dangling], 4800);

    expect(reversed.startDistance).toBe(3677.23);
    expect(reversed).not.toHaveProperty('endDistance');
    expect(reversed.startOffsetMeters).toBe(900);
    expect(reversed).not.toHaveProperty('endOffsetMeters');
    expect(reversed.points).toEqual([{ i: 2 }, { i: 1 }, { i: 0 }]);
    const names = reversed.waypoints!.map(w => (w as TestWaypoint).name);
    expect(names).toEqual(['Near junction', 'Free end']);
    expect(reversed.waypoints![0].totalDistance).toBe(3677.73); // 0.5 km out
    expect(reversed.waypoints![1].totalDistance).toBe(3685.23); // the whole 8 km
    expect(reversed.waypoints![1].distance).toBe(7.5);
    expect(reversed.waypoints![0].variantTrackIndex).toBe(0);
  });

  it('rounds the mirrored junctions to the 10 m every other km is', () => {
    // 100.1 - 30.7 is 69.39999999999999 in floating point.
    const [reversed] = reverseAlternates([{ startDistance: 10.3, endDistance: 30.7 }], 100.1);
    expect(reversed.startDistance).toBe(69.4);
    expect(reversed.endDistance).toBe(89.8);
  });

  it('leaves unattached alternates untouched (variant-relative km, no junction to mirror)', () => {
    const unattached: ReversibleVariant = {
      distance: 5,
      points: [{ a: 1 }, { a: 2 }],
      waypoints: [makeWaypoint({ distance: 1.2, totalDistance: 1.2 })],
    };
    const reversed = reverseAlternates([unattached], 100);
    expect(reversed[0]).toBe(unattached); // identity — nothing transformed
    expect(reversed[0].waypoints![0].totalDistance).toBe(1.2);
    expect(reversed[0].startDistance).toBeUndefined();
  });
});

describe('transformSideTrips', () => {
  it('mirrors start distance', () => {
    const transformed = transformSideTrips([{ startDistance: 25 }], 100);
    expect(transformed[0].startDistance).toBe(75);
  });

  it('shifts waypoint absolute km with the junction, keeping variant-relative stats', () => {
    const transformed = transformSideTrips(
      [
        {
          distance: 4,
          startDistance: 25,
          waypoints: [makeWaypoint({ distance: 3, totalDistance: 28, ascent: 50, descent: 10, variantTrackIndex: 7 })],
        },
      ],
      100
    );
    const wp = transformed[0].waypoints![0];
    expect(transformed[0].startDistance).toBe(75);
    expect(wp.totalDistance).toBe(78); // 75 + 3
    expect(wp.distance).toBe(3);
    expect(wp.ascent).toBe(50);
    expect(wp.variantTrackIndex).toBe(7);
  });

  it('rounds the mirrored junction', () => {
    // 981.6 - 909.53 is 72.07000000000005 in floating point.
    const [transformed] = transformSideTrips([{ startDistance: 909.53 }], 981.6);
    expect(transformed.startDistance).toBe(72.07);
  });

  it('turns a side trip attached at its end only round, like an alternate', () => {
    const spur: ReversibleVariant = {
      distance: 3,
      endDistance: 903.01,
      points: [{ i: 0 }, { i: 1 }],
      waypoints: [makeWaypoint({ distance: 0, totalDistance: 0, variantTrackIndex: 0 })],
    };
    const [transformed] = transformSideTrips([spur], 1200);
    expect(transformed.startDistance).toBe(296.99);
    expect(transformed).not.toHaveProperty('endDistance');
    expect(transformed.points).toEqual([{ i: 1 }, { i: 0 }]);
    expect(transformed.waypoints![0].totalDistance).toBe(299.99);
  });

  it('moves a side trip hanging off an alternate along that alternate', () => {
    const parent: ParentedVariant = { name: 'Parent', startDistance: 10, endDistance: 40, distance: 25 };
    const spur: ParentedVariant = {
      distance: 2,
      startDistance: 17.8, // 7.8 km along the parent
      parent: { name: 'Parent', index: 0 },
      waypoints: [makeWaypoint({ distance: 1, totalDistance: 18.8 })],
    };
    const [transformed] = transformSideTrips([spur], 100, [parent]);

    expect(transformed.startDistance).toBe(77.2); // 60 + 25 - 7.8
    expect(transformed.parent).toEqual({ name: 'Parent', index: 0 });
    expect(transformed.waypoints![0].totalDistance).toBe(78.2);
  });

  it('moves a side trip off a one-junction alternate out along it', () => {
    const parent: ParentedVariant = { name: 'Parent', startDistance: 10, distance: 20 };
    const spur: ParentedVariant = { distance: 2, startDistance: 15, parent: { name: 'Parent', index: 0 } };
    expect(transformSideTrips([spur], 100, [parent])[0].startDistance).toBe(95); // 90 + 5
  });

  it('mirrors a parent-attached side trip about the main route when the alternates are not passed', () => {
    const spur: ParentedVariant = { distance: 2, startDistance: 17.8, parent: { name: 'Parent', index: 0 } };
    expect(transformSideTrips([spur], 100)[0].startDistance).toBe(82.2);
  });

  it('leaves unattached side trips untouched (regression: AAWT spurs >500m off-track)', () => {
    // Real shipped case: side trip starts >500m from the main track so
    // startDistance is undefined and waypoint km are variant-relative (0.34).
    // The old code computed newStart = 688.3 - 0 and produced waypoint km
    // beyond the end of a 688.3 km trail.
    const spur: ReversibleVariant = {
      distance: 2.8,
      waypoints: [makeWaypoint({ distance: 0.34, totalDistance: 0.34 })],
    };
    const transformed = transformSideTrips([spur], 688.3);
    expect(transformed[0]).toBe(spur); // identity — nothing transformed
    expect(transformed[0].startDistance).toBeUndefined();
    expect(transformed[0].waypoints![0].totalDistance).toBe(0.34);
  });
});
