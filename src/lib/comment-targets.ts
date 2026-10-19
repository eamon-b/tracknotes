/**
 * The ids a comment may be filed under, shared by the comments API (which
 * refuses anything else) and the phone (which offers a composer only where the
 * server will take the comment). One form per kind of place a screen shows
 * comments for:
 *
 * - `w_` + 8-40 hex: a curated waypoint (`data/waypoint-ids.json`, minted by
 *   `scripts/lib/waypoint-ids.ts`; up to 40 hex in case the mint is widened).
 *   Only on a curated trail.
 * - `uw_` + 1-40 lowercase alphanumerics, optionally `_<n>`: a community
 *   route's own waypoint. A route keeps the ids its import minted
 *   (`mintImportedWaypointIds`, the `_2`, `_3`… a route that passes one place
 *   twice adds), and the server stores them as submitted, so they are stable
 *   for as long as the route is. Only on a community route (`c_…`): on a
 *   hiker's private `u_` import the same form names a place no one else has.
 * - `hw_` + a lowercase v4 uuid: a shared hiker waypoint (`isUserWaypointId`),
 *   on any trail the server knows.
 * - `osm_<node|way|relation>_<id>`: an OSM POI (`poiCommentId`), the id a
 *   non-negative safe integer written without leading zeros, on any trail.
 *
 * Every check here is by form only: neither the worker nor this module
 * carries the registry, a route's waypoint list or a trail's POIs.
 */

import { isUserWaypointId } from './user-waypoints';

export type CommentTargetKind = 'curated' | 'community' | 'shared' | 'osm';

/** Which kind of trail a comment is filed on: ours, or a community route. */
export type CommentTrailKind = 'curated' | 'community';

const CURATED_WAYPOINT_ID_RE = /^w_[0-9a-f]{8,40}$/;
const COMMUNITY_WAYPOINT_ID_RE = /^uw_[a-z0-9]{1,40}(?:_[0-9]{1,6})?$/;
const OSM_COMMENT_ID_RE = /^osm_(?:node|way|relation)_(0|[1-9][0-9]{0,15})$/;

/** The kind of place an id names, by its form, or null when it names none. */
export function commentTargetKind(id: unknown): CommentTargetKind | null {
  if (typeof id !== 'string') return null;
  if (CURATED_WAYPOINT_ID_RE.test(id)) return 'curated';
  if (COMMUNITY_WAYPOINT_ID_RE.test(id)) return 'community';
  if (isUserWaypointId(id)) return 'shared';
  const osm = OSM_COMMENT_ID_RE.exec(id);
  if (osm && Number.isSafeInteger(Number(osm[1]))) return 'osm';
  return null;
}

/**
 * Whether a place of this kind takes comments on a trail of that kind: a
 * curated id only on a curated trail, a route's own id only on a community
 * route, shared hiker waypoints and OSM places on either.
 */
export function commentTargetFitsTrail(kind: CommentTargetKind, trail: CommentTrailKind): boolean {
  if (kind === 'curated') return trail === 'curated';
  if (kind === 'community') return trail === 'community';
  return true;
}
