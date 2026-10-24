/**
 * Typed client for the comment and shared-waypoint moderation endpoints, for
 * `admin-moderation.html`. Every call needs an admin account's session; the
 * worker re-checks that on each one (403 otherwise).
 */

import type {
  AdminComment,
  AdminCommentsResponse,
  AdminSharedWaypoint,
  AdminSharedWaypointsResponse,
  BanUserResponse,
} from '@lib/comments-api-types';
import { apiRequest, type FetchLike } from './client';
import type { WebSession } from './session';

export interface ModerationApiDeps {
  fetchImpl?: FetchLike;
}

/** The most the admin listings return in one read. */
const ADMIN_LIST_LIMIT = 500;

/** Every reported comment, those hidden by reports first. */
export async function adminListReportedComments(
  session: WebSession,
  deps: ModerationApiDeps = {}
): Promise<AdminComment[]> {
  const body = await apiRequest<AdminCommentsResponse>(`/v1/admin/comments?reported=1&limit=${ADMIN_LIST_LIMIT}`, {
    token: session.token,
    fetchImpl: deps.fetchImpl,
  });
  return body.comments;
}

/** Shared waypoints, reported first. */
export async function adminListSharedWaypoints(
  session: WebSession,
  deps: ModerationApiDeps = {}
): Promise<AdminSharedWaypoint[]> {
  const body = await apiRequest<AdminSharedWaypointsResponse>(`/v1/admin/waypoints?limit=${ADMIN_LIST_LIMIT}`, {
    token: session.token,
    fetchImpl: deps.fetchImpl,
  });
  return body.waypoints;
}

/** Admin delete: final, photos and all. Also makes a report hide final. */
export async function adminDeleteComment(session: WebSession, id: string, deps: ModerationApiDeps = {}): Promise<void> {
  await apiRequest<unknown>(`/v1/comments/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    token: session.token,
    fetchImpl: deps.fetchImpl,
  });
}

/** Undo a hide by reports. */
export async function adminRestoreComment(
  session: WebSession,
  id: string,
  deps: ModerationApiDeps = {}
): Promise<void> {
  await apiRequest<unknown>(`/v1/admin/comments/${encodeURIComponent(id)}/restore`, {
    method: 'POST',
    token: session.token,
    fetchImpl: deps.fetchImpl,
  });
}

export async function adminDeleteSharedWaypoint(
  session: WebSession,
  id: string,
  deps: ModerationApiDeps = {}
): Promise<void> {
  await apiRequest<unknown>(`/v1/waypoints/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    token: session.token,
    fetchImpl: deps.fetchImpl,
  });
}

/** Undo an admin or report hide. */
export async function adminRestoreSharedWaypoint(
  session: WebSession,
  id: string,
  deps: ModerationApiDeps = {}
): Promise<void> {
  await apiRequest<unknown>(`/v1/admin/waypoints/${encodeURIComponent(id)}/restore`, {
    method: 'POST',
    token: session.token,
    fetchImpl: deps.fetchImpl,
  });
}

/** Ban (optionally taking down the account's comments and waypoints) or unban. */
export async function adminSetBanned(
  session: WebSession,
  userId: string,
  banned: boolean,
  removeContent = false,
  deps: ModerationApiDeps = {}
): Promise<BanUserResponse> {
  return apiRequest<BanUserResponse>(`/v1/admin/users/${encodeURIComponent(userId)}/ban`, {
    method: 'POST',
    token: session.token,
    body: banned ? { banned, removeContent } : { banned },
    fetchImpl: deps.fetchImpl,
  });
}
