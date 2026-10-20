import { describe, expect, it } from 'vitest';
import { alternateKmToRoute, buildPlannedRoute, planToRoute, type PlannableVariant } from './plan-alternates';
import { computePlanDays, removeStoredStop } from './plan-editor';
import { planStopIssues, stopIssueText, stopIssuesNotice, type StopIssuesTrail } from './plan-stop-issues';
import type { PlanDocument, PlanStop } from './plan-types';

/** Degrees of longitude per km on the equator. */
const DEG_PER_KM = 1 / 111.19492664455873;

/**
 * A 100 km main route along the equator with Camp 10, Camp 20 and Camp 60,
 * and "Alt" off km 30 rejoining at km 50: 25 km long, with Alt Camp 10 km
 * along it (absolute km 40) and Alt Hut 24 km along (km 54).
 */
function trailFixture(): StopIssuesTrail & { config: { id: string; name: string } } {
  const points = Array.from({ length: 101 }, (_, km) => ({ lat: 0, lon: km * DEG_PER_KM, ele: 100, dist: km }));
  const altPoints = Array.from({ length: 26 }, (_, i) => ({
    lat: (i <= 12 ? i : 25 - i) * 0.3 * DEG_PER_KM,
    lon: (30 + (20 * i) / 25) * DEG_PER_KM,
    ele: 100,
  }));
  const alt: PlannableVariant = {
    name: 'Alt',
    type: 'alternate',
    points: altPoints,
    distance: 25,
    elevation: { ascent: 0, descent: 0 },
    startDistance: 30,
    endDistance: 50,
    waypoints: [
      { id: 'w_altcamp', name: 'Alt Camp', type: 'campsite', totalDistance: 40 },
      { id: 'w_althut', name: 'Alt Hut', type: 'hut', totalDistance: 54 },
    ],
  };
  return {
    config: { id: 'demo', name: 'Demo' },
    track: { points, totalDistance: 100 },
    waypoints: [
      { id: 'w_c10', name: 'Camp 10', type: 'campsite', totalDistance: 10 },
      { id: 'w_c20', name: 'Camp 20', type: 'campsite', totalDistance: 20 },
      { id: 'w_c60', name: 'Camp 60', type: 'campsite', totalDistance: 60 },
    ],
    offTrailWaypoints: [{ id: 'w_far' }],
    alternates: [alt],
  };
}

function plan(stops: PlanStop[], extra: Partial<PlanDocument> = {}): PlanDocument {
  return {
    id: 'p',
    trailId: 'demo',
    name: 'Plan',
    direction: 'NOBO',
    startDate: '2026-11-01',
    stops,
    updatedAt: '2026-10-01T00:00:00.000Z',
    version: 1,
    ...extra,
  };
}

const stop = (km: number, name: string, extra: Partial<PlanStop> = {}): PlanStop => ({ km, name, nights: 1, ...extra });

describe('planStopIssues', () => {
  it('reports nothing for a plan whose stops all match the data, and leaves the days alone', () => {
    const trail = trailFixture();
    const doc = plan([
      stop(10, 'Camp 10', { waypointId: 'w_c10', nights: 2 }),
      stop(40, 'Alt Camp', { waypointId: 'w_altcamp', alternate: 'Alt' }),
      stop(54.04, 'Alt Hut', { waypointId: 'w_althut', alternate: 'Alt' }),
      stop(70, 'Somewhere'),
      stop(80, 'Far place', { waypointId: 'w_far' }),
      stop(90, 'My spot', { waypointId: 'hw_00000000-0000-4000-8000-000000000000' }),
    ], { alternates: ['Alt'] });
    expect(planStopIssues(doc, trail)).toEqual([]);

    // Every stop of an all-ok plan is a day boundary on the route as planned.
    const route = buildPlannedRoute(trail, doc.alternates);
    const routePlan = planToRoute(doc, route);
    expect(routePlan.stops.map(s => s.km)).toEqual([10, 40, 54.04, 75, 85, 95]);
  });

  it('(a) keeps a stop whose place is gone in its day, flagged', () => {
    const doc = plan([stop(15, 'Old Camp', { waypointId: 'w_gone' })]);
    const issues = planStopIssues(doc, trailFixture());
    expect(issues).toEqual([{ stop: doc.stops[0], reason: 'waypoint-missing', routeKm: 15 }]);
    // Still a day boundary: nothing the days do changes for it.
    expect(computePlanDays(trailFixture(), doc, { baseKmh: 4 })[0].endKm).toBe(15);
  });

  it('(a) flags a stop whose place moved where another stop already is', () => {
    const doc = plan([stop(20, 'Somewhere'), stop(22, 'Camp 20', { waypointId: 'w_c20' })]);
    expect(planStopIssues(doc, trailFixture()).map(i => [i.stop.name, i.reason, i.routeKm])).toEqual([
      ['Camp 20', 'waypoint-moved', 22],
    ]);
  });

  it('(a) flags a place that moved between the main route and an alternate', () => {
    // Alt Camp is the alternate's now; a main-route stop at its id no longer matches.
    const doc = plan([stop(40, 'Alt Camp', { waypointId: 'w_altcamp' })]);
    expect(planStopIssues(doc, trailFixture())[0].reason).toBe('waypoint-missing');
  });

  it('(b) lists a stop past either end of the trail with no route km, nights and all', () => {
    const doc = plan([stop(105, 'Old End Camp', { nights: 3 }), stop(-1, 'Before'), stop(10, 'Camp 10', { waypointId: 'w_c10' })]);
    const issues = planStopIssues(doc, trailFixture());
    expect(issues.map(i => [i.stop.name, i.reason, i.routeKm])).toEqual([
      ['Old End Camp', 'off-route', null],
      ['Before', 'off-route', null],
    ]);
    expect(stopIssuesNotice(issues)).toBe(
      '2 stops need checking after a trail data update. 4 nights are left out of the dates until you move or remove them.',
    );
  });

  it('(c) lists a stop on an alternate the trail no longer has', () => {
    const doc = plan([stop(40, 'Gone Camp', { alternate: 'Gone', waypointId: 'w_x' })], { alternates: ['Gone'] });
    expect(planStopIssues(doc, trailFixture()).map(i => [i.reason, i.routeKm])).toEqual([['alternate-missing', null]]);
  });

  it('(c) lists a stop on an alternate whose junction is now past the end of the trail', () => {
    const trail = trailFixture();
    trail.alternates![0] = { ...trail.alternates![0], startDistance: 95, endDistance: 120 };
    const doc = plan([stop(105, 'Alt Camp', { alternate: 'Alt', waypointId: 'w_altcamp' })], { alternates: ['Alt'] });
    expect(planStopIssues(doc, trail)[0].reason).toBe('alternate-missing');
  });

  it('(c) names a stop on an alternate the plan does not take, or on a bypassed stretch', () => {
    const trail = trailFixture();
    const notTaken = plan([stop(40, 'Alt Camp', { alternate: 'Alt', waypointId: 'w_altcamp' })]);
    expect(planStopIssues(notTaken, trail)[0].reason).toBe('not-on-route');
    const bypassed = plan([stop(45, 'Bypassed')], { alternates: ['Alt'] });
    expect(planStopIssues(bypassed, trail).map(i => [i.reason, i.routeKm])).toEqual([['not-on-route', null]]);
  });

  it('(d) lists a stop past the end of a shortened alternate instead of pinning it to the rejoin', () => {
    const trail = trailFixture();
    const doc = plan([stop(58, 'Old Alt End', { alternate: 'Alt' })], { alternates: ['Alt'] });
    const route = buildPlannedRoute(trail, doc.alternates);
    expect(alternateKmToRoute(route, 'Alt', 58)).toBeNull();
    expect(alternateKmToRoute(route, 'Alt', 55.05)).toBe(55);
    expect(planStopIssues(doc, trail, { route }).map(i => [i.reason, i.routeKm])).toEqual([['off-alternate', null]]);
    // Not a day boundary at the rejoin any more.
    expect(planToRoute(doc, route).stops).toEqual([]);
  });

  it('reports the second of two stops at one route km as a duplicate', () => {
    const doc = plan([stop(30, 'Junction'), stop(30, 'Alt start', { alternate: 'Alt' })], { alternates: ['Alt'] });
    expect(planStopIssues(doc, trailFixture()).map(i => [i.stop.name, i.reason])).toEqual([['Alt start', 'duplicate']]);
  });

  it('defers to newer data: every issue reads as newer-data on an older device', () => {
    const doc = plan([stop(15, 'New Camp', { waypointId: 'w_new' })], { dataUpdatedAt: '2026-10-05T00:00:00.000Z' });
    const trail = trailFixture();
    expect(planStopIssues(doc, trail, { dataUpdatedAt: '2026-09-01T00:00:00.000Z' })[0].reason).toBe('newer-data');
    expect(planStopIssues(doc, trail, { dataUpdatedAt: '2026-10-06T00:00:00.000Z' })[0].reason).toBe('waypoint-missing');
  });

  it('words every reason and the notice', () => {
    expect(stopIssueText('off-route')).toBe('Past the end of the updated trail');
    expect(stopIssueText('waypoint-missing')).toBe('This place is no longer in the trail data');
    expect(stopIssueText('alternate-missing')).toBe('On an alternate that is no longer in the trail data');
    expect(stopIssuesNotice([])).toBeNull();
    const placed = planStopIssues(plan([stop(15, 'Old', { waypointId: 'w_gone', nights: 2 })]), trailFixture());
    expect(stopIssuesNotice(placed)).toBe('1 stop needs checking after a trail data update.');
  });
});

describe('removeStoredStop', () => {
  it('removes exactly the stored stop, alternate and all, and is a no-op otherwise', () => {
    const doc = plan([stop(40, 'Main 40'), stop(40, 'Alt 40', { alternate: 'Gone' })]);
    const next = removeStoredStop(doc, { km: 40, alternate: 'Gone' }, { now: () => '2026-10-02T00:00:00.000Z' });
    expect(next.stops.map(s => s.name)).toEqual(['Main 40']);
    expect(removeStoredStop(doc, { km: 41 })).toBe(doc);
  });
});
