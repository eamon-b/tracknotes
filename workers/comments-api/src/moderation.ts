/**
 * Account moderation: an admin bans or unbans an account.
 *
 *   POST /v1/admin/users/:id/ban   { banned: boolean, removeContent?: boolean }
 *
 * A banned account keeps its identity and can still read, sync and report
 * (reporting is a safety action), but may no longer post comments, photos,
 * shared waypoints, plans or community routes — every write path already
 * refuses `is_banned`. `removeContent` also takes down everything the account
 * has up, as an admin delete: its live comments (photos and all) and shared
 * waypoints, plus any a report hide is holding. Its community routes are left
 * to the community review page, where hiding one is a choice per route.
 *
 * `is_banned` is also what deleting an account sets, so a ban records
 * `banned_at`, and only a ban that has one can be lifted: a deleted account
 * stays deleted. Admin accounts cannot be banned; demote one in D1 first.
 */

import { HttpError, json, readJson } from './http';
import type { Env } from './http';
import { requireAdmin } from './auth';
import { deleteCommentPhotos } from './photos';
import type { BanUserResponse } from '../../../src/lib/comments-api-types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface UserBanRow {
  id: string;
  is_admin: number;
  is_banned: number;
  banned_at: string | null;
}

export async function adminBanUser(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  userId: string
): Promise<Response> {
  if (!UUID_RE.test(userId)) throw new HttpError(400, 'invalid_id', 'User id must be a uuid');
  const admin = await requireAdmin(request, env, ctx);
  const body = await readJson(request);
  if (typeof body.banned !== 'boolean') {
    throw new HttpError(400, 'invalid_banned', 'banned must be true or false');
  }
  if (body.removeContent !== undefined && typeof body.removeContent !== 'boolean') {
    throw new HttpError(400, 'invalid_remove_content', 'removeContent must be true or false');
  }
  const banned = body.banned;
  const removeContent = banned && body.removeContent === true;

  const user = await env.DB.prepare(
    `SELECT id, is_admin, is_banned, banned_at FROM users WHERE id = ?`
  )
    .bind(userId)
    .first<UserBanRow>();
  if (!user) throw new HttpError(404, 'not_found', 'User not found');
  if (user.id === admin.id || user.is_admin === 1) {
    throw new HttpError(400, 'cannot_ban_admin', 'An admin account cannot be banned');
  }

  const now = new Date().toISOString();
  if (!banned) {
    if (user.is_banned === 1 && user.banned_at === null) {
      throw new HttpError(409, 'account_deleted', 'This account was deleted, not banned');
    }
    await env.DB.prepare(
      `UPDATE users SET is_banned = 0, banned_at = NULL WHERE id = ? AND banned_at IS NOT NULL`
    )
      .bind(userId)
      .run();
    const payload: BanUserResponse = { userId, banned: false, removedComments: 0, removedWaypoints: 0 };
    return json(payload);
  }

  if (user.is_banned === 1 && user.banned_at === null) {
    // Deleted: already banned for good, and its content already tombstoned.
    const payload: BanUserResponse = { userId, banned: true, removedComments: 0, removedWaypoints: 0 };
    return json(payload);
  }

  // A repeat ban keeps the first `banned_at`.
  const statements = [
    env.DB.prepare(
      `UPDATE users SET is_banned = 1, banned_at = COALESCE(banned_at, ?) WHERE id = ?`
    ).bind(now, userId),
  ];
  let withPhotos: { id: string }[] = [];
  if (removeContent) {
    // Snapshot which comments have photos before the update clears the column.
    ({ results: withPhotos } = await env.DB.prepare(
      `SELECT id FROM comments
        WHERE user_id = ? AND photo_urls_json IS NOT NULL
          AND (deleted_at IS NULL OR deleted_by = 'reports')`
    )
      .bind(userId)
      .all<{ id: string }>());
    statements.push(
      env.DB.prepare(
        `UPDATE comments
            SET deleted_at = COALESCE(deleted_at, ?), deleted_by = 'admin', updated_at = ?,
                photo_urls_json = NULL, photo_hashes_json = NULL
          WHERE user_id = ? AND (deleted_at IS NULL OR deleted_by = 'reports')`
      ).bind(now, now, userId),
      env.DB.prepare(
        `UPDATE shared_waypoints
            SET deleted_at = COALESCE(deleted_at, ?), deleted_by = 'admin', updated_at = ?
          WHERE user_id = ? AND (deleted_at IS NULL OR deleted_by = 'reports')`
      ).bind(now, now, userId)
    );
  }
  const results = await env.DB.batch(statements);

  if (withPhotos.length > 0) {
    ctx.waitUntil(
      Promise.all(withPhotos.map((row) => deleteCommentPhotos(env, row.id))).then(() => undefined)
    );
  }

  const payload: BanUserResponse = {
    userId,
    banned: true,
    removedComments: removeContent ? (results[1].meta.changes ?? 0) : 0,
    removedWaypoints: removeContent ? (results[2].meta.changes ?? 0) : 0,
  };
  return json(payload);
}
