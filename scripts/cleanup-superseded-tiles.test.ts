import { describe, it, expect } from 'vitest';
import {
  packPrefixes,
  listedTrailKeys,
  planCleanup,
  planTrailDataCleanup,
  planWorldBuildCleanup,
  referencedNames,
  type BucketObject,
} from './cleanup-superseded-tiles';

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
  it('finds trail prefixes with a manifest, and nothing else', () => {
    expect(
      packPrefixes([
        obj('larapinta/manifest.json'),
        obj('larapinta/base.aaaa.mbtiles'),
        obj('grid/E114_S34/manifest.json'),
        obj('grid/index.json'),
        obj('manifest.json'),
        obj('trails/v1/catalog.json'),
        obj('contours/world.pmtiles'),
        obj('nomanifest/base.mbtiles'),
      ])
    ).toEqual(['larapinta/']);
  });
});

describe('referencedNames', () => {
  it('takes the content-addressed key and the plain name old app builds download', () => {
    expect([
      ...referencedNames(manifest({ name: 'base.mbtiles', key: 'base.aaaa.mbtiles' }, { name: 'contours.mbtiles' })),
    ]).toEqual(['base.mbtiles', 'base.aaaa.mbtiles', 'contours.mbtiles']);
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
    obj('larapinta/base.mbtiles'),
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
      [
        'larapinta/',
        manifest(
          { name: 'base.mbtiles', key: 'base.new1.mbtiles' },
          { name: 'contours.mbtiles', key: 'contours.new2.mbtiles' }
        ),
      ],
      ['cdt/', new Error('rclone cat failed')],
    ]);
    const plan = planCleanup(objects, manifests, { now: NOW, graceDays: 7 });
    expect(plan.delete.map(o => o.path)).toEqual(['larapinta/base.old1.mbtiles']);
    expect(plan.keptRecent.map(o => o.path)).toEqual(['larapinta/contours.old2.mbtiles']);
    expect(plan.prefixes).toEqual(['larapinta/']);
    // A manifest that cannot be read protects its whole prefix.
    expect(plan.skipped).toEqual([{ prefix: 'cdt/', reason: 'rclone cat failed' }]);
  });

  it('leaves a prefix alone until its manifest has been live for the grace', () => {
    const manifests = new Map<string, unknown>([
      [
        'larapinta/',
        manifest(
          { name: 'base.mbtiles', key: 'base.new1.mbtiles' },
          { name: 'contours.mbtiles', key: 'contours.new2.mbtiles' }
        ),
      ],
      ['cdt/', manifest({ name: 'base.mbtiles' })],
    ]);
    // cdt's base.old.mbtiles is a month old, but the manifest that dropped it
    // went up two days ago: phones may still be downloading it.
    const fresh = objects.map(o => (o.path === 'cdt/manifest.json' ? { ...o, modTime: RECENT } : o));
    const plan = planCleanup(fresh, manifests, { now: NOW, graceDays: 7 });
    expect(plan.delete.map(o => o.path)).toEqual(['larapinta/base.old1.mbtiles']);
    expect(plan.skipped).toEqual([{ prefix: 'cdt/', reason: 'manifest published 2026-10-30, inside the 7-day grace' }]);
  });

  it('a grace of 0 days deletes recent superseded files too', () => {
    const manifests = new Map<string, unknown>([
      [
        'larapinta/',
        manifest(
          { name: 'base.mbtiles', key: 'base.new1.mbtiles' },
          { name: 'contours.mbtiles', key: 'contours.new2.mbtiles' }
        ),
      ],
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

describe('planWorldBuildCleanup', () => {
  const build = [
    obj('contours/world-build/batches/oceania/batch-00.mbtiles', '2026-10-01T00:00:00Z'),
    obj('contours/world-build/shards/world_oceania.mbtiles', '2026-10-03T00:00:00Z'),
  ];
  const opts = { now: NOW, graceDays: 7 };

  it('deletes the insurance copies once the archive is newer than all of them', () => {
    const plan = planWorldBuildCleanup(build, obj('contours/world.pmtiles', '2026-10-05T00:00:00Z'), opts);
    expect(plan.refused).toBeUndefined();
    expect(plan.delete.map(o => o.path)).toEqual(build.map(o => o.path));
  });

  it('refuses without the archive, or while the build is newer than it', () => {
    expect(planWorldBuildCleanup(build, null, opts).refused).toMatch(/not in the bucket/);
    const running = planWorldBuildCleanup(build, obj('contours/world.pmtiles', '2026-10-02T00:00:00Z'), opts);
    expect(running.refused).toMatch(/1 object\(s\).*world_oceania/);
    expect(running.delete).toEqual([]);
  });

  it('keeps what is younger than the grace', () => {
    const recent = [...build, obj('contours/world-build/shards/world_asia.mbtiles', RECENT)];
    const plan = planWorldBuildCleanup(recent, obj('contours/world.pmtiles', '2026-10-31T00:00:00Z'), opts);
    expect(plan.keptRecent.map(o => o.path)).toEqual(['contours/world-build/shards/world_asia.mbtiles']);
    expect(plan.delete).toHaveLength(2);
  });
});

describe('planTrailDataCleanup', () => {
  const opts = { now: NOW, graceDays: 7 };
  const catalog = {
    format: 1,
    trails: [
      { id: 'heysen', key: 'heysen.aaaaaaaaaaaa.json' },
      { id: 'overland', key: 'overland.bbbbbbbbbbbb.json' },
    ],
  };
  const objects = [
    obj('trails/v1/catalog.json', '2026-10-10T00:00:00Z'),
    obj('trails/v1/heysen.aaaaaaaaaaaa.json'),
    obj('trails/v1/overland.bbbbbbbbbbbb.json'),
    obj('trails/v1/heysen.111111111111.json'),
    obj('trails/v1/overland.222222222222.json', RECENT),
    obj('trails/v1/notes.txt'),
    obj('trails/v1/old/heysen.333333333333.json'),
  ];

  it('deletes unlisted trail files once the catalog is past the grace, keeping recent ones', () => {
    const plan = planTrailDataCleanup(objects, catalog, opts);
    expect(plan.refused).toBeUndefined();
    expect(plan.waiting).toBeUndefined();
    expect(plan.delete.map(o => o.path)).toEqual(['trails/v1/heysen.111111111111.json']);
    expect(plan.keptRecent.map(o => o.path)).toEqual(['trails/v1/overland.222222222222.json']);
  });

  it('waits while the catalog is inside the grace', () => {
    const young = objects.map(o => (o.path === 'trails/v1/catalog.json' ? { ...o, modTime: RECENT } : o));
    const plan = planTrailDataCleanup(young, catalog, opts);
    expect(plan.waiting).toMatch(/inside the 7-day grace/);
    expect(plan.delete).toEqual([]);
  });

  it('refuses a catalog it cannot trust', () => {
    expect(planTrailDataCleanup(objects, new Error('404'), opts).refused).toMatch(/cannot read/);
    expect(planTrailDataCleanup(objects, { trails: [] }, opts).refused).toMatch(/lists no trails/);
    expect(planTrailDataCleanup(objects, { trails: [{ id: 'x', key: '../x.json' }] }, opts).refused).toMatch(
      /without a valid key/
    );
  });
});

describe('listedTrailKeys', () => {
  it('lists the catalog keys, or says why the catalog cannot be trusted', () => {
    expect(listedTrailKeys({ trails: [{ key: 'heysen.aaaaaaaaaaaa.json' }] })).toEqual(
      new Set(['heysen.aaaaaaaaaaaa.json'])
    );
    expect(listedTrailKeys(new Error('404'))).toMatch(/cannot read/);
    expect(listedTrailKeys({ trails: [{ key: 'x' }] })).toMatch(/without a valid key/);
  });
});
