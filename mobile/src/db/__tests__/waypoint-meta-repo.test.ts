import { createMigratedTestDb, expectDbRejection } from './test-helpers';
import type { SqlDatabase } from '../sql-database';
import * as metaRepo from '../waypoint-meta-repo';

async function db(): Promise<SqlDatabase> {
  return (await createMigratedTestDb()) as unknown as SqlDatabase;
}

describe('waypoint-meta-repo', () => {
  it('upserts and reads descriptions per trail', async () => {
    const d = await db();
    await metaRepo.upsertDescriptions(d, 'aawt', [
      { waypointId: 'w_1', description: 'Tank on the west side.', updatedAt: 'T1' },
      { waypointId: 'w_2', description: 'Locked hut.', updatedAt: 'T1' },
    ]);
    await metaRepo.upsertDescriptions(d, 'larapinta', [
      { waypointId: 'w_1', description: 'Different trail.', updatedAt: 'T1' },
    ]);

    expect(await metaRepo.getDescription(d, 'aawt', 'w_1')).toBe('Tank on the west side.');
    expect(await metaRepo.getDescription(d, 'aawt', 'w_2')).toBe('Locked hut.');
    expect(await metaRepo.getDescription(d, 'larapinta', 'w_1')).toBe('Different trail.');
  });

  it('overwrites an existing row on conflict', async () => {
    const d = await db();
    await metaRepo.upsertDescriptions(d, 'aawt', [
      { waypointId: 'w_1', description: 'old', updatedAt: 'T1' },
    ]);
    await metaRepo.upsertDescriptions(d, 'aawt', [
      { waypointId: 'w_1', description: 'new', updatedAt: 'T2' },
    ]);
    expect(await metaRepo.getDescription(d, 'aawt', 'w_1')).toBe('new');
    const row = await d.getFirstAsync<{ updated_at: string; n: number }>(
      "SELECT updated_at, (SELECT COUNT(*) FROM waypoint_meta) AS n FROM waypoint_meta WHERE waypoint_id = 'w_1'",
    );
    expect(row?.updated_at).toBe('T2');
    expect(row?.n).toBe(1);
  });

  it('stores a cleared row but hides it from readers', async () => {
    const d = await db();
    await metaRepo.upsertDescriptions(d, 'aawt', [
      { waypointId: 'w_1', description: 'Tank is here.', updatedAt: 'T1' },
    ]);
    await metaRepo.upsertDescriptions(d, 'aawt', [
      { waypointId: 'w_1', description: '', updatedAt: 'T2' },
    ]);

    expect(await metaRepo.getDescription(d, 'aawt', 'w_1')).toBeNull();
    // The row itself survives, so a later re-fill upserts onto the same key.
    const row = await d.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM waypoint_meta');
    expect(row?.n).toBe(1);
  });

  it('writes a batch atomically: a failing row rolls the whole batch back', async () => {
    const d = await db();
    await expectDbRejection(() =>
      metaRepo.upsertDescriptions(d, 'aawt', [
        { waypointId: 'w_1', description: 'first', updatedAt: 'T1' },
        // NOT NULL violation on the second row.
        { waypointId: 'w_2', description: null as unknown as string, updatedAt: 'T1' },
      ]),
    );
    expect(await metaRepo.getDescription(d, 'aawt', 'w_1')).toBeNull();
  });

  it('returns null for an unknown waypoint', async () => {
    const d = await db();
    expect(await metaRepo.getDescription(d, 'aawt', 'nope')).toBeNull();
  });

  describe('a later pass of a revisited place (<id>_2)', () => {
    const FIRST = 'w_07233ee1';
    const LATER = 'w_07233ee1_2';
    const ABSENT = undefined;

    // Every combination of the later pass's own row and the first pass's:
    // absent, cleared ('') or text. `null` means the screen shows the bundled text.
    it.each<[string | undefined, string | undefined, string | null]>([
      [ABSENT, ABSENT, null],
      [ABSENT, 'Place.', 'Place.'],
      [ABSENT, '', null],
      ['Own.', ABSENT, 'Own.'],
      ['Own.', 'Place.', 'Own.'],
      ['Own.', '', 'Own.'],
      ['', ABSENT, null],
      // A cleared row holds no text: it does not hide the first pass.
      ['', 'Place.', 'Place.'],
      ['', '', null],
    ])('own row %j, first-pass row %j: shows %j', async (own, first, shown) => {
      const d = await db();
      const rows = [
        ...(own === ABSENT ? [] : [{ waypointId: LATER, description: own, updatedAt: 'T1' }]),
        ...(first === ABSENT ? [] : [{ waypointId: FIRST, description: first, updatedAt: 'T1' }]),
      ];
      await metaRepo.upsertDescriptions(d, 'three_passes', rows);
      expect(await metaRepo.getDescription(d, 'three_passes', LATER)).toBe(shown);
    });

    it('follows the first pass through an edit and a clear', async () => {
      const d = await db();
      await metaRepo.upsertDescriptions(d, 'three_passes', [
        { waypointId: FIRST, description: 'Lodge open.', updatedAt: 'T1' },
      ]);
      expect(await metaRepo.getDescription(d, 'three_passes', LATER)).toBe('Lodge open.');
      await metaRepo.upsertDescriptions(d, 'three_passes', [
        { waypointId: FIRST, description: 'Lodge closed.', updatedAt: 'T2' },
      ]);
      expect(await metaRepo.getDescription(d, 'three_passes', LATER)).toBe('Lodge closed.');
      await metaRepo.upsertDescriptions(d, 'three_passes', [
        { waypointId: FIRST, description: '', updatedAt: 'T3' },
      ]);
      expect(await metaRepo.getDescription(d, 'three_passes', LATER)).toBeNull();
    });

    it('never gives the first pass a later pass’s text', async () => {
      const d = await db();
      await metaRepo.upsertDescriptions(d, 'three_passes', [
        { waypointId: LATER, description: 'Own.', updatedAt: 'T1' },
      ]);
      expect(await metaRepo.getDescription(d, 'three_passes', FIRST)).toBeNull();
      expect(await metaRepo.getDescription(d, 'three_passes', 'w_07233ee1_3')).toBeNull();
    });

    it('reads the first pass from the same trail only', async () => {
      const d = await db();
      await metaRepo.upsertDescriptions(d, 'aawt', [
        { waypointId: FIRST, description: 'Another trail.', updatedAt: 'T1' },
      ]);
      expect(await metaRepo.getDescription(d, 'three_passes', LATER)).toBeNull();
    });

    it('reads no pass into an id that merely ends in digits', async () => {
      const d = await db();
      await metaRepo.upsertDescriptions(d, 'aawt', [
        { waypointId: 'w', description: 'Not a place.', updatedAt: 'T1' },
        { waypointId: 'osm_node', description: 'Not a place either.', updatedAt: 'T1' },
      ]);
      // Hex that is all digits is an id of its own, and an OSM place is no waypoint.
      expect(await metaRepo.getDescription(d, 'aawt', 'w_00176641')).toBeNull();
      expect(await metaRepo.getDescription(d, 'aawt', 'osm_node_12')).toBeNull();
    });
  });

  it('keeps the meta high-water mark separate from the comment cursor', async () => {
    const d = await db();
    expect(await metaRepo.readMetaSyncedAt(d, 'aawt')).toBeUndefined();

    await metaRepo.writeMetaSyncedAt(d, 'aawt', 'M1');
    expect(await metaRepo.readMetaSyncedAt(d, 'aawt')).toBe('M1');

    // A comment cursor write must not disturb it, nor vice versa.
    await d.runAsync(
      `INSERT INTO sync_state (trail_id, last_synced_at) VALUES (?, ?)
       ON CONFLICT(trail_id) DO UPDATE SET last_synced_at = excluded.last_synced_at`,
      ['aawt', 'C1'],
    );
    await metaRepo.writeMetaSyncedAt(d, 'aawt', 'M2');
    const row = await d.getFirstAsync<{ last_synced_at: string; meta_synced_at: string }>(
      'SELECT last_synced_at, meta_synced_at FROM sync_state WHERE trail_id = ?',
      ['aawt'],
    );
    expect(row).toEqual({ last_synced_at: 'C1', meta_synced_at: 'M2' });
  });
});
