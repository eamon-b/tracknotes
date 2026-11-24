/**
 * "My shared routes" rules, with no UI attached (`app/my-shared-routes.tsx`).
 *
 * A route its owner shared can be hidden by the automatic review, by reports
 * or by a moderator. A hidden route leaves the public list, so My Guides never
 * shows it, and it has no public `trailUrl`, so it cannot open as a guide: the
 * owner's own list (`GET /v1/me/community/routes`) is the one place it is
 * still visible, and this module words what that list says.
 */

import type { CommunityRouteDetail } from '@lib/community-types';
import { ApiError } from '../../api/client';
import { deleteCommunityRoute, type ApiContext } from '../../api/community';
import { apiErrorMessage } from '../../api/error-message';
import { forgetCommunityRoute } from '../../services/community-routes';

export type CommunityHiddenReason = NonNullable<CommunityRouteDetail['hiddenReason']>;

export const HIDDEN_REASON_TEXT: Record<CommunityHiddenReason, string> = {
  review: 'Hidden by the automatic review',
  reports: 'Hidden after reports from other users',
  admin: 'Hidden by a moderator',
};

/** Said when a hidden route's detail does not say why (an older worker). */
export const HIDDEN_UNKNOWN_TEXT = 'Hidden from the community list';

export const MY_ROUTES_LOAD_FAILED = 'Couldn’t load your shared routes.';
export const MY_ROUTE_DELETE_FAILED = 'Couldn’t delete the route. Please try again.';

/** One line of why a route is hidden, or null when it is not hidden. */
export function hiddenReasonText(
  route: Pick<CommunityRouteDetail, 'status' | 'hiddenReason'>,
): string | null {
  if (route.status !== 'hidden') return null;
  const reason = route.hiddenReason;
  return reason && reason in HIDDEN_REASON_TEXT ? HIDDEN_REASON_TEXT[reason] : HIDDEN_UNKNOWN_TEXT;
}

/** Shared and downloadable: it can open as a guide. */
export function isLiveRoute(route: Pick<CommunityRouteDetail, 'status' | 'trailUrl'>): boolean {
  return (route.status === 'verified' || route.status === 'unverified') && !!route.trailUrl;
}

/** What a failed load of the list says (offline and a refused token have their own words). */
export function mySharedRoutesError(err: unknown): string {
  return apiErrorMessage(err, MY_ROUTES_LOAD_FAILED);
}

export const DELETE_SHARED_ROUTE_TITLE = 'Delete shared route';

/** What the server says about a route its owner may delete or release. */
export type RouteEstablishment = Pick<CommunityRouteDetail, 'established' | 'otherPosters'>;

/** Whether the owner's delete releases this route rather than removing it (#386). */
export function releasesOnDelete(route?: RouteEstablishment | null): boolean {
  return route?.established === true;
}

/** The confirm button: "Release" for an established route, "Delete" otherwise. */
export function deleteSharedRouteAction(route?: RouteEstablishment | null): string {
  return releasesOnDelete(route) ? 'Release' : 'Delete';
}

/**
 * The owner's delete confirmation, on both screens that offer it. Deleting
 * also removes the downloaded community copy from this phone, with its plan,
 * favourites, routes and "Hiking now" pin (`forgetCommunityRoute`), so it says
 * so; the `u_` guide the route was shared from is a different trail and stays.
 *
 * An established route (shared for a month and posted on by other hikers) is
 * released instead: it stays in the community without the owner's name, and
 * any copy on this phone stays, since it is still a shared route.
 */
export function deleteSharedRouteMessage(
  name?: string | null,
  route?: RouteEstablishment | null,
): string {
  const what = name ? `“${name}”` : 'this route';
  if (releasesOnDelete(route)) {
    const others = route?.otherPosters;
    return (
      `Other hikers use ${what}${others ? ` (${others} have posted on it)` : ''}, so it stays in the community without your name. ` +
      'Your name comes off it, the GPX file you uploaded is deleted, and it is no longer yours to edit or delete. ' +
      'To have it taken down for a safety or privacy problem, report it or email us instead. ' +
      'This can’t be undone.'
    );
  }
  return (
    `Remove ${what} from the community for everyone? ` +
    'If the community copy is downloaded on this phone, it is removed too, along with its plan, favourites and routes. ' +
    'The guide you imported and shared from stays on this phone.'
  );
}

export interface DeleteMySharedRouteDeps {
  deleteRoute?: typeof deleteCommunityRoute;
  forget?: (id: string) => Promise<void>;
}

/**
 * Delete an owned route on the server, then everything about it on this phone
 * (the list row, a downloaded copy, its plan and the rest:
 * `forgetCommunityRoute`). A 404 means it is already gone, which is what was
 * asked for, so the local cleanup still runs. Any other failure throws before
 * anything local is touched.
 *
 * With `release` (an established route), the server releases it instead: it
 * stays shared, so nothing on this phone is touched, a 204 or 404 included
 * (a moderator removed it meanwhile, or it is no longer this account's). Resolves to whether it
 * was released.
 */
export async function deleteMySharedRoute(
  ctx: ApiContext,
  id: string,
  deps: DeleteMySharedRouteDeps = {},
  options: { release?: boolean } = {},
): Promise<{ released: boolean }> {
  const deleteRoute = deps.deleteRoute ?? deleteCommunityRoute;
  const forget = deps.forget ?? ((routeId: string) => forgetCommunityRoute(routeId));
  try {
    const { released } = await deleteRoute(ctx, id, options.release ? { release: true } : {});
    // Asked as a release, nothing on this phone goes, whatever the answer: a
    // 204 means a moderator removed it meanwhile, and a route taken down stays
    // on the phone as "No longer shared".
    if (released || options.release) return { released };
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) throw err;
    if (options.release) return { released: false };
  }
  await forget(id);
  return { released: false };
}

/**
 * The server refused a plain delete because the route became established
 * since this phone read it: the screen asks again, as a release.
 */
export function isRouteEstablishedError(err: unknown): err is ApiError {
  return err instanceof ApiError && err.status === 409 && err.code === 'route_established';
}
