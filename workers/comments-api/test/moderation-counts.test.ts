import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { authHeaders, createComment, makeAdmin, registerDevice, reportComment, url, type Device } from './helpers';
import { getModerationCounts } from '../src/moderation-counts';
import type { Env } from '../src/http';
import { needsAttention, type ModeratedRow } from '../../../src/lib/moderation-attention';
import type {
  AdminCommentsResponse,
  AdminSharedWaypointsResponse,
  ModerationCountsResponse,
} from '../../../src/lib/comments-api-types';

const COUNTS = '/v1/admin/moderation/counts';
const countsHeaders = () => ({ Authorization: `Bearer ${env.MODERATION_COUNTS_TOKEN}` });

async function counts(): Promise<ModerationCountsResponse> {
  const res = await SELF.fetch(url(COUNTS), { headers: countsHeaders() });
  expect(res.status).toBe(200);
  expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  return (await res.json()) as ModerationCountsResponse;
}

async function newAdmin(): Promise<Device> {
  const admin = await registerDevice('Moderator');
  await makeAdmin(admin.userId);
  return admin;
}

async function sharedWaypoint(owner: Device): Promise<string> {
  const id = `hw_${crypto.randomUUID()}`;
  const res = await SELF.fetch(url(`/v1/waypoints/${id}`), {
    method: 'PUT',
    headers: authHeaders(owner),
    body: JSON.stringify({ trailId: 'heysen', name: 'Creek', type: 'water', lat: -34.12, lon: 138.5 }),
  });
  expect(res.ok).toBe(true);
  return id;
}

type State = { deletedBy?: 'reports' | 'admin' | null; restoredAt?: string | null; verdict?: string | null };

/** Put a row in a moderation state by hand (`review_status` set, so it is in the queue's scope). */
async function setState(table: 'comments' | 'shared_waypoints', id: string, s: State): Promise<void> {
  const now = new Date().toISOString();
  const review = s.verdict ? JSON.stringify({ status: 'done', trigger: 'report', verdict: s.verdict }) : null;
  await env.DB.prepare(
    `UPDATE ${table}
        SET deleted_by = ?, deleted_at = ?, restored_at = ?, review_status = 'done', review_json = ?
      WHERE id = ?`
  )
    .bind(s.deletedBy ?? null, s.deletedBy ? now : null, s.restoredAt ?? null, review, id)
    .run();
}

/** What the moderation page would highlight, from the admin listings. */
async function pageCounts(admin: Device): Promise<ModerationCountsResponse> {
  const c = (await (
    await SELF.fetch(url('/v1/admin/comments?reported=1&limit=500'), { headers: authHeaders(admin) })
  ).json()) as AdminCommentsResponse;
  const w = (await (
    await SELF.fetch(url('/v1/admin/waypoints?limit=500'), { headers: authHeaders(admin) })
  ).json()) as AdminSharedWaypointsResponse;
  const tally = (rows: readonly ModeratedRow[]) => {
    const waiting = rows.filter(needsAttention);
    return { waiting: waiting.length, hidden: waiting.filter((r) => r.deletedBy === 'reports').length };
  };
  const comments = tally(c.comments);
  const waypoints = tally(w.waypoints);
  return { comments, waypoints, total: comments.waiting + waypoints.waiting };
}

describe('GET /v1/admin/moderation/counts', () => {
  it('counts what the moderation page highlights, and the hidden among them', async () => {
    const admin = await newAdmin();
    const before = await counts();
    const owner = await registerDevice('Author');

    const states: State[] = [
      { deletedBy: 'reports' },
      { verdict: 'needs_human' },
      { verdict: 'remove' },
      { verdict: 'keep' },
      { verdict: 'remove', restoredAt: new Date().toISOString() },
      { deletedBy: 'admin', verdict: 'remove' },
      {},
    ];
    for (const state of states) {
      const { id } = await createComment(owner);
      await setState('comments', id, state);
      await setState('shared_waypoints', await sharedWaypoint(owner), state);
    }
    // Reported but not reviewed or hidden: listed, not waiting.
    const { id: reported } = await createComment(owner);
    expect((await reportComment(await registerDevice(), reported)).status).toBe(201);

    const after = await counts();
    expect(after.comments.waiting - before.comments.waiting).toBe(3);
    expect(after.comments.hidden - before.comments.hidden).toBe(1);
    expect(after.waypoints.waiting - before.waypoints.waiting).toBe(3);
    expect(after.waypoints.hidden - before.waypoints.hidden).toBe(1);
    expect(after.total).toBe(after.comments.waiting + after.waypoints.waiting);
    expect(after).toEqual(await pageCounts(admin));
  });

  it('answers only to the counts token: not an admin device, a wrong token or none', async () => {
    const admin = await newAdmin();
    expect((await SELF.fetch(url(COUNTS))).status).toBe(401);
    expect((await SELF.fetch(url(COUNTS), { headers: authHeaders(admin) })).status).toBe(401);
    const wrong = { Authorization: `Bearer ${env.MODERATION_COUNTS_TOKEN}x` };
    expect((await SELF.fetch(url(COUNTS), { headers: wrong })).status).toBe(401);
    expect((await SELF.fetch(url(COUNTS), { method: 'POST', headers: countsHeaders() })).status).toBe(405);
  });

  it('opens nothing else: the counts token is no admin on the admin routes', async () => {
    for (const path of ['/v1/admin/comments?reported=1', '/v1/admin/waypoints', '/v1/admin/reports']) {
      expect((await SELF.fetch(url(path), { headers: countsHeaders() })).status).toBe(401);
    }
  });

  it('refuses everyone while the secret is unset or too short', async () => {
    const request = () => new Request(url(COUNTS), { headers: { Authorization: 'Bearer short' } });
    for (const secret of [undefined, '', 'short']) {
      const testEnv = { ...env, MODERATION_COUNTS_TOKEN: secret } as unknown as Env;
      await expect(getModerationCounts(request(), testEnv)).rejects.toMatchObject({ status: 401 });
    }
  });
});
