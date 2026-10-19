/**
 * Which trail ids the comments, plan and shared-waypoint routes take.
 *
 * Two kinds: the curated trails (`ALLOWED_TRAILS`, held equal to the bundled
 * ones) and community routes (`c_…`, a row in `community_routes`). Anything
 * else — a `u_` import above all — is refused, so a client's "is this trail
 * server-known?" gate going wrong can never put someone's private import on
 * the server.
 *
 * What a community route takes depends on what is asked of it:
 *
 * - `public-write` (a comment, a shared hiker waypoint): only a live route
 *   (`unverified` or `verified`). A hidden or removed route is not shown to
 *   anyone, so nothing new is published on it — 403 `trail_not_live`.
 * - `private-write` (a plan) and `read` (the public feeds): any route the
 *   server has a row for, whatever its status. A plan is the hiker's private
 *   document, and a hiker on trail keeps the copy of a route that was taken
 *   down ("No longer shared" on the phone), so planning on it goes on. The
 *   feeds keep answering what was posted while the route was up.
 *
 * Rows in `community_routes` are never deleted (a removal is a tombstone), so
 * "this id is a community route" is cached for the life of the isolate; "it is
 * live" only for `LIVE_CACHE_MS`, so a hide stops new comments within a
 * minute without a status read on every comment.
 */

import { HttpError } from './http';
import type { Env } from './http';
import { ALLOWED_TRAILS } from './validation';
import { PUBLIC_COMMUNITY_STATUSES, isCommunityRouteId } from '../../../src/lib/community-types';
import type { CommunityRouteStatus } from '../../../src/lib/community-types';
import type { CommentTrailKind } from '../../../src/lib/comment-targets';

export type TrailUse = 'public-write' | 'private-write' | 'read';

/** How long a route read as live is taken to still be live without a read. */
export const LIVE_CACHE_MS = 60_000;
/** Past this many entries the cache starts over rather than growing. */
const CACHE_MAX_ENTRIES = 5_000;

interface CachedRoute {
  live: boolean;
  readAt: number;
}

const routeCache = new Map<string, CachedRoute>();

/** Test seam: forget every cached route. */
export function clearTrailCache(): void {
  routeCache.clear();
}

async function readRoute(env: Env, id: string, nowMs: number): Promise<CachedRoute | null> {
  const row = await env.DB.prepare(`SELECT status FROM community_routes WHERE id = ?`)
    .bind(id)
    .first<{ status: CommunityRouteStatus }>();
  if (!row) return null;
  const entry = { live: PUBLIC_COMMUNITY_STATUSES.includes(row.status), readAt: nowMs };
  if (routeCache.size >= CACHE_MAX_ENTRIES) routeCache.clear();
  routeCache.set(id, entry);
  return entry;
}

export interface TrailRefusal {
  code: string;
  message: string;
}

const UNKNOWN_TRAIL: TrailRefusal = { code: 'invalid_trail', message: 'Unknown or missing trailId' };

/**
 * Resolve a trail id for `use`, returning its kind, or throw: 400 with
 * `unknown` (default `invalid_trail`) for an id that is neither a curated
 * trail nor a community route; 403 `trail_not_live` for a public write on a
 * route that is hidden or removed.
 */
export async function resolveTrail(
  env: Env,
  raw: unknown,
  use: TrailUse,
  unknown: TrailRefusal = UNKNOWN_TRAIL
): Promise<{ id: string; kind: CommentTrailKind }> {
  if (typeof raw === 'string' && ALLOWED_TRAILS.includes(raw)) {
    return { id: raw, kind: 'curated' };
  }
  if (typeof raw !== 'string' || !isCommunityRouteId(raw)) {
    throw new HttpError(400, unknown.code, unknown.message);
  }

  const nowMs = Date.now();
  let route = routeCache.get(raw) ?? null;
  const fresh = route !== null && route.live && nowMs - route.readAt < LIVE_CACHE_MS;
  if (route === null || (use === 'public-write' && !fresh)) {
    route = await readRoute(env, raw, nowMs);
  }
  if (route === null) {
    throw new HttpError(400, unknown.code, unknown.message);
  }
  if (use === 'public-write' && !route.live) {
    throw new HttpError(
      403,
      'trail_not_live',
      'This community route is not shared at the moment, so it takes nothing new'
    );
  }
  return { id: raw, kind: 'community' };
}
