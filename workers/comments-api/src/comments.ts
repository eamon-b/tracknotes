/**
 * Comment endpoints: idempotent create, soft delete, per-waypoint feed,
 * trail-wide bulk/delta sync, the admin listing and the admin restore of a
 * comment hidden by reports (`reports.ts`).
 */

import { HttpError, json, noContent, readJson } from './http';
import type { Env } from './http';
import { getUser, requireAdmin, requireUser } from './auth';
import { appendSinceFilter, decodeCursor, encodeCursor } from './cursor';
import { deleteCommentPhotos, parsePhotoUrls } from './photos';
import { RATE_BUCKETS, consumeRateLimit, refundRateLimit } from './rate-limit';
import {
  assertClientCommentId,
  clampObservedAt,
  parseLimit,
  publishedObservedAt,
  validateCommentTarget,
  validateText,
  validateWaterStatus,
} from './validation';
import { resolveTrail } from './trails';
import { parseContentReview, reviewFlaggedSql, screenOnPost } from './content-review';
import type { CommentTarget } from './validation';
import type {
  AdminComment,
  AdminCommentReport,
  AdminCommentsResponse,
  BulkSyncResponse,
  FeedComment,
  FeedResponse,
  MyComment,
  MyCommentsResponse,
  SyncEntry,
  WaterStatus,
} from '../../../src/lib/comments-api-types';

const FEED_DEFAULT_LIMIT = 20;
const FEED_MAX_LIMIT = 100;
const BULK_DEFAULT_LIMIT = 500;
const BULK_MAX_LIMIT = 1000;
const MINE_DEFAULT_LIMIT = 500;
const MINE_MAX_LIMIT = 1000;
const ADMIN_DEFAULT_LIMIT = 100;
const ADMIN_MAX_LIMIT = 500;

/** A row as stored in the `comments` table. */
export interface CommentRow {
  id: string;
  trail_id: string;
  waypoint_id: string;
  user_id: string;
  text: string | null;
  water_status: WaterStatus | null;
  observed_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: 'owner' | 'admin' | 'reports' | null;
  photo_urls_json: string | null;
  /** JSON array of sha-256 hex digests, index-aligned with `photo_urls_json`. */
  photo_hashes_json: string | null;
  /** Last admin restore of a report hide; only reports after it count. */
  restored_at: string | null;
  /** The automated review (`content-review.ts`): status, the review as JSON, when it was claimed. */
  review_status: string | null;
  review_json: string | null;
  review_requested_at: string | null;
}

function toFeedComment(row: CommentRow, displayName: string): FeedComment {
  return {
    id: row.id,
    waypointId: row.waypoint_id,
    displayName,
    text: row.text,
    waterStatus: row.water_status,
    observedAt: publishedObservedAt(row.observed_at),
    createdAt: row.created_at,
    photoUrls: parsePhotoUrls(row.photo_urls_json),
  };
}

/**
 * Refuse a comment on a place no screen would show it under, where that is
 * cheap to know. A shared hiker waypoint is one row: it must exist on this
 * trail and still be shared (an owner's unshare, a report or an admin hide
 * all tombstone it). Curated, community-route and OSM ids are checked by form
 * only — the worker carries neither the waypoint registry, a route's stored
 * trail nor the trails' POI lists, and a registry entry the build has just
 * minted must not need a worker deploy.
 */
async function assertCommentTargetExists(env: Env, target: CommentTarget, trailId: string): Promise<void> {
  if (target.kind !== 'shared') return;
  const row = await env.DB.prepare(`SELECT trail_id, deleted_at FROM shared_waypoints WHERE id = ?`)
    .bind(target.id)
    .first<{ trail_id: string; deleted_at: string | null }>();
  if (!row || row.trail_id !== trailId) {
    throw new HttpError(404, 'waypoint_not_found', 'No shared waypoint with this id on this trail');
  }
  if (row.deleted_at !== null) {
    throw new HttpError(410, 'waypoint_deleted', 'This shared waypoint is no longer shared');
  }
}

// ---------------------------------------------------------------------------
// PUT /v1/comments/:id — idempotent create
// ---------------------------------------------------------------------------

export async function putComment(request: Request, env: Env, ctx: ExecutionContext, id: string): Promise<Response> {
  assertClientCommentId(id);
  const user = await requireUser(request, env, ctx);

  const body = await readJson(request);

  // Idempotency: if this client id already exists, replay it (or 409 if it
  // belongs to someone else). Ahead of validating the body, and skipping the
  // ban and rate-limit checks, because the row is already stored — a byte-safe
  // outbox retry must always succeed, even of a comment stored under rules
  // that have since been tightened.
  const existing = await env.DB.prepare(`SELECT * FROM comments WHERE id = ?`).bind(id).first<CommentRow>();
  if (existing) {
    if (existing.user_id !== user.id) {
      throw new HttpError(409, 'id_conflict', 'This comment id belongs to another user');
    }
    return json(toFeedComment(existing, user.display_name), 200);
  }

  // A curated trail or a live community route (`trails.ts`); the trail's kind
  // decides which waypoint ids it has.
  const trail = await resolveTrail(env, body.trailId, 'public-write');
  const trailId = trail.id;
  const target = validateCommentTarget(body.waypointId, trail.kind);
  const waypointId = target.id;
  const text = validateText(body.text);
  const waterStatus = validateWaterStatus(body.waterStatus);
  if (text === null && waterStatus === null) {
    throw new HttpError(400, 'empty_comment', 'A comment must include text, a water status, or both');
  }
  const nowMs = Date.now();
  const observedAt = clampObservedAt(body.observedAt, nowMs);

  // New comment — enforce moderation guards.
  if (user.is_banned === 1) {
    throw new HttpError(403, 'banned', 'This account may not post comments');
  }

  await assertCommentTargetExists(env, target, trailId);

  const spec = RATE_BUCKETS.commentPost;
  const rateEvent = await consumeRateLimit(
    env,
    spec,
    user.id,
    nowMs,
    `Comment limit of ${spec.limit} per day reached`,
    ctx
  );

  const nowIso = new Date(nowMs).toISOString();
  const inserted = await env.DB.prepare(
    `INSERT INTO comments
       (id, trail_id, waypoint_id, user_id, text, water_status, observed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING
     RETURNING *`
  )
    .bind(id, trailId, waypointId, user.id, text, waterStatus, observedAt, nowIso, nowIso)
    .first<CommentRow>();

  if (!inserted) {
    // Lost a race with a concurrent insert of the same id: nothing new was
    // stored, so the allowance goes back. Re-read and replay.
    await refundRateLimit(env, rateEvent);
    const row = await env.DB.prepare(`SELECT * FROM comments WHERE id = ?`).bind(id).first<CommentRow>();
    if (!row) {
      throw new HttpError(500, 'insert_failed', 'Comment could not be stored');
    }
    if (row.user_id !== user.id) {
      throw new HttpError(409, 'id_conflict', 'This comment id belongs to another user');
    }
    return json(toFeedComment(row, user.display_name), 200);
  }

  if (text !== null) ctx.waitUntil(screenOnPost(env, 'comment', id, text));
  return json(toFeedComment(inserted, user.display_name), 201);
}

// ---------------------------------------------------------------------------
// DELETE /v1/comments/:id — soft delete (owner or admin)
// ---------------------------------------------------------------------------

export async function deleteComment(request: Request, env: Env, ctx: ExecutionContext, id: string): Promise<Response> {
  const user = await requireUser(request, env, ctx);

  const row = await env.DB.prepare(`SELECT * FROM comments WHERE id = ?`).bind(id).first<CommentRow>();
  if (!row) {
    throw new HttpError(404, 'not_found', 'Comment not found');
  }

  const isOwner = row.user_id === user.id;
  const isAdmin = user.is_admin === 1;
  if (!isOwner && !isAdmin) {
    throw new HttpError(403, 'forbidden', 'You may only delete your own comments');
  }

  const deletedBy = isOwner ? 'owner' : 'admin';
  if (row.deleted_at !== null) {
    // Idempotent: already tombstoned → 204 without touching anything. A hide
    // by reports is provisional (it keeps the photos so an admin can restore
    // it), so the owner's or an admin's delete makes it final.
    if (row.deleted_by !== 'reports') return noContent();
    const finalised = await env.DB.prepare(
      `UPDATE comments
          SET deleted_by = ?, updated_at = ?, photo_urls_json = NULL, photo_hashes_json = NULL
        WHERE id = ? AND deleted_by = 'reports'
        RETURNING id`
    )
      .bind(deletedBy, new Date().toISOString(), id)
      .first<{ id: string }>();
    if (finalised && row.photo_urls_json !== null) {
      ctx.waitUntil(deleteCommentPhotos(env, id));
    }
    return noContent();
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE comments
        SET deleted_at = ?, deleted_by = ?, updated_at = ?,
            photo_urls_json = NULL, photo_hashes_json = NULL
      WHERE id = ?`
  )
    .bind(now, deletedBy, now, id)
    .run();

  // Tombstoned comments must not leak images: best-effort R2 cleanup off the
  // response path. Already-cached client URLs may 404 afterwards — that's fine.
  if (row.photo_urls_json !== null) {
    ctx.waitUntil(deleteCommentPhotos(env, id));
  }

  return noContent();
}

// ---------------------------------------------------------------------------
// GET /v1/trails/:trailId/waypoints/:waypointId/comments — public feed
// ---------------------------------------------------------------------------

export async function getWaypointFeed(
  request: Request,
  env: Env,
  trailId: string,
  waypointId: string
): Promise<Response> {
  const url = new URL(request.url);
  const limit = parseLimit(url.searchParams.get('limit'), FEED_DEFAULT_LIMIT, FEED_MAX_LIMIT);
  const cursor = decodeCursor(url.searchParams.get('cursor'));

  const conditions = ['c.trail_id = ?', 'c.waypoint_id = ?', 'c.deleted_at IS NULL'];
  const binds: unknown[] = [trailId, waypointId];
  if (cursor) {
    // Newest-first keyset: advance to strictly-older rows.
    conditions.push('(c.created_at < ? OR (c.created_at = ? AND c.id < ?))');
    binds.push(cursor.sortValue, cursor.sortValue, cursor.id);
  }

  const sql = `SELECT c.*, u.display_name AS display_name
       FROM comments c JOIN users u ON u.id = c.user_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT ?`;
  binds.push(limit + 1);

  const { results } = await env.DB.prepare(sql)
    .bind(...binds)
    .all<CommentRow & { display_name: string }>();

  let nextCursor: string | null = null;
  const page = results;
  if (page.length > limit) {
    page.length = limit;
    const last = page[page.length - 1];
    nextCursor = encodeCursor(last.created_at, last.id);
  }

  const comments: FeedComment[] = page.map((row) => toFeedComment(row, row.display_name));
  const payload: FeedResponse = { comments, nextCursor };
  return json(payload);
}

// ---------------------------------------------------------------------------
// GET /v1/trails/:trailId/comments — public bulk / delta sync
// ---------------------------------------------------------------------------

export async function getBulkSync(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  trailId: string
): Promise<Response> {
  const url = new URL(request.url);
  // The read stays public. A token only adds `mine` to live rows; a missing,
  // bad, revoked or expired one reads as anonymous rather than failing.
  const viewer = await getUser(request, env, ctx);
  const viewerId = viewer?.id ?? null;
  const limit = parseLimit(url.searchParams.get('limit'), BULK_DEFAULT_LIMIT, BULK_MAX_LIMIT);
  const cursor = decodeCursor(url.searchParams.get('cursor'));
  const since = url.searchParams.get('since');
  const syncedAt = new Date().toISOString();

  const conditions = ['c.trail_id = ?'];
  const binds: unknown[] = [trailId];

  if (since) {
    // Delta mode: everything touched since `since`, tombstones included.
    appendSinceFilter(conditions, binds, 'c.updated_at', since);
  } else {
    // Snapshot mode: only live rows.
    conditions.push('c.deleted_at IS NULL');
  }

  if (cursor) {
    // Ascending keyset: continue from the last (updated_at, id) seen.
    conditions.push('(c.updated_at > ? OR (c.updated_at = ? AND c.id > ?))');
    binds.push(cursor.sortValue, cursor.sortValue, cursor.id);
  }

  const sql = `SELECT c.*, u.display_name AS display_name
       FROM comments c JOIN users u ON u.id = c.user_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY c.updated_at ASC, c.id ASC
      LIMIT ?`;
  binds.push(limit + 1);

  const { results } = await env.DB.prepare(sql)
    .bind(...binds)
    .all<CommentRow & { display_name: string }>();

  let nextCursor: string | null = null;
  const page = results;
  if (page.length > limit) {
    page.length = limit;
    const last = page[page.length - 1];
    nextCursor = encodeCursor(last.updated_at, last.id);
  }

  const comments: SyncEntry[] = page.map((row) => {
    if (row.deleted_at !== null) {
      return {
        id: row.id,
        waypointId: row.waypoint_id,
        deleted: true as const,
        updatedAt: row.updated_at,
      };
    }
    return {
      id: row.id,
      waypointId: row.waypoint_id,
      displayName: row.display_name,
      text: row.text,
      waterStatus: row.water_status,
      observedAt: publishedObservedAt(row.observed_at),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      photoUrls: parsePhotoUrls(row.photo_urls_json),
      ...(viewerId !== null ? { mine: row.user_id === viewerId } : {}),
    };
  });

  const payload: BulkSyncResponse = { comments, nextCursor, syncedAt };
  // A token-bearing response is personal (`mine`), so no shared cache may keep it.
  return json(payload, 200, viewerId !== null ? { 'Cache-Control': 'private, no-store' } : {});
}

// ---------------------------------------------------------------------------
// GET /v1/me/comments — the caller's own comments (personal export)
// ---------------------------------------------------------------------------

/**
 * Every comment the account posted, oldest first, deleted and hidden ones
 * included with when and by whom: the hiker's copy of what the server holds.
 * No display name, as in every export. Any of the account's tokens may read it,
 * a linked browser included; it is personal, so no shared cache may keep it.
 */
export async function getMyComments(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const user = await requireUser(request, env, ctx);
  const url = new URL(request.url);
  const limit = parseLimit(url.searchParams.get('limit'), MINE_DEFAULT_LIMIT, MINE_MAX_LIMIT);
  const cursor = decodeCursor(url.searchParams.get('cursor'));

  const conditions = ['user_id = ?'];
  const binds: unknown[] = [user.id];
  if (cursor) {
    conditions.push('(created_at > ? OR (created_at = ? AND id > ?))');
    binds.push(cursor.sortValue, cursor.sortValue, cursor.id);
  }
  binds.push(limit + 1);

  const { results } = await env.DB.prepare(
    `SELECT * FROM comments
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at ASC, id ASC
      LIMIT ?`
  )
    .bind(...binds)
    .all<CommentRow>();

  let nextCursor: string | null = null;
  const page = results;
  if (page.length > limit) {
    page.length = limit;
    const last = page[page.length - 1];
    nextCursor = encodeCursor(last.created_at, last.id);
  }

  const comments: MyComment[] = page.map((row) => ({
    id: row.id,
    trailId: row.trail_id,
    waypointId: row.waypoint_id,
    text: row.text,
    waterStatus: row.water_status,
    observedAt: publishedObservedAt(row.observed_at),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    photoUrls: parsePhotoUrls(row.photo_urls_json) ?? [],
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by,
  }));

  const payload: MyCommentsResponse = { comments, nextCursor };
  return json(payload, 200, { 'Cache-Control': 'private, no-store' });
}

// ---------------------------------------------------------------------------
// GET /v1/admin/comments — admin listing (newest across all trails, or one trail to its end)
// ---------------------------------------------------------------------------

/**
 * The `json_group_array` of a row's reports, newest first. SQLite does not
 * promise an aggregate keeps a subquery's order, so the sort is done here.
 */
export function parseAdminReports(raw: string | null): AdminCommentReport[] {
  const reports = raw ? (JSON.parse(raw) as AdminCommentReport[]) : [];
  return reports.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

/** A comment with a report, or one the automated review has looked at: what `?reported=1` lists. */
const REPORTED_OR_REVIEWED_SQL = 'c.id IN (SELECT comment_id FROM comment_reports) OR c.review_status IS NOT NULL';

/**
 * What `?moderated=1` lists: every comment moderation has touched and its
 * author has not withdrawn — taken down by reports, the review or an admin,
 * or still published with a report or a review result.
 */
const MODERATED_SQL = `c.deleted_by IS NOT 'owner' AND (c.deleted_at IS NOT NULL OR ${REPORTED_OR_REVIEWED_SQL})`;

export interface AdminCommentsQuery {
  /** `?reported=1`: only comments with a report or a review result. */
  reportedOnly: boolean;
  /** `?trail=`: only this trail's comments, in keyset order. */
  trailId?: string;
  /** `?moderated=1` (with `trail`): only what moderation has touched (`MODERATED_SQL`). */
  moderatedOnly?: boolean;
  /** `?cursor=` (with `trail`): continue after this `(created_at, id)`. */
  cursor?: { sortValue: string; id: string } | null;
}

/**
 * The listing's SQL and its binds, bar the final LIMIT bind.
 *
 * Across every trail it is one read with no cursor: every comment newest
 * first, which walks `idx_comments_created` (migration 0013) backwards and
 * stops at the LIMIT; or with `reportedOnly` the reported or reviewed ones,
 * driven from the reports' own index and the reviewed rows' partial index (a
 * post the screen flagged may have no report), so it scales with what was
 * reported or reviewed.
 *
 * For one trail it is always newest first by `(created_at, id)`, whatever
 * `reportedOnly` says: both columns are immutable, so a keyset over them
 * neither skips nor repeats a row however the rows change between pages,
 * which the reported-first order (hidden, flagged, a report count that moves
 * with every report) cannot promise.
 *
 * Either way the reports themselves are gathered only for the page, outside
 * the LIMIT; the outer query repeats the order, which a subquery's does not
 * carry.
 */
export function adminCommentsSql(query: AdminCommentsQuery): { sql: string; binds: unknown[] } {
  const { reportedOnly, trailId, moderatedOnly = false, cursor = null } = query;
  const binds: unknown[] = [];
  let where: string;
  if (trailId === undefined) {
    where = reportedOnly ? `WHERE ${REPORTED_OR_REVIEWED_SQL}` : '';
  } else {
    const conditions = ['c.trail_id = ?'];
    binds.push(trailId);
    if (reportedOnly) conditions.push(`(${REPORTED_OR_REVIEWED_SQL})`);
    if (moderatedOnly) conditions.push(MODERATED_SQL);
    if (cursor) {
      // Newest-first keyset: advance to strictly-older rows.
      conditions.push('(c.created_at < ? OR (c.created_at = ? AND c.id < ?))');
      binds.push(cursor.sortValue, cursor.sortValue, cursor.id);
    }
    where = `WHERE ${conditions.join(' AND ')}`;
  }
  const order = (a: string, count: string) =>
    reportedOnly && trailId === undefined
      ? `(${a}.deleted_by IS 'reports') DESC, ${reviewFlaggedSql(a)} DESC, ${count} DESC, ${a}.created_at DESC, ${a}.id DESC`
      : `${a}.created_at DESC, ${a}.id DESC`;
  const sql = `SELECT p.*,
            (SELECT json_group_array(json_object(
                      'id', r.id, 'reporterUserId', r.user_id,
                      'reporterDisplayName', ru.display_name, 'reason', r.reason,
                      'detail', r.detail, 'createdAt', r.created_at))
               FROM comment_reports r JOIN users ru ON ru.id = r.user_id
              WHERE r.comment_id = p.id) AS reports_json
       FROM (SELECT c.*, u.display_name AS display_name, u.is_banned AS user_banned,
                    u.is_admin AS user_admin, u.deleted_at AS user_deleted_at,
                    (SELECT COUNT(*) FROM comment_reports r WHERE r.comment_id = c.id) AS report_count
               FROM comments c JOIN users u ON u.id = c.user_id
              ${where}
              ORDER BY ${order('c', 'report_count')}
              LIMIT ?) p
      ORDER BY ${order('p', 'p.report_count')}`;
  return { sql, binds };
}

/**
 * Across every trail (no `trail`): every comment, newest first; with
 * `?reported=1` only the reported or reviewed ones: those hidden by reports or
 * the review first, then those the review would remove or wants a human for,
 * then by report count. One read of up to `limit` rows, with no cursor.
 *
 * For one trail (`?trail=<id>`, a curated trail or a community route): that
 * trail's comments newest first by `(created_at, id)`, paged to the end with
 * `cursor` (the response's `nextCursor`, null on the last page). `reported=1`
 * narrows it as above (the order stays newest first), `moderated=1` to what
 * moderation has touched (`MODERATED_SQL`): the set the waypoint editor lays
 * over a trail's public comments. The response echoes `trailId`, which a
 * worker from before the filter does not, so a client can tell an answer for
 * its trail from an unfiltered one. `cursor` and `moderated` are refused
 * without `trail`.
 *
 * Each row carries its reports (reason and detail) and whether its author is
 * banned, which is what the moderation page (`src/web/admin-moderation.ts`)
 * acts on.
 */
export async function getAdminComments(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  await requireAdmin(request, env, ctx);
  const url = new URL(request.url);
  const limit = parseLimit(url.searchParams.get('limit'), ADMIN_DEFAULT_LIMIT, ADMIN_MAX_LIMIT);
  const reportedOnly = url.searchParams.get('reported') === '1';
  const moderatedOnly = url.searchParams.get('moderated') === '1';
  const trailRaw = url.searchParams.get('trail');
  const cursor = decodeCursor(url.searchParams.get('cursor'));

  let trailId: string | undefined;
  if (trailRaw !== null) {
    trailId = (await resolveTrail(env, trailRaw, 'read')).id;
  } else {
    // Only a trail's listing has a keyset order, and only it is narrow enough
    // for the moderated filter to stay off a walk of the whole table.
    if (cursor) throw new HttpError(400, 'invalid_cursor', 'cursor needs trail: only one trail’s listing is paged');
    if (moderatedOnly) throw new HttpError(400, 'invalid_moderated', 'moderated=1 needs trail');
  }

  const { sql, binds } = adminCommentsSql({ reportedOnly, trailId, moderatedOnly, cursor });
  const { results } = await env.DB.prepare(sql)
    // A trail's page reads one row past the limit to learn whether there is another.
    .bind(...binds, trailId === undefined ? limit : limit + 1)
    .all<
      CommentRow & {
        display_name: string;
        user_banned: number;
        user_admin: number;
        user_deleted_at: string | null;
        report_count: number;
        reports_json: string | null;
      }
    >();

  let nextCursor: string | null = null;
  if (trailId !== undefined && results.length > limit) {
    results.length = limit;
    const last = results[results.length - 1];
    nextCursor = encodeCursor(last.created_at, last.id);
  }

  const comments: AdminComment[] = results.map((row) => {
    const reports = parseAdminReports(row.reports_json);
    return {
      id: row.id,
      trailId: row.trail_id,
      waypointId: row.waypoint_id,
      userId: row.user_id,
      displayName: row.display_name,
      userBanned: row.user_banned === 1,
      userAdmin: row.user_admin === 1,
      userDeleted: row.user_deleted_at !== null,
      text: row.text,
      waterStatus: row.water_status,
      observedAt: publishedObservedAt(row.observed_at),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
      deletedBy: row.deleted_by,
      restoredAt: row.restored_at,
      photoUrls: parsePhotoUrls(row.photo_urls_json) ?? [],
      reportCount: row.report_count,
      reports,
      review: parseContentReview(row.review_json),
    };
  });

  // The unfiltered answer keeps the shape it has always had.
  const payload: AdminCommentsResponse = trailId === undefined ? { comments } : { comments, trailId, nextCursor };
  return json(payload);
}

// ---------------------------------------------------------------------------
// POST /v1/admin/comments/:id/restore — undo a report hide, or keep a live one
// ---------------------------------------------------------------------------

/**
 * Undo a hide by reports. Reports filed before the restore no longer count
 * towards hiding it again, and the automated review never claims it again.
 * On a live comment it is the admin's "Keep": it sets `restored_at` the same
 * way (settling its reports and review) and leaves `updated_at` alone, since
 * nothing a phone sees changes. An owner's or admin's delete is final — it
 * has already removed the photos — so it is refused.
 */
export async function adminRestoreComment(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  id: string
): Promise<Response> {
  assertClientCommentId(id);
  await requireAdmin(request, env, ctx);
  const row = await env.DB.prepare(`SELECT deleted_at, deleted_by FROM comments WHERE id = ?`)
    .bind(id)
    .first<Pick<CommentRow, 'deleted_at' | 'deleted_by'>>();
  if (!row) throw new HttpError(404, 'not_found', 'Comment not found');
  if (row.deleted_at === null) {
    await env.DB.prepare(`UPDATE comments SET restored_at = ? WHERE id = ? AND deleted_at IS NULL`)
      .bind(new Date().toISOString(), id)
      .run();
    return noContent();
  }
  if (row.deleted_by !== 'reports') {
    throw new HttpError(
      409,
      row.deleted_by === 'owner' ? 'owner_deleted' : 'admin_deleted',
      row.deleted_by === 'owner'
        ? 'Its author deleted this comment'
        : 'An admin deleted this comment; that cannot be undone'
    );
  }
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE comments
        SET deleted_at = NULL, deleted_by = NULL, restored_at = ?, updated_at = ?
      WHERE id = ? AND deleted_by = 'reports'`
  )
    .bind(now, now, id)
    .run();
  return noContent();
}
