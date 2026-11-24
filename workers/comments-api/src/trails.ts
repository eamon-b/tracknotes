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
 *   down ("No longer shared" on the phone), so planning on it goes on.
 *
 * A `read` also says whether the route's public feeds are open (`feedOpen`):
 * a removed route's feeds close `REMOVED_ROUTE_FEED_DAYS` after its removal
 * (issue #386). Until then a hiker out on a copy they hold keeps its water and
 * hazard notes; after it, the comments and shared waypoints posted on it are
 * not served to anyone (admins still see them). A hidden route's feeds stay
 * open, since a hide can be undone.
 *
 * Rows in `community_routes` are never deleted (a removal is a tombstone), so
 * "this id is a community route" is cached for the life of the isolate; "it is
 * live" only for `LIVE_CACHE_MS`, so a hide stops new comments within a
 * minute without a status read on every comment. A `read` re-reads an entry
 * older than that unless it is already removed (a removal is final), so a
 * feed learns of a removal, and so of when it closes, within a minute too.
 */

import { HttpError } from './http';
import type { Env } from './http';
import { ALLOWED_TRAILS } from './validation';
import {
  PUBLIC_COMMUNITY_STATUSES,
  REMOVED_ROUTE_FEED_DAYS,
  isCommunityRouteId,
} from '../../../src/lib/community-types';
import type { CommunityRouteStatus } from '../../../src/lib/community-types';
import type { CommentTrailKind } from '../../../src/lib/comment-targets';

export type TrailUse = 'public-write' | 'private-write' | 'read';

/** How long a route read as live is taken to still be live without a read. */
export const LIVE_CACHE_MS = 60_000;
/** Past this many entries the cache starts over rather than growing. */
const CACHE_MAX_ENTRIES = 5_000;
/** How long a removed route's public feeds keep answering after its removal. */
export const REMOVED_FEED_MS = REMOVED_ROUTE_FEED_DAYS * 24 * 60 * 60 * 1000;

interface CachedRoute {
  live: boolean;
  /** Set once the route is removed: its `removed_at` in ms (0 when the row has none). */
  removedAtMs: number | null;
  readAt: number;
}

const routeCache = new Map<string, CachedRoute>();

/** Test seam: forget every cached route. */
export function clearTrailCache(): void {
  routeCache.clear();
}

async function readRoute(env: Env, id: string, nowMs: number): Promise<CachedRoute | null> {
  const row = await env.DB.prepare(`SELECT status, removed_at FROM community_routes WHERE id = ?`)
    .bind(id)
    .first<{ status: CommunityRouteStatus; removed_at: string | null }>();
  if (!row) return null;
  let removedAtMs: number | null = null;
  if (row.status === 'removed') {
    const parsed = row.removed_at ? Date.parse(row.removed_at) : NaN;
    removedAtMs = Number.isFinite(parsed) ? parsed : 0;
  }
  const entry = { live: PUBLIC_COMMUNITY_STATUSES.includes(row.status), removedAtMs, readAt: nowMs };
  if (routeCache.size >= CACHE_MAX_ENTRIES) routeCache.clear();
  routeCache.set(id, entry);
  return entry;
}

export interface TrailRefusal {
  code: string;
  message: string;
}

const UNKNOWN_TRAIL: TrailRefusal = { code: 'invalid_trail', message: 'Unknown or missing trailId' };

export interface ResolvedTrail {
  id: string;
  kind: CommentTrailKind;
  /**
   * Whether the public feeds answer for it: false only for a community route
   * removed more than `REMOVED_FEED_MS` ago. Read fresh only for a `read`.
   */
  feedOpen: boolean;
}

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
): Promise<ResolvedTrail> {
  if (typeof raw === 'string' && ALLOWED_TRAILS.includes(raw)) {
    return { id: raw, kind: 'curated', feedOpen: true };
  }
  if (typeof raw !== 'string' || !isCommunityRouteId(raw)) {
    throw new HttpError(400, unknown.code, unknown.message);
  }

  const nowMs = Date.now();
  let route = routeCache.get(raw) ?? null;
  const fresh = route !== null && route.live && nowMs - route.readAt < LIVE_CACHE_MS;
  const staleForRead = route !== null && route.removedAtMs === null && nowMs - route.readAt >= LIVE_CACHE_MS;
  if (route === null || (use === 'public-write' && !fresh) || (use === 'read' && staleForRead)) {
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
  const feedOpen = route.removedAtMs === null || nowMs - route.removedAtMs < REMOVED_FEED_MS;
  return { id: raw, kind: 'community', feedOpen };
}

/**
 * Whether a public feed answers for `trailId`. The comment feeds take any id
 * (an unknown one simply has no rows), so only a community route is looked
 * up: it answers unless it was removed more than `REMOVED_FEED_MS` ago. An id
 * shaped like a community route with no row answers (empty) as before.
 */
export async function publicFeedOpen(env: Env, trailId: string): Promise<boolean> {
  if (!isCommunityRouteId(trailId)) return true;
  try {
    return (await resolveTrail(env, trailId, 'read')).feedOpen;
  } catch (err) {
    if (err instanceof HttpError && err.status === 400) return true;
    throw err;
  }
}
