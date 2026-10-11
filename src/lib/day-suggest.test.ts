import { describe, it, expect } from 'vitest';
import { buildTimeIndex } from './day-calculator';
import { assertSearchable, measureDay, suggestDays, withWalks, type SuggestDaysInput } from './day-suggest';

/** A 100 km trail, flat unless `hill` raises a stretch (1 m per 10 m of km … simple ramps). */
function track(lengthKm = 100, elevationAt: (km: number) => number = () => 100) {
  return Array.from({ length: lengthKm * 10 + 1 }, (_, i) => {
    const km = i / 10;
    return { lat: 0, lon: km * 0.009, ele: elevationAt(km), dist: km };
  });
}

interface Camp {
  km: number;
  name: string;
  walk?: { km: number; ascentM: number; descentM: number };
}

const camp = (km: number): Camp => ({ km, name: `Camp ${km}` });

function input(overrides: Partial<SuggestDaysInput<Camp>> = {}): SuggestDaysInput<Camp> {
  return {
    index: buildTimeIndex(track()),
    candidates: [10, 18, 20, 22, 30, 40, 41, 60, 62, 80].map(camp),
    fromKm: 0,
    endKm: 100,
    days: 3,
    alternatives: 3,
    criteria: { distanceKm: { min: 15, max: 25 } },
    baseKmh: 4,
    ...overrides,
  };
}

describe('assertSearchable', () => {
  it('refuses criteria without any maximum', () => {
    expect(() => assertSearchable({ distanceKm: { min: 10 } })).toThrow(/maximum/);
    expect(() => assertSearchable({})).toThrow(/maximum/);
  });

  it('accepts any one maximum', () => {
    expect(() => assertSearchable({ ascentM: { max: 800 } })).not.toThrow();
    expect(() => assertSearchable({ hours: { max: 8 } })).not.toThrow();
  });
});

describe('measureDay', () => {
  it('reads distance, climb and Naismith hours off the index', () => {
    const index = buildTimeIndex(track(100, km => (km <= 10 ? km * 60 : 600)));
    const day = measureDay(index, 0, 20, 4);
    expect(day.distanceKm).toBe(20);
    expect(day.ascentM).toBe(600);
    expect(day.descentM).toBe(0);
    expect(day.hours).toBeCloseTo(20 / 4 + 600 / 600);
  });
});

describe('suggestDays', () => {
  it('ranks whole plans by least deviation from the target', () => {
    const { plans } = suggestDays(input());
    expect(plans[0].stops.map(s => s.km)).toEqual([20, 40, 60]);
    expect(plans[0].score).toBe(0);
    expect(plans).toHaveLength(3);
    for (let i = 1; i < plans.length; i++) expect(plans[i].score).toBeGreaterThanOrEqual(plans[i - 1].score);
  });

  it('keeps every day inside every range', () => {
    const { plans } = suggestDays(input());
    for (const plan of plans) {
      for (const day of plan.days) {
        expect(day.distanceKm).toBeGreaterThanOrEqual(15);
        expect(day.distanceKm).toBeLessThanOrEqual(25);
      }
    }
  });

  it('prefers distinct plans over near-duplicates', () => {
    const { plans } = suggestDays(input());
    // 40 and 41 are the same night for the hiker; the runner-up must differ elsewhere.
    const [best, second] = plans;
    const sameShape = best.days.every((d, i) => Math.abs(d.endKm - second.days[i].endKm) < 1);
    expect(sameShape).toBe(false);
  });

  it('honours an explicit target inside the range', () => {
    const { plans } = suggestDays(input({ criteria: { distanceKm: { min: 15, max: 25, target: 18 } }, days: 1 }));
    expect(plans[0].stops[0].km).toBe(18);
  });

  it('starts from the given km, not the trail start', () => {
    const { plans } = suggestDays(input({ fromKm: 40, days: 2 }));
    expect(plans[0].days[0].startKm).toBe(40);
    expect(plans[0].stops.map(s => s.km)).toEqual([60, 80]);
  });

  it('may finish at the range end, with a short last day costing nothing', () => {
    const { plans } = suggestDays(input({ fromKm: 60, days: 3 }));
    const best = plans[0];
    expect(best.reachesEnd).toBe(true);
    expect(best.days[best.days.length - 1].end).toBeNull();
    expect(best.days[best.days.length - 1].endKm).toBe(100);
  });

  it('judges ascent as well as distance', () => {
    // A 600 m climb between km 20 and 30.
    const index = buildTimeIndex(track(100, km => (km < 20 ? 100 : km < 30 ? 100 + (km - 20) * 60 : 700)));
    const { plans } = suggestDays(
      input({ index, days: 1, criteria: { distanceKm: { max: 40 }, ascentM: { max: 300 } } }),
    );
    for (const plan of plans) expect(plan.days[0].ascentM).toBeLessThanOrEqual(300);
    expect(plans[0].stops[0].km).toBeLessThanOrEqual(25);
  });

  it('works in hours mode alone', () => {
    const { plans } = suggestDays(input({ criteria: { hours: { min: 4, max: 6, target: 5 } }, days: 2 }));
    expect(plans[0].stops.map(s => s.km)).toEqual([20, 40]);
  });

  it('reports when the criteria run out before the days do', () => {
    // No camp between 41 and 60 is 15-25 km on from 41 → only 2 days from 0 via 20/22, 40/41.
    const { plans, shortOf } = suggestDays(
      input({ candidates: [20, 40].map(camp), days: 3 }),
    );
    expect(shortOf).toBe(2);
    expect(plans[0].stops.map(s => s.km)).toEqual([20, 40]);
  });

  it('returns nothing when no first day fits', () => {
    expect(suggestDays(input({ candidates: [5].map(camp), days: 2 })).plans).toEqual([]);
  });

  it('ignores candidates behind the start or at the ends', () => {
    const { plans } = suggestDays(input({ fromKm: 30, candidates: [0, 10, 30, 50, 100].map(camp), days: 1 }));
    expect(plans.flatMap(p => p.stops.map(s => s.km))).toEqual([50]);
  });

  it('caps the alternatives asked for', () => {
    expect(suggestDays(input({ alternatives: 1 })).plans).toHaveLength(1);
  });

  it('does not let a trivial walk out dilute the mean (camp 100 m from the end)', () => {
    // Flat 36 km at 4 km/h: one 9 h day to the end is inside 6-10 h. Camping at
    // 35.9 km and walking the last 100 m tomorrow must not outrank it.
    const { plans } = suggestDays(
      input({
        index: buildTimeIndex(track(36)),
        candidates: [camp(35.9)],
        endKm: 36,
        criteria: { hours: { min: 6, max: 10, target: 8 } },
      }),
    );
    expect(plans[0].days).toHaveLength(1);
    expect(plans[0].reachesEnd).toBe(true);
    expect(plans[0].score).toBeCloseTo(0.25);
    const split = plans.find(plan => plan.days.length === 2);
    if (split) expect(split.score).toBeGreaterThan(plans[0].score);
  });

  it('keeps a forced short walk out free', () => {
    // 36 → 50 km is under the minimum, but 0 → 50 km is over the maximum: the
    // short day cannot be avoided, so it costs nothing.
    const { plans } = suggestDays(
      input({
        index: buildTimeIndex(track(50)),
        candidates: [camp(32)],
        endKm: 50,
        criteria: { hours: { min: 6, max: 10, target: 8 } },
      }),
    );
    expect(plans[0].stops.map(s => s.km)).toEqual([32]);
    expect(plans[0].days[1].cost).toBe(0);
    expect(plans[0].score).toBe(0);
  });
});

describe('walks to camps off the route', () => {
  const offRoute = (km: number, walkKm: number): Camp => ({ ...camp(km), walk: { km: walkKm, ascentM: 0, descentM: 0 } });

  it('adds the walk out and in to a day, and its Naismith hours over the totals', () => {
    const day = withWalks(
      { distanceKm: 10, ascentM: 0, descentM: 0, hours: 2.5 },
      { km: 1, ascentM: 50, descentM: 0 },
      { km: 2, ascentM: 100, descentM: 10 },
      4
    );
    // Out climbs what the walk in to that stop descended, and the other way round.
    expect(day).toEqual({ distanceKm: 13, ascentM: 100, descentM: 60, hours: 13 / 4 + 100 / 600 });
  });

  it('counts the walk to a camp against the day that ends there', () => {
    // Camp 20 is 6 km off the route: 26 km is over the 25 km maximum, so the
    // first day ends at 22 instead.
    const { plans } = suggestDays(
      input({ days: 1, candidates: [offRoute(20, 6), camp(22)], criteria: { distanceKm: { min: 18, max: 25 } } })
    );
    expect(plans[0].stops.map(s => s.km)).toEqual([22]);
    expect(plans.some(plan => plan.stops.some(s => s.km === 20))).toBe(false);
  });

  it('keeps the shortest walk among places that share a junction', () => {
    const far = { ...offRoute(20, 2.8), name: 'Far inn' };
    const near = { ...offRoute(20, 0.3), name: 'Near inn' };
    for (const candidates of [[far, near], [near, far]]) {
      const { plans } = suggestDays(input({ days: 1, candidates, criteria: { distanceKm: { min: 18, max: 25 } } }));
      expect(plans[0].stops.map(s => s.name)).toEqual(['Near inn']);
    }
  });

  it('prefers a camp on the route to a place off it at the same km', () => {
    const { plans } = suggestDays(
      input({ days: 1, candidates: [offRoute(20, 1), camp(20)], criteria: { distanceKm: { min: 18, max: 25 } } })
    );
    expect(plans[0].stops.map(s => s.name)).toEqual(['Camp 20']);
  });

  it('starts the first day with the walk back out of an off-route stop', () => {
    const { plans } = suggestDays(
      input({ days: 1, candidates: [camp(20), camp(24)], criteria: { distanceKm: { min: 18, max: 25 } }, fromWalk: { km: 3, ascentM: 0, descentM: 0 } })
    );
    // 20 + 3 = 23 fits; 24 + 3 = 27 does not.
    expect(plans.map(plan => plan.stops.map(s => s.km))).toEqual([[20]]);
    expect(plans[0].days[0].distanceKm).toBe(23);
  });
});
