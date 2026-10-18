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
  ])('%s', (_, lat, lon, country, state) => {
    expect(regionAt(lat, lon)).toEqual({ country, state });
  });

  it('takes the nearest shape for a point just off a coarse coastline', () => {
    // Cape Leeuwin's lighthouse, at the tip of a coarse WA coastline.
    expect(regionAt(-34.375, 115.136)).toEqual({ country: 'AU', state: 'WA' });
  });

  it('finds nothing far out at sea, in an unlisted country, or in a hole', () => {
    expect(regionAt(-30, -140)).toBeNull();
    expect(regionAt(-12.05, -77.04)).toBeNull(); // Lima
    expect(regionAt(-29.6, 28.2)).toBeNull(); // Lesotho, a hole in South Africa
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
    expect(detectRegion(points)).toEqual({ country: 'AU', states: ['VIC', 'NSW'], state: 'NSW' });
  });

  it('ignores a state the route only strays into', () => {
    const points = [
      { lat: -35.28, lon: 149.13 }, // one point in the ACT
      ...Array.from({ length: 99 }, () => ({ lat: -33.8, lon: 150.9 })),
    ];
    expect(detectRegion(points).states).toEqual(['NSW']);
  });

  it('returns no region for no usable points', () => {
    const none = { country: null, states: [], state: null };
    expect(detectRegion([])).toEqual(none);
    expect(detectRegion([{ lat: -12.05, lon: -77.04 }])).toEqual(none);
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
    expect(checkCommunityRegion([{ lat: -12.05, lon: -77.04 }], 'PE', null).level).toBe('pass');
  });
});
