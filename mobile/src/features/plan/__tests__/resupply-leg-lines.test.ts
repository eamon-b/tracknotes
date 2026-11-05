/**
 * The guide map's resupply legs: the resupply screen's carries, cut out of the
 * map's copy of the route at route breaks, and coloured in turn.
 */

import { DEFAULT_PLAN_THRESHOLDS } from '@lib/plan-types';
import { buildResupplyLegCollection } from '../../map/map-geojson';
import { resupplyLegColors } from '../../map/map-style';
import { PACE_KMH } from '../plan-adapters';
import { resupplyLegLines } from '../use-resupply-leg-lines';
import type { TrailJson } from '../../../services/trail-assets';

const INPUTS = {
  dailyHours: 8,
  baseKmh: PACE_KMH.average,
  longCarryDays: DEFAULT_PLAN_THRESHOLDS.longCarryDays,
  foodGramsPerDay: DEFAULT_PLAN_THRESHOLDS.foodGramsPerDay,
};

/** 60 km due east, a point per km; the map's copy keeps every other one. */
function trail(withTowns = true, breaks?: TrailJson['track']['breaks']): TrailJson {
  const points = Array.from({ length: 61 }, (_, km) => ({
    lat: 0,
    lon: km * 0.01,
    ele: 0,
    dist: km,
  }));
  return {
    config: { id: 'legs', name: 'Legs', shortName: 'L', region: 'Test', lengthKm: 60 },
    waypoints: withTowns
      ? [
          { id: 't1', name: 'Alpha', lat: 0, lon: 0.2, type: 'town', totalDistance: 20 },
          { id: 't2', name: 'Bravo', lat: 0, lon: 0.4, type: 'town', totalDistance: 40 },
        ]
      : [],
    track: {
      points,
      displayPoints: points.filter((_, i) => i % 2 === 0),
      totalDistance: 60,
      totalAscent: 0,
      totalDescent: 0,
      ...(breaks ? { breaks } : {}),
    },
  } as TrailJson;
}

const kms = (runs: { dist: number }[][]) => runs.map((run) => [run[0].dist, run.at(-1)!.dist]);

describe('resupplyLegLines', () => {
  it('draws every option as a stop while nothing is chosen, as the resupply screen counts', () => {
    const lines = resupplyLegLines(trail(), INPUTS);
    expect(lines.map((line) => kms(line.runs))).toEqual([[[0, 20]], [[20, 40]], [[40, 60]]]);
  });

  it('follows the selection', () => {
    const lines = resupplyLegLines(trail(), { ...INPUTS, resupplyStops: ['t2'] });
    expect(lines.map((line) => kms(line.runs))).toEqual([[[0, 40]], [[40, 60]]]);
  });

  it('cuts a leg at a route break, on the map copy’s own index', () => {
    // The break falls before km 30: index 30 in `points`, 15 in `displayPoints`.
    const breaks = [
      { index: 30, displayIndex: 15, km: 30, straightLineKm: 4, fromTrack: 'N', toTrack: 'S' },
    ];
    const [, middle] = resupplyLegLines(trail(true, breaks), INPUTS);
    expect(kms(middle.runs)).toEqual([
      [20, 28],
      [30, 40],
    ]);
  });

  it('draws nothing for a trail with no resupply to plan', () => {
    expect(resupplyLegLines(trail(false), INPUTS)).toEqual([]);
  });
});

describe('buildResupplyLegCollection', () => {
  it('numbers each leg and colours it in turn, so neighbours differ', () => {
    const lines = resupplyLegLines(trail(), INPUTS);
    const palette = resupplyLegColors('light');
    const collection = buildResupplyLegCollection(lines, palette);

    expect(collection.features.map((f) => f.properties)).toEqual([
      { leg: 1, color: palette[0] },
      { leg: 2, color: palette[1] },
      { leg: 3, color: palette[2] },
    ]);
    expect(collection.features[0].geometry.coordinates[0][0]).toEqual([0, 0]);
  });

  it('wraps the palette, and leaves out a leg too short to draw', () => {
    const run = [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 1 },
    ];
    const lines = Array.from({ length: 5 }, (_, index) => ({
      index,
      runs: index === 3 ? [] : [run],
    }));
    const collection = buildResupplyLegCollection(lines, ['a', 'b']);
    expect(collection.features.map((f) => [f.properties?.leg, f.properties?.color])).toEqual([
      [1, 'a'],
      [2, 'b'],
      [3, 'a'],
      [5, 'a'],
    ]);
  });

  it('has a palette for each map theme', () => {
    expect(resupplyLegColors('light').length).toBeGreaterThanOrEqual(3);
    expect(resupplyLegColors('dark')).toHaveLength(resupplyLegColors('light').length);
  });
});
