/**
 * The server boundary, as a dependency-light module.
 *
 * Only the bundled trails exist server-side: they are the comments API's
 * `ALLOWED_TRAILS` allowlist and the only ids in `data/waypoint-ids.json`. A
 * user-imported trail (`u_<hash>`) and its waypoints (`uw_<hash>`) exist on one
 * device and nowhere else, so every network path — comment pull, outbox write,
 * curated-description sync — has to gate on {@link isServerKnown} first.
 *
 * Why this lives apart from `trail-loader`: the gate is checked deep in the sync
 * engine, and importing the loader there would drag ~3 MB of bundled trail JSON,
 * `expo-file-system` and the SQLite layer into the sync module graph for the
 * sake of a set membership test. `assets/trails/index.json` is 4 KB and has the
 * same ids as the allowlist (`scripts/server-trail-allowlist.test.ts` holds them
 * equal), so this module is the cheap authority and `trail-loader` re-exports
 * it (see its `isServerKnown`).
 *
 * Trails published to the R2 catalog but not bundled in this build (a trail
 * added after the APK was made) are server-known too: the catalog is ours, and
 * publishing a trail means adding it to the allowlist. `trail-data-updates`
 * registers their ids here whenever it loads or refreshes the catalog — pushed
 * in rather than pulled, so this module still imports nothing.
 *
 * Community routes (`c_<16>`, `services/community-routes`) are server-known
 * too: the comments API takes comments, plans and shared waypoints on a route
 * it holds (`workers/comments-api/src/trails.ts`). They are known here once
 * this phone has heard of them — the cached list or a downloaded copy —
 * which `community-routes` registers through
 * {@link registerCommunityTrailIds}, pushed in like the catalog's ids. A `u_`
 * import never is.
 */

import { isCommunityRouteId } from '@lib/community-types';

const SERVER_TRAIL_IDS: ReadonlySet<string> = new Set(
  (require('../../assets/trails/index.json') as { id: string }[]).map((entry) => entry.id),
);

/** Catalog-only trail ids — see {@link registerRemoteTrailIds}. */
let remoteTrailIds: ReadonlySet<string> = new Set();

/** Community route ids this phone knows — see {@link registerCommunityTrailIds}. */
let communityTrailIds: ReadonlySet<string> = new Set();

/**
 * Whether this trail id is known to the server — a bundled trail, one in the
 * R2 catalog (both in the comments API allowlist and the waypoint-id
 * registry), or a community route this phone knows.
 *
 * Imported ids must never be sent: a comment posted against one would 4xx at
 * best and create orphan rows at worst.
 */
export function isServerKnown(id: string): boolean {
  if (id.startsWith('u_')) return false;
  return isCuratedTrailId(id) || communityTrailIds.has(id);
}

/**
 * Whether this is one of our own trails — bundled or in the R2 catalog — as
 * opposed to a community route or an import. Only these have offline packs
 * and curated waypoint ids.
 */
export function isCuratedTrailId(id: string): boolean {
  if (isLocalOnlyTrailId(id)) return false;
  return SERVER_TRAIL_IDS.has(id) || remoteTrailIds.has(id);
}

/**
 * Ids whose guide exists only as data on this phone, not in the bundle or the
 * catalog: user imports (`u_`) and community routes (`c_`,
 * `plans/community-routes.md`) — the guides `local-trail-data` cleans up after
 * and the catalog must never name. Checked by prefix rather than by the full
 * id shape so a malformed id is refused too. (Not the server gate: that is
 * {@link isServerKnown}, which takes the community routes this phone knows.)
 */
export function isLocalOnlyTrailId(id: string): boolean {
  return id.startsWith('u_') || id.startsWith('c_');
}

/**
 * Replace the set of community route ids this phone knows (the cached list
 * and every downloaded copy, a "No longer shared" one included: the server
 * still answers its comments and plans). Called by `community-routes`
 * whenever it loads or saves its state; anything not shaped like a community
 * id is dropped.
 */
export function registerCommunityTrailIds(ids: Iterable<string>): void {
  communityTrailIds = new Set([...ids].filter((id) => isCommunityRouteId(id)));
}

/**
 * Replace the set of catalog-only trail ids (published to R2, not bundled).
 * Called by `trail-data-updates`, which has already refused `u_` and `c_` ids —
 * they are refused again here, because this set is the gate on every network path.
 */
export function registerRemoteTrailIds(ids: Iterable<string>): void {
  remoteTrailIds = new Set([...ids].filter((id) => !isLocalOnlyTrailId(id)));
}

/** The bundled trail ids, in bundle order. */
export function serverTrailIds(): string[] {
  return [...SERVER_TRAIL_IDS];
}
