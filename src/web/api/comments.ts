/**
 * Read-only comment clients for the web, used by the local waypoint editor
 * (`admin-waypoints.html`) to show hikers' reports next to the waypoint they
 * are about. Nothing here writes.
 *
 * - `listTrailComments`: the public bulk read, `GET /v1/trails/:trailId/comments`
 *   in snapshot mode (no `since`, so live comments only, no tombstones), one
 *   request per page of up to 1000. No token is sent, so the response stays
 *   shareable by caches and carries no `mine`.
 * - `adminListModeratedComments`: `GET /v1/admin/comments?reported=1`, every
 *   reported or screen-flagged comment on every trail, hidden ones included.
 *   Admin only: the worker answers 403 to any other account.
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

/** The most the admin listing returns in one read (`ADMIN_MAX_LIMIT`). */
const ADMIN_LIST_LIMIT = 500;

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

/** Reported or flagged comments on every trail (hidden ones too), for an admin's linked browser. */
export async function adminListModeratedComments(
  session: WebSession,
  deps: CommentsApiDeps = {}
): Promise<AdminComment[]> {
  const body = await apiRequest<AdminCommentsResponse>(`/v1/admin/comments?reported=1&limit=${ADMIN_LIST_LIMIT}`, {
    token: session.token,
    fetchImpl: deps.fetchImpl,
    baseUrl: deps.baseUrl,
  });
  return body.comments;
}
