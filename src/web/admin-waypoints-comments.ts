/**
 * Hikers' comments in the waypoint editor: what the comments API holds about
 * each waypoint ("the tank is gone", "the camp is 200 m further on"), shown
 * beside the form so a report can feed a correction.
 *
 * One public bulk read per trail (`listTrailComments`) is grouped by stable
 * waypoint id; when this browser is linked to an admin account, the admin
 * listing adds hidden ones and report counts. That listing has no trail filter
 * and no cursor (`api/comments.ts`), so it is read twice, newest first and
 * reported first, and the section says how far the two reads reach
 * (`AdminCoverage`). The editor only reads: nothing here posts, edits or
 * moderates.
 *
 * A waypoint's comments are paged: the form shows the newest
 * `COMMENTS_PAGE_SIZE` and reveals more on request, so a hut with hundreds of
 * them neither makes a very long form nor fetches every thumbnail at once.
 *
 * Everything in a comment is user-supplied: every string goes through
 * `escapeHtml` and every photo URL through `safeHttpUrl`. The markup builders
 * are pure and tested in `admin-waypoints-comments.test.ts`;
 * `admin-waypoints.ts` holds what is revealed and wires them to the page.
 */

import { commentTargetKind } from '@lib/comment-targets';
import type { AdminComment, DeletedBy, SyncComment, WaterStatus } from '@lib/comments-api-types';
import { safeHttpUrl } from '@lib/poi-display';
import { ApiError, NetworkError, getApiBase, type FetchLike } from './api/client';
import { ADMIN_LIST_LIMIT, adminListComments, listTrailComments } from './api/comments';
import type { WebSession } from './api/session';
import { escapeHtml } from './web-utils';

/** A comment as the editor shows it, from the public read or the admin listing. */
export interface EditorComment {
  id: string;
  waypointId: string;
  displayName: string;
  text: string | null;
  waterStatus: WaterStatus | null;
  observedAt: string | null;
  createdAt: string;
  photoUrls: string[];
  /** Who took it down, or null while it is published (only admins see hidden ones). */
  hiddenBy: DeletedBy | null;
  /** Reports against it: known only from the admin listing. */
  reportCount: number | null;
}

/** What the admin listing added: nothing (no linked browser), or why not. */
export type AdminAccess = 'unlinked' | 'admin' | 'not-admin' | 'expired' | 'failed';

/**
 * How far an admin's two reads of the listing reach. It covers every trail,
 * has no trail filter or cursor, and one read stops at `ADMIN_LIST_LIMIT` rows.
 * - `complete`: the newest-first read held every comment on every trail.
 * - `recent`: it was cut, so only the newest `ADMIN_LIST_LIMIT` comments on
 *   all trails are known from it; the reported-first read was whole, so every
 *   comment with a report or an automated-review result is known too. Missing:
 *   an older comment an admin deleted that nobody reported.
 * - `partial`: the reported-first read was cut as well, so some reported or
 *   hidden comments may be missing.
 */
export type AdminCoverage = 'complete' | 'recent' | 'partial';

export type CommentsState =
  | { kind: 'unconfigured' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | {
      kind: 'ready';
      /** Newest first within each waypoint. */
      byWaypoint: ReadonlyMap<string, readonly EditorComment[]>;
      total: number;
      admin: AdminAccess;
      /** What the admin listing could be shown to include; null unless `admin` is `'admin'`. */
      adminCoverage: AdminCoverage | null;
    };

// ---------------------------------------------------------------------------
// Merging and grouping
// ---------------------------------------------------------------------------

function fromLive(c: SyncComment): EditorComment {
  return {
    id: c.id,
    waypointId: c.waypointId,
    displayName: c.displayName,
    text: c.text,
    waterStatus: c.waterStatus,
    observedAt: c.observedAt,
    createdAt: c.createdAt,
    photoUrls: c.photoUrls ?? [],
    hiddenBy: null,
    reportCount: null,
  };
}

/**
 * The live comments, with the admin listing's rows for this trail laid over
 * them: a live comment gains its report count, and a hidden one (which the
 * public read leaves out) is added with who hid it.
 */
export function mergeComments(
  live: readonly SyncComment[],
  moderated: readonly AdminComment[] | null,
  trailId: string
): EditorComment[] {
  const byId = new Map<string, EditorComment>(live.map(c => [c.id, fromLive(c)]));
  for (const m of moderated ?? []) {
    if (m.trailId !== trailId) continue;
    const known = byId.get(m.id);
    if (known) {
      known.reportCount = m.reportCount;
      known.hiddenBy = m.deletedAt === null ? null : m.deletedBy;
      continue;
    }
    // Deleted by its author: withdrawn, not a report to act on.
    if (m.deletedBy === 'owner') continue;
    byId.set(m.id, {
      id: m.id,
      waypointId: m.waypointId,
      displayName: m.displayName,
      text: m.text,
      waterStatus: m.waterStatus,
      observedAt: m.observedAt,
      createdAt: m.createdAt,
      photoUrls: m.photoUrls,
      hiddenBy: m.deletedAt === null ? null : m.deletedBy,
      reportCount: m.reportCount,
    });
  }
  return [...byId.values()];
}

/** Comments keyed by waypoint id, newest first within each. */
export function groupByWaypoint(comments: readonly EditorComment[]): Map<string, EditorComment[]> {
  const groups = new Map<string, EditorComment[]>();
  for (const c of comments) {
    const list = groups.get(c.waypointId);
    if (list) list.push(c);
    else groups.set(c.waypointId, [c]);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1));
  }
  return groups;
}

/** Comments per waypoint id, for the list badges and the "Has comments" filter. Empty until loaded. */
export function commentCounts(state: CommentsState): Map<string, number> {
  const counts = new Map<string, number>();
  if (state.kind !== 'ready') return counts;
  for (const [id, list] of state.byWaypoint) counts.set(id, list.length);
  return counts;
}

/**
 * Curated-waypoint ids with comments that no waypoint on this trail has: the
 * comments a lost id orphaned (`docs/architecture/trail-data.md`). OSM POIs and
 * shared hiker waypoints take comments too and are not counted. `knownIds`
 * must hold the ids the build merged into a waypoint as well as the rows' own
 * (`knownCommentIds`): a merged-away id is live, not lost.
 */
export function orphanedCommentIds(state: CommentsState, knownIds: ReadonlySet<string>): string[] {
  if (state.kind !== 'ready') return [];
  return [...state.byWaypoint.keys()].filter(id => commentTargetKind(id) === 'curated' && !knownIds.has(id)).sort();
}

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

/** How many of a waypoint's comments the form shows at first, and reveals per "Show more". */
export const COMMENTS_PAGE_SIZE = 10;

/** The same for the ids in the "filed under ids no waypoint has" note. */
export const ORPHAN_IDS_PAGE_SIZE = 20;

/**
 * How much of a paged list is revealed, and of which list: `key` names it (the
 * selected waypoint for its comments, the trail for its orphaned ids).
 * `shown` is `Infinity` after "Show all", so a Reload that brings more still shows all.
 */
export interface Reveal {
  key: string;
  shown: number;
}

/**
 * What is revealed of the list `key`: `reveal` itself while it is about that
 * list (a re-render, a Reload, a save), one page again once it is about another.
 */
export function revealFor(reveal: Reveal | null, key: string, pageSize: number): Reveal {
  return reveal && reveal.key === key ? reveal : { key, shown: pageSize };
}

/** The count a "Show more" / "Show all" button asks for (its `data-*-show` value), or null if it is not one. */
export function parseShown(value: string | undefined): number | null {
  if (value === 'all') return Infinity;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export interface LoadCommentsDeps {
  /** The linked browser, if any: only an admin's adds hidden comments and reports. */
  session: WebSession | null;
  fetchImpl?: FetchLike;
  baseUrl?: string;
}

function describeFailure(error: unknown, base: string): string {
  if (error instanceof NetworkError) {
    return `Could not reach the comments API at ${base}. It may be down, offline, or the browser refused the response (CORS).`;
  }
  if (error instanceof ApiError) return `The comments API answered ${error.status}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/** Read a trail's comments (and, for an admin, its moderated ones) into a ready or error state. */
export async function loadTrailComments(trailId: string, deps: LoadCommentsDeps): Promise<CommentsState> {
  const base = deps.baseUrl ?? getApiBase();
  if (!base) return { kind: 'unconfigured' };
  const api = { fetchImpl: deps.fetchImpl, baseUrl: base };

  // The admin listing cannot be asked for one trail or paged, so it is read
  // both ways it can be ordered: newest first (which holds comments an admin
  // deleted that nobody reported, as far back as one read goes) and reported
  // first (every comment with a report or a review result, however old).
  const session = deps.session;
  const moderated: Promise<{ rows: AdminComment[] | null; admin: AdminAccess; coverage: AdminCoverage | null }> =
    session
      ? Promise.all([
          adminListComments(session, { reportedOnly: false }, api),
          adminListComments(session, { reportedOnly: true }, api),
        ]).then(
          ([newest, reported]) => ({
            // One row per comment: the two reads overlap.
            rows: [...new Map([...newest.comments, ...reported.comments].map(c => [c.id, c])).values()],
            admin: 'admin' as const,
            coverage: !newest.truncated
              ? ('complete' as const)
              : !reported.truncated
                ? ('recent' as const)
                : ('partial' as const),
          }),
          (error: unknown) => ({
            rows: null,
            admin:
              error instanceof ApiError && error.status === 403
                ? ('not-admin' as const)
                : error instanceof ApiError && error.status === 401
                  ? ('expired' as const)
                  : ('failed' as const),
            coverage: null,
          })
        )
      : Promise.resolve({ rows: null, admin: 'unlinked' as const, coverage: null });

  try {
    const [live, mod] = await Promise.all([listTrailComments(trailId, api), moderated]);
    const merged = mergeComments(live, mod.rows, trailId);
    return {
      kind: 'ready',
      byWaypoint: groupByWaypoint(merged),
      total: merged.length,
      admin: mod.admin,
      adminCoverage: mod.coverage,
    };
  } catch (error) {
    return { kind: 'error', message: describeFailure(error, base) };
  }
}

// ---------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------

/** `2026-10-05` from an ISO timestamp (UTC), or the input as it is if it is not one. Not escaped: callers escape it. */
export function commentDate(iso: string): string {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? new Date(at).toISOString().slice(0, 10) : iso;
}

const HIDDEN_LABELS: Record<DeletedBy, string> = {
  reports: 'hidden by reports',
  admin: 'deleted by an admin',
  owner: 'deleted by its author',
};

const WATER_LABELS: Record<WaterStatus, string> = { flowing: 'flowing', low: 'low', dry: 'dry' };

/** The list row's badge: how many comments a waypoint has, or nothing. */
export function commentBadgeHtml(count: number | undefined): string {
  if (!count) return '';
  const label = count === 1 ? '1 comment' : `${count} comments`;
  return `<span class="wpe-badge wpe-badge-comments" title="Hikers' comments">${label}</span>`;
}

export function commentHtml(c: EditorComment): string {
  const meta: string[] = [
    `<strong>${escapeHtml(c.displayName || 'A hiker')}</strong>`,
    escapeHtml(commentDate(c.createdAt)),
  ];
  if (c.observedAt && commentDate(c.observedAt) !== commentDate(c.createdAt)) {
    meta.push(`seen ${escapeHtml(commentDate(c.observedAt))}`);
  }
  const flags: string[] = [];
  if (c.hiddenBy) flags.push(`<span class="wpe-badge wpe-badge-dirty">${escapeHtml(HIDDEN_LABELS[c.hiddenBy])}</span>`);
  if (c.reportCount) {
    flags.push(
      `<span class="wpe-badge wpe-badge-dirty">${c.reportCount === 1 ? '1 report' : `${c.reportCount} reports`}</span>`
    );
  }
  const water = c.waterStatus
    ? `<p class="wpe-comment-water">Water: <strong>${escapeHtml(WATER_LABELS[c.waterStatus] ?? c.waterStatus)}</strong></p>`
    : '';
  const text = c.text ? `<p class="wpe-comment-text">${escapeHtml(c.text)}</p>` : '';
  const photos = c.photoUrls
    .map(u => safeHttpUrl(u))
    .filter((u): u is string => !!u)
    .map(
      (u, i) =>
        `<a href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer" title="Photo ${i + 1}">` +
        `<img src="${escapeHtml(u)}" alt="Photo ${i + 1}" loading="lazy" referrerpolicy="no-referrer"></a>`
    )
    .join('');
  return (
    `<li class="wpe-comment${c.hiddenBy ? ' is-hidden' : ''}" data-comment-id="${escapeHtml(c.id)}">` +
    `<div class="wpe-comment-meta">${meta.join(' · ')}${flags.length ? ` ${flags.join(' ')}` : ''}</div>` +
    water +
    text +
    (photos ? `<div class="wpe-comment-photos">${photos}</div>` : '') +
    `</li>`
  );
}

const ADMIN_NOTES: Record<Exclude<AdminAccess, 'admin'>, string> = {
  unlinked: 'Hidden comments and reports show only in a browser linked to an admin account.',
  'not-admin': 'This browser is linked, but not to an admin account: hidden comments are not shown.',
  expired: "This browser's link has expired or was revoked: hidden comments are not shown.",
  failed: 'The admin listing did not load: hidden comments are not shown.',
};

const ADMIN_LISTING_LIMITS = `The admin listing covers every trail, with no trail filter or cursor, and one read stops at ${ADMIN_LIST_LIMIT} rows`;

/** What an admin's reads added to the public comments, and what they could not be shown to include. */
const ADMIN_COVERAGE_NOTES: Record<AdminCoverage, string> = {
  complete:
    'Linked as an admin: comments hidden by reports or deleted by an admin are included, with report counts. Comments deleted by their author are left out.',
  recent:
    'Linked as an admin: report counts are included, with every comment that has a report or an automated-review result, hidden or not. ' +
    `${ADMIN_LISTING_LIMITS}, so a comment an admin deleted that was never reported or reviewed is included only when it is among the newest ${ADMIN_LIST_LIMIT} comments on all trails. ` +
    'Comments deleted by their author are left out.',
  partial:
    'Linked as an admin, but the admin listing was truncated. ' +
    `${ADMIN_LISTING_LIMITS} (those hidden by reports first), so some reported or hidden comments on this trail may be missing, and report counts with them; ` +
    `a comment an admin deleted that was never reported is included only when it is among the newest ${ADMIN_LIST_LIMIT} comments on all trails. ` +
    'Comments deleted by their author are left out.',
};

/** The line under the comments that says whose view this is: what is included, and what is not. */
export function adminNoteText(state: { admin: AdminAccess; adminCoverage: AdminCoverage | null }): string {
  // An admin read with no stated coverage claims nothing it cannot show.
  return state.admin === 'admin' ? ADMIN_COVERAGE_NOTES[state.adminCoverage ?? 'partial'] : ADMIN_NOTES[state.admin];
}

/** The comment count for the section heading: blank until loaded. */
export function commentsCountText(state: CommentsState, waypointId: string): string {
  return state.kind === 'ready' ? String(state.byWaypoint.get(waypointId)?.length ?? 0) : '';
}

/** "Show N more", and "Show all" when more than one further page remains. `attr` is the delegated click's `data-*`. */
function showMoreButtonsHtml(attr: string, shown: number, total: number, pageSize: number): string {
  const remaining = total - shown;
  if (remaining <= 0) return '';
  const step = Math.min(pageSize, remaining);
  return (
    ` <button type="button" class="wpe-btn wpe-btn-small" ${attr}="${shown + step}">Show ${step} more</button>` +
    (remaining > pageSize
      ? ` <button type="button" class="wpe-btn wpe-btn-small" ${attr}="all">Show all ${total}</button>`
      : '')
  );
}

/**
 * What the comments below the fold include that an editor must not miss:
 * hidden ones, and published ones with reports (both known only to an admin).
 */
function unshownFlagsText(unshown: readonly EditorComment[]): string {
  const hidden = unshown.filter(c => c.hiddenBy).length;
  const reported = unshown.filter(c => !c.hiddenBy && c.reportCount).length;
  if (!hidden && !reported) return '';
  const parts = [hidden ? `${hidden} hidden` : '', reported ? `${reported}${hidden ? ' more' : ''} reported` : ''];
  return `The ${unshown.length} not shown include ${parts.filter(Boolean).join(' and ')}.`;
}

/**
 * One waypoint's comments (newest first), the first `shown` of them, with the
 * line that says how many that is and the buttons that reveal the rest.
 * Comments past `shown` are left out of the markup, so their thumbnails are not fetched.
 */
export function commentsListHtml(list: readonly EditorComment[], shown: number = COMMENTS_PAGE_SIZE): string {
  if (!list.length) return '<p class="wpe-muted">No comments on this waypoint.</p>';
  const count = Math.min(list.length, Math.max(COMMENTS_PAGE_SIZE, shown));
  const items = `<ul class="wpe-comments-list">${list.slice(0, count).map(commentHtml).join('')}</ul>`;
  if (list.length <= COMMENTS_PAGE_SIZE) return items;
  if (count === list.length) {
    return `${items}<p class="wpe-muted wpe-comments-paging">Showing all ${list.length} comments.</p>`;
  }
  const flags = unshownFlagsText(list.slice(count));
  return (
    items +
    `<p class="wpe-muted wpe-comments-paging">Showing the newest ${count} of ${list.length} comments.` +
    (flags ? ` <strong class="wpe-comments-unshown">${flags}</strong>` : '') +
    showMoreButtonsHtml('data-comments-show', count, list.length, COMMENTS_PAGE_SIZE) +
    `</p>`
  );
}

/** The note listing ids with comments that no waypoint has, the first `shown` of them. */
export function orphanNoteHtml(orphaned: readonly string[], shown: number = ORPHAN_IDS_PAGE_SIZE): string {
  if (!orphaned.length) return '';
  const count = Math.min(orphaned.length, Math.max(ORPHAN_IDS_PAGE_SIZE, shown));
  const ids = orphaned
    .slice(0, count)
    .map(id => `<code class="wpe-orphan-id">${escapeHtml(id)}</code>`)
    .join(', ');
  const rest =
    count < orphaned.length
      ? `, and ${orphaned.length - count} more.` +
        showMoreButtonsHtml('data-orphans-show', count, orphaned.length, ORPHAN_IDS_PAGE_SIZE)
      : '.';
  return `<p class="wpe-muted">Comments are also filed under ${orphaned.length === 1 ? 'an id' : `${orphaned.length} ids`} no waypoint here has (a lost id?): ${ids}${rest}</p>`;
}

/**
 * A short line for the section's status region (`role="status"`), said after a
 * load, a Reload or "Show more". The section's body is not a live region: it
 * is re-rendered whole, and a screen reader would read every comment again.
 */
export function commentsStatusText(
  state: CommentsState,
  waypointId: string,
  shown: number = COMMENTS_PAGE_SIZE
): string {
  switch (state.kind) {
    case 'unconfigured':
      return 'Comments are unavailable: no comments API is configured.';
    case 'loading':
      return 'Loading comments…';
    case 'error':
      return 'Comments are unavailable.';
    case 'ready': {
      const total = state.byWaypoint.get(waypointId)?.length ?? 0;
      if (!total) return 'No comments on this waypoint.';
      const count = Math.min(total, Math.max(COMMENTS_PAGE_SIZE, shown));
      if (count < total) return `Showing the newest ${count} of ${total} comments.`;
      return total === 1 ? '1 comment on this waypoint.' : `${total} comments on this waypoint.`;
    }
  }
}

/**
 * The Comments section's body for one waypoint, in every state. Every state
 * but "unconfigured" carries the reload control (`data-comments-reload`), so
 * the page can hand keyboard focus from one render's control to the next's;
 * while loading it is `aria-disabled`, which keeps it focusable.
 * `shown` and `orphansShown` are how many comments and orphaned ids to list
 * (`revealFor`); the default is one page of each.
 */
export function commentsSectionHtml(
  state: CommentsState,
  waypointId: string,
  options: {
    orphaned?: readonly string[];
    shown?: number;
    orphansShown?: number;
    /**
     * Said over the list once loaded, e.g. that the app shows none of these (a
     * merged-away duplicate). It sits above the first comment, so paging never hides it.
     */
    note?: string;
  } = {}
): string {
  switch (state.kind) {
    case 'unconfigured':
      return '<p class="wpe-muted">Comments are unavailable: no comments API is configured (set <code>VITE_API_BASE_URL</code> and restart <code>npm run dev</code>).</p>';
    case 'loading':
      return (
        '<p class="wpe-muted">Loading comments… ' +
        '<button type="button" class="wpe-btn wpe-btn-small" data-comments-reload aria-disabled="true">Reload</button></p>'
      );
    case 'error':
      return (
        `<p class="wpe-muted is-error">Comments are unavailable. ${escapeHtml(state.message)}</p>` +
        '<button type="button" class="wpe-btn wpe-btn-small" data-comments-reload>Try again</button>'
      );
    case 'ready':
      return (
        (options.note ? `<p class="wpe-comments-note">${escapeHtml(options.note)}</p>` : '') +
        commentsListHtml(state.byWaypoint.get(waypointId) ?? [], options.shown) +
        `<p class="wpe-muted">${state.total === 1 ? '1 comment' : `${state.total} comments`} on this trail. ${escapeHtml(adminNoteText(state))} ` +
        '<button type="button" class="wpe-btn wpe-btn-small" data-comments-reload>Reload</button></p>' +
        orphanNoteHtml(options.orphaned ?? [], options.orphansShown)
      );
  }
}
