import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { authHeaders, makeAdmin, registerDevice, url, wpId, type Device } from './helpers';
import { submitRoute } from './community-fixtures';
import { adminCommentsSql } from '../src/comments';
import type { AdminComment, AdminCommentsResponse, DeletedBy } from '../../../src/lib/comments-api-types';
import type { CommunityRouteDetail } from '../../../src/lib/community-types';

/**
 * `GET /v1/admin/comments`: the read across every trail, which must answer as
 * it always has, and the read of one trail (`?trail=`), paged to its end.
 *
 * Rows are written straight to D1: the tests need exact `created_at` values
 * (ties included) and every moderation state, without the report threshold,
 * the post rate limit or the clock in the way. Each test files under a trail
 * of its own, since the tests in a file share one database.
 */

interface Seed {
  trailId: string;
  createdAt: string;
  id?: string;
  deletedBy?: DeletedBy;
  /** How many reports to file against it. */
  reports?: number;
  reviewStatus?: 'pending' | 'done' | 'failed';
  reviewVerdict?: 'remove' | 'needs_human' | 'keep';
}

let author: Device | null = null;
let reporters: Device[] = [];

async function seed(row: Seed): Promise<string> {
  author ??= await registerDevice('Author');
  const id = row.id ?? crypto.randomUUID();
  const deletedAt = row.deletedBy ? '2026-06-01T00:00:00.000Z' : null;
  await env.DB.prepare(
    `INSERT INTO comments (id, trail_id, waypoint_id, user_id, text, created_at, updated_at,
                           deleted_at, deleted_by, review_status, review_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      row.trailId,
      wpId('admin-listing'),
      author.userId,
      `Comment ${id}`,
      row.createdAt,
      deletedAt ?? row.createdAt,
      deletedAt,
      row.deletedBy ?? null,
      row.reviewStatus ?? null,
      row.reviewStatus
        ? JSON.stringify({ status: row.reviewStatus, trigger: 'screen', verdict: row.reviewVerdict })
        : null
    )
    .run();
  for (let i = 0; i < (row.reports ?? 0); i++) {
    reporters[i] ??= await registerDevice(`Reporter ${i}`);
    await env.DB.prepare(
      `INSERT INTO comment_reports (id, comment_id, user_id, reason, detail, created_at) VALUES (?, ?, ?, 'inaccurate', ?, ?)`
    )
      .bind(crypto.randomUUID(), id, reporters[i].userId, `r${i}`, `2026-05-0${i + 1}T00:00:00.000Z`)
      .run();
  }
  return id;
}

async function newAdmin(): Promise<Device> {
  const admin = await registerDevice('Moderator');
  await makeAdmin(admin.userId);
  return admin;
}

function list(device: Device, query: string): Promise<Response> {
  return SELF.fetch(url(`/v1/admin/comments${query}`), { headers: authHeaders(device) });
}

async function page(device: Device, query: string): Promise<AdminCommentsResponse> {
  const res = await list(device, query);
  expect(res.status).toBe(200);
  return (await res.json()) as AdminCommentsResponse;
}

/** Follow `nextCursor` to the end, returning every page. */
async function readAll(device: Device, query: string, from: string | null = null): Promise<AdminCommentsResponse[]> {
  const pages: AdminCommentsResponse[] = [];
  let cursor = from;
  do {
    const body: AdminCommentsResponse = await page(
      device,
      cursor ? `${query}&cursor=${encodeURIComponent(cursor)}` : query
    );
    pages.push(body);
    cursor = body.nextCursor ?? null;
    expect(pages.length).toBeLessThan(50);
  } while (cursor);
  return pages;
}

const ids = (rows: readonly AdminComment[]): string[] => rows.map((c) => c.id);

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

/** `(created_at, id)` newest first: the order every read of one trail has. */
function newestFirst(rows: readonly { id: string; createdAt: string }[]): string[] {
  return [...rows]
    .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1))
    .map((r) => r.id);
}

describe('GET /v1/admin/comments across every trail', () => {
  it('answers as it did before the trail filter: the same rows, order and shape', async () => {
    const admin = await newAdmin();
    // The first rows this file writes, so the listing holds exactly these.
    const published = await seed({ trailId: 'heysen', createdAt: '2026-03-05T00:00:00.000Z' });
    const hidden = await seed({
      trailId: 'bibbulmun',
      createdAt: '2026-03-01T00:00:00.000Z',
      deletedBy: 'reports',
      reports: 3,
    });
    const flagged = await seed({
      trailId: 'heysen',
      createdAt: '2026-03-02T00:00:00.000Z',
      reviewStatus: 'done',
      reviewVerdict: 'needs_human',
    });
    const twice = await seed({ trailId: 'aawt', createdAt: '2026-03-03T00:00:00.000Z', reports: 2 });
    const once = await seed({ trailId: 'heysen', createdAt: '2026-03-04T00:00:00.000Z', reports: 1 });
    const withdrawn = await seed({ trailId: 'aawt', createdAt: '2026-03-06T00:00:00.000Z', deletedBy: 'owner' });

    const all = await page(admin, '');
    expect(Object.keys(all)).toEqual(['comments']);
    expect(ids(all.comments)).toEqual([withdrawn, published, once, twice, flagged, hidden]);
    expect(all.comments.find((c) => c.id === hidden)).toEqual(
      expect.objectContaining({ trailId: 'bibbulmun', deletedBy: 'reports', reportCount: 3 })
    );

    // Hidden by reports, then review-flagged, then by report count.
    const reported = await page(admin, '?reported=1&limit=500');
    expect(Object.keys(reported)).toEqual(['comments']);
    expect(ids(reported.comments)).toEqual([hidden, flagged, twice, once]);

    // A full read says nothing about there being more: it never has.
    const cut = await page(admin, '?limit=2');
    expect(Object.keys(cut)).toEqual(['comments']);
    expect(ids(cut.comments)).toEqual([withdrawn, published]);
  });

  it('refuses a cursor or the moderated filter without a trail', async () => {
    const admin = await newAdmin();
    const cursor = btoa('2026-03-03T00:00:00.000Z|00000000-0000-4000-8000-000000000000');
    const paged = await list(admin, `?cursor=${cursor}`);
    expect(paged.status).toBe(400);
    expect(await errorCode(paged)).toBe('invalid_cursor');
    const moderated = await list(admin, '?moderated=1');
    expect(moderated.status).toBe(400);
    expect(await errorCode(moderated)).toBe('invalid_moderated');
  });
});

describe('GET /v1/admin/comments?trail=', () => {
  it('lists only that trail, newest first, in every state, and names the trail', async () => {
    const admin = await newAdmin();
    const trailId = 'larapinta';
    const mine = [
      { id: await seed({ trailId, createdAt: '2026-04-01T00:00:00.000Z' }), createdAt: '2026-04-01T00:00:00.000Z' },
      {
        id: await seed({ trailId, createdAt: '2026-04-03T00:00:00.000Z', deletedBy: 'owner' }),
        createdAt: '2026-04-03T00:00:00.000Z',
      },
      {
        id: await seed({ trailId, createdAt: '2026-04-02T00:00:00.000Z', deletedBy: 'reports', reports: 3 }),
        createdAt: '2026-04-02T00:00:00.000Z',
      },
    ];
    await seed({ trailId: 'overland', createdAt: '2026-04-02T00:00:00.000Z', reports: 1 });

    const body = await page(admin, `?trail=${trailId}`);
    expect(body.trailId).toBe(trailId);
    expect(body.nextCursor).toBeNull();
    expect(ids(body.comments)).toEqual(newestFirst(mine));
    expect(body.comments.every((c) => c.trailId === trailId)).toBe(true);
    const hidden = body.comments.find((c) => c.deletedBy === 'reports');
    expect(hidden?.reportCount).toBe(3);
    expect(hidden?.reports.map((r) => r.detail).sort()).toEqual(['r0', 'r1', 'r2']);
  });

  it('pages to the end across ties on created_at, skipping and repeating nothing', async () => {
    const admin = await newAdmin();
    const trailId = 'six_foot_track';
    const tie = '2026-05-10T10:00:00.000Z';
    const rows: { id: string; createdAt: string }[] = [];
    for (const createdAt of [tie, tie, tie, tie, tie, '2026-05-11T00:00:00.000Z', '2026-05-09T00:00:00.000Z']) {
      rows.push({ id: await seed({ trailId, createdAt }), createdAt });
    }
    // The same instants on another trail must not leak into the pages.
    await seed({ trailId: 'heysen', createdAt: tie });

    const pages = await readAll(admin, `?trail=${trailId}&limit=3`);
    expect(pages.map((p) => p.comments.length)).toEqual([3, 3, 1]);
    expect(pages.map((p) => p.nextCursor === null)).toEqual([false, false, true]);
    expect(pages.every((p) => p.trailId === trailId)).toBe(true);
    const read = pages.flatMap((p) => ids(p.comments));
    expect(read).toEqual(newestFirst(rows));
    expect(new Set(read).size).toBe(rows.length);

    // A page that ends exactly on the last row says so, with no empty page to follow.
    const exact = await page(admin, `?trail=${trailId}&limit=7`);
    expect(ids(exact.comments)).toEqual(newestFirst(rows));
    expect(exact.nextCursor).toBeNull();

    // A page boundary inside the tie: the cursor carries the id, not only the instant.
    const [first] = pages;
    expect(first.comments[2].createdAt).toBe(tie);
    expect(pages[1].comments[0].createdAt).toBe(tie);
  });

  it('keeps its place when rows arrive or change between pages', async () => {
    const admin = await newAdmin();
    const trailId = 'thorsborne';
    const rows: { id: string; createdAt: string }[] = [];
    for (let day = 1; day <= 5; day++) {
      const createdAt = `2026-07-0${day}T00:00:00.000Z`;
      rows.push({ id: await seed({ trailId, createdAt, reports: 1 }), createdAt });
    }
    const first = await page(admin, `?trail=${trailId}&reported=1&limit=2`);
    expect(ids(first.comments)).toEqual(newestFirst(rows).slice(0, 2));

    // A newer comment, and a hide of one already read: neither moves what is left.
    await seed({ trailId, createdAt: '2026-07-09T00:00:00.000Z', reports: 2 });
    await env.DB.prepare(`UPDATE comments SET deleted_at = ?, deleted_by = 'reports', updated_at = ? WHERE id = ?`)
      .bind('2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z', first.comments[0].id)
      .run();
    expect(first.nextCursor).toEqual(expect.any(String));
    const rest = await readAll(admin, `?trail=${trailId}&reported=1&limit=2`, first.nextCursor);
    expect(rest.flatMap((p) => ids(p.comments))).toEqual(newestFirst(rows).slice(2));
  });

  it('with reported=1 lists the trail’s reported or reviewed comments, still newest first', async () => {
    const admin = await newAdmin();
    const trailId = 'three_capes';
    const oldHidden = await seed({
      trailId,
      createdAt: '2026-01-01T00:00:00.000Z',
      deletedBy: 'reports',
      reports: 3,
    });
    const once = await seed({ trailId, createdAt: '2026-01-04T00:00:00.000Z', reports: 1 });
    const reviewed = await seed({
      trailId,
      createdAt: '2026-01-03T00:00:00.000Z',
      reviewStatus: 'done',
      reviewVerdict: 'keep',
    });
    const twice = await seed({ trailId, createdAt: '2026-01-02T00:00:00.000Z', reports: 2 });
    await seed({ trailId, createdAt: '2026-01-05T00:00:00.000Z' });
    await seed({ trailId, createdAt: '2026-01-06T00:00:00.000Z', deletedBy: 'admin' });
    await seed({ trailId: 'shikoku', createdAt: '2026-01-07T00:00:00.000Z', reports: 1 });

    // Not hidden-first: across every trail `oldHidden` would lead.
    const whole = await page(admin, `?trail=${trailId}&reported=1`);
    expect(ids(whole.comments)).toEqual([once, reviewed, twice, oldHidden]);
    expect(whole.nextCursor).toBeNull();

    const pages = await readAll(admin, `?trail=${trailId}&reported=1&limit=3`);
    expect(pages.map((p) => ids(p.comments))).toEqual([[once, reviewed, twice], [oldHidden]]);
  });

  it('with moderated=1 lists what moderation touched, and nothing an author withdrew', async () => {
    const admin = await newAdmin();
    const trailId = 'kep_track';
    const hidden = await seed({ trailId, createdAt: '2026-02-01T00:00:00.000Z', deletedBy: 'reports', reports: 3 });
    // An admin's delete of a comment nobody reported: in no reported listing.
    const adminDeleted = await seed({ trailId, createdAt: '2026-02-02T00:00:00.000Z', deletedBy: 'admin' });
    const flagged = await seed({
      trailId,
      createdAt: '2026-02-03T00:00:00.000Z',
      reviewStatus: 'done',
      reviewVerdict: 'needs_human',
    });
    const reportedLive = await seed({ trailId, createdAt: '2026-02-04T00:00:00.000Z', reports: 2 });
    await seed({ trailId, createdAt: '2026-02-05T00:00:00.000Z' }); // published, never reported
    await seed({ trailId, createdAt: '2026-02-06T00:00:00.000Z', deletedBy: 'owner' });
    await seed({ trailId, createdAt: '2026-02-07T00:00:00.000Z', deletedBy: 'owner', reports: 2 });
    await seed({ trailId: 'cdt', createdAt: '2026-02-08T00:00:00.000Z', deletedBy: 'admin' });

    const pages = await readAll(admin, `?trail=${trailId}&moderated=1&limit=3`);
    expect(pages.map((p) => ids(p.comments))).toEqual([[reportedLive, flagged, adminDeleted], [hidden]]);
    const rows = pages.flatMap((p) => p.comments);
    expect(rows.map((c) => [c.deletedBy, c.reportCount])).toEqual([
      [null, 2],
      [null, 0],
      ['admin', 0],
      ['reports', 3],
    ]);
    expect(rows[1].review).toEqual(expect.objectContaining({ verdict: 'needs_human' }));

    // Both filters: the reported ones among them, so not the admin's unreported delete.
    const both = await page(admin, `?trail=${trailId}&moderated=1&reported=1`);
    expect(ids(both.comments)).toEqual([reportedLive, flagged, hidden]);
  });

  it('answers 400 for a malformed cursor, never 500', async () => {
    const admin = await newAdmin();
    for (const cursor of ['%25%25%25', 'not base64!', btoa('no separator')]) {
      const res = await list(admin, `?trail=heysen&cursor=${cursor}`);
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe('invalid_cursor');
    }
    // One that decodes but names no row is only a place to continue from.
    const odd = await page(admin, `?trail=heysen&cursor=${encodeURIComponent(btoa('|'))}`);
    expect(odd.comments).toEqual([]);
    expect(odd.nextCursor).toBeNull();
  });

  it('answers 400 for a trail the server does not know', async () => {
    const admin = await newAdmin();
    for (const trail of ['', 'nope', 'u_abcdef123456', 'c_AAAAAAAAAAAAAAAA', "heysen' OR 1=1 --"]) {
      const res = await list(admin, `?trail=${encodeURIComponent(trail)}`);
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe('invalid_trail');
    }
  });

  it('takes a community route’s id', async () => {
    const admin = await newAdmin();
    const res = await submitRoute(await registerDevice('Owner'));
    expect(res.status).toBe(201);
    const route = (await res.json()) as CommunityRouteDetail;
    const id = await seed({ trailId: route.id, createdAt: '2026-08-01T00:00:00.000Z', deletedBy: 'admin' });
    const body = await page(admin, `?trail=${route.id}&moderated=1`);
    expect(body.trailId).toBe(route.id);
    expect(ids(body.comments)).toEqual([id]);
  });

  it('is 403 for a non-admin and 401 without a token, whatever else is sent', async () => {
    const device = await registerDevice();
    for (const query of ['?trail=heysen', '?trail=heysen&moderated=1', '?trail=nope', '?trail=heysen&cursor=%25']) {
      expect((await list(device, query)).status).toBe(403);
      expect((await SELF.fetch(url(`/v1/admin/comments${query}`))).status).toBe(401);
    }
  });

  it('finds the trail’s rows through an index led by trail_id, not a scan of the table', async () => {
    const cursor = { sortValue: '2026-01-01T00:00:00.000Z', id: '00000000-0000-4000-8000-000000000000' };
    for (const query of [
      { reportedOnly: false, trailId: 'heysen' },
      { reportedOnly: false, trailId: 'heysen', cursor },
      { reportedOnly: true, trailId: 'heysen', cursor },
      { reportedOnly: false, trailId: 'heysen', moderatedOnly: true, cursor },
    ]) {
      const { sql, binds } = adminCommentsSql(query);
      const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...binds, 501)
        .all<{ detail: string }>();
      const plan = results.map((r) => r.detail).join('\n');
      expect(plan).toMatch(/SEARCH c USING INDEX \w+ \(trail_id=\?/);
      expect(plan).not.toMatch(/SCAN c\b/);
    }
  });
});
