/**
 * How many reported or flagged posts are waiting for an admin, for the daily
 * Moderation queue workflow (`scripts/moderation-queue.ts`, issue #365).
 *
 *   GET /v1/admin/moderation/counts   Authorization: Bearer <MODERATION_COUNTS_TOKEN>
 *
 * Its own credential, the worker secret `MODERATION_COUNTS_TOKEN`, accepted on
 * this route and nowhere else: it reads four numbers and cannot list, restore,
 * delete or ban anything, so the GitHub environment that runs the check need
 * not hold an admin's token. Not a device token (nothing in D1), so an admin
 * device token is refused here too, and the route answers 401 while the secret
 * is unset or shorter than `MIN_COUNTS_TOKEN_LENGTH`.
 *
 * "Waiting" is the rule the moderation page highlights with
 * (`needsAttention`, `@lib/moderation-attention`), in SQL: hidden by reports or
 * the review (`deleted_by = 'reports'`), or live, never restored or kept, with
 * a review verdict that is not `keep`. "Hidden" is the first arm alone.
 * The test suite checks the two agree on the admin listings.
 */

import { HttpError, json } from './http';
import type { Env } from './http';
import { parseBearer, sha256Hex } from './auth';
import type { ModerationCountsResponse, ModerationQueueCounts } from '../../../src/lib/comments-api-types';

/** A shorter secret is treated as unset: the route refuses every caller. */
export const MIN_COUNTS_TOKEN_LENGTH = 32;

/**
 * Compare SHA-256 digests, not the strings: both are 64 hex characters whatever
 * was presented, and every character is compared (no early exit), so the time
 * taken says nothing about the secret.
 */
async function tokenMatches(presented: string, secret: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256Hex(presented), sha256Hex(secret)]);
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Require the counts token or throw 401 (never says whether the secret is set). */
async function requireCountsToken(request: Request, env: Env): Promise<void> {
  const presented = parseBearer(request);
  const secret = env.MODERATION_COUNTS_TOKEN;
  const configured = typeof secret === 'string' && secret.length >= MIN_COUNTS_TOKEN_LENGTH;
  if (!presented || !configured || !(await tokenMatches(presented, secret))) {
    throw new HttpError(401, 'unauthorized', 'The moderation counts token is required');
  }
}

/** `waiting` and `hidden` for one table, driven from its reports and reviewed rows like the admin listing. */
async function countTable(
  env: Env,
  table: 'comments' | 'shared_waypoints',
  reports: 'comment_reports' | 'shared_waypoint_reports',
  reportKey: 'comment_id' | 'waypoint_id'
): Promise<ModerationQueueCounts> {
  const row = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN t.deleted_by = 'reports'
                          OR (t.deleted_by IS NULL AND t.restored_at IS NULL
                              AND json_extract(t.review_json, '$.verdict') IN ('remove', 'needs_human'))
                         THEN 1 ELSE 0 END), 0) AS waiting,
       COALESCE(SUM(CASE WHEN t.deleted_by = 'reports' THEN 1 ELSE 0 END), 0) AS hidden
       FROM ${table} t
      WHERE t.id IN (SELECT ${reportKey} FROM ${reports}) OR t.review_status IS NOT NULL`
  ).first<{ waiting: number; hidden: number }>();
  return { waiting: row?.waiting ?? 0, hidden: row?.hidden ?? 0 };
}

export async function getModerationCounts(request: Request, env: Env): Promise<Response> {
  await requireCountsToken(request, env);
  const [comments, waypoints] = await Promise.all([
    countTable(env, 'comments', 'comment_reports', 'comment_id'),
    countTable(env, 'shared_waypoints', 'shared_waypoint_reports', 'waypoint_id'),
  ]);
  const payload: ModerationCountsResponse = {
    comments,
    waypoints,
    total: comments.waiting + waypoints.waiting,
  };
  return json(payload, 200, { 'Cache-Control': 'private, no-store' });
}
