import { SELF } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { authHeaders, createComment, registerDevice, url, wpId } from './helpers';
import type { MyCommentsResponse } from '../../../src/lib/comments-api-types';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('GET /v1/me/comments — personal export', () => {
  it('needs a token', async () => {
    const res = await SELF.fetch(url('/v1/me/comments'));
    expect(res.status).toBe(401);
  });

  it('lists only the caller’s comments, oldest first, deleted ones included, with no display name', async () => {
    const me = await registerDevice('Exporter');
    const other = await registerDevice('Someone Else');
    const a = await createComment(me, { waypointId: wpId('mine-a'), text: 'first', waterStatus: 'flowing' });
    await delay(2);
    const b = await createComment(me, { trailId: 'larapinta', waypointId: wpId('mine-b'), text: 'second' });
    await createComment(other, { waypointId: wpId('mine-a'), text: 'not mine' });
    await SELF.fetch(url(`/v1/comments/${b.id}`), { method: 'DELETE', headers: authHeaders(me) });

    const res = await SELF.fetch(url('/v1/me/comments'), { headers: authHeaders(me) });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    const body = (await res.json()) as MyCommentsResponse;
    expect(body.nextCursor).toBeNull();
    expect(body.comments.map((c) => c.id)).toEqual([a.id, b.id]);

    const [first, second] = body.comments;
    expect(first).toMatchObject({
      trailId: 'heysen',
      waypointId: wpId('mine-a'),
      text: 'first',
      waterStatus: 'flowing',
      photoUrls: [],
      deletedAt: null,
      deletedBy: null,
    });
    expect(second).toMatchObject({ trailId: 'larapinta', text: 'second', deletedBy: 'owner' });
    expect(second.deletedAt).not.toBeNull();
    expect(JSON.stringify(body)).not.toContain('Exporter');
    expect(first).not.toHaveProperty('displayName');
  });

  it('exports a water report’s observation only to the day, even from a row stored to the second', async () => {
    const me = await registerDevice();
    const { id } = await createComment(me, { waypointId: wpId('obs'), text: 'tank full', waterStatus: 'flowing' });
    // As a row written before migration 0010 holds it.
    await env.DB.prepare(`UPDATE comments SET observed_at = ? WHERE id = ?`).bind('2026-10-20T14:05:33.000Z', id).run();

    const res = await SELF.fetch(url('/v1/me/comments'), { headers: authHeaders(me) });
    const body = (await res.json()) as MyCommentsResponse;
    expect(body.comments.find((c) => c.id === id)?.observedAt).toBe('2026-10-20T00:00:00.000Z');
  });

  it('pages through every comment with the cursor', async () => {
    const me = await registerDevice();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { id } = await createComment(me, { waypointId: wpId(`page-${i}`), text: `n ${i}` });
      ids.push(id);
      await delay(2);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : '?limit=2';
      const res: Response = await SELF.fetch(url(`/v1/me/comments${q}`), { headers: authHeaders(me) });
      const body = (await res.json()) as MyCommentsResponse;
      expect(body.comments.length).toBeLessThanOrEqual(2);
      seen.push(...body.comments.map((c) => c.id));
      cursor = body.nextCursor;
      pages++;
      expect(pages).toBeLessThan(10);
    } while (cursor);

    expect(seen).toEqual(ids);
  });
});
