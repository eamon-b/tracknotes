import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminComment, SyncComment } from '@lib/comments-api-types';
import {
  commentBadgeHtml,
  commentCounts,
  commentHtml,
  commentsCountText,
  commentsSectionHtml,
  groupByWaypoint,
  loadTrailComments,
  mergeComments,
  orphanedCommentIds,
  type CommentsState,
  type EditorComment,
} from './admin-waypoints-comments';
import type { WebSession } from './api/session';

const BASE = 'https://api.example.test';

function live(extra: Partial<SyncComment> = {}): SyncComment {
  return {
    id: 'c1',
    waypointId: 'w_0000aaaa',
    displayName: 'Walker',
    text: 'The tank is gone.',
    waterStatus: null,
    observedAt: null,
    createdAt: '2026-10-01T08:00:00.000Z',
    updatedAt: '2026-10-01T08:00:00.000Z',
    ...extra,
  };
}

function moderated(extra: Partial<AdminComment> = {}): AdminComment {
  return {
    id: 'c9',
    trailId: 'heysen',
    waypointId: 'w_0000aaaa',
    userId: 'u1',
    displayName: 'Reported walker',
    text: 'Hidden text',
    waterStatus: null,
    observedAt: null,
    createdAt: '2026-10-03T08:00:00.000Z',
    updatedAt: '2026-10-03T08:00:00.000Z',
    deletedAt: '2026-10-04T08:00:00.000Z',
    deletedBy: 'reports',
    userBanned: false,
    userAdmin: false,
    userDeleted: false,
    restoredAt: null,
    photoUrls: [],
    reportCount: 3,
    reports: [],
    review: null,
    ...extra,
  };
}

function editor(extra: Partial<EditorComment> = {}): EditorComment {
  return { ...mergeComments([live()], null, 'heysen')[0], ...extra };
}

function ready(comments: EditorComment[], admin: 'unlinked' | 'admin' = 'unlinked'): CommentsState {
  return { kind: 'ready', byWaypoint: groupByWaypoint(comments), total: comments.length, admin };
}

describe('groupByWaypoint', () => {
  it('keys by waypoint id, newest first, ties broken by id', () => {
    const groups = groupByWaypoint([
      editor({ id: 'a', createdAt: '2026-01-01T00:00:00Z' }),
      editor({ id: 'b', createdAt: '2026-03-01T00:00:00Z' }),
      editor({ id: 'c', waypointId: 'w_0000bbbb' }),
      editor({ id: 'd', createdAt: '2026-03-01T00:00:00Z' }),
    ]);
    expect([...groups.keys()]).toEqual(['w_0000aaaa', 'w_0000bbbb']);
    expect(groups.get('w_0000aaaa')!.map(c => c.id)).toEqual(['d', 'b', 'a']);
    expect(commentCounts(ready([...groups.values()].flat())).get('w_0000aaaa')).toBe(3);
  });

  it('counts nothing until loaded', () => {
    expect(commentCounts({ kind: 'loading' }).size).toBe(0);
    expect(commentsCountText({ kind: 'loading' }, 'w_0000aaaa')).toBe('');
    expect(commentsCountText(ready([editor()]), 'w_0000bbbb')).toBe('0');
  });
});

describe('mergeComments', () => {
  it('adds hidden comments and report counts from the admin listing, for this trail only', () => {
    const merged = mergeComments(
      [live()],
      [
        moderated(),
        moderated({ id: 'c1', deletedAt: null, deletedBy: null, reportCount: 1 }),
        moderated({ id: 'other', trailId: 'larapinta' }),
        moderated({ id: 'withdrawn', deletedBy: 'owner' }),
      ],
      'heysen'
    );
    expect(merged.map(c => [c.id, c.hiddenBy, c.reportCount])).toEqual([
      ['c1', null, 1],
      ['c9', 'reports', 3],
    ]);
  });

  it('leaves the public comments alone without an admin listing', () => {
    expect(mergeComments([live({ photoUrls: undefined })], null, 'heysen')[0]).toMatchObject({
      hiddenBy: null,
      reportCount: null,
      photoUrls: [],
    });
  });
});

describe('orphanedCommentIds', () => {
  it('lists curated ids no waypoint has, not POIs or shared waypoints', () => {
    const state = ready([
      editor({ waypointId: 'w_0000aaaa' }),
      editor({ id: 'x', waypointId: 'w_deadbeef' }),
      editor({ id: 'y', waypointId: 'osm_node_12' }),
      editor({ id: 'z', waypointId: 'hw_0b8e3c5e-1d2f-4a3b-8c4d-5e6f7a8b9c0d' }),
    ]);
    expect(orphanedCommentIds(state, new Set(['w_0000aaaa']))).toEqual(['w_deadbeef']);
  });
});

describe('commentHtml', () => {
  it('escapes every user-supplied string', () => {
    const html = commentHtml(
      editor({ displayName: '<b>x</b>', text: '<img src=x onerror=alert(1)>', id: '"><script>' })
    );
    expect(html).not.toContain('<b>x</b>');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('"><script>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('links photos only through safeHttpUrl', () => {
    const html = commentHtml(
      editor({ photoUrls: ['javascript:alert(1)', 'https://data.example.test/p/1.jpg?a=1&b="2"'] })
    );
    expect(html).not.toContain('javascript:');
    const doc = new DOMParser().parseFromString(`<ul>${html}</ul>`, 'text/html');
    const links = [...doc.querySelectorAll('.wpe-comment-photos a')];
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('https://data.example.test/p/1.jpg?a=1&b=%222%22');
    expect(links[0].getAttribute('rel')).toBe('noopener noreferrer');
    expect(doc.querySelector('img')!.getAttribute('src')).toBe(links[0].getAttribute('href'));
  });

  it('shows the date, when it was seen, water, and hidden or reported status', () => {
    const html = commentHtml(
      editor({
        observedAt: '2026-09-28T00:00:00.000Z',
        waterStatus: 'dry',
        hiddenBy: 'reports',
        reportCount: 2,
      })
    );
    expect(html).toContain('2026-10-01');
    expect(html).toContain('seen 2026-09-28');
    expect(html).toContain('Water: <strong>dry</strong>');
    expect(html).toContain('hidden by reports');
    expect(html).toContain('2 reports');
    expect(html).toContain('is-hidden');
  });
});

describe('commentsSectionHtml', () => {
  it('says why comments are unavailable', () => {
    expect(commentsSectionHtml({ kind: 'unconfigured' }, 'w_1')).toContain('VITE_API_BASE_URL');
    expect(commentsSectionHtml({ kind: 'loading' }, 'w_1')).toContain('Loading');
    const error = commentsSectionHtml({ kind: 'error', message: 'Nope <b>' }, 'w_1');
    expect(error).toContain('Nope &lt;b&gt;');
    expect(error).toContain('data-comments-reload');
  });

  it('lists the waypoint’s comments, or says it has none, with the trail total and orphans', () => {
    const state = ready([editor(), editor({ id: 'c2', waypointId: 'w_0000bbbb' })], 'admin');
    const html = commentsSectionHtml(state, 'w_0000aaaa', { orphaned: ['w_<x>'] });
    expect(html).toContain('The tank is gone.');
    expect(html).toContain('2 comments on this trail');
    expect(html).toContain('Linked as an admin');
    expect(html).toContain('<code>w_&lt;x&gt;</code>');
    expect(commentsSectionHtml(state, 'w_0000cccc')).toContain('No comments on this waypoint.');
  });

  it('badges a row only when it has comments', () => {
    expect(commentBadgeHtml(undefined)).toBe('');
    expect(commentBadgeHtml(0)).toBe('');
    expect(commentBadgeHtml(1)).toContain('1 comment<');
    expect(commentBadgeHtml(4)).toContain('4 comments');
  });
});

describe('loadTrailComments', () => {
  afterEach(() => vi.unstubAllEnvs());

  const session: WebSession = { userId: 'u1', token: 'tok', displayName: 'Admin', expiresAt: null };

  function respond(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }

  it('is unconfigured without an API base', async () => {
    vi.stubEnv('VITE_API_BASE_URL', '');
    expect(await loadTrailComments('heysen', { session: null })).toEqual({ kind: 'unconfigured' });
  });

  it('follows the bulk cursor without a token, and skips tombstones', async () => {
    const calls: { url: string; auth: string | undefined }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), auth: (init?.headers as Record<string, string>).Authorization });
      return String(url).includes('cursor=')
        ? respond(200, {
            comments: [{ id: 'gone', waypointId: 'w_0000aaaa', deleted: true, updatedAt: 'x' }, live({ id: 'c2' })],
            nextCursor: null,
            syncedAt: 'x',
          })
        : respond(200, { comments: [live()], nextCursor: 'next', syncedAt: 'x' });
    });
    const state = await loadTrailComments('heysen', { session: null, fetchImpl, baseUrl: BASE });
    expect(calls.map(c => c.url)).toEqual([
      `${BASE}/v1/trails/heysen/comments?limit=1000`,
      `${BASE}/v1/trails/heysen/comments?limit=1000&cursor=next`,
    ]);
    expect(calls.every(c => c.auth === undefined)).toBe(true);
    expect(state).toMatchObject({ kind: 'ready', total: 2, admin: 'unlinked' });
  });

  it('adds the admin listing for an admin, and degrades for anyone else', async () => {
    const make = (adminStatus: number) =>
      vi.fn(async (url: string | URL | Request) =>
        String(url).includes('/admin/')
          ? adminStatus === 200
            ? respond(200, { comments: [moderated()] })
            : respond(adminStatus, { error: { code: 'forbidden', message: 'no' } })
          : respond(200, { comments: [live()], nextCursor: null, syncedAt: 'x' })
      );
    const asAdmin = await loadTrailComments('heysen', { session, fetchImpl: make(200), baseUrl: BASE });
    expect(asAdmin).toMatchObject({ kind: 'ready', total: 2, admin: 'admin' });
    expect(await loadTrailComments('heysen', { session, fetchImpl: make(403), baseUrl: BASE })).toMatchObject({
      total: 1,
      admin: 'not-admin',
    });
    expect(await loadTrailComments('heysen', { session, fetchImpl: make(401), baseUrl: BASE })).toMatchObject({
      admin: 'expired',
    });
  });

  it('reports a failed read as an error state', async () => {
    const offline = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const state = await loadTrailComments('heysen', { session: null, fetchImpl: offline, baseUrl: BASE });
    expect(state.kind).toBe('error');
    expect(state.kind === 'error' && state.message).toContain('CORS');
    const failing = vi.fn(async () => respond(500, { error: { code: 'internal_error', message: 'boom' } }));
    expect(await loadTrailComments('heysen', { session: null, fetchImpl: failing, baseUrl: BASE })).toEqual({
      kind: 'error',
      message: 'The comments API answered 500: boom',
    });
  });
});
