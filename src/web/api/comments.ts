/**
 * Read-only comment clients for the web, used by the local waypoint editor
 * (`admin-waypoints.html`) to show hikers' reports next to the waypoint they
 * are about. Nothing here writes.
 *
 * - `listTrailComments`: the public bulk read, `GET /v1/trails/:trailId/comments`
 *   in snapshot mode (no `since`, so live comments only, no tombstones), one
 *   request per page of up to 1000. No token is sent, so the response stays
 *   shareable by caches and carries no `mine`.
 * - `adminListModeratedComments`: `GET /v1/admin/comments` for one trail, the
 *   comments moderation has touched (`?trail=<id>&moderated=1`): hidden by
 *   reports or the automated review, deleted by an admin, or still published
 *   with a report or a review result, but not ones their author deleted.
 *   Admin only: the worker answers 403 to any other account. It is read to
 *   the end by its keyset cursor, a bounded number of pages, and the answer
 *   says how far the read got (`ModeratedCoverage`).
 *   A worker that predates the trail filter ignores it and answers for every
 *   trail, with no cursor; its answer lacks the `trailId` echo, and the read
 *   then falls back to that worker's two orders of the whole listing (every
 *   comment newest first, and with `?reported=1` only those with a report or
 *   a review status, hidden by reports first), each of which stops at
 *   `ADMIN_LIST_LIMIT` rows.
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

/** How many pages of one trail's moderated comments a load follows before it stops and says so. */
const MODERATED_MAX_PAGES = 10;

/** The most moderated comments one load reads for a trail; past it the answer is `capped`. */
export const MODERATED_ROW_CAP = ADMIN_LIST_LIMIT * MODERATED_MAX_PAGES;

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

/**
 * How far a read of one trail's moderated comments got.
 * - `complete`: every one of them was read.
 * - `capped`: the trail has more than `MODERATED_ROW_CAP`; the newest that
 *   many were read and the read stopped.
 * - `interrupted`: a page after the first failed, so only the newest were read.
 *
 * From a worker that predates the trail filter (the listing of every trail,
 * read both ways it can be ordered) `complete` means the newest-first read
 * held every comment on every trail, and otherwise:
 * - `recent`: it was cut, so only the newest `ADMIN_LIST_LIMIT` comments on
 *   all trails are known from it; the reported-first read was whole, so every
 *   comment with a report or an automated-review result is known too. Missing:
 *   an older comment an admin deleted that nobody reported.
 * - `partial`: the reported-first read was cut as well, so some reported or
 *   hidden comments may be missing.
 */
export type ModeratedCoverage = 'complete' | 'capped' | 'interrupted' | 'recent' | 'partial';

/** A trail's moderated comments, as far as they were read. */
export interface ModeratedListing {
  /** Newest first. From a worker without the trail filter, rows of other trails are among them. */
  comments: AdminComment[];
  coverage: ModeratedCoverage;
}

/** One read of the listing of every trail, which is all a worker without the trail filter serves. */
async function adminListAllTrails(
  session: WebSession,
  reportedOnly: boolean,
  deps: CommentsApiDeps
): Promise<{ comments: AdminComment[]; truncated: boolean }> {
  const qs = new URLSearchParams();
  if (reportedOnly) qs.set('reported', '1');
  qs.set('limit', String(ADMIN_LIST_LIMIT));
  const body = await apiRequest<AdminCommentsResponse>(`/v1/admin/comments?${qs.toString()}`, {
    token: session.token,
    fetchImpl: deps.fetchImpl,
    baseUrl: deps.baseUrl,
  });
  // That listing has no cursor: a read that came back full may have left rows behind.
  return { comments: body.comments, truncated: body.comments.length >= ADMIN_LIST_LIMIT };
}

/**
 * The comments on `trailId` that moderation has touched, for an admin's linked
 * browser: one request sequence, following the cursor to the end or to
 * `MODERATED_ROW_CAP` rows.
 *
 * Throws (`ApiError`, `NetworkError`) only when the read fails before any of
 * the trail's rows came back, so a caller can tell "not an admin" from
 * "expired"; a later page that fails ends the read as `interrupted`, with the
 * pages already read.
 */
export async function adminListModeratedComments(
  session: WebSession,
  trailId: string,
  deps: CommentsApiDeps = {}
): Promise<ModeratedListing> {
  const readPage = (cursor: string | null): Promise<AdminCommentsResponse> => {
    const qs = new URLSearchParams({ trail: trailId, moderated: '1', limit: String(ADMIN_LIST_LIMIT) });
    if (cursor) qs.set('cursor', cursor);
    return apiRequest<AdminCommentsResponse>(`/v1/admin/comments?${qs.toString()}`, {
      token: session.token,
      fetchImpl: deps.fetchImpl,
      baseUrl: deps.baseUrl,
    });
  };
  // Only a worker that knows the filter names the trail and states a cursor (null at the end).
  const isForTrail = (page: AdminCommentsResponse): boolean =>
    page.trailId === trailId && (page.nextCursor === null || typeof page.nextCursor === 'string');

  const first = await readPage(null);
  if (!isForTrail(first)) {
    // A worker from before the filter ignored it: what came back is a page of
    // every trail's comments, never to be taken for this trail's whole set.
    // Its listing is read both ways it can be ordered instead: newest first
    // (which holds comments an admin deleted that nobody reported, as far
    // back as one read goes) and reported first (every comment with a report
    // or a review result, however old).
    const [newest, reported] = await Promise.all([
      adminListAllTrails(session, false, deps),
      adminListAllTrails(session, true, deps),
    ]);
    return {
      // One row per comment: the two reads overlap.
      comments: [...new Map([...newest.comments, ...reported.comments].map(c => [c.id, c])).values()],
      coverage: !newest.truncated ? 'complete' : !reported.truncated ? 'recent' : 'partial',
    };
  }

  const comments = [...first.comments];
  let cursor = first.nextCursor ?? null;
  for (let pages = 1; cursor; pages++) {
    if (pages >= MODERATED_MAX_PAGES) return { comments, coverage: 'capped' };
    let page: AdminCommentsResponse;
    try {
      page = await readPage(cursor);
    } catch {
      return { comments, coverage: 'interrupted' };
    }
    // An answer that is not for this trail (a worker rolled back mid-read) is no page of it.
    if (!isForTrail(page)) return { comments, coverage: 'interrupted' };
    comments.push(...page.comments);
    cursor = page.nextCursor ?? null;
  }
  return { comments, coverage: 'complete' };
}
