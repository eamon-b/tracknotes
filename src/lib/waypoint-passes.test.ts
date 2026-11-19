import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { firstPassIdOf, placeIdOf, resolveSyncedDescription, syncedDescriptionIds } from './waypoint-passes';

const ROOT = path.resolve(__dirname, '../..');

describe('firstPassIdOf', () => {
  it('reads the build’s suffix after a whole waypoint id', () => {
    expect(firstPassIdOf('w_07233ee1_2')).toBe('w_07233ee1');
    expect(firstPassIdOf('w_07233ee1_3')).toBe('w_07233ee1');
    expect(firstPassIdOf('w_07233ee1_12')).toBe('w_07233ee1');
    // An import's ids take the same suffix.
    expect(firstPassIdOf('uw_0a1b2c3d4e5f_2')).toBe('uw_0a1b2c3d4e5f');
  });

  it('leaves an id of its own alone, however it ends', () => {
    expect(firstPassIdOf('w_07233ee1')).toBeNull();
    // Hex that is all digits: not pass 176641 of `w`.
    expect(firstPassIdOf('w_00176641')).toBeNull();
    expect(firstPassIdOf('uw_0a1b2c3d4e5f')).toBeNull();
    // A pass of an all-digit id is still a pass.
    expect(firstPassIdOf('w_00176641_3')).toBe('w_00176641');
  });

  it('takes only a suffix the build writes: from 2, with no leading zero', () => {
    for (const id of [
      'w_07233ee1_1',
      'w_07233ee1_0',
      'w_07233ee1_02',
      'w_07233ee1_',
      'w_07233ee1_2_',
      'w_07233ee1_x',
    ]) {
      expect(firstPassIdOf(id)).toBeNull();
    }
  });

  it('reads no pass into ids that are not waypoints of a route', () => {
    for (const id of [
      'osm_node_12',
      'osm_way_123456',
      'hw_3f2b8c1e-7a4d-4e9b-9c1a-2b3c4d5e6f70',
      'new:0123456789',
      'c_abcdef_2',
      'W_07233EE1_2',
      '',
    ]) {
      expect(firstPassIdOf(id)).toBeNull();
    }
  });

  it('with the trail’s ids, also needs the first pass to be one of them', () => {
    const ids = new Set(['w_07233ee1', 'w_07233ee1_2', 'w_12345678', 'w_aaaa1111_2']);
    const known = (id: string) => ids.has(id);
    expect(firstPassIdOf('w_07233ee1_2', known)).toBe('w_07233ee1');
    expect(firstPassIdOf('w_12345678', known)).toBeNull();
    expect(firstPassIdOf('w_07233ee1', known)).toBeNull();
    // By form a pass, but the trail has no first pass for it.
    expect(firstPassIdOf('w_aaaa1111_2')).toBe('w_aaaa1111');
    expect(firstPassIdOf('w_aaaa1111_2', known)).toBeNull();
  });
});

describe('placeIdOf', () => {
  it('is the first pass’s id for a later pass, else the id itself', () => {
    expect(placeIdOf('w_07233ee1_2')).toBe('w_07233ee1');
    expect(placeIdOf('w_00176641')).toBe('w_00176641');
    expect(placeIdOf('w_00176641_3')).toBe('w_00176641');
    expect(placeIdOf('new:0123456789')).toBe('new:0123456789');
  });
});

describe('resolveSyncedDescription', () => {
  const FIRST = 'w_07233ee1';
  const LATER = 'w_07233ee1_2';
  const from = (rows: Record<string, string>) => (id: string) => rows[id];

  it('tries a waypoint’s own row, then its place’s first pass', () => {
    expect(syncedDescriptionIds(FIRST)).toEqual([FIRST]);
    expect(syncedDescriptionIds(LATER)).toEqual([LATER, FIRST]);
    expect(syncedDescriptionIds('osm_node_12')).toEqual(['osm_node_12']);
  });

  // Each combination of the later pass's own row and the first pass's:
  // absent, cleared ('') or text. `null` = the bundled text shows.
  it.each<[string, Record<string, string>, { waypointId: string; description: string } | null]>([
    ['no rows', {}, null],
    ['first pass only', { [FIRST]: 'Place.' }, { waypointId: FIRST, description: 'Place.' }],
    ['first pass cleared', { [FIRST]: '' }, null],
    ['own row only', { [LATER]: 'Own.' }, { waypointId: LATER, description: 'Own.' }],
    ['own row over the first pass', { [LATER]: 'Own.', [FIRST]: 'Place.' }, { waypointId: LATER, description: 'Own.' }],
    ['own row over a cleared first pass', { [LATER]: 'Own.', [FIRST]: '' }, { waypointId: LATER, description: 'Own.' }],
    ['own row cleared', { [LATER]: '' }, null],
    [
      'own row cleared: the first pass shows through',
      { [LATER]: '', [FIRST]: 'Place.' },
      { waypointId: FIRST, description: 'Place.' },
    ],
    ['both cleared', { [LATER]: '', [FIRST]: '' }, null],
  ])('a later pass with %s', (_label, rows, expected) => {
    expect(resolveSyncedDescription(LATER, from(rows))).toEqual(expected);
  });

  it('never gives a first pass, or an ordinary waypoint, another row’s text', () => {
    expect(resolveSyncedDescription(FIRST, from({ [LATER]: 'Own.' }))).toBeNull();
    expect(resolveSyncedDescription(FIRST, from({ [FIRST]: '', [LATER]: 'Own.' }))).toBeNull();
    expect(resolveSyncedDescription(FIRST, from({ [FIRST]: 'Place.' }))).toEqual({
      waypointId: FIRST,
      description: 'Place.',
    });
    expect(resolveSyncedDescription('w_00176641', from({ w: 'Not a place.' }))).toBeNull();
  });

  it('treats a null row as no row', () => {
    expect(resolveSyncedDescription(LATER, id => (id === FIRST ? 'Place.' : null))).toEqual({
      waypointId: FIRST,
      description: 'Place.',
    });
  });

  it('follows the first pass only where the trail has one, when given its ids', () => {
    const rows = from({ w_aaaa1111: 'Another waypoint.' });
    expect(resolveSyncedDescription('w_aaaa1111_2', rows)?.waypointId).toBe('w_aaaa1111');
    expect(resolveSyncedDescription('w_aaaa1111_2', rows, () => false)).toBeNull();
  });
});

describe('the committed waypoint ids', () => {
  const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/waypoint-ids.json'), 'utf8')) as Record<
    string,
    { id: string }[]
  >;

  it('holds first-pass ids only: none reads as a later pass', () => {
    const ids = Object.values(registry).flatMap(entries => entries.map(e => e.id));
    expect(ids.length).toBeGreaterThan(2000);
    expect(ids.filter(id => firstPassIdOf(id) !== null)).toEqual([]);
  });

  it('lists the first pass of every place trail.json says a route revisits', () => {
    // Three Passes walks back out the way it came in: its later passes are
    // `<id>_2` of registry ids, so each resolves to an id the registry has.
    const known = new Set(registry.three_passes.map(e => e.id));
    expect(firstPassIdOf('w_07233ee1_2', id => known.has(id))).toBe('w_07233ee1');
  });
});
