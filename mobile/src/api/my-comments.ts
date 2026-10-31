/**
 * The hiker's personal export: `GET /v1/me/comments`, every comment the
 * account posted (deleted and hidden ones included), followed page by page.
 *
 * {@link listMyComments} is the ctx-taking primitive; {@link fetchMyComments}
 * reads the stored session through `link.ts`, so the token stays in `src/api`.
 */

import type { MyComment, MyCommentsResponse } from '@lib/comments-api-types';
import { apiRequest } from './client';
import { sessionContext, type ApiContext, type LinkDeps } from './link';

/** Fetch ALL of the caller's comments, oldest first (one request per page). */
export async function listMyComments(ctx: ApiContext): Promise<MyComment[]> {
  const comments: MyComment[] = [];
  let cursor: string | null = null;
  do {
    const path: string =
      '/v1/me/comments' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');
    const page: MyCommentsResponse = await apiRequest<MyCommentsResponse>(path, {
      baseUrl: ctx.baseUrl,
      fetchImpl: ctx.fetchImpl,
      token: ctx.token,
    });
    comments.push(...page.comments);
    cursor = page.nextCursor;
  } while (cursor);
  return comments;
}

/** {@link listMyComments} against the stored session. */
export async function fetchMyComments(deps?: LinkDeps): Promise<MyComment[]> {
  return listMyComments(await sessionContext(deps));
}
