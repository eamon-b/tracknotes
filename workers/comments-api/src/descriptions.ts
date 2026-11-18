/**
 * Curated waypoint descriptions.
 *
 * Editorial content (not UGC): admins write it, everyone reads it, and clients
 * pull it with the same `since` high-water-mark semantics as the comment bulk
 * endpoint. An empty description is a cleared tombstone rather than a deleted
 * row, so a client that has cached prose learns it was withdrawn.
 */

import { json, readJson } from './http';
import type { Env } from './http';
import { requireAdmin } from './auth';
import { appendSinceFilter } from './cursor';
import {
  validateDescription,
  validateDescriptionSource,
  validateIfUpdatedAt,
  validateTrailId,
  validateWaypointId,
} from './validation';
import { resolveTrail } from './trails';
import type {
  DescriptionConflictResponse,
  TrailDescriptionsResponse,
  WaypointDescription,
} from '../../../src/lib/comments-api-types';
import { DESCRIPTION_WRITE_FEATURES } from '../../../src/lib/description-write-features';

interface DescriptionRow {
  waypoint_id: string;
  description: string;
  updated_at: string;
  /** 'live' | 'upload', or NULL on a row from before migration 0012 or written without a source. */
  source: string | null;
}

const ROW_COLUMNS = 'waypoint_id, description, updated_at, source';

/**
 * A row as the API serves it. Anything that is not a live edit reads as
 * `upload`: the live editor is the only writer that says `live`, and it did
 * not exist before the column did, so a NULL row was uploaded.
 */
function toWaypointDescription(row: DescriptionRow): WaypointDescription {
  return {
    waypointId: row.waypoint_id,
    description: row.description,
    updatedAt: row.updated_at,
    source: row.source === 'live' ? 'live' : 'upload',
  };
}

// ---------------------------------------------------------------------------
// GET /v1/trails/:trailId/descriptions — public read (full or delta)
// ---------------------------------------------------------------------------

/**
 * GET /v1/trails/:trailId/descriptions?since=<iso> — unauthenticated.
 *
 * Every answer carries `writeFeatures`: what the PUT below does with `source`
 * and `ifUpdatedAt`. The site and this worker deploy separately, and a worker
 * that predates those two ignores them without an error, so both writers (the
 * live editor and `upload-descriptions`) read this first and write nothing to
 * a worker that does not say it honours them. It is a top-level field beside
 * the rows: the phone reads `descriptions` and `syncedAt` and ignores it.
 */
export async function getTrailDescriptions(request: Request, env: Env, trailIdRaw: string): Promise<Response> {
  const trail = await resolveTrail(env, trailIdRaw, 'read');
  const trailId = trail.id;
  const url = new URL(request.url);
  const since = url.searchParams.get('since');
  const syncedAt = new Date().toISOString();

  // A community route's descriptions are its owner's, in the route itself;
  // curated ones are only ever written for our trails (the admin PUT below).
  if (trail.kind === 'community') {
    const empty: TrailDescriptionsResponse = {
      descriptions: [],
      syncedAt,
      writeFeatures: [...DESCRIPTION_WRITE_FEATURES],
    };
    return json(empty);
  }

  const conditions = ['trail_id = ?'];
  const binds: unknown[] = [trailId];
  if (since) {
    appendSinceFilter(conditions, binds, 'updated_at', since);
  }

  const { results } = await env.DB.prepare(
    `SELECT ${ROW_COLUMNS}
       FROM waypoint_descriptions
      WHERE ${conditions.join(' AND ')}
      ORDER BY waypoint_id ASC`
  )
    .bind(...binds)
    .all<DescriptionRow>();

  const payload: TrailDescriptionsResponse = {
    descriptions: results.map(toWaypointDescription),
    syncedAt,
    writeFeatures: [...DESCRIPTION_WRITE_FEATURES],
  };
  return json(payload);
}

// ---------------------------------------------------------------------------
// PUT /v1/admin/trails/:trailId/descriptions/:waypointId — admin upsert
// ---------------------------------------------------------------------------

/**
 * PUT a curated description for one waypoint. Empty string clears it.
 *
 * Re-sending the text a waypoint already has is a no-op: `updated_at` is what
 * every phone's delta pull keys on, and `upload-descriptions` re-PUTs the whole
 * curated file each run, so bumping it unconditionally re-shipped every
 * description to every phone on every upload. The row only changes when the
 * text differs; otherwise the stored row is answered as it stands.
 *
 * `source` says which tool is writing (`live`: the live description editor,
 * `upload`: the upload script) and is stored with any change of text, so the
 * page and the upload's plan can tell an uncommitted live edit from text an
 * upload sent. It comes from the request, not from the token: both writers
 * present a bearer token of an admin account, and nothing fixes which kind
 * (`primary` or `linked`) the upload's is. One write changes `source` alone:
 * an `upload` of the text a `live` row already holds marks it `upload` (the
 * live edit has reached descriptions.json), leaving `updated_at` as it was so
 * no phone re-downloads it.
 *
 * `ifUpdatedAt` is the writer's optimistic check: the `updated_at` it last
 * read for the row, or null for "no row". When the row has changed since and
 * does not already hold the text sent, nothing is written and the answer is
 * 409 `description_conflict` with the row as it is now. Each conditional
 * write is one statement, so two writers cannot both pass the check. Both
 * send it: the live editor, and the upload, which must not replace a row that
 * was edited live after it read the set. A PUT without one is unconditional.
 */
export async function upsertTrailDescription(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  trailIdRaw: string,
  waypointIdRaw: string
): Promise<Response> {
  await requireAdmin(request, env, ctx);
  const trailId = validateTrailId(trailIdRaw);
  const waypointId = validateWaypointId(waypointIdRaw);

  const body = await readJson(request);
  const description = validateDescription(body.description);
  const source = validateDescriptionSource(body.source);
  const ifUpdatedAt = validateIfUpdatedAt(body);
  const now = new Date().toISOString();

  let written: DescriptionRow | null;
  if (ifUpdatedAt === undefined) {
    written = await env.DB.prepare(
      `INSERT INTO waypoint_descriptions (trail_id, waypoint_id, description, updated_at, source)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(trail_id, waypoint_id) DO UPDATE
         SET description = excluded.description, updated_at = excluded.updated_at, source = excluded.source
         WHERE excluded.description <> waypoint_descriptions.description
       RETURNING ${ROW_COLUMNS}`
    )
      .bind(trailId, waypointId, description, now, source)
      .first<DescriptionRow>();
  } else if (ifUpdatedAt === null) {
    // The client read no row: only an insert may go through.
    written = await env.DB.prepare(
      `INSERT INTO waypoint_descriptions (trail_id, waypoint_id, description, updated_at, source)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(trail_id, waypoint_id) DO NOTHING
       RETURNING ${ROW_COLUMNS}`
    )
      .bind(trailId, waypointId, description, now, source)
      .first<DescriptionRow>();
  } else {
    // The client read a row: only that same version may be replaced.
    written = await env.DB.prepare(
      `UPDATE waypoint_descriptions
          SET description = ?, updated_at = ?, source = ?
        WHERE trail_id = ? AND waypoint_id = ? AND updated_at = ? AND description <> ?
       RETURNING ${ROW_COLUMNS}`
    )
      .bind(description, now, source, trailId, waypointId, ifUpdatedAt, description)
      .first<DescriptionRow>();
  }
  if (written) return json(toWaypointDescription(written));

  // Nothing was written: the row already holds this text, or a precondition
  // did not hold. Read it as stored to tell which.
  const current = await env.DB.prepare(
    `SELECT ${ROW_COLUMNS}
       FROM waypoint_descriptions WHERE trail_id = ? AND waypoint_id = ?`
  )
    .bind(trailId, waypointId)
    .first<DescriptionRow>();

  if (current && current.description === description) {
    // Already this text: answer the row as stored, its original stamp intact.
    // An upload re-sending a live edit's text takes the row over.
    if (source === 'upload' && current.source === 'live') {
      await env.DB.prepare(
        `UPDATE waypoint_descriptions SET source = 'upload'
          WHERE trail_id = ? AND waypoint_id = ? AND description = ? AND source = 'live'`
      )
        .bind(trailId, waypointId, description)
        .run();
      return json(toWaypointDescription({ ...current, source: 'upload' }));
    }
    return json(toWaypointDescription(current));
  }

  if (ifUpdatedAt !== undefined) {
    const conflict: DescriptionConflictResponse = {
      error: {
        code: 'description_conflict',
        message: current
          ? 'This description has changed since it was read'
          : 'This description no longer has a synced row',
      },
      current: current ? toWaypointDescription(current) : null,
    };
    return json(conflict, 409);
  }

  // Unreachable short of a concurrent hard delete (nothing deletes rows): the
  // unconditional upsert writes unless the row already holds the text.
  return json({
    waypointId,
    description,
    updatedAt: now,
    source: source === 'live' ? 'live' : 'upload',
  } satisfies WaypointDescription);
}
