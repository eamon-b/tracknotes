/**
 * Typed client for the curated waypoint descriptions, for the live description
 * editor (`admin-descriptions.html`): the public read every phone syncs from,
 * the admin PUT, and `GET /v1/me` to tell an admin's linked browser from
 * anyone else's before offering the editor. The worker re-checks admin on
 * every PUT (403 otherwise).
 */

import type {
  MeResponse,
  TrailDescriptionsResponse,
  UpsertDescriptionRequest,
  WaypointDescription,
} from '@lib/comments-api-types';
import { apiRequest, type FetchLike } from './client';
import type { WebSession } from './session';

export interface DescriptionsApiDeps {
  fetchImpl?: FetchLike;
}

/** Every synced description for a curated trail, cleared ones ('') included. Public. */
export async function fetchSyncedDescriptions(
  trailId: string,
  deps: DescriptionsApiDeps = {}
): Promise<WaypointDescription[]> {
  const body = await apiRequest<TrailDescriptionsResponse>(`/v1/trails/${encodeURIComponent(trailId)}/descriptions`, {
    fetchImpl: deps.fetchImpl,
  });
  return body.descriptions;
}

/**
 * Set a waypoint's synced description; `''` clears it (a tombstone the phones
 * sync, after which they show the bundled text again). Answers the stored row.
 */
export async function adminPutDescription(
  session: WebSession,
  trailId: string,
  waypointId: string,
  description: string,
  deps: DescriptionsApiDeps = {}
): Promise<WaypointDescription> {
  const body: UpsertDescriptionRequest = { description };
  return apiRequest<WaypointDescription>(
    `/v1/admin/trails/${encodeURIComponent(trailId)}/descriptions/${encodeURIComponent(waypointId)}`,
    { method: 'PUT', token: session.token, body, fetchImpl: deps.fetchImpl }
  );
}

/** Who this browser is linked as, and whether that account is an admin. */
export async function fetchMe(session: WebSession, deps: DescriptionsApiDeps = {}): Promise<MeResponse> {
  return apiRequest<MeResponse>('/v1/me', { token: session.token, fetchImpl: deps.fetchImpl });
}
