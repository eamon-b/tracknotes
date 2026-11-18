/**
 * Plan adapter tests. Covers the pick options and the resupply and water cards
 * (section scoping, the hiker's selection, pace, hours and thresholds), and
 * confirms the shared @lib calculators are driven with the right inputs over
 * real bundled trails (cape_to_cape — the smallest, 126.9 km; the CDT).
 */

import {
  PACE_KMH,
  computePlanExtras,
  computeResupplyPlan,
  overnightWaypoints,
  planWindowHours,
  toPlanDay,
  waypointOptions,
  type ResupplyPlanInputs,
} from '../plan-adapters';
import { DEFAULT_PLAN_THRESHOLDS, type Pace, type SectionConfig } from '@lib/plan-types';
import type { TrailJson } from '../../../services/trail-assets';

// Real bundled fixtures: work in Jest via the require() map.
const cape = require('../../../../assets/trails/cape_to_cape.json') as TrailJson;
const cdt = require('../../../../assets/trails/cdt.json') as TrailJson;

/** Small synthetic trail with predictable camps for boundary tests. */
function syntheticTrail(): TrailJson {
  const points = Array.from({ length: 101 }, (_, i) => ({
    lat: 0,
    lon: i * 0.001,
    ele: 100, // flat: hoursRaw == distance / baseKmh (no ascent/descent)
    dist: i, // 0..100 km
  }));
  return {
    config: {
      id: 'syn',
      name: 'Synthetic',
      shortName: 'SYN',
      region: 'Test',
      lengthKm: 100,
      direction: { default: 'Northbound', reversed: 'Southbound' },
    },
    waypoints: [
      { id: 'w0', name: 'Start', lat: 0, lon: 0, type: 'trailhead', totalDistance: 0 },
      { id: 'c1', name: 'Camp A', lat: 0, lon: 0, type: 'campsite', totalDistance: 20 },
      { id: 't1', name: 'Townsville', lat: 0, lon: 0, type: 'town', totalDistance: 40 },
      // 50 m along and named after the same turn-off: one group, one stop —
      // the Salida / Poncha Springs shape, in miniature.
      {
        id: 't2',
        name: 'Poncha',
        lat: 0,
        lon: 0,
        type: 'town',
        totalDistance: 40.05,
        offTrailKm: 5,
        accessMode: 'hitch',
        accessName: 'Highway 1',
      },
      { id: 'wt', name: 'Tank', lat: 0, lon: 0, type: 'water-tank', totalDistance: 55 },
      { id: 'c2', name: 'Camp B', lat: 0, lon: 0, type: 'campsite', totalDistance: 60 },
      { id: 'end', name: 'Finish', lat: 0, lon: 0, type: 'trailhead', totalDistance: 100 },
    ],
    track: { points, displayPoints: points, totalDistance: 100, totalAscent: 0, totalDescent: 0 },
  };
}

describe('waypoint selectors', () => {
  it('overnightWaypoints returns only camp/shelter family, km-ordered', () => {
    const camps = overnightWaypoints(syntheticTrail());
    expect(camps.map((c) => c.name)).toEqual(['Camp A', 'Camp B']);
  });

  it('overnightWaypoints over the real trail finds the campsites in order', () => {
    const camps = overnightWaypoints(cape);
    expect(camps.length).toBe(6); // cape_to_cape has 6 campsites
    const kms = camps.map((c) => c.km);
    expect(kms).toEqual([...kms].sort((a, b) => a - b));
  });

  it('waypointOptions is the full waypoint set in km order', () => {
    const opts = waypointOptions(cape);
    expect(opts.length).toBe(cape.waypoints.length);
    expect(opts[0].km).toBeLessThanOrEqual(opts[opts.length - 1].km);
  });
});

describe('toPlanDay', () => {
  const day = (endKm: number) =>
    ({ dayNumber: 1, startKm: 0, endKm, startName: 'A', endName: 'B' }) as never;
  it('marks the finish, a bed, and any other stop', () => {
    const camps = new Set([20]);
    expect(toPlanDay(day(100), 100, camps).endKind).toBe('finish');
    expect(toPlanDay(day(20), 100, camps).endKind).toBe('camp');
    expect(toPlanDay(day(40), 100, camps).endKind).toBe('stop');
  });
});

describe('planWindowHours', () => {
  it('clamps the snap window to [0.75, 2.5] around 0.35 · targetHours', () => {
    expect(planWindowHours(1)).toBeCloseTo(0.75, 5); // 0.35 below floor -> clamped up
    expect(planWindowHours(5)).toBeCloseTo(1.75, 5); // in range
    expect(planWindowHours(8)).toBeCloseTo(2.5, 5); // 2.8 above ceiling -> clamped down
  });
});

/** The whole synthetic section, 0 → `endKm`. */
function sectionOf(endKm: number): SectionConfig {
  return { startKm: 0, endKm, startName: 'Start', endName: 'Finish' };
}

/** The resupply inputs at 8 h, average pace and the default thresholds, overridden. */
function inputsFor(
  over: Partial<ResupplyPlanInputs> & { pace?: Pace; thresholds?: typeof DEFAULT_PLAN_THRESHOLDS },
): ResupplyPlanInputs {
  const { pace = 'average', thresholds = DEFAULT_PLAN_THRESHOLDS, ...rest } = over;
  return {
    dailyHours: 8,
    baseKmh: PACE_KMH[pace],
    longCarryDays: thresholds.longCarryDays,
    foodGramsPerDay: thresholds.foodGramsPerDay,
    ...rest,
  };
}

const extrasInputs = {
  dailyHours: 8,
  baseKmh: PACE_KMH.average,
  thresholds: DEFAULT_PLAN_THRESHOLDS,
};

describe('section scoping', () => {
  it('keeps the legs inside the chosen section, the option list trail-wide', () => {
    const opts = waypointOptions(cape);
    const prevelly = opts.find((o) => o.name === 'Prevelly')!;
    const yallingup = opts.find((o) => o.name === 'Yallingup')!;
    const plan = computeResupplyPlan(
      cape,
      { startKm: prevelly.km, endKm: yallingup.km, startName: 'Prevelly', endName: 'Yallingup' },
      inputsFor({}),
    );
    for (const leg of plan.legs) {
      expect(leg.fromKm).toBeGreaterThanOrEqual(prevelly.km);
      expect(leg.toKm).toBeLessThanOrEqual(yallingup.km);
    }
    expect(plan.groups.length).toBe(3);
  });

  it('surfaces resupply legs over the real trail (cape_to_cape has 3 towns)', () => {
    const plan = computeResupplyPlan(cape, null, inputsFor({}));
    expect(plan.groups.length).toBe(3);
    expect(plan.legs.length).toBeGreaterThan(0);
    // Each leg carries the calculator's own food-weight estimate.
    expect(plan.legs[0].food.weightKg).toBeGreaterThan(0);
    expect(plan.summary.hasData).toBe(true);
  });
});

describe('water carries', () => {
  it('reports no water data when the trail has no water-type waypoints', () => {
    const extras = computePlanExtras(cape, sectionOf(cape.track.totalDistance), extrasInputs);
    expect(extras.water.hasWaterData).toBe(false);
    expect(extras.topWaterCarries).toEqual([]);
  });

  it('surfaces water carries and the dry-stretch flag on a watered trail', () => {
    const extras = computePlanExtras(syntheticTrail(), sectionOf(100), extrasInputs); // tank at 55 km
    expect(extras.water.hasWaterData).toBe(true);
    expect(extras.topWaterCarries.length).toBeGreaterThan(0);
    // Biggest carry first.
    const dists = extras.topWaterCarries.map((g) => g.distanceKm);
    expect(dists).toEqual([...dists].sort((a, b) => b - a));
    // A > 15 km gap must be flagged dry.
    expect(extras.topWaterCarries.some((g) => g.isDryStretch)).toBe(true);
  });
});

describe('resupply selection', () => {
  /** The resupply half of a plan over 0 → `endKm` with the given inputs. */
  const resupplyOf = (trail: TrailJson, over: Parameters<typeof inputsFor>[0] = {}, endKm = 100) =>
    computeResupplyPlan(trail, sectionOf(endKm), inputsFor(over));

  /**
   * The synthetic trail on a steady 2 m/km climb plus a second, separate town,
   * so a leg's ascent and a merge are both exact hand sums: 0→40 climbs 80 m,
   * 40→70 climbs 60 m, 70→100 climbs 60 m.
   */
  function twoTownTrail(): TrailJson {
    const points = Array.from({ length: 101 }, (_, i) => ({
      lat: 0,
      lon: i * 0.001,
      ele: 100 + i * 2,
      dist: i,
    }));
    const base = syntheticTrail();
    return {
      ...base,
      waypoints: [
        ...base.waypoints,
        { id: 't3', name: 'Creede', lat: 0, lon: 0, type: 'town', totalDistance: 70 },
      ],
      track: {
        points,
        displayPoints: points,
        totalDistance: 100,
        totalAscent: 200,
        totalDescent: 0,
      },
    };
  }

  it('ticks every option by default: one stop per group, one leg per boundary', () => {
    const plan = resupplyOf(syntheticTrail());
    // The twin towns 50 m apart are one turn-off, so one group and one stop.
    expect(plan.groups.length).toBe(1);
    expect(plan.groups[0].label).toBe('Highway 1');
    // Poncha is a 5 km hitch: the stop carries it, never walked.
    expect(plan.stops).toEqual([
      {
        km: 40,
        name: 'Townsville / Poncha',
        optionIds: ['t1', 't2'],
        access: {
          place: 'Poncha',
          walkKm: 0,
          walkAscentM: 0,
          walkDescentM: 0,
          rideKm: 5,
          rideMode: 'hitch',
        },
      },
    ]);
    expect(plan.legs.map((l) => [l.fromName, l.toName])).toEqual([
      ['Trail Start', 'Townsville / Poncha'],
      ['Townsville / Poncha', 'Trail End'],
    ]);
  });

  it('joins two ticks in one group into a single stop', () => {
    const plan = resupplyOf(syntheticTrail(), { resupplyStops: ['t1', 't2'] });
    expect(plan.stops.length).toBe(1);
    expect(plan.stops[0].name).toBe('Townsville / Poncha');
    // One tick in the same group is the same stop, under its own name.
    const one = resupplyOf(syntheticTrail(), { resupplyStops: ['t2'] });
    expect(one.stops.map((s) => s.name)).toEqual(['Poncha']);
  });

  it('merges the legs of an unticked stop, summing distance and ascent', () => {
    const trail = twoTownTrail();
    const every = resupplyOf(trail);
    expect(every.legs.map((l) => l.distanceKm)).toEqual([40, 30, 30]);
    expect(every.legs.map((l) => l.ascentM)).toEqual([80, 60, 60]);

    // Untick the first group: its two legs become one.
    const merged = resupplyOf(trail, { resupplyStops: ['t3'] });
    expect(merged.legs.map((l) => [l.fromName, l.toName])).toEqual([
      ['Trail Start', 'Creede'],
      ['Creede', 'Trail End'],
    ]);
    expect(merged.legs[0].distanceKm).toBe(40 + 30);
    expect(merged.legs[0].ascentM).toBe(80 + 60);
  });

  it('an explicit empty selection is a plan with no stops, not the default', () => {
    const plan = resupplyOf(twoTownTrail(), { resupplyStops: [] });
    expect(plan.stops).toEqual([]);
    // No stops is still a carry: the whole trail, start to end, as one leg.
    expect(plan.legs.map((l) => [l.fromName, l.toName])).toEqual([['Trail Start', 'Trail End']]);
    expect(plan.summary.hasData).toBe(true);
    expect(plan.summary.stopsChosen).toBe(0);
    // The options themselves are still offered — the list is trail-wide.
    expect(plan.groups.length).toBe(2);
  });

  it('takes days per leg from the hiker’s hours and pace, not the day split', () => {
    // The first leg is 40 flat km: 10 h at 4 km/h, 13.3 h at 3 km/h.
    const trail = syntheticTrail();
    const at8 = resupplyOf(trail);
    expect(at8.legs[0].estimatedHours).toBeCloseTo(10, 5);
    expect(at8.legs[0].estimatedDays).toBe(2);
    expect(resupplyOf(trail, { pace: 'slow' }).legs[0].estimatedDays).toBe(2);
    expect(resupplyOf(trail, { dailyHours: 16 }).legs[0].estimatedDays).toBe(1);
  });

  it('weighs food and flags long carries at the hiker’s thresholds', () => {
    const trail = syntheticTrail();
    const plan = resupplyOf(trail, {
      thresholds: { ...DEFAULT_PLAN_THRESHOLDS, foodGramsPerDay: 1000, longCarryDays: 1 },
    });
    // The first leg is two days either way; only its weight and flag move.
    expect(plan.legs[0].estimatedDays).toBe(2);
    expect(plan.legs[0].food.weightGrams).toBe(2000);
    expect(plan.legs[0].isLong).toBe(true);
    expect(resupplyOf(trail).legs[0].isLong).toBe(false);
  });

  it('drops a ticked stop outside the section, keeping the list trail-wide', () => {
    const plan = resupplyOf(twoTownTrail(), {}, 50);
    // Creede (70 km) is ticked but out of range: no leg reaches it.
    expect(plan.legs.map((l) => l.toName)).toEqual(['Townsville / Poncha', 'Trail End']);
    for (const leg of plan.legs) expect(leg.toKm).toBeLessThanOrEqual(50);
    expect(plan.stops.length).toBe(2);
    expect(plan.groups.length).toBe(2);
  });

  it('groups the real CDT asset and resolves Monarch Pass to one stop', () => {
    const plan = computeResupplyPlan(cdt, null, inputsFor({}));
    const options = plan.groups.reduce((n, g) => n + g.options.length, 0);
    expect(options).toBeGreaterThanOrEqual(60);
    // Several towns share a turn-off, so there are strictly fewer groups.
    expect(plan.groups.length).toBeLessThan(options);

    const monarch = plan.groups.find((g) => g.label?.startsWith('Monarch Pass'))!;
    expect(monarch.options.length).toBeGreaterThan(1);
    expect(plan.stops.filter((s) => s.km === monarch.km).length).toBe(1);
  });

  it('computeResupplyPlan counts zero days in the total, never in the food', () => {
    const inputs = {
      dailyHours: 8,
      baseKmh: PACE_KMH.average,
      longCarryDays: DEFAULT_PLAN_THRESHOLDS.longCarryDays,
      foodGramsPerDay: DEFAULT_PLAN_THRESHOLDS.foodGramsPerDay,
      resupplyStops: ['t3'],
    };
    const without = computeResupplyPlan(twoTownTrail(), null, inputs);
    const rested = computeResupplyPlan(twoTownTrail(), null, { ...inputs, zeroDays: { t3: 1.5 } });

    expect(rested.legs.map((l) => l.zeroDays)).toEqual([1.5, 0]);
    expect(rested.legs.map((l) => l.food)).toEqual(without.legs.map((l) => l.food));
    expect(rested.summary.totalDays).toBe(without.summary.totalDays + 1.5);
    // The hiker's hours per day reach the total: it halves when they double.
    const longer = computeResupplyPlan(twoTownTrail(), null, { ...inputs, dailyHours: 16 });
    expect(longer.summary.totalDays).toBeLessThan(without.summary.totalDays);
    expect(rested.summary.stopsChosen).toBe(1);
    // No camp plan is passed, so no leg carries an arrival day.
    expect(rested.legs.every((l) => l.arrival === undefined)).toBe(true);
  });

  it('computePlanExtras gives the planner summary the Plan screen row reads', () => {
    const extras = computePlanExtras(twoTownTrail(), sectionOf(100), {
      dailyHours: 8,
      baseKmh: PACE_KMH.average,
      thresholds: DEFAULT_PLAN_THRESHOLDS,
      resupplyStops: ['t3'],
      zeroDays: { t3: 2 },
    });
    expect(extras.resupplyPlanSummary.stopsChosen).toBe(1);
    expect(extras.resupplyPlanSummary.zeroDays).toBe(2);
  });

  it('computePlanExtras takes groups a caller memoised on the trail', () => {
    const trail = twoTownTrail();
    const groups = computeResupplyPlan(trail, null, inputsFor({})).groups;
    const extras = computePlanExtras(trail, sectionOf(100), extrasInputs, groups);
    expect(extras.resupplyGroups).toBe(groups);
    expect(extras.resupplyPlanSummary).toEqual(
      computePlanExtras(trail, sectionOf(100), extrasInputs).resupplyPlanSummary,
    );
  });

  it('counts the zero days before day 1 in the total days, never in the food', () => {
    const inputs = {
      dailyHours: 8,
      baseKmh: PACE_KMH.average,
      longCarryDays: DEFAULT_PLAN_THRESHOLDS.longCarryDays,
      foodGramsPerDay: DEFAULT_PLAN_THRESHOLDS.foodGramsPerDay,
      resupplyStops: ['t3'],
    };
    const without = computeResupplyPlan(twoTownTrail(), null, inputs);
    const rested = computeResupplyPlan(twoTownTrail(), null, { ...inputs, startZeroDays: 1.5 });
    expect(rested.summary.totalDays).toBe(without.summary.totalDays + 1.5);
    expect(rested.legs.map((l) => l.food)).toEqual(without.legs.map((l) => l.food));

    const extras = computePlanExtras(twoTownTrail(), sectionOf(100), {
      dailyHours: 8,
      baseKmh: PACE_KMH.average,
      thresholds: DEFAULT_PLAN_THRESHOLDS,
      resupplyStops: ['t3'],
      startZeroDays: 2,
    });
    expect(extras.resupplyPlanSummary.zeroDays).toBe(2);
  });
});
