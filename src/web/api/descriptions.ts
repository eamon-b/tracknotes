/**
 * Typed client for the curated waypoint descriptions, for the live description
 * editor (`admin-descriptions.html`): the public read every phone syncs from,
 * the admin PUT, and `GET /v1/me` to tell an admin's linked browser from
 * anyone else's before offering the editor. The worker re-checks admin on
 * every PUT (403 otherwise).
 */

import type {
  DescriptionConflictResponse,
  MeResponse,
  TrailDescriptionsResponse,
  UpsertDescriptionRequest,
  WaypointDescription,
} from '@lib/comments-api-types';
import { guardsDescriptionWrites } from '@lib/description-write-features';
import { ApiError, apiRequest, type FetchLike } from './client';
import type { WebSession } from './session';

export interface DescriptionsApiDeps {
  fetchImpl?: FetchLike;
}

/** What the public read answers, as the live editor needs it. */
export interface SyncedDescriptions {
  /** Every synced row for the trail, cleared ones ('') included. */
  descriptions: WaypointDescription[];
  /**
   * Whether the worker that answered says it records which tool wrote a
   * description and refuses a save over a row that changed since it was read
   * (`writeFeatures`, `@lib/description-write-features`). False for a worker
   * that predates both: a save sent to it would be last-write-wins and stored
   * with no origin, so the page must not send one.
   */
  guardsWrites: boolean;
}

/** Every synced description for a curated trail, and whether the worker guards writes. Public. */
export async function fetchSyncedDescriptions(
  trailId: string,
  deps: DescriptionsApiDeps = {}
): Promise<SyncedDescriptions> {
  const body = await apiRequest<TrailDescriptionsResponse>(`/v1/trails/${encodeURIComponent(trailId)}/descriptions`, {
    fetchImpl: deps.fetchImpl,
  });
  return { descriptions: body.descriptions, guardsWrites: guardsDescriptionWrites(body) };
}

/**
 * Set a waypoint's synced description as a live edit; `''` clears it (a
 * tombstone the phones sync, after which they show the bundled text again).
 * Answers the stored row.
 *
 * `readUpdatedAt` is what this page last read for the row: its `updatedAt`, or
 * `null` when it read no row. The worker refuses the write with 409
 * `description_conflict` when the row has changed since (`conflictCurrent`
 * reads the row it has now), so one admin's save cannot silently replace
 * another's. A worker that predates the check ignores it and writes, which
 * is why the page sends nothing unless the read said the worker guards writes
 * (`SyncedDescriptions.guardsWrites`).
 */
export async function adminPutDescription(
  session: WebSession,
  trailId: string,
  waypointId: string,
  description: string,
  readUpdatedAt: string | null,
  deps: DescriptionsApiDeps = {}
): Promise<WaypointDescription> {
  const body: UpsertDescriptionRequest = { description, source: 'live', ifUpdatedAt: readUpdatedAt };
  return apiRequest<WaypointDescription>(
    `/v1/admin/trails/${encodeURIComponent(trailId)}/descriptions/${encodeURIComponent(waypointId)}`,
    { method: 'PUT', token: session.token, body, fetchImpl: deps.fetchImpl }
  );
}

/**
 * When `err` is the PUT's 409 `description_conflict`: the row as the server
 * has it now (`null` when it has none). `undefined` for any other error.
 */
export function conflictCurrent(err: unknown): WaypointDescription | null | undefined {
  if (!(err instanceof ApiError) || err.status !== 409 || err.code !== 'description_conflict') return undefined;
  const current = (err.body as Partial<DescriptionConflictResponse> | undefined)?.current;
  return current && typeof current.waypointId === 'string' && typeof current.description === 'string' ? current : null;
}

/** Who this browser is linked as, and whether that account is an admin. */
export async function fetchMe(session: WebSession, deps: DescriptionsApiDeps = {}): Promise<MeResponse> {
  return apiRequest<MeResponse>('/v1/me', { token: session.token, fetchImpl: deps.fetchImpl });
}
