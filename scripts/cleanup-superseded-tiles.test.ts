import { describe, it, expect } from 'vitest';
import { packPrefixes, planCleanup, referencedNames, type BucketObject } from './cleanup-superseded-tiles';

const NOW = Date.parse('2026-11-01T00:00:00Z');
const OLD = '2026-09-23T00:00:00Z';
const RECENT = '2026-10-30T00:00:00Z';

const obj = (p: string, modTime = OLD, size = 1000): BucketObject => ({ path: p, size, modTime });

const manifest = (...files: Array<{ name: string; key?: string }>) => ({
  trailId: 't',
  version: '2026-11-01',
  files: files.map(f => ({ ...f, size: 1000, sha256: 'x' })),
});

describe('packPrefixes', () => {
  it('finds trail and grid prefixes with a manifest, and nothing else', () => {
    expect(packPrefixes([
      obj('larapinta/manifest.json'),
      obj('larapinta/base.aaaa.mbtiles'),
      obj('grid/E114_S34/manifest.json'),
      obj('grid/index.json'),
      obj('manifest.json'),
      obj('trails/v1/catalog.json'),
      obj('contours/world.pmtiles'),
      obj('nomanifest/base.mbtiles'),
    ])).toEqual(['grid/E114_S34/', 'larapinta/']);
  });
});

describe('referencedNames', () => {
  it('takes the content-addressed key, else the legacy name', () => {
    expect([...referencedNames(manifest({ name: 'base.mbtiles', key: 'base.aaaa.mbtiles' }, { name: 'contours.mbtiles' }))])
      .toEqual(['base.aaaa.mbtiles', 'contours.mbtiles']);
  });

  it('refuses something that is not a manifest', () => {
    expect(() => referencedNames({})).toThrow(/no files/);
    expect(() => referencedNames({ files: [{ name: '../x' }] })).toThrow(/invalid/);
  });
});

describe('planCleanup', () => {
  const objects = [
    obj('larapinta/manifest.json'),
    obj('larapinta/base.new1.mbtiles'),
    obj('larapinta/contours.new2.mbtiles'),
    obj('larapinta/base.old1.mbtiles'),
    obj('larapinta/contours.old2.mbtiles', RECENT),
    obj('larapinta/notes.txt'),
    obj('larapinta/sub/base.old3.mbtiles'),
    obj('larapinta2/base.orphan.mbtiles'),
    obj('cdt/manifest.json'),
    obj('cdt/base.old.mbtiles'),
    obj('contours/australia.pmtiles'),
  ];

  it('deletes unreferenced old pack files and keeps everything else', () => {
    const manifests = new Map<string, unknown>([
      ['larapinta/', manifest({ name: 'base.mbtiles', key: 'base.new1.mbtiles' }, { name: 'contours.mbtiles', key: 'contours.new2.mbtiles' })],
      ['cdt/', new Error('rclone cat failed')],
    ]);
    const plan = planCleanup(objects, manifests, { now: NOW, graceDays: 7 });
    expect(plan.delete.map(o => o.path)).toEqual(['larapinta/base.old1.mbtiles']);
    expect(plan.keptRecent.map(o => o.path)).toEqual(['larapinta/contours.old2.mbtiles']);
    expect(plan.prefixes).toEqual(['larapinta/']);
    // A manifest that cannot be read protects its whole prefix.
    expect(plan.skipped).toEqual([{ prefix: 'cdt/', reason: 'rclone cat failed' }]);
  });

  it('a grace of 0 days deletes recent superseded files too', () => {
    const manifests = new Map<string, unknown>([
      ['larapinta/', manifest({ name: 'base.mbtiles', key: 'base.new1.mbtiles' }, { name: 'contours.mbtiles', key: 'contours.new2.mbtiles' })],
      ['cdt/', manifest({ name: 'base.mbtiles' })],
    ]);
    const plan = planCleanup(objects, manifests, { now: NOW, graceDays: 0 });
    expect(plan.delete.map(o => o.path)).toEqual([
      'cdt/base.old.mbtiles',
      'larapinta/base.old1.mbtiles',
      'larapinta/contours.old2.mbtiles',
    ]);
  });
});
