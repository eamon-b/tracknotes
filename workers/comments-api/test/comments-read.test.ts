import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { authHeaders, createComment, registerDevice, url, wpId } from './helpers';
import type { BulkSyncResponse, FeedResponse, SyncTombstone } from '../../../src/lib/comments-api-types';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('per-waypoint feed pagination', () => {
  it('returns newest-first, excludes deleted, and round-trips the cursor', async () => {
    const device = await registerDevice();
    const wp = wpId('feed-page-wp');
    const created: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { id, res } = await createComment(device, { waypointId: wp, text: `msg ${i}` });
      expect(res.status).toBe(201);
      created.push(id);
      await delay(2); // ensure distinct createdAt for a stable newest-first order
    }

    // Delete the middle one — it must not appear in the feed.
    const deletedId = created[2];
    await SELF.fetch(url(`/v1/comments/${deletedId}`), {
      method: 'DELETE',
      headers: authHeaders(device),
    });

    // Page through with limit=2, following the cursor.
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : '?limit=2';
      const res: Response = await SELF.fetch(url(`/v1/trails/heysen/waypoints/${wp}/comments${q}`));
      expect(res.status).toBe(200);
      const body = (await res.json()) as FeedResponse;
      expect(body.comments.length).toBeLessThanOrEqual(2);
      for (const c of body.comments) seen.push(c.id);
      cursor = body.nextCursor;
      pages++;
      expect(pages).toBeLessThan(10); // guard against infinite loop
    } while (cursor);

    // 4 live comments (5 created, 1 deleted), no duplicates, deleted excluded.
    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
    expect(seen).not.toContain(deletedId);

    // Newest-first: the order should be the reverse of creation for the live set.
    const expectedOrder = [created[4], created[3], created[1], created[0]];
    expect(seen).toEqual(expectedOrder);
  });
});

describe('trail-wide bulk / delta sync', () => {
  it('snapshot omits tombstones; delta returns updated rows + tombstones', async () => {
    const device = await registerDevice();
    const trail = 'larapinta';

    const a = await createComment(device, { trailId: trail, waypointId: wpId('bulk-wp-a'), text: 'A' });
    const b = await createComment(device, { trailId: trail, waypointId: wpId('bulk-wp-b'), text: 'B' });
    await createComment(device, { trailId: trail, waypointId: wpId('bulk-wp-c'), text: 'C' });
    // The `since` boundary is inclusive, so keep the writes out of the
    // snapshot's own millisecond for the "unchanged B is absent" check below.
    await delay(5);

    // Full snapshot (no since): 3 live rows, none flagged deleted, syncedAt present.
    const snapRes = await SELF.fetch(url(`/v1/trails/${trail}/comments`));
    expect(snapRes.status).toBe(200);
    const snap = (await snapRes.json()) as BulkSyncResponse;
    expect(snap.comments).toHaveLength(3);
    expect(snap.comments.every((c) => !('deleted' in c && c.deleted))).toBe(true);
    expect(typeof snap.syncedAt).toBe('string');
    const since = snap.syncedAt;

    // Mutate strictly after the snapshot: delete A, add a new one.
    await delay(10);
    await SELF.fetch(url(`/v1/comments/${a.id}`), {
      method: 'DELETE',
      headers: authHeaders(device),
    });
    const d = await createComment(device, { trailId: trail, waypointId: wpId('bulk-wp-d'), text: 'D' });
    expect(d.res.status).toBe(201);

    // Delta since snapshot: exactly the tombstone for A and the new row D.
    const deltaRes = await SELF.fetch(url(`/v1/trails/${trail}/comments?since=${encodeURIComponent(since)}`));
    const delta = (await deltaRes.json()) as BulkSyncResponse;
    expect(delta.comments).toHaveLength(2);

    const tombstone = delta.comments.find((c): c is SyncTombstone => 'deleted' in c && c.deleted === true);
    expect(tombstone).toBeDefined();
    expect(tombstone).toEqual({
      id: a.id,
      waypointId: wpId('bulk-wp-a'),
      deleted: true,
      updatedAt: expect.any(String),
    });
    // B (unchanged) must NOT appear in the delta.
    expect(delta.comments.some((c) => c.id === b.id)).toBe(false);

    const live = delta.comments.find((c) => !('deleted' in c && c.deleted));
    expect(live?.id).toBe(d.id);

    // A fresh full snapshot now omits the tombstone (A deleted) → 3 live rows.
    const snap2 = (await (await SELF.fetch(url(`/v1/trails/${trail}/comments`))).json()) as BulkSyncResponse;
    expect(snap2.comments).toHaveLength(3);
    expect(snap2.comments.some((c) => c.id === a.id)).toBe(false);
  });

  it('delivers a row stamped exactly at `since`', async () => {
    // `syncedAt` is taken before the SELECT, so a write that commits in the
    // same millisecond just after it would fall through a strict `>`.
    const device = await registerDevice('Boundary');
    const { id } = await createComment(device, { trailId: 'aawt', waypointId: wpId('bulk-edge-wp') });
    const row = await env.DB.prepare(`SELECT updated_at FROM comments WHERE id = ?`)
      .bind(id)
      .first<{ updated_at: string }>();

    const delta = (await (
      await SELF.fetch(url(`/v1/trails/aawt/comments?since=${encodeURIComponent(row!.updated_at)}`))
    ).json()) as BulkSyncResponse;
    expect(delta.comments.map((c) => c.id)).toContain(id);
  });

  it('paginates the delta feed stably with a small limit', async () => {
    const device = await registerDevice();
    const trail = 'bibbulmun';
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { id } = await createComment(device, {
        trailId: trail,
        waypointId: wpId('bulk-page-wp'),
        text: `row ${i}`,
      });
      ids.push(id);
      await delay(2);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : '?limit=2';
      const res: Response = await SELF.fetch(url(`/v1/trails/${trail}/comments${q}`));
      const body = (await res.json()) as BulkSyncResponse;
      for (const c of body.comments) seen.push(c.id);
      cursor = body.nextCursor;
      pages++;
      expect(pages).toBeLessThan(10);
    } while (cursor);

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(seen.sort()).toEqual([...ids].sort());
  });

  it("flags the caller's own live rows with `mine` only when a token is sent", async () => {
    const author = await registerDevice('Author');
    const reader = await registerDevice('Reader');
    const trail = 'cape_to_cape';
    const own = await createComment(author, { trailId: trail, waypointId: wpId('mine-wp-a'), text: 'own' });
    const theirs = await createComment(reader, { trailId: trail, waypointId: wpId('mine-wp-b'), text: 'theirs' });
    const gone = await createComment(author, { trailId: trail, waypointId: wpId('mine-wp-c'), text: 'gone' });
    await SELF.fetch(url(`/v1/comments/${gone.id}`), { method: 'DELETE', headers: authHeaders(author) });

    const read = async (headers: Record<string, string> = {}) => {
      const res = await SELF.fetch(
        url(`/v1/trails/${trail}/comments?since=${encodeURIComponent('1970-01-01T00:00:00.000Z')}`),
        { headers }
      );
      expect(res.status).toBe(200);
      return { res, body: (await res.json()) as BulkSyncResponse };
    };
    const byId = (body: BulkSyncResponse, id: string) => body.comments.find((c) => c.id === id);

    const anon = await read();
    expect(byId(anon.body, own.id)).not.toHaveProperty('mine');
    expect(byId(anon.body, theirs.id)).not.toHaveProperty('mine');
    expect(anon.res.headers.get('Cache-Control')).toBeNull();

    const asAuthor = await read(authHeaders(author));
    expect(byId(asAuthor.body, own.id)).toMatchObject({ mine: true });
    expect(byId(asAuthor.body, theirs.id)).toMatchObject({ mine: false });
    // Tombstones never carry it.
    expect(byId(asAuthor.body, gone.id)).toEqual({
      id: gone.id,
      waypointId: wpId('mine-wp-c'),
      deleted: true,
      updatedAt: expect.any(String),
    });
    expect(asAuthor.res.headers.get('Cache-Control')).toBe('private, no-store');

    const asReader = await read(authHeaders(reader));
    expect(byId(asReader.body, own.id)).toMatchObject({ mine: false });
    expect(byId(asReader.body, theirs.id)).toMatchObject({ mine: true });
  });

  it('reads anonymously, not failing, with a bad token', async () => {
    const device = await registerDevice();
    const trail = 'cape_to_cape';
    const { id } = await createComment(device, { trailId: trail, waypointId: wpId('mine-bad-token') });
    const res = await SELF.fetch(url(`/v1/trails/${trail}/comments`), {
      headers: { Authorization: 'Bearer not-a-real-token' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as BulkSyncResponse;
    expect(body.comments.find((c) => c.id === id)).not.toHaveProperty('mine');
  });
});
