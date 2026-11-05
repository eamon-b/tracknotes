import { describe, expect, it } from 'vitest';
import { computePlanDays, newPlan, setNights, setStartDate, setStopNote, toggleStop } from './plan-editor';
import type { PlanTrail } from './day-calculator';
import type { PlanDocument } from './plan-types';
import { computeResupplyLegs, listResupplyOptions, resolveResupplyStops, resupplyCandidates } from './resupply-plan';
import { parseGpx } from './gpx-parser';
import { createReversedTrail } from './trail-reverse';
import { plannedRouteFor, plannedRouteTrail, planToRoute, type PlannableTrail } from './plan-alternates';
import {
  canExportIcs,
  foldIcsLine,
  icsText,
  planExportFileName,
  planToGpx,
  planToIcs,
  xmlText,
  type PlanExportInput,
} from './plan-export';

const opts = { idFactory: () => 'plan-1', now: () => '2026-09-20T00:00:00.000Z' };
const DTSTAMP = '2026-11-05T08:30:00.000Z';

/**
 * A 60 km trail with a route break (a ferry) at km 30: points every km, the
 * break's landing at index 31 (km 30 → km 31 is not walked).
 */
function trail() {
  const points = Array.from({ length: 61 }, (_, i) => ({ lat: -35 + i * 0.001, lon: 149, ele: 500 + i, dist: i }));
  return {
    config: { name: 'Test & Trail' },
    track: {
      points,
      totalDistance: 60,
      totalAscent: 60,
      totalDescent: 0,
      breaks: [{ index: 31, displayIndex: 31, km: 30, fromTrack: 'North', toTrack: 'South' }],
    },
    waypoints: [
      { id: 'w_start', name: 'Trailhead', type: 'trailhead', totalDistance: 0, lat: -35, lon: 149 },
      { id: 'w_hut_a', name: 'Hut <A>', type: 'hut', totalDistance: 20, lat: -34.5, lon: 149.5 },
      { id: 'w_town', name: 'Townsville', type: 'town', totalDistance: 40, lat: -34.9, lon: 149.1 },
      { id: 'w_hut_b', name: 'Hut B', type: 'hut', totalDistance: 40, lat: -34.96, lon: 149 },
      { id: 'w_end', name: 'Summit', type: 'trailhead', totalDistance: 60, lat: -34.94, lon: 149 },
    ],
  };
}

function plan(): PlanDocument {
  let doc = newPlan('test', 'My "walk"; with, commas', 'NOBO', opts);
  doc = toggleStop(doc, { id: 'w_hut_a', km: 20, name: 'Hut <A>' }, { ...opts, totalKm: 60 });
  doc = toggleStop(doc, { id: 'w_hut_b', km: 40, name: 'Hut B' }, { ...opts, totalKm: 60 });
  doc = setNights(doc, { waypointId: 'w_hut_b', km: 40 }, 3, opts);
  doc = setStopNote(doc, { waypointId: 'w_hut_a', km: 20 }, 'Book & pay\nat the store', opts);
  return doc;
}

function input(doc: PlanDocument, active: PlanTrail = trail(), zeroDays?: Record<string, number>): PlanExportInput {
  const days = computePlanDays(active, doc, { baseKmh: 4 });
  const groups = listResupplyOptions(resupplyCandidates(active));
  const resupplyStops = resolveResupplyStops(groups, undefined);
  const resupplyLegs = computeResupplyLegs(active, resupplyStops, {
    dailyHours: 8,
    baseKmh: 4,
    longThresholdDays: 5,
    gramsPerDay: 700,
    days,
    zeroDays,
  });
  return { plan: doc, trail: active, days, resupplyStops, resupplyLegs };
}

describe('planToGpx', () => {
  it('re-parses with the repo GPX parser: a segment per stretch, night stops and resupply as waypoints', () => {
    const gpx = planToGpx(input(plan()));
    const parsed = parseGpx(gpx);
    expect(parsed.metadataName).toBe('My "walk"; with, commas');
    expect(parsed.tracks).toHaveLength(1);
    // The break at km 30 splits the route in two; never a straight line across.
    expect(parsed.tracks[0].segments).toHaveLength(2);
    expect(parsed.tracks[0].segments[0].points).toHaveLength(31);
    expect(parsed.tracks[0].segments[1].points).toHaveLength(30);

    const names = parsed.waypoints.map(wp => wp.name);
    expect(names).toEqual(['Hut <A>', 'Hut B', 'Townsville']);
    const hutA = parsed.waypoints[0];
    // At the place itself, not the route.
    expect(hutA.lat).toBeCloseTo(-34.5);
    expect(hutA.desc).toContain('km 20.0');
    expect(hutA.desc).toContain('Book & pay');
    expect(parsed.waypoints[1].desc).toContain('3 nights');
    expect(parsed.waypoints[2].desc).toContain('Resupply');
  });

  it('escapes and strips what XML cannot carry', () => {
    expect(xmlText('a<b>&"\'\u0000\u0007c')).toBe('a&lt;b&gt;&amp;&quot;&apos;c');
    expect(xmlText('lone \uD800 surrogate 😀')).toBe('lone  surrogate 😀');
    const gpx = planToGpx(input(plan()));
    expect(gpx).toContain('<name>Hut &lt;A&gt;</name>');
    expect(gpx).not.toContain('Hut <A>');
  });

  it('writes the route in the plan direction', () => {
    const doc = { ...plan(), direction: 'SOBO' as const };
    const reversed = createReversedTrail(trail()) as unknown as PlanTrail;
    const parsed = parseGpx(planToGpx(input(doc, reversed)));
    const first = parsed.tracks[0].segments[0].points[0];
    expect(first.lat).toBeCloseTo(-35 + 0.06);
    expect(parsed.tracks[0].segments).toHaveLength(2);
    // SOBO: Hut B (NOBO km 40) is reached first, at active km 20.
    expect(parsed.waypoints[0].name).toBe('Hut B');
    expect(parsed.waypoints[0].desc).toContain('km 20.0');
  });

  it('follows an alternate the plan takes instead of the main route it bypasses', () => {
    const base = {
      ...trail(),
      alternates: [
        {
          name: 'High Route',
          type: 'alternate',
          // Five km out east of the main line between km 5 and km 10.
          points: Array.from({ length: 6 }, (_, i) => ({ lat: -35 + (5 + i) * 0.001, lon: 149.05, ele: 900 })),
          distance: 5,
          startDistance: 5,
          endDistance: 10,
          startTrackIndex: 5,
          endTrackIndex: 10,
        },
      ],
    };
    const stored = { ...plan(), alternates: ['High Route'] };
    const route = plannedRouteFor(base as unknown as PlannableTrail, stored);
    const routeTrail = plannedRouteTrail(base as unknown as PlannableTrail, route) as unknown as PlanTrail;
    const parsed = parseGpx(planToGpx(input(planToRoute(stored, route), routeTrail)));
    const lons = parsed.tracks[0].segments.flatMap(seg => seg.points.map(p => p.lon));
    expect(lons).toContain(149.05);
    // Still split at the break, wherever it now falls in route km.
    expect(parsed.tracks[0].segments).toHaveLength(2);
  });

  it('notes resupply zero days', () => {
    const gpx = planToGpx(input(plan(), trail(), { w_town: 1.5 }));
    expect(gpx).toContain('1.5 zero days');
  });
});

describe('planToIcs', () => {
  it('is null without a start date', () => {
    const data = input(plan());
    expect(canExportIcs(data)).toBe(false);
    expect(planToIcs({ ...data, dtstamp: DTSTAMP })).toBeNull();
  });

  it('writes an all-day event per walking day and per rest day', () => {
    const doc = setStartDate(plan(), '2026-12-30', opts);
    const ics = planToIcs({ ...input(doc), dtstamp: DTSTAMP })!;
    expect(ics).not.toBeNull();
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    // CRLF only.
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);

    const unfolded = ics.replace(/\r\n /g, '');
    const summaries = unfolded.split('\r\n').filter(l => l.startsWith('SUMMARY:'));
    expect(summaries).toEqual([
      'SUMMARY:Day 1: Trailhead → Hut <A>\\, 20.0 km',
      'SUMMARY:Day 2: Hut <A> → Hut B\\, 20.0 km',
      'SUMMARY:Rest day at Hut B',
      'SUMMARY:Rest day at Hut B',
      'SUMMARY:Day 3: Hut B → Summit\\, 20.0 km',
    ]);
    const starts = unfolded.split('\r\n').filter(l => l.startsWith('DTSTART'));
    // Across the new year; the two rest days push day 3 back.
    expect(starts).toEqual([
      'DTSTART;VALUE=DATE:20261230',
      'DTSTART;VALUE=DATE:20261231',
      'DTSTART;VALUE=DATE:20270101',
      'DTSTART;VALUE=DATE:20270102',
      'DTSTART;VALUE=DATE:20270103',
    ]);
    expect(unfolded).toContain('DTEND;VALUE=DATE:20261231');
    expect(unfolded).toContain('DTSTAMP:20261105T083000Z');
    expect(unfolded).toContain('Book & pay\\nat the store');
    expect(unfolded).toContain('X-WR-CALNAME:My "walk"\\; with\\, commas');
    // The town at km 40 is on day 2.
    expect(unfolded).toMatch(/Resupply at Townsville/);
  });

  it('keeps every line within 75 octets', () => {
    let doc = setStartDate(plan(), '2026-12-30', opts);
    doc = setStopNote(doc, { waypointId: 'w_hut_a', km: 20 }, 'Ünïcödé 😀 '.repeat(30), opts);
    const ics = planToIcs({ ...input(doc), dtstamp: DTSTAMP })!;
    for (const line of ics.split('\r\n')) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
    // Unfolding gives the note back whole.
    expect(ics.replace(/\r\n /g, '')).toContain('Ünïcödé 😀 '.repeat(30).trim());
  });

  it('derives stable UIDs from the plan and the day', () => {
    const doc = setStartDate(plan(), '2026-12-30', opts);
    const a = planToIcs({ ...input(doc), dtstamp: DTSTAMP })!;
    const b = planToIcs({ ...input(doc), dtstamp: '2027-01-01T00:00:00Z' })!;
    const uids = (ics: string) => ics.split('\r\n').filter(l => l.startsWith('UID:'));
    expect(uids(a)).toEqual(uids(b));
    expect(new Set(uids(a)).size).toBe(uids(a).length);
    expect(uids(a)[0]).toMatch(/^UID:plan-[a-z0-9]+-day-1@tracknotes\.info$/);
    const other = planToIcs({ ...input({ ...doc, id: 'plan-2' }), dtstamp: DTSTAMP })!;
    expect(uids(other)[0]).not.toBe(uids(a)[0]);
  });

  it('names resupply zero days the camp plan does not hold', () => {
    const doc = setStartDate(plan(), '2026-12-30', opts);
    const ics = planToIcs({ ...input(doc, trail(), { w_town: 4 }), dtstamp: DTSTAMP })!;
    const unfolded = ics.replace(/\r\n /g, '');
    expect(unfolded).toContain('4 zero days planned at Townsville\\, 2 nights of which are in these dates');
    // Two nights already cover them: nothing to say.
    const covered = planToIcs({ ...input(doc, trail(), { w_town: 2 }), dtstamp: DTSTAMP })!;
    expect(covered.replace(/\r\n /g, '')).not.toContain('zero days planned');
  });

  it('rejects a bad dtstamp', () => {
    const doc = setStartDate(plan(), '2026-12-30', opts);
    expect(() => planToIcs({ ...input(doc), dtstamp: 'nope' })).toThrow(RangeError);
  });
});

describe('helpers', () => {
  it('escapes TEXT', () => {
    expect(icsText('a\\b;c,d\r\ne\nf\u0001')).toBe('a\\\\b\\;c\\,d\\ne\\nf');
  });

  it('folds at 75 octets without splitting a character', () => {
    const line = `DESCRIPTION:${'é'.repeat(100)}`;
    const folded = foldIcsLine(line);
    const parts = folded.split('\r\n');
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75);
    expect(parts.slice(1).every(p => p.startsWith(' '))).toBe(true);
    expect(folded.replace(/\r\n /g, '')).toBe(line);
    expect(foldIcsLine('short')).toBe('short');
  });

  it('makes a file name', () => {
    expect(planExportFileName('Heysen Trail — Spring 2027!', 'gpx')).toBe('heysen-trail-spring-2027.gpx');
    expect(planExportFileName('Été', 'ics')).toBe('ete.ics');
    expect(planExportFileName('   ', 'ics')).toBe('tracknotes-plan.ics');
  });
});
