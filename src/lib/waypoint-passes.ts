/**
 * The passes of a revisited place, by id, and the one rule for which synced
 * description a pass shows.
 *
 * A route that comes back through a place days later keeps every pass as a
 * waypoint of its own: the first under the place's id, the later ones as
 * `<id>_2`, `<id>_3` (`resolveDuplicateWaypointIds` in `trail-ingest.ts`, for a
 * trail's `revisitedWaypoints` and for every import). The suffix is written
 * after everything keyed by the id has been applied, so what is authored once
 * per place lives under the first pass's id: the registry entry in
 * `data/waypoint-ids.json`, the `descriptions.json` entry, and the synced
 * description row the comments API serves.
 *
 * Platform-neutral: the phone's description lookup, the live description
 * editor and the local waypoint editor all read the rule from here.
 */

/**
 * A later pass's id: a whole waypoint id (`w_…` from the registry, `uw_…` from
 * an import; neither holds an underscore of its own), then `_N` with N from 2,
 * written as the build writes it. So `w_00176641` is an id of its own, not
 * pass 176641 of `w`, and an OSM place's `osm_node_12` is not pass 12 of
 * anything.
 */
const LATER_PASS_ID_RE = /^(u?w_[0-9a-z]+)_(?:[2-9]|[1-9][0-9]+)$/;

/**
 * The first pass's id when `id` is a later pass of a revisited place
 * (`<id>_2`, `<id>_3`), else null.
 *
 * By form alone that is what the build's suffix looks like. A caller that
 * holds the trail's waypoints can pass `isWaypointId` to also require that the
 * first pass is one of them: a later pass never exists without its first.
 */
export function firstPassIdOf(id: string, isWaypointId?: (id: string) => boolean): string | null {
  const first = LATER_PASS_ID_RE.exec(id)?.[1];
  if (first === undefined) return null;
  return isWaypointId && !isWaypointId(first) ? null : first;
}

/**
 * The id a place's shared things are keyed by: the first pass's id for a later
 * pass, else the id itself.
 */
export function placeIdOf(id: string): string {
  return firstPassIdOf(id) ?? id;
}

/**
 * The ids whose synced description rows a waypoint can show, in the order they
 * are tried: its own, then, for a later pass, its place's first pass.
 */
export function syncedDescriptionIds(id: string, isWaypointId?: (id: string) => boolean): string[] {
  const first = firstPassIdOf(id, isWaypointId);
  return first === null ? [id] : [id, first];
}

/** A synced description and the id whose row holds it. */
export interface ResolvedSyncedDescription {
  waypointId: string;
  description: string;
}

/**
 * The synced description a waypoint shows, or null when it shows its bundled
 * text.
 *
 * It is the text of the waypoint's own row; when that row is absent or cleared
 * and the waypoint is a later pass, the text of its place's first-pass row.
 * A cleared row (`''`, the API's tombstone) holds no text wherever it sits: it
 * never hides the next source. So a later pass whose own row was cleared or
 * withdrawn follows the first pass again, and a place whose first-pass row is
 * cleared shows the bundled text on every pass that has no text of its own.
 *
 * `rowText` answers a row's description by id (`''` cleared; `undefined` or
 * `null` when there is no row).
 */
export function resolveSyncedDescription(
  id: string,
  rowText: (id: string) => string | null | undefined,
  isWaypointId?: (id: string) => boolean
): ResolvedSyncedDescription | null {
  for (const waypointId of syncedDescriptionIds(id, isWaypointId)) {
    const description = rowText(waypointId);
    if (description) return { waypointId, description };
  }
  return null;
}
