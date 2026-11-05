import { describe, expect, it } from 'vitest';
import { buildPlannedRoute, plannedRouteTrail, type PlannableTrail } from './plan-alternates';
import { rangeLines, routeRunsBetweenKm } from './route-ranges';
import { createReversedTrail } from './trail-reverse';
import type { RouteBreak } from './trail-types';
import type { ReversibleTrail } from './trail-reverse';

/** Degrees of longitude per km on the equator. */
const DEG_PER_KM = 1 / 111.19492664455873;

/** A point per km along the equator, `count` of them. */
function line(count: number) {
  return Array.from({ length: count }, (_, km) => ({ lat: 0, lon: km * DEG_PER_KM, ele: 0, dist: km }));
}

function routeBreak(index: number, displayIndex: number): RouteBreak {
  return { index, displayIndex, km: index, straightLineKm: 1, fromTrack: 'A', toTrack: 'B' };
}

const kmsOf = (runs: { dist: number }[][]) => runs.map(run => run.map(p => p.dist));

describe('routeRunsBetweenKm', () => {
  it('takes the points nearest the two km and everything between', () => {
    const runs = routeRunsBetweenKm(line(11), new Set(), 2.2, 5.6);
    expect(kmsOf(runs)).toEqual([[2, 3, 4, 5, 6]]);
  });

  it('reads the range either way round', () => {
    expect(routeRunsBetweenKm(line(11), new Set(), 6, 2)).toEqual(routeRunsBetweenKm(line(11), new Set(), 2, 6));
  });

  it('cuts the run at a route break inside the range, never drawing the gap', () => {
    const runs = routeRunsBetweenKm(line(11), new Set([5]), 2, 8);
    expect(kmsOf(runs)).toEqual([
      [2, 3, 4],
      [5, 6, 7, 8],
    ]);
  });

  it('drops a single-point run where a range starts right at a break', () => {
    // Index 5 is the first point after the break: 4 → 5 is the crossing.
    const runs = routeRunsBetweenKm(line(11), new Set([5]), 4, 8);
    expect(kmsOf(runs)).toEqual([[5, 6, 7, 8]]);
  });

  it('has nothing to draw for a range shorter than a step, or a track of one point', () => {
    expect(routeRunsBetweenKm(line(11), new Set(), 3.1, 3.2)).toEqual([]);
    expect(routeRunsBetweenKm(line(1), new Set(), 0, 1)).toEqual([]);
  });
});

describe('rangeLines', () => {
  it('gives neighbouring ranges a shared end point, so their lines meet', () => {
    const lines = rangeLines(
      { points: line(21) },
      [
        { fromKm: 0, toKm: 7.4 },
        { fromKm: 7.4, toKm: 20 },
      ],
      'points'
    );
    expect(lines.map(l => l.index)).toEqual([0, 1]);
    expect(lines[0].runs[0].at(-1)).toBe(lines[1].runs[0][0]);
    expect(lines[0].runs[0][0].dist).toBe(0);
    expect(lines[1].runs[0].at(-1)!.dist).toBe(20);
  });

  it('draws the display copy with its own break index', () => {
    const points = line(21);
    const displayPoints = points.filter((_, i) => i % 2 === 0); // km 0, 2, … 20
    // The break falls before km 10: index 10 in `points`, 5 in `displayPoints`.
    const track = { points, displayPoints, breaks: [routeBreak(10, 5)] };

    const [display] = rangeLines(track, [{ fromKm: 4, toKm: 16 }], 'displayPoints');
    expect(kmsOf(display.runs)).toEqual([
      [4, 6, 8],
      [10, 12, 14, 16],
    ]);

    const [full] = rangeLines(track, [{ fromKm: 8, toKm: 12 }], 'points');
    expect(kmsOf(full.runs)).toEqual([
      [8, 9],
      [10, 11, 12],
    ]);
  });

  it('falls back to the full points when a track has no display copy', () => {
    const [only] = rangeLines({ points: line(5), displayPoints: [] }, [{ fromKm: 1, toKm: 3 }], 'displayPoints');
    expect(kmsOf(only.runs)).toEqual([[1, 2, 3]]);
  });

  it('follows a taken alternate on the route as the plan walks it', () => {
    const alternatePoints = Array.from({ length: 31 }, (_, i) => ({
      lat: (i <= 15 ? i : 30 - i) * 0.5 * DEG_PER_KM,
      lon: (20 + (20 * i) / 30) * DEG_PER_KM,
      ele: 0,
    }));
    const trail = {
      config: { id: 'demo', name: 'Demo' },
      track: { points: line(101), totalDistance: 100, totalAscent: 0, totalDescent: 0 },
      waypoints: [],
      alternates: [
        {
          name: 'Alt: High Route',
          type: 'alternate',
          points: alternatePoints,
          distance: 30,
          elevation: { ascent: 0, descent: 0 },
          startDistance: 20,
          endDistance: 40,
          waypoints: [],
        },
      ],
    } as unknown as PlannableTrail;
    const route = buildPlannedRoute(trail, ['Alt: High Route']);
    const routeTrail = plannedRouteTrail(trail, route);

    // Route km 25-45 is wholly on the 30 km alternate (route km 20-50).
    const [onAlternate] = rangeLines(routeTrail.track, [{ fromKm: 25, toKm: 45 }], 'points');
    expect(onAlternate.runs).toHaveLength(1);
    expect(onAlternate.runs[0].every(p => p.lat > 0)).toBe(true);

    // And the same range SOBO, measured from the other end, is the same ground.
    const reversed = createReversedTrail(routeTrail as unknown as ReversibleTrail);
    const total = reversed.track.totalDistance;
    const [sobo] = rangeLines(
      reversed.track as typeof routeTrail.track,
      [{ fromKm: total - 45, toKm: total - 25 }],
      'points'
    );
    expect(sobo.runs[0].every(p => p.lat > 0)).toBe(true);
  });
});
