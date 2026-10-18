import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  authHeaders,
  banUser,
  createComment,
  deleteMe,
  makeAdmin,
  registerDevice,
  reportComment,
  url,
  type Device,
} from './helpers';
import { ageAccount, registerAgedDevice } from './community-fixtures';
import type {
  AdminCommentsResponse,
  AdminSharedWaypointsResponse,
  BanUserResponse,
  BulkSyncResponse,
} from '../../../src/lib/comments-api-types';

async function commentState(id: string) {
  return env.DB.prepare(`SELECT deleted_at, deleted_by, restored_at FROM comments WHERE id = ?`)
    .bind(id)
    .first<{ deleted_at: string | null; deleted_by: string | null; restored_at: string | null }>();
}

async function newAdmin(): Promise<Device> {
  const admin = await registerDevice('Moderator');
  await makeAdmin(admin.userId);
  return admin;
}

/** A comment on `trailId` with `n` reports from day-old accounts. */
async function reportedComment(n: number, trailId = 'heysen'): Promise<{ owner: Device; id: string }> {
  const owner = await registerDevice('Author');
  const { id, res } = await createComment(owner, { trailId });
  expect(res.status).toBe(201);
  for (let i = 0; i < n; i++) {
    expect((await reportComment(await registerAgedDevice(), id, { reason: 'offensive', detail: `r${i}` })).status).toBe(201);
  }
  return { owner, id };
}

function restore(device: Device, id: string): Promise<Response> {
  return SELF.fetch(url(`/v1/admin/comments/${id}/restore`), { method: 'POST', headers: authHeaders(device) });
}

function ban(device: Device, userId: string, body: Record<string, unknown>): Promise<Response> {
  return SELF.fetch(url(`/v1/admin/users/${userId}/ban`), {
    method: 'POST',
    headers: authHeaders(device),
    body: JSON.stringify(body),
  });
}

describe('comment report threshold', () => {
  it('hides a comment at three reports from day-old accounts, tombstoned in the delta feed', async () => {
    const owner = await registerDevice();
    const { id } = await createComment(owner, { trailId: 'bibbulmun' });
    const since = new Date(Date.now() - 1000).toISOString();
    for (let i = 0; i < 2; i++) await reportComment(await registerAgedDevice(), id);
    expect((await commentState(id))?.deleted_at).toBeNull();

    await reportComment(await registerAgedDevice(), id);
    const state = await commentState(id);
    expect(state?.deleted_at).not.toBeNull();
    expect(state?.deleted_by).toBe('reports');

    const res = await SELF.fetch(url(`/v1/trails/bibbulmun/comments?since=${encodeURIComponent(since)}`));
    const body = (await res.json()) as BulkSyncResponse;
    expect(body.comments).toEqual([expect.objectContaining({ id, deleted: true })]);
    // Hidden is gone as far as reporters are concerned.
    expect((await reportComment(await registerAgedDevice(), id)).status).toBe(410);
  });

  it('does not count accounts under a day old, or the author', async () => {
    const owner = await registerDevice();
    await ageAccount(owner.userId);
    const { id } = await createComment(owner);
    await reportComment(owner, id);
    for (let i = 0; i < 2; i++) await reportComment(await registerAgedDevice(), id);
    for (let i = 0; i < 3; i++) await reportComment(await registerDevice(), id);
    expect((await commentState(id))?.deleted_at).toBeNull();
  });
});

describe('POST /v1/admin/comments/:id/restore', () => {
  it('undoes a report hide, and only later reports count', async () => {
    const admin = await newAdmin();
    const { owner, id } = await reportedComment(3);
    expect((await restore(owner, id)).status).toBe(403);
    expect((await restore(admin, id)).status).toBe(204);
    const state = await commentState(id);
    expect(state?.deleted_at).toBeNull();
    expect(state?.restored_at).not.toBeNull();

    await reportComment(await registerAgedDevice(), id);
    expect((await commentState(id))?.deleted_at).toBeNull();
  });

  it('refuses an owner or admin delete, which are final', async () => {
    const admin = await newAdmin();
    const owner = await registerDevice();
    const { id: mine } = await createComment(owner);
    await SELF.fetch(url(`/v1/comments/${mine}`), { method: 'DELETE', headers: authHeaders(owner) });
    const res = await restore(admin, mine);
    expect(res.status).toBe(409);

    const { id: hidden } = await reportedComment(3);
    await env.DB.prepare(`UPDATE comments SET photo_urls_json = ?, photo_hashes_json = ? WHERE id = ?`)
      .bind('["https://photos.test/a.jpg"]', '["00"]', hidden)
      .run();
    expect((await SELF.fetch(url(`/v1/comments/${hidden}`), { method: 'DELETE', headers: authHeaders(admin) })).status).toBe(204);
    expect((await commentState(hidden))?.deleted_by).toBe('admin');
    // The photos are purged, so the row no longer names them.
    const photos = await env.DB.prepare(`SELECT photo_urls_json, photo_hashes_json FROM comments WHERE id = ?`)
      .bind(hidden)
      .first<{ photo_urls_json: string | null; photo_hashes_json: string | null }>();
    expect(photos).toEqual({ photo_urls_json: null, photo_hashes_json: null });
    expect((await restore(admin, hidden)).status).toBe(409);
  });

  it('404s an unknown comment', async () => {
    expect((await restore(await newAdmin(), crypto.randomUUID())).status).toBe(404);
  });
});

describe('GET /v1/admin/comments?reported=1', () => {
  it('lists reported comments with every report reason and detail, hidden first', async () => {
    const admin = await newAdmin();
    const { id: hidden } = await reportedComment(3);
    const { id: once } = await reportedComment(1);
    await createComment(await registerDevice());

    const res = await SELF.fetch(url('/v1/admin/comments?reported=1&limit=500'), { headers: authHeaders(admin) });
    expect(res.status).toBe(200);
    const { comments } = (await res.json()) as AdminCommentsResponse;
    expect(comments.every((c) => c.reportCount > 0)).toBe(true);
    const first = comments.findIndex((c) => c.id === hidden);
    const second = comments.findIndex((c) => c.id === once);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(second);
    const row = comments[first];
    expect(row.deletedBy).toBe('reports');
    expect(row.userBanned).toBe(false);
    expect(row.userAdmin).toBe(false);
    expect(row.userDeleted).toBe(false);
    const dates = row.reports.map((r) => r.createdAt);
    expect(dates).toEqual([...dates].sort().reverse());
    expect(row.reports).toHaveLength(3);
    expect(row.reports.map((r) => r.detail).sort()).toEqual(['r0', 'r1', 'r2']);
    expect(row.reports[0]).toEqual(
      expect.objectContaining({ reason: 'offensive', reporterDisplayName: expect.any(String) })
    );
  });
});

describe('GET /v1/admin/waypoints', () => {
  it('carries each report with its reason and detail', async () => {
    const admin = await newAdmin();
    const owner = await registerDevice();
    const id = `hw_${crypto.randomUUID()}`;
    await SELF.fetch(url(`/v1/waypoints/${id}`), {
      method: 'PUT',
      headers: authHeaders(owner),
      body: JSON.stringify({ trailId: 'heysen', name: 'Tank', type: 'water', lat: -34, lon: 138 }),
    });
    await SELF.fetch(url(`/v1/waypoints/${id}/report`), {
      method: 'POST',
      headers: authHeaders(await registerDevice('Reporter')),
      body: JSON.stringify({ reason: 'inaccurate', detail: 'No tank here' }),
    });
    const res = await SELF.fetch(url('/v1/admin/waypoints?limit=500'), { headers: authHeaders(admin) });
    const { waypoints } = (await res.json()) as AdminSharedWaypointsResponse;
    const row = waypoints.find((w) => w.id === id);
    expect(row?.reports).toEqual([
      expect.objectContaining({ reason: 'inaccurate', detail: 'No tank here', reporterDisplayName: 'Reporter' }),
    ]);
    expect(row?.userBanned).toBe(false);
  });

  it('marks an owner who deleted their account apart from a banned one', async () => {
    const admin = await newAdmin();
    const owner = await registerDevice();
    const id = `hw_${crypto.randomUUID()}`;
    await SELF.fetch(url(`/v1/waypoints/${id}`), {
      method: 'PUT',
      headers: authHeaders(owner),
      body: JSON.stringify({ trailId: 'heysen', name: 'Tank', type: 'water', lat: -34, lon: 138 }),
    });
    await deleteMe(owner);
    const res = await SELF.fetch(url('/v1/admin/waypoints?limit=500'), { headers: authHeaders(admin) });
    const { waypoints } = (await res.json()) as AdminSharedWaypointsResponse;
    expect(waypoints.find((w) => w.id === id)).toEqual(
      expect.objectContaining({ userBanned: true, userDeleted: true, userAdmin: false })
    );
  });
});

describe('POST /v1/admin/users/:id/ban', () => {
  it('is admin-only and refuses to ban an admin', async () => {
    const admin = await newAdmin();
    const user = await registerDevice();
    expect((await ban(user, admin.userId, { banned: true })).status).toBe(403);
    const other = await newAdmin();
    const res = await ban(admin, other.userId, { banned: true });
    expect(res.status).toBe(400);
    expect((await ban(admin, crypto.randomUUID(), { banned: true })).status).toBe(404);
    expect((await ban(admin, user.userId, { banned: 'yes' })).status).toBe(400);
  });

  it('stops posting, and lifting it lets the account post again', async () => {
    const admin = await newAdmin();
    const user = await registerDevice();
    const res = await ban(admin, user.userId, { banned: true });
    expect(res.status).toBe(200);
    expect((await res.json()) as BanUserResponse).toEqual({
      userId: user.userId,
      banned: true,
      removedComments: 0,
      removedWaypoints: 0,
    });
    expect((await createComment(user)).res.status).toBe(403);
    // Reporting is still allowed.
    const { id } = await createComment(await registerDevice());
    expect((await reportComment(user, id)).status).toBe(201);

    expect((await ban(admin, user.userId, { banned: false })).status).toBe(200);
    expect((await createComment(user)).res.status).toBe(201);
  });

  it('with removeContent takes down live and report-hidden content as an admin delete', async () => {
    const admin = await newAdmin();
    const { owner, id: hidden } = await reportedComment(3);
    const { id: live } = await createComment(owner);
    const wp = `hw_${crypto.randomUUID()}`;
    await SELF.fetch(url(`/v1/waypoints/${wp}`), {
      method: 'PUT',
      headers: authHeaders(owner),
      body: JSON.stringify({ trailId: 'heysen', name: 'Tank', type: 'water', lat: -34, lon: 138 }),
    });

    const res = await ban(admin, owner.userId, { banned: true, removeContent: true });
    expect((await res.json()) as BanUserResponse).toEqual(
      expect.objectContaining({ removedComments: 2, removedWaypoints: 1 })
    );
    expect((await commentState(hidden))?.deleted_by).toBe('admin');
    expect((await commentState(live))?.deleted_by).toBe('admin');
    const row = await env.DB.prepare(`SELECT deleted_by FROM shared_waypoints WHERE id = ?`)
      .bind(wp)
      .first<{ deleted_by: string }>();
    expect(row?.deleted_by).toBe('admin');
  });

  it('lifts, and removes the posts of, an account banned by hand in D1', async () => {
    const admin = await newAdmin();
    const user = await registerDevice();
    const { id } = await createComment(user);
    await banUser(user.userId); // is_banned = 1, no banned_at or deleted_at
    const res = await ban(admin, user.userId, { banned: true, removeContent: true });
    expect(((await res.json()) as BanUserResponse).removedComments).toBe(1);
    expect((await commentState(id))?.deleted_by).toBe('admin');
    expect((await ban(admin, user.userId, { banned: false })).status).toBe(200);
    expect((await createComment(user)).res.status).toBe(201);
  });

  it('never lifts the ban on a deleted account', async () => {
    const admin = await newAdmin();
    const user = await registerDevice();
    expect((await deleteMe(user)).status).toBe(204);
    const res = await ban(admin, user.userId, { banned: false });
    expect(res.status).toBe(409);
    // A ban before the deletion does not open that door either.
    const other = await registerDevice();
    await ban(admin, other.userId, { banned: true });
    await deleteMe(other);
    expect((await ban(admin, other.userId, { banned: false })).status).toBe(409);
  });
});
