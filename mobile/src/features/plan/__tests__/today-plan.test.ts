/**
 * Today's plan: which day of the plan is dated today, and the waypoints along it.
 */

import { newPlan, setNights, setStartDate, toggleStop } from '@lib/plan-editor';
import type { PlanDocument } from '@lib/plan-types';
import type { TrailJson } from '../../../services/trail-assets';
import { planGlance, type PlanGlanceOptions } from '../plan-glance';
import { stopCandidateOf, toggleTargetOf } from '../plan-stops';
import type { TrailPOI } from '@lib/trail-types';
import {
  currentPlanDay,
  dayFromRouteParams,
  dayRouteParams,
  emptyMessage,
  localIsoDate,
  msUntilLocalMidnight,
  sectionFromRouteParams,
  sectionOnRoute,
  todayEntries,
  todayPlan,
  todayPois,
  todayRows,
} from '../today-plan';

/** 100 km trail climbing 10 m per km for the first 50 km, then descending. */
function trail(): TrailJson {
  const points = Array.from({ length: 101 }, (_, i) => ({
    lat: 0,
    lon: i * 0.001,
    ele: i <= 50 ? 100 + i * 10 : 600 - (i - 50) * 10,
    dist: i,
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
      { id: 'c1', name: 'Camp A', lat: 0, lon: 0, type: 'campsite', totalDistance: 20 },
      { id: 'wa', name: 'Creek', lat: 0, lon: 0, type: 'water', totalDistance: 30 },
      { id: 'j1', name: 'Junction', lat: 0, lon: 0, type: 'junction', totalDistance: 55 },
      { id: 'c2', name: 'Camp B', lat: 0, lon: 0, type: 'campsite', totalDistance: 60 },
      { id: 'c3', name: 'Camp C', lat: 0, lon: 0, type: 'campsite', totalDistance: 80 },
    ],
    track: { points, displayPoints: points, totalDistance: 100, totalAscent: 500, totalDescent: 500 },
  };
}

const OPTS: PlanGlanceOptions = { direction: 'NOBO', baseKmh: 4, dailyHours: 8 };

function plan(t: TrailJson, ids: string[], startDate: string | null): PlanDocument {
  let doc = newPlan('syn', 'Synthetic', 'NOBO', { idFactory: () => 'plan-1' });
  for (const id of ids) {
    const wp = t.waypoints.find((w) => w.id === id)!;
    doc = toggleStop(doc, toggleTargetOf(stopCandidateOf(wp, 'NOBO', 100)), { totalKm: 100 });
  }
  return startDate ? setStartDate(doc, startDate) : doc;
}

describe('localIsoDate', () => {
  it('formats the local calendar date', () => {
    expect(localIsoDate(new Date(2026, 0, 5, 23, 30))).toBe('2026-01-05');
  });
});

describe('msUntilLocalMidnight', () => {
  it('counts down to the start of the next local day', () => {
    expect(msUntilLocalMidnight(new Date(2026, 0, 5, 23, 30))).toBe(30 * 60_000);
    expect(msUntilLocalMidnight(new Date(2026, 0, 31, 0, 0))).toBe(24 * 3_600_000);
    const now = new Date(2026, 11, 31, 12, 0);
    expect(localIsoDate(new Date(now.getTime() + msUntilLocalMidnight(now)))).toBe('2027-01-01');
  });
});

describe('todayPlan', () => {
  const t = trail();

  it('finds the walking day dated today', () => {
    const glance = planGlance(t, plan(t, ['c1', 'c2', 'c3'], '2026-10-10'), OPTS);
    const today = todayPlan(glance, '2026-10-11');
    expect(today?.kind).toBe('walk');
    expect(today?.day.startName).toBe('Camp A');
    expect(today?.day.endName).toBe('Camp B');
  });

  it('has nothing without a start date, before the start, or in the unplanned tail', () => {
    expect(todayPlan(planGlance(t, plan(t, ['c1', 'c2'], null), OPTS), '2026-10-10')).toBeNull();
    const glance = planGlance(t, plan(t, ['c1', 'c2'], '2026-10-10'), OPTS);
    expect(todayPlan(glance, '2026-10-09')).toBeNull();
    // Camp B → end is 40 km: 10 h, past an 8 h hiker's final-day allowance.
    expect(glance.unplanned).not.toBeNull();
    expect(todayPlan(glance, '2026-10-12')).toBeNull();
  });

  it('reads a rest day at the stop', () => {
    let doc = plan(t, ['c1', 'c2', 'c3'], '2026-10-10');
    doc = setNights(doc, { waypointId: 'c1', km: 20 }, 3);
    const glance = planGlance(t, doc, OPTS);
    const rest = todayPlan(glance, '2026-10-12');
    expect(rest).toMatchObject({ kind: 'rest', restDay: 2, restDays: 2 });
    expect(rest?.day.endName).toBe('Camp A');
    expect(emptyMessage(rest, '2026-10-12', true, true)).toBe('A rest day at Camp A (2 of 2).');
    expect(todayPlan(glance, '2026-10-13')?.day.startName).toBe('Camp A');
  });
});

describe('todayRows', () => {
  it('says how far each place is from the trail line', () => {
    const t = trail();
    // The creek sits ~1.1 km north of the line; the camps are on it.
    t.waypoints[1] = { ...t.waypoints[1], lat: 0.01, lon: 0.03 };
    const today = todayPlan(planGlance(t, plan(t, ['c1', 'c2', 'c3'], '2026-10-10'), OPTS), '2026-10-11');
    const rows = todayRows(t, today!.day);
    const creek = rows.find((r) => r.name === 'Creek')!;
    expect(creek.offTrailM).toBeGreaterThan(1000);
    expect(creek.offTrailM).toBeLessThan(1200);
    expect(rows.find((r) => r.name === 'Camp B')!.offTrailM).toBeLessThan(50);
  });

  it('lists the day from camp to camp with each leg', () => {
    const t = trail();
    const today = todayPlan(planGlance(t, plan(t, ['c1', 'c2', 'c3'], '2026-10-10'), OPTS), '2026-10-11');
    const rows = todayRows(t, today!.day);
    expect(rows.map((r) => [r.role, r.name, r.fromStartKm, r.legKm])).toEqual([
      ['start', 'Camp A', 0, 0],
      ['via', 'Creek', 10, 10],
      ['via', 'Junction', 35, 25],
      ['end', 'Camp B', 40, 5],
    ]);
    expect(rows[1]).toMatchObject({ legAscentM: 100, legDescentM: 0 });
    expect(rows[2]).toMatchObject({ legAscentM: 200, legDescentM: 50 });
    expect(rows[3]).toMatchObject({ legAscentM: 0, legDescentM: 50, totalAscentM: 300, totalDescentM: 100 });
    expect(rows[3].waypoint?.id).toBe('c2');
  });

  it("walks out of last night's off-route stop and in to tonight's", () => {
    const t = trail();
    const walk = { offTrailKm: 2, accessMode: 'foot' as const, offTrailAscentM: 30, offTrailDescentM: 10 };
    t.waypoints[0] = { ...t.waypoints[0], ...walk };
    t.waypoints[3] = { ...t.waypoints[3], ...walk };
    const today = todayPlan(planGlance(t, plan(t, ['c1', 'c2', 'c3'], '2026-10-10'), OPTS), '2026-10-11');
    const rows = todayRows(t, today!.day);
    expect(rows.map((r) => [r.name, r.fromStartKm, r.legKm])).toEqual([
      ['Camp A', 0, 0],
      ['Creek', 12, 12],
      ['Junction', 37, 25],
      ['Camp B', 44, 7],
    ]);
    // Out of Camp A climbs what its walk in descended; in to Camp B climbs its own.
    expect(rows[1]).toMatchObject({ legAscentM: 110, legDescentM: 30 });
    expect(rows[3]).toMatchObject({ legAscentM: 30, legDescentM: 60 });
    // The rows add up to the day.
    expect(rows[3].fromStartKm).toBeCloseTo(today!.day.distanceKm, 5);
    expect(rows[3].totalAscentM).toBe(today!.day.ascentM);
  });

  it('names the trail start when the day has no waypoint there', () => {
    const t = trail();
    const today = todayPlan(planGlance(t, plan(t, ['c1', 'c2'], '2026-10-10'), OPTS), '2026-10-10');
    const rows = todayRows(t, today!.day);
    expect(rows[0]).toMatchObject({ role: 'start', name: 'Synthetic Start', km: 0 });
    expect(rows[0].waypoint).toBeUndefined();
    expect(rows[rows.length - 1].name).toBe('Camp A');
  });
});

function poi(id: number, km: number, over: Partial<TrailPOI> = {}): TrailPOI {
  return {
    id,
    type: 'node',
    category: 'restaurant',
    lat: 0,
    lon: 0,
    name: `Place ${id}`,
    tags: {},
    distanceAlongTrail: km,
    distanceFromTrail: 0.1,
    ...over,
  };
}

describe('the POIs along today', () => {
  const t: TrailJson = {
    ...trail(),
    pois: [poi(1, 10), poi(2, 25), poi(3, 30), poi(4, 59.9), poi(5, 75), poi(6, 45, { duplicateOf: 'x' })],
  };
  const today = todayPlan(planGlance(t, plan(t, ['c1', 'c2', 'c3'], '2026-10-10'), OPTS), '2026-10-11')!;

  it('takes the day start to tonight, nothing either side', () => {
    expect(today.day).toMatchObject({ startKm: 20, endKm: 60 });
    expect(todayPois(t, today.day).map((p) => p.id)).toEqual([2, 3, 6, 4]);
  });

  it('has none on a trail with no POI data', () => {
    expect(todayPois(trail(), today.day)).toEqual([]);
  });

  it('places each POI among the rows at its km, after a waypoint at the same km', () => {
    const rows = todayRows(t, today.day);
    const entries = todayEntries(rows, todayPois(t, today.day).filter((p) => !p.duplicateOf), today.day);
    expect(entries.map((e) => (e.kind === 'row' ? e.row.name : `poi ${e.poi.id}`))).toEqual([
      'Camp A',
      'poi 2',
      'Creek',
      'poi 3',
      'Junction',
      'poi 4',
      'Camp B',
    ]);
    const poi3 = entries.find((e) => e.kind === 'poi' && e.poi.id === 3);
    expect(poi3).toMatchObject({ fromStartKm: 10 });
    expect(new Set(entries.map((e) => e.key)).size).toBe(entries.length);
  });

  it('leaves the waypoint legs alone', () => {
    const rows = todayRows(t, today.day);
    const entries = todayEntries(rows, todayPois(t, today.day), today.day);
    const legs = entries.flatMap((e) => (e.kind === 'row' ? [e.row.legKm] : []));
    expect(legs).toEqual([0, 10, 25, 5]);
  });
});

describe('dayRouteParams / dayFromRouteParams', () => {
  const day = {
    dayNumber: 3,
    date: '2026-10-12',
    startName: 'Camp A',
    endName: 'Hut & Co',
    startKm: 20.25,
    endKm: 41.5,
    distanceKm: 21.25,
    ascentM: 812,
    descentM: 640,
    estimatedHours: 7.4,
    waterSources: 2,
    restDays: 1,
  };

  it('round-trips a day through string params', () => {
    const params = dayRouteParams(day);
    expect(Object.values(params).every((v) => typeof v === 'string')).toBe(true);
    expect(dayFromRouteParams(params)).toEqual(day);
  });

  it('leaves out a date and rest days the day does not have', () => {
    const { date: _date, restDays: _rest, ...undated } = day;
    expect(dayFromRouteParams(dayRouteParams(undated))).toEqual(undated);
  });

  it('refuses missing or malformed params', () => {
    const params = dayRouteParams(day);
    expect(dayFromRouteParams({ ...params, startKm: 'x' })).toBeNull();
    expect(dayFromRouteParams({ ...params, endKm: '' })).toBeNull();
    expect(dayFromRouteParams({ ...params, endKm: '10' })).toBeNull();
    const { endName: _end, ...noEnd } = params;
    expect(dayFromRouteParams(noEnd)).toBeNull();
    expect(dayFromRouteParams({ ...params, startName: ['a', 'b'] })).toBeNull();
  });
});

describe('sectionFromRouteParams', () => {
  const section = { startKm: 20, endKm: 80, startName: 'Camp A', endName: 'Camp C' };
  const day = {
    dayNumber: 1,
    startName: 'Camp A',
    endName: 'Camp B',
    startKm: 20,
    endKm: 60,
    distanceKm: 40,
    ascentM: 0,
    descentM: 0,
    estimatedHours: 9,
    waterSources: 0,
  };

  it('round-trips the section beside the day', () => {
    const params = dayRouteParams(day, section);
    expect(sectionFromRouteParams(params)).toEqual(section);
    expect(dayFromRouteParams(params)).toEqual(day);
  });

  it('is undefined without one, or with an unusable one', () => {
    expect(sectionFromRouteParams(dayRouteParams(day))).toBeUndefined();
    const params = dayRouteParams(day, section);
    expect(sectionFromRouteParams({ ...params, sectionEndKm: '10' })).toBeUndefined();
    expect(sectionFromRouteParams({ ...params, sectionStartKm: '' })).toBeUndefined();
    expect(sectionFromRouteParams({ ...params, sectionEndName: ['a'] })).toBeUndefined();
  });
});

describe('sectionOnRoute', () => {
  const section = { startKm: 20, endKm: 80, startName: 'Camp A', endName: 'Camp C' };

  it('keeps a section that fits the route, and drops one past its end', () => {
    expect(sectionOnRoute(section, 100)).toBe(section);
    expect(sectionOnRoute(section, 80)).toBe(section);
    // An alternate taken since: the route is now 75 km.
    expect(sectionOnRoute(section, 75)).toBeUndefined();
    expect(sectionOnRoute(undefined, 100)).toBeUndefined();
  });
});

describe('currentPlanDay', () => {
  it('follows the day from the same stop when a stop is added before it', () => {
    const t = trail();
    const opened = planGlance(t, plan(t, ['c2', 'c3'], '2026-10-10'), OPTS).days[1];
    expect(opened).toMatchObject({ startName: 'Camp B', date: '2026-10-11' });
    const after = planGlance(t, plan(t, ['c1', 'c2', 'c3'], '2026-10-10'), OPTS);
    const current = currentPlanDay(after, opened);
    expect(current).toEqual({ kind: 'day', day: after.days[2] });
    expect(after.days[2]).toMatchObject({ dayNumber: 3, startName: 'Camp B', date: '2026-10-12' });
  });

  it('does not land on another stretch under the same date or number', () => {
    const t = trail();
    const opened = planGlance(t, plan(t, ['c1', 'c2'], '2026-10-10'), OPTS).days[1];
    expect(opened).toMatchObject({ dayNumber: 2, startName: 'Camp A', date: '2026-10-11' });
    // Camp A taken out: day 2 and the 11th are now Camp B onwards.
    const after = planGlance(t, plan(t, ['c2', 'c3'], '2026-10-10'), OPTS);
    expect(after.days[1]).toMatchObject({ dayNumber: 2, startName: 'Camp B' });
    expect(currentPlanDay(after, opened)).toEqual({ kind: 'gone' });
  });

  it('says so when the stretch from that stop is now "not planned yet"', () => {
    const t = trail();
    const before = planGlance(t, plan(t, ['c1', 'c2'], null), OPTS);
    const opened = before.days[1]; // Camp A → Camp B
    // Camp B taken out: from Camp A it is 80 km to the end, too long for a day.
    const after = planGlance(t, plan(t, ['c1'], null), OPTS);
    expect(after.unplanned).toMatchObject({ startName: 'Camp A' });
    expect(currentPlanDay(after, opened)).toEqual({ kind: 'unplanned', day: after.unplanned });
  });

  it('measures over the section it is given', () => {
    const t = trail();
    const section = { startKm: 20, endKm: 80, startName: 'Camp A', endName: 'Camp C' };
    const { days } = planGlance(t, plan(t, ['c2'], null), OPTS, section);
    expect(days.map((d) => [d.startKm, d.endKm])).toEqual([
      [20, 60],
      [60, 80],
    ]);
  });
});
