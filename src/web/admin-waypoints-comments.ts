/**
 * Hikers' comments in the waypoint editor: what the comments API holds about
 * each waypoint ("the tank is gone", "the camp is 200 m further on"), shown
 * beside the form so a report can feed a correction.
 *
 * One public bulk read per trail (`listTrailComments`) is grouped by stable
 * waypoint id; when this browser is linked to an admin account, the admin
 * listing of reported and flagged comments adds hidden ones and report counts.
 * The editor only reads: nothing here posts, edits or moderates.
 *
 * Everything in a comment is user-supplied: every string goes through
 * `escapeHtml` and every photo URL through `safeHttpUrl`. The markup builders
 * are pure and tested in `admin-waypoints-comments.test.ts`;
 * `admin-waypoints.ts` wires them to the page.
 */

import { commentTargetKind } from '@lib/comment-targets';
import type { AdminComment, DeletedBy, SyncComment, WaterStatus } from '@lib/comments-api-types';
import { safeHttpUrl } from '@lib/poi-display';
import { ApiError, NetworkError, getApiBase, type FetchLike } from './api/client';
import { adminListModeratedComments, listTrailComments } from './api/comments';
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
 * shared hiker waypoints take comments too and are not counted.
 */
export function orphanedCommentIds(state: CommentsState, knownIds: ReadonlySet<string>): string[] {
  if (state.kind !== 'ready') return [];
  return [...state.byWaypoint.keys()].filter(id => commentTargetKind(id) === 'curated' && !knownIds.has(id)).sort();
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

  const moderated: Promise<{ rows: AdminComment[] | null; admin: AdminAccess }> = deps.session
    ? adminListModeratedComments(deps.session, api).then(
        rows => ({ rows, admin: 'admin' as const }),
        (error: unknown) => ({
          rows: null,
          admin:
            error instanceof ApiError && error.status === 403
              ? ('not-admin' as const)
              : error instanceof ApiError && error.status === 401
                ? ('expired' as const)
                : ('failed' as const),
        })
      )
    : Promise.resolve({ rows: null, admin: 'unlinked' as const });

  try {
    const [live, mod] = await Promise.all([listTrailComments(trailId, api), moderated]);
    const merged = mergeComments(live, mod.rows, trailId);
    return { kind: 'ready', byWaypoint: groupByWaypoint(merged), total: merged.length, admin: mod.admin };
  } catch (error) {
    return { kind: 'error', message: describeFailure(error, base) };
  }
}

// ---------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------

/** `2026-10-05` from an ISO timestamp (UTC), or the input escaped if it is not one. */
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

const ADMIN_NOTES: Record<AdminAccess, string> = {
  unlinked: 'Hidden comments and reports show only in a browser linked to an admin account.',
  admin: 'Linked as an admin: hidden comments and report counts are included.',
  'not-admin': 'This browser is linked, but not to an admin account: hidden comments are not shown.',
  expired: "This browser's link has expired or was revoked: hidden comments are not shown.",
  failed: 'The admin listing did not load: hidden comments are not shown.',
};

/** The comment count for the section heading: blank until loaded. */
export function commentsCountText(state: CommentsState, waypointId: string): string {
  return state.kind === 'ready' ? String(state.byWaypoint.get(waypointId)?.length ?? 0) : '';
}

/** The Comments section's body for one waypoint, in every state. */
export function commentsSectionHtml(
  state: CommentsState,
  waypointId: string,
  options: { orphaned?: readonly string[] } = {}
): string {
  switch (state.kind) {
    case 'unconfigured':
      return '<p class="wpe-muted">Comments are unavailable: no comments API is configured (set <code>VITE_API_BASE_URL</code> and restart <code>npm run dev</code>).</p>';
    case 'loading':
      return '<p class="wpe-muted">Loading comments…</p>';
    case 'error':
      return (
        `<p class="wpe-muted is-error">Comments are unavailable. ${escapeHtml(state.message)}</p>` +
        '<button type="button" class="wpe-btn wpe-btn-small" data-comments-reload>Try again</button>'
      );
    case 'ready': {
      const list = state.byWaypoint.get(waypointId) ?? [];
      const body = list.length
        ? `<ul class="wpe-comments-list">${list.map(commentHtml).join('')}</ul>`
        : '<p class="wpe-muted">No comments on this waypoint.</p>';
      const orphaned = options.orphaned ?? [];
      const orphanNote = orphaned.length
        ? `<p class="wpe-muted">Comments are also filed under ${orphaned.length === 1 ? 'an id' : `${orphaned.length} ids`} no waypoint here has (a lost id?): ${orphaned
            .map(id => `<code>${escapeHtml(id)}</code>`)
            .join(', ')}.</p>`
        : '';
      return (
        body +
        `<p class="wpe-muted">${state.total === 1 ? '1 comment' : `${state.total} comments`} on this trail. ${escapeHtml(ADMIN_NOTES[state.admin])} ` +
        '<button type="button" class="wpe-btn wpe-btn-small" data-comments-reload>Reload</button></p>' +
        orphanNote
      );
    }
  }
}
