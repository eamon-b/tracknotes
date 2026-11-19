/**
 * Waypoint meta repository — the local mirror of curated waypoint
 * descriptions pulled from the comments API.
 *
 * Rows are stored exactly as the server sends them, including the empty-string
 * "cleared" tombstone: keeping the row (rather than deleting it) means the
 * high-water-mark delta stays correct and a later re-fill upserts onto the same
 * key. Readers never see a cleared row — `getDescription` filters empties so callers can fall back to the bundled trail description.
 *
 * A description is authored per place, under the first pass's id; a later pass
 * of a revisited place (`<id>_2`) has no row of its own. `getDescription` is
 * the one reader, and it applies the shared rule
 * (`@lib/waypoint-passes` `resolveSyncedDescription`), so no screen can look a
 * pass up by its own id alone.
 *
 * The description high-water mark lives in `sync_state.meta_synced_at`,
 * independent of the comment cursor (`last_synced_at`).
 */

import { resolveSyncedDescription, syncedDescriptionIds } from '@lib/waypoint-passes';
import type { SqlDatabase } from './sql-database';
import { withTransaction } from './transaction';

/** One curated description row as pulled from the server. */
export interface DescriptionInput {
  waypointId: string;
  /** Empty string means "cleared" — stored, but hidden from readers. */
  description: string;
  updatedAt: string;
}

/**
 * Insert or update curated descriptions for a trail. Empty descriptions are
 * stored verbatim (they are the server's tombstone) and filtered on read.
 * One transaction for the batch: a first pull of a trail is hundreds of rows,
 * and one commit each was the cost. Opens its own, so it must not be called
 * from inside another transaction.
 */
export async function upsertDescriptions(
  db: SqlDatabase,
  trailId: string,
  rows: DescriptionInput[],
): Promise<void> {
  if (rows.length === 0) return;
  await withTransaction(db, async (tx) => {
    for (const row of rows) {
      await tx.runAsync(
        `INSERT INTO waypoint_meta (trail_id, waypoint_id, description, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(trail_id, waypoint_id) DO UPDATE SET
         description = excluded.description,
         updated_at = excluded.updated_at`,
        [trailId, row.waypointId, row.description, row.updatedAt],
      );
    }
  });
}

/**
 * The synced description a waypoint shows, or null when it shows its bundled
 * text.
 *
 * In order: the waypoint's own row; for a later pass of a revisited place
 * (`<id>_2`), the row of the place's first pass (`<id>`). A cleared row holds
 * no text wherever it sits, so it never hides the next source: a later pass
 * whose own row is cleared follows the first pass, and a cleared first pass
 * leaves the bundled text.
 */
export async function getDescription(
  db: SqlDatabase,
  trailId: string,
  waypointId: string,
): Promise<string | null> {
  const ids = syncedDescriptionIds(waypointId);
  const rows = await db.getAllAsync<{ waypoint_id: string; description: string }>(
    `SELECT waypoint_id, description FROM waypoint_meta
      WHERE trail_id = ? AND waypoint_id IN (${ids.map(() => '?').join(', ')})
        AND description <> ''`,
    [trailId, ...ids],
  );
  const texts = new Map(rows.map((row) => [row.waypoint_id, row.description]));
  return resolveSyncedDescription(waypointId, (id) => texts.get(id))?.description ?? null;
}

/** The stored description high-water mark for a trail, or undefined. */
export async function readMetaSyncedAt(
  db: SqlDatabase,
  trailId: string,
): Promise<string | undefined> {
  const row = await db.getFirstAsync<{ meta_synced_at: string | null }>(
    'SELECT meta_synced_at FROM sync_state WHERE trail_id = ?',
    [trailId],
  );
  return row?.meta_synced_at ?? undefined;
}

/** Persist the description high-water mark (leaves the comment cursor alone). */
export async function writeMetaSyncedAt(
  db: SqlDatabase,
  trailId: string,
  syncedAt: string,
): Promise<void> {
  await db.runAsync(
    `INSERT INTO sync_state (trail_id, meta_synced_at) VALUES (?, ?)
     ON CONFLICT(trail_id) DO UPDATE SET meta_synced_at = excluded.meta_synced_at`,
    [trailId, syncedAt],
  );
}
