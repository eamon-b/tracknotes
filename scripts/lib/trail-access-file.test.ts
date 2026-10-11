import { describe, it, expect } from 'vitest';
import {
  accessPlacements,
  mergeTrailAccess,
  parseTrailAccessFile,
  stringifyTrailAccessFile,
  type TrailAccessFile,
} from './trail-access-file';

const FILE: TrailAccessFile = {
  source: 's',
  attribution: 'a',
  fetchedAt: '2026-10-11T00:00:00.000Z',
  endpoint: 'e',
  minDistanceM: 150,
  places: {
    w_b: { name: 'Camp', method: 'osm', junction: [33.93, 134.519], junctionKm: 111.89, offTrailKm: 2.82, path: [[33.93, 134.519], [33.92, 134.5]] },
    w_a: { name: 'Hut', method: 'none', reason: 'no mapped way within 300 m of the place' },
    w_c: { name: 'Inn', method: 'manual', junction: [34, 134], offTrailKm: 0.4 },
  },
};

describe('trail access file', () => {
  it('round-trips, sorted by id, with each coordinate pair on one line', () => {
    const text = stringifyTrailAccessFile(FILE);
    expect(Object.keys(parseTrailAccessFile(text, 'access.json').places)).toEqual(['w_a', 'w_b', 'w_c']);
    expect(text).toContain('"junction": [33.93, 134.519]');
    expect(text).toContain('[33.92, 134.5]');
    expect(parseTrailAccessFile(text, 'access.json')).toEqual(FILE);
  });

  it('places only the entries that found a junction', () => {
    const placements = accessPlacements(FILE);
    expect([...placements.keys()].sort()).toEqual(['w_b', 'w_c']);
    expect(placements.get('w_b')).toEqual({ junction: { lat: 33.93, lon: 134.519 }, offTrailKm: 2.82 });
    expect(accessPlacements(null).size).toBe(0);
  });

  it('refuses an entry that cannot be placed', () => {
    const bad = { ...FILE, places: { w_x: { name: 'X', method: 'osm', offTrailKm: 1 } } };
    expect(() => parseTrailAccessFile(JSON.stringify(bad), 'access.json')).toThrow(
      'access.json: places["w_x"].junction must be [lat, lon]'
    );
    const none = { ...FILE, places: { w_x: { name: 'X', method: 'none' } } };
    expect(() => parseTrailAccessFile(JSON.stringify(none), 'f')).toThrow(/needs a "reason"/);
  });

  it('keeps manual entries and the previous entry of a failed query', () => {
    const fresh = { w_b: { ...FILE.places.w_b, offTrailKm: 3 } };
    const merged = mergeTrailAccess(FILE, fresh, new Set(['w_a']));
    expect(merged.w_b.offTrailKm).toBe(3);
    expect(merged.w_a).toBe(FILE.places.w_a);
    expect(merged.w_c).toBe(FILE.places.w_c);
    expect(Object.keys(mergeTrailAccess(FILE, fresh, new Set()))).toEqual(['w_b', 'w_c']);
  });
});
