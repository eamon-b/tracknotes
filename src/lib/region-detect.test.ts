import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectRegion, regionAt } from './region-detect';
import { REGION_SHAPES } from './region-shapes';
import { COUNTRIES } from './trail-regions';
import { checkCommunityRegion } from './community-checks';

const TRAILS_DIR = join(__dirname, '..', '..', 'mobile', 'assets', 'trails');

interface IndexEntry {
  id: string;
  country: string;
  states: string[];
}

function loadIndex(): IndexEntry[] {
  const raw = JSON.parse(readFileSync(join(TRAILS_DIR, 'index.json'), 'utf8')) as
    | IndexEntry[]
    | { trails: IndexEntry[] };
  return Array.isArray(raw) ? raw : raw.trails;
}

function trailPoints(id: string): { lat: number; lon: number }[] {
  return (JSON.parse(readFileSync(join(TRAILS_DIR, `${id}.json`), 'utf8')) as {
    track: { points: { lat: number; lon: number }[] };
  }).track.points;
}

describe('region shapes', () => {
  it('cover every listed country and state', () => {
    for (const country of COUNTRIES) {
      if (country.states.length === 0) {
        expect(REGION_SHAPES.some((s) => s.country === country.code && s.state === null), country.code).toBe(true);
      }
      for (const state of country.states) {
        expect(
          REGION_SHAPES.some((s) => s.country === country.code && s.state === state.code),
          `${country.code} ${state.code}`
        ).toBe(true);
      }
    }
  });
});

describe('regionAt', () => {
  it.each([
    ['Melbourne', -37.81, 144.96, 'AU', 'VIC'],
    ['Canberra', -35.28, 149.13, 'AU', 'ACT'],
    ['Goulburn', -34.75, 149.72, 'AU', 'NSW'],
    ['Hobart', -42.88, 147.33, 'AU', 'TAS'],
    ['Alice Springs', -23.7, 133.88, 'AU', 'NT'],
    ['Cairns', -16.92, 145.77, 'AU', 'QLD'],
    ['Adelaide', -34.93, 138.6, 'AU', 'SA'],
    ['Albany', -35.02, 117.88, 'AU', 'WA'],
    ['Wellington', -41.29, 174.78, 'NZ', 'NI'],
    ['Christchurch', -43.53, 172.64, 'NZ', 'SI'],
    ['Oban, Stewart Island', -46.9, 168.13, 'NZ', 'STI'],
    ['Kyoto', 35.01, 135.77, 'JP', null],
    ['Zermatt', 46.02, 7.75, 'CH', null],
    ['Chamonix', 45.92, 6.87, 'FR', null],
    ['Courmayeur', 45.79, 6.97, 'IT', null],
    ['Kathmandu', 27.72, 85.32, 'NP', null],
    ['Denver', 39.74, -104.99, 'US', null],
    ['Banff', 51.18, -115.57, 'CA', null],
    ['Fort William', 56.82, -5.11, 'GB', null],
    ['Santiago de Compostela', 42.88, -8.54, 'ES', null],
    ['Torres del Paine', -50.94, -73.41, 'CL', null],
    ['El Chaltén', -49.33, -72.89, 'AR', null],
    ['Cape Town', -33.92, 18.42, 'ZA', null],
    // Islands smaller than the Arctic ones that are dropped.
    ['Kalalau, Kauai', 22.17, -159.63, 'US', null],
    ['Diamond Head, Oahu', 21.26, -157.8, 'US', null],
    ['Haleakalā, Maui', 20.72, -156.17, 'US', null],
    ['Reine, Lofoten', 67.93, 13.09, 'NO', null],
    // Both sides of a border, simplified once for both neighbours.
    ['Glacier National Park', 48.99, -114.0, 'US', null],
    ['Waterton', 49.05, -113.91, 'CA', null],
    ['Moama', -36.11, 144.76, 'AU', 'NSW'],
    ['Echuca', -36.13, 144.75, 'AU', 'VIC'],
    ['Albury', -36.08, 146.92, 'AU', 'NSW'],
    ['Wodonga', -36.12, 146.89, 'AU', 'VIC'],
    // Unlisted countries bordering a listed one are themselves.
    ['Andorra la Vella', 42.55, 1.6, 'AD', null],
    ['Vaduz', 47.14, 9.55, 'LI', null],
    ['Sani Top, Lesotho', -29.58, 29.28, 'LS', null],
    ['Maseru, a hole in South Africa', -29.31, 27.48, 'LS', null],
    ['Tijuana', 32.45, -116.95, 'MX', null],
    ['Lima', -12.05, -77.04, 'PE', null],
  ])('%s', (_, lat, lon, country, state) => {
    expect(regionAt(lat, lon)).toEqual({ country, state });
  });

  it('takes the nearest shape for a point just off a coarse coastline', () => {
    // Cape Leeuwin's lighthouse, at the tip of a coarse WA coastline.
    expect(regionAt(-34.375, 115.136)).toEqual({ country: 'AU', state: 'WA' });
  });

  it('finds nothing far out at sea or in an unlisted country with no listed neighbour', () => {
    expect(regionAt(-30, -140)).toBeNull();
    expect(regionAt(-1.29, 36.82)).toBeNull(); // Nairobi
    expect(regionAt(Number.NaN, 0)).toBeNull();
  });
});

describe('detectRegion', () => {
  it.each(loadIndex().map((t) => [t.id, t] as const))(
    'matches the curated region of %s',
    (id, entry) => {
      const detected = detectRegion(trailPoints(id));
      expect(detected.country).toBe(entry.country);
      expect(detected.states).toEqual(entry.states);
      expect(detected.state === null ? [] : [detected.state]).toEqual(
        entry.states.length === 0 ? [] : [expect.toBeOneOf(entry.states)]
      );
    }
  );

  it('prefills the state most of the route is in', () => {
    // 10 points in VIC, then 30 in NSW.
    const points = [
      ...Array.from({ length: 10 }, (_, i) => ({ lat: -37.8, lon: 144.9 + i * 0.01 })),
      ...Array.from({ length: 30 }, (_, i) => ({ lat: -33.8, lon: 150.9 + i * 0.001 })),
    ];
    expect(detectRegion(points)).toMatchObject({ country: 'AU', states: ['VIC', 'NSW'], state: 'NSW' });
  });

  it('lists only the states a route spends some time in, but has seen every one', () => {
    const points = [
      { lat: -35.28, lon: 149.13 }, // one point in the ACT
      ...Array.from({ length: 99 }, () => ({ lat: -33.8, lon: 150.9 })),
    ];
    const detected = detectRegion(points);
    expect(detected.states).toEqual(['NSW']);
    expect(detected.seen).toEqual({ countries: ['AU'], states: ['AU:ACT', 'AU:NSW'] });
  });

  it('is quick on a long route beside a large many-ringed country', () => {
    // 5,000 points through Mexico, inside the US's Aleutian-wide box.
    const points = Array.from({ length: 5000 }, (_, i) => ({ lat: 19 + i * 0.001, lon: -99 + i * 0.001 }));
    detectRegion(points); // warm-up: decodes the shapes
    const start = performance.now();
    expect(detectRegion(points).country).toBe('MX');
    expect(performance.now() - start).toBeLessThan(50);
  });

  it('returns no region for no usable points', () => {
    const none = { country: null, states: [], state: null, seen: { countries: [], states: [] } };
    expect(detectRegion([])).toEqual(none);
    expect(detectRegion([{ lat: -1.29, lon: 36.82 }])).toEqual(none);
    expect(detectRegion(null as unknown as [])).toEqual(none);
    expect(detectRegion([{ lat: 'x', lon: 1 } as unknown as { lat: number; lon: number }])).toEqual(none);
  });
});

describe('checkCommunityRegion', () => {
  const sydney = Array.from({ length: 5 }, (_, i) => ({ lat: -33.8 - i * 0.01, lon: 150.9 }));

  it('passes when the chosen region matches', () => {
    expect(checkCommunityRegion(sydney, 'AU', 'NSW').level).toBe('pass');
    expect(checkCommunityRegion(sydney, 'au', null).level).toBe('pass');
  });

  it('warns, never fails, when the country or state disagrees', () => {
    const country = checkCommunityRegion(sydney, 'NZ', null);
    expect(country).toMatchObject({ id: 'region', level: 'warn' });
    expect(country.message).toContain('Australia');
    expect(country.message).toContain('New Zealand');
    const state = checkCommunityRegion(sydney, 'AU', 'VIC');
    expect(state.level).toBe('warn');
    expect(state.message).toContain('New South Wales');
    expect(state.message).toContain('Victoria');
  });

  it('passes when the route is outside every known region', () => {
    expect(checkCommunityRegion([{ lat: -1.29, lon: 36.82 }], 'KE', null).level).toBe('pass');
  });

  it('never contradicts a state a short real stretch of the route is in', () => {
    // Mostly NSW, with a stretch in the ACT too short to be listed.
    const points = [
      ...Array.from({ length: 3 }, () => ({ lat: -35.28, lon: 149.13 })),
      ...Array.from({ length: 253 }, () => ({ lat: -33.8, lon: 150.9 })),
    ];
    expect(checkCommunityRegion(points, 'AU', 'ACT').level).toBe('pass');
    expect(checkCommunityRegion(points, 'AU', 'VIC').level).toBe('warn');
  });

  it('never contradicts the right unlisted country, nor the smaller side of a border', () => {
    const lesotho = [{ lat: -29.58, lon: 29.28 }];
    expect(checkCommunityRegion(lesotho, 'LS', null).level).toBe('pass');
    expect(checkCommunityRegion(lesotho, 'ZA', null).level).toBe('warn');
    // Glacier to Waterton: mostly in the US, filed under Canada.
    const crossing = [
      ...Array.from({ length: 8 }, (_, i) => ({ lat: 48.7 + i * 0.03, lon: -113.95 })),
      { lat: 49.05, lon: -113.91 },
    ];
    expect(checkCommunityRegion(crossing, 'CA', null).level).toBe('pass');
  });
});
