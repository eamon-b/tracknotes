import { describe, expect, it } from 'vitest';
import { describeChanges, diffFile, diffSnapshots, formatReport, layoutOf, normalizeForCompare } from './data-diff.js';

const pretty = (value: unknown) => JSON.stringify(value, null, 2);

const trail = {
  config: { id: 'demo', name: 'Demo', lengthKm: 10 },
  track: { points: [{ lat: 0, lon: 0 }], totalDistance: 10 },
  waypoints: [
    { id: 'w_1', name: 'Hut', type: 'hut' },
    { id: 'w_2', name: 'Tank', type: 'water-tank' },
  ],
  dataUpdatedAt: '2026-11-01T00:00:00.000Z',
};

describe('normalizeForCompare', () => {
  it('drops dataUpdatedAt from a generated trail file only', () => {
    expect(normalizeForCompare('generated/demo.json', pretty(trail))).not.toHaveProperty('dataUpdatedAt');
    expect(normalizeForCompare('mobile/demo.json', JSON.stringify(trail))).toHaveProperty('dataUpdatedAt');
  });

  it("drops each app index entry's clock but keeps its md5", () => {
    const index = [
      { id: 'demo', md5: 'a'.repeat(32), bytes: 10, updatedAt: '2026-11-01T00:00:00Z', dataVersion: '2026-11-01' },
    ];
    expect(normalizeForCompare('mobile/index.json', pretty(index))).toEqual([
      { id: 'demo', md5: 'a'.repeat(32), bytes: 10 },
    ]);
  });

  it('leaves non-JSON files to a byte comparison', () => {
    expect(normalizeForCompare('pages/demo/index.html', '<html>')).toBeUndefined();
  });
});

describe('diffFile', () => {
  it('passes a trail whose only difference is the build time', () => {
    const rebuilt = { ...trail, dataUpdatedAt: '2026-11-11T09:00:00.000Z' };
    expect(diffFile('generated/demo.json', pretty(trail), pretty(rebuilt))).toBeNull();
  });

  it('does not ignore dataUpdatedAt outside the generated trail files', () => {
    const rebuilt = { ...trail, dataUpdatedAt: '2026-11-11T09:00:00.000Z' };
    expect(diffFile('mobile/demo.json', JSON.stringify(trail), JSON.stringify(rebuilt))?.status).toBe('changed');
  });

  it('reports a change of layout even when the values are the same', () => {
    expect(diffFile('generated/demo.json', pretty(trail), JSON.stringify(trail))).toEqual({
      path: 'generated/demo.json',
      status: 'changed',
      changes: ['formatting only (same values, different bytes)'],
    });
  });

  it('reports a reordered key, since the rule is byte-identical output', () => {
    const { config, ...rest } = trail;
    const diff = diffFile('generated/demo.json', pretty(trail), pretty({ ...rest, config }));
    expect(diff).toEqual({ path: 'generated/demo.json', status: 'changed', changes: ['(root): keys reordered'] });
  });

  it('names the keys that changed and how arrays moved', () => {
    const rebuilt = {
      ...trail,
      config: { ...trail.config, lengthKm: 10.4 },
      track: { ...trail.track, points: [...trail.track.points, { lat: 1, lon: 1 }] },
      waypoints: [
        { id: 'w_1', name: 'Hut (renamed)', type: 'hut' },
        { id: 'w_3', name: 'Creek', type: 'water' },
      ],
    };
    expect(diffFile('generated/demo.json', pretty(trail), pretty(rebuilt))).toEqual({
      path: 'generated/demo.json',
      status: 'changed',
      changes: [
        'config.lengthKm: 10 → 10.4',
        'track.points: 1 → 2 items',
        'waypoints: 2 → 2 items, +1 (w_3), -1 (w_2), 1 changed',
      ],
    });
  });

  it('compares non-JSON files as bytes', () => {
    expect(diffFile('pages/demo/index.html', '<p>a</p>', '<p>ab</p>')?.status).toBe('changed');
  });
});

describe('describeChanges', () => {
  it('summarises a waypoint-id registry change per trail', () => {
    const before = { demo: [{ id: 'w_1' }, { id: 'w_2' }] };
    const after = { demo: [{ id: 'w_1' }, { id: 'w_2', retired: true }, { id: 'w_9' }] };
    expect(describeChanges(before, after)).toEqual(['demo: 2 → 3 items, +1 (w_9), 1 changed']);
  });

  it('stops at the given depth', () => {
    expect(describeChanges({ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } }, 1)).toEqual(['a: changed']);
  });

  it('reports added and removed keys', () => {
    expect(describeChanges({ a: 1 }, { b: 1 })).toEqual(['a: removed', 'b: added']);
  });

  it('counts changed items in arrays without ids', () => {
    expect(describeChanges({ p: [1, 2, 3] }, { p: [1, 5, 3] })).toEqual(['p: 1 of 3 items changed']);
  });
});

describe('layoutOf', () => {
  it('tells pretty, compact and newline-terminated JSON apart', () => {
    expect(layoutOf(pretty({ a: 1 }))).toBe('indent 2');
    expect(layoutOf(JSON.stringify({ a: 1 }))).toBe('indent 0');
    expect(layoutOf(`${pretty({ a: 1 })}\n`)).toBe('indent 2, newline');
    expect(layoutOf('{ "a":1 }')).toBeUndefined();
  });
});

describe('diffSnapshots', () => {
  it('lists added, removed and changed files in path order, and nothing for identical ones', () => {
    const before = new Map([
      ['generated/a.json', pretty({ x: 1 })],
      ['generated/gone.json', pretty({})],
      ['waypoint-ids.json', pretty({ a: [] })],
    ]);
    const after = new Map([
      ['generated/a.json', pretty({ x: 2 })],
      ['generated/new.json', pretty({})],
      ['waypoint-ids.json', pretty({ a: [] })],
    ]);
    const diffs = diffSnapshots(before, after);
    expect(diffs).toEqual([
      { path: 'generated/a.json', status: 'changed', changes: ['x: 1 → 2'] },
      { path: 'generated/gone.json', status: 'removed' },
      { path: 'generated/new.json', status: 'added' },
    ]);
    expect(formatReport(diffs)).toBe(
      '  generated/a.json\n      x: 1 → 2\n  generated/gone.json (removed)\n  generated/new.json (added)'
    );
  });

  it('finds no difference between a snapshot and itself', () => {
    const files = new Map([['generated/demo.json', pretty(trail)]]);
    expect(diffSnapshots(files, new Map(files))).toEqual([]);
  });
});
