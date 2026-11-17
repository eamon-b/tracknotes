/**
 * Read-only comment clients for the web, used by the local waypoint editor
 * (`admin-waypoints.html`) to show hikers' reports next to the waypoint they
 * are about. Nothing here writes.
 *
 * - `listTrailComments`: the public bulk read, `GET /v1/trails/:trailId/comments`
 *   in snapshot mode (no `since`, so live comments only, no tombstones), one
 *   request per page of up to 1000. No token is sent, so the response stays
 *   shareable by caches and carries no `mine`.
 * - `adminListComments`: `GET /v1/admin/comments`, hidden and deleted comments
 *   included. Admin only: the worker answers 403 to any other account. The
 *   listing covers every trail, with no trail filter and no cursor, and stops
 *   at `ADMIN_LIST_LIMIT` rows, so it cannot be read to the end: a caller is
 *   told when a read came back full (`truncated`). It has two orders:
 *   everything, newest first; or with `?reported=1` only the comments that
 *   have a report or an automated-review status, those hidden by reports
 *   first. A comment an admin deleted that nobody reported and the review
 *   never flagged is in the first only.
 */

import type { AdminComment, AdminCommentsResponse, BulkSyncResponse, SyncComment } from '@lib/comments-api-types';
import { isSyncTombstone } from '@lib/comments-api-types';
import { apiRequest, type FetchLike } from './client';
import type { WebSession } from './session';

export interface CommentsApiDeps {
  fetchImpl?: FetchLike;
  baseUrl?: string;
}

/** The largest page the bulk endpoint serves (`BULK_MAX_LIMIT` in the worker). */
const BULK_PAGE_LIMIT = 1000;

/** The most the admin listing returns in one read (`ADMIN_MAX_LIMIT` in the worker). */
export const ADMIN_LIST_LIMIT = 500;

/** Every live comment on a trail, following the keyset cursor to the end. */
export async function listTrailComments(trailId: string, deps: CommentsApiDeps = {}): Promise<SyncComment[]> {
  const comments: SyncComment[] = [];
  let cursor: string | null = null;
  do {
    const qs = new URLSearchParams({ limit: String(BULK_PAGE_LIMIT) });
    if (cursor) qs.set('cursor', cursor);
    const page: BulkSyncResponse = await apiRequest<BulkSyncResponse>(
      `/v1/trails/${encodeURIComponent(trailId)}/comments?${qs.toString()}`,
      { fetchImpl: deps.fetchImpl, baseUrl: deps.baseUrl }
    );
    // Snapshot mode sends no tombstones; skipping them keeps a delta-shaped answer harmless.
    for (const entry of page.comments) if (!isSyncTombstone(entry)) comments.push(entry);
    cursor = page.nextCursor;
  } while (cursor);
  return comments;
}

/** One read of the admin listing. */
export interface AdminListing {
  comments: AdminComment[];
  /**
   * The read came back with as many rows as one read may hold, so there may be
   * more the listing has no way to send (it has no cursor).
   */
  truncated: boolean;
}

/**
 * One read of the admin listing across every trail, for an admin's linked
 * browser: every comment newest first, or with `reportedOnly` the reported and
 * review-flagged ones (hidden by reports first).
 */
export async function adminListComments(
  session: WebSession,
  options: { reportedOnly: boolean },
  deps: CommentsApiDeps = {}
): Promise<AdminListing> {
  const qs = new URLSearchParams();
  if (options.reportedOnly) qs.set('reported', '1');
  qs.set('limit', String(ADMIN_LIST_LIMIT));
  const body = await apiRequest<AdminCommentsResponse>(`/v1/admin/comments?${qs.toString()}`, {
    token: session.token,
    fetchImpl: deps.fetchImpl,
    baseUrl: deps.baseUrl,
  });
  return { comments: body.comments, truncated: body.comments.length >= ADMIN_LIST_LIMIT };
}
