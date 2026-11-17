import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminComment, SyncComment } from '@lib/comments-api-types';
import {
  COMMENTS_PAGE_SIZE,
  ORPHAN_IDS_PAGE_SIZE,
  commentBadgeHtml,
  commentCounts,
  commentHtml,
  commentsCountText,
  commentsListHtml,
  commentsSectionHtml,
  groupByWaypoint,
  loadTrailComments,
  mergeComments,
  orphanNoteHtml,
  orphanedCommentIds,
  parseShown,
  revealFor,
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
    expect(html).toContain('w_&lt;x&gt;</code>');
    expect(commentsSectionHtml(state, 'w_0000cccc')).toContain('No comments on this waypoint.');
  });

  it('badges a row only when it has comments', () => {
    expect(commentBadgeHtml(undefined)).toBe('');
    expect(commentBadgeHtml(0)).toBe('');
    expect(commentBadgeHtml(1)).toContain('1 comment<');
    expect(commentBadgeHtml(4)).toContain('4 comments');
  });
});

describe('paging a waypoint’s comments', () => {
  const N = COMMENTS_PAGE_SIZE;

  /** `count` comments on one waypoint, `c0` the newest, each with a thumbnail named after it. */
  function comments(count: number, extra: (i: number) => Partial<EditorComment> = () => ({})): EditorComment[] {
    const list = Array.from({ length: count }, (_, i) =>
      editor({
        id: `c${i}`,
        text: `Comment ${i}`,
        createdAt: new Date(Date.UTC(2026, 9, 1) - i * 3_600_000).toISOString(),
        photoUrls: [`https://data.example.test/p/${i}.jpg`],
        ...extra(i),
      })
    );
    return groupByWaypoint(list).get('w_0000aaaa')!;
  }

  function parse(html: string) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return {
      ids: [...doc.querySelectorAll('.wpe-comment')].map(li => li.getAttribute('data-comment-id')),
      images: [...doc.querySelectorAll('img')],
      paging: doc.querySelector('.wpe-comments-paging')?.textContent ?? null,
      unshown: doc.querySelector('.wpe-comments-unshown')?.textContent ?? null,
      buttons: [...doc.querySelectorAll('button[data-comments-show]')].map(b => [
        b.textContent,
        b.getAttribute('data-comments-show'),
      ]),
    };
  }

  it('shows a page or less whole, with no paging line', () => {
    const page = parse(commentsListHtml(comments(N)));
    expect(page.ids).toHaveLength(N);
    expect(page.paging).toBeNull();
    expect(page.buttons).toEqual([]);
    expect(parse(commentsListHtml(comments(3))).ids).toEqual(['c0', 'c1', 'c2']);
  });

  it('shows the newest page of one more than a page, and offers the one left', () => {
    const page = parse(commentsListHtml(comments(N + 1)));
    expect(page.ids).toEqual(Array.from({ length: N }, (_, i) => `c${i}`));
    expect(page.paging).toContain(`Showing the newest ${N} of ${N + 1} comments.`);
    expect(page.buttons).toEqual([['Show 1 more', String(N + 1)]]);
  });

  it('offers the last page alone when exactly one further page remains', () => {
    expect(parse(commentsListHtml(comments(2 * N))).buttons).toEqual([[`Show ${N} more`, String(2 * N)]]);
  });

  it('offers the next page and "Show all" when more than one further page remains', () => {
    const list = comments(3 * N + 5);
    const first = parse(commentsListHtml(list));
    expect(first.ids).toHaveLength(N);
    expect(first.buttons).toEqual([
      [`Show ${N} more`, String(2 * N)],
      [`Show all ${3 * N + 5}`, 'all'],
    ]);

    const second = parse(commentsListHtml(list, 2 * N));
    expect(second.ids).toHaveLength(2 * N);
    expect(second.ids.at(-1)).toBe(`c${2 * N - 1}`);
    expect(second.paging).toContain(`Showing the newest ${2 * N} of ${3 * N + 5} comments.`);
    expect(second.buttons).toEqual([
      [`Show ${N} more`, String(3 * N)],
      [`Show all ${3 * N + 5}`, 'all'],
    ]);

    const last = parse(commentsListHtml(list, 3 * N));
    expect(last.buttons).toEqual([['Show 5 more', String(3 * N + 5)]]);
  });

  it('shows everything after "Show all", and when more is asked for than there is', () => {
    const list = comments(3 * N + 5);
    for (const shown of [parseShown('all')!, 3 * N + 5, 1000]) {
      const all = parse(commentsListHtml(list, shown));
      expect(all.ids).toHaveLength(3 * N + 5);
      expect(all.paging).toBe(`Showing all ${3 * N + 5} comments.`);
      expect(all.buttons).toEqual([]);
    }
  });

  it('never shows less than a page', () => {
    expect(parse(commentsListHtml(comments(N + 1), 0)).ids).toHaveLength(N);
    expect(parse(commentsListHtml(comments(4), 1)).ids).toHaveLength(4);
  });

  it('leaves comments that are not shown out of the markup, so their thumbnails are not fetched', () => {
    const page = parse(commentsListHtml(comments(N + 3)));
    expect(page.images.map(img => img.getAttribute('src'))).toEqual(
      Array.from({ length: N }, (_, i) => `https://data.example.test/p/${i}.jpg`)
    );
    expect(page.images.every(img => img.getAttribute('loading') === 'lazy')).toBe(true);
    expect(commentsListHtml(comments(N + 3))).not.toContain(`/p/${N}.jpg`);
  });

  it('says when comments below the fold are hidden or reported', () => {
    const list = comments(3 * N, i => {
      if (i === 2) return { hiddenBy: 'reports', reportCount: 4 }; // on the first page: not counted
      if (i === N + 1) return { hiddenBy: 'reports', reportCount: 3 };
      if (i === N + 2) return { hiddenBy: 'admin', reportCount: 0 };
      if (i === 2 * N + 1) return { reportCount: 1 };
      return {};
    });
    expect(parse(commentsListHtml(list)).unshown).toBe(`The ${2 * N} not shown include 2 hidden and 1 more reported.`);
    expect(parse(commentsListHtml(list, 2 * N)).unshown).toBe(`The ${N} not shown include 1 reported.`);
    expect(parse(commentsListHtml(list, 3 * N)).unshown).toBeNull();

    const hiddenOnly = comments(N + 2, i => (i === N ? { hiddenBy: 'admin' } : {}));
    expect(parse(commentsListHtml(hiddenOnly)).unshown).toBe('The 2 not shown include 1 hidden.');
    // Without the admin listing nothing is known to be hidden or reported.
    expect(parse(commentsListHtml(comments(3 * N))).unshown).toBeNull();
  });

  it('pages the section, keeping the heading count the waypoint’s total', () => {
    const list = [...comments(2 * N + 1), editor({ id: 'other', waypointId: 'w_0000bbbb' })];
    const state = ready(list, 'admin');
    expect(commentsCountText(state, 'w_0000aaaa')).toBe(String(2 * N + 1));
    const first = parse(commentsSectionHtml(state, 'w_0000aaaa'));
    expect(first.ids).toHaveLength(N);
    expect(first.buttons.map(b => b[1])).toEqual([String(2 * N), 'all']);
    expect(parse(commentsSectionHtml(state, 'w_0000aaaa', { shown: 2 * N })).ids).toHaveLength(2 * N);
    expect(commentsSectionHtml(state, 'w_0000aaaa')).toContain(`${2 * N + 2} comments on this trail`);
    expect(parse(commentsSectionHtml(state, 'w_0000bbbb')).paging).toBeNull();
  });
});

describe('revealFor and parseShown', () => {
  it('keeps what was revealed for the same waypoint and starts again for another', () => {
    const first = revealFor(null, 'heysen/w_0000aaaa', COMMENTS_PAGE_SIZE);
    expect(first).toEqual({ key: 'heysen/w_0000aaaa', shown: COMMENTS_PAGE_SIZE });
    const more = { key: first.key, shown: 30 };
    expect(revealFor(more, 'heysen/w_0000aaaa', COMMENTS_PAGE_SIZE)).toBe(more);
    const other = revealFor(more, 'heysen/w_0000bbbb', COMMENTS_PAGE_SIZE);
    expect(other).toEqual({ key: 'heysen/w_0000bbbb', shown: COMMENTS_PAGE_SIZE });
    // Back on the first waypoint, what was revealed there is forgotten.
    expect(revealFor(other, 'heysen/w_0000aaaa', COMMENTS_PAGE_SIZE).shown).toBe(COMMENTS_PAGE_SIZE);
  });

  it('reads a button’s count, and nothing else', () => {
    expect(parseShown('20')).toBe(20);
    expect(parseShown('all')).toBe(Infinity);
    for (const bad of [undefined, '', '0', '-5', '1.5', 'lots']) expect(parseShown(bad)).toBeNull();
  });
});

describe('orphanNoteHtml', () => {
  const M = ORPHAN_IDS_PAGE_SIZE;
  const ids = (count: number) => Array.from({ length: count }, (_, i) => `w_${String(i).padStart(8, '0')}`);

  function parse(html: string) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return {
      ids: [...doc.querySelectorAll('.wpe-orphan-id')].map(c => c.textContent),
      text: doc.body.textContent ?? '',
      buttons: [...doc.querySelectorAll('button[data-orphans-show]')].map(b => [
        b.textContent,
        b.getAttribute('data-orphans-show'),
      ]),
    };
  }

  it('says nothing without orphans, and lists a page or less whole', () => {
    expect(orphanNoteHtml([])).toBe('');
    expect(parse(orphanNoteHtml(['w_deadbeef'])).text).toContain('under an id no waypoint here has');
    const page = parse(orphanNoteHtml(ids(M)));
    expect(page.ids).toEqual(ids(M));
    expect(page.buttons).toEqual([]);
  });

  it('caps a long list, saying how many more there are', () => {
    const first = parse(orphanNoteHtml(ids(2 * M + 3)));
    expect(first.ids).toEqual(ids(M));
    expect(first.text).toContain(`under ${2 * M + 3} ids no waypoint here has`);
    expect(first.text).toContain(`and ${M + 3} more.`);
    expect(first.buttons).toEqual([
      [`Show ${M} more`, String(2 * M)],
      [`Show all ${2 * M + 3}`, 'all'],
    ]);
    const second = parse(orphanNoteHtml(ids(2 * M + 3), 2 * M));
    expect(second.ids).toHaveLength(2 * M);
    expect(second.buttons).toEqual([['Show 3 more', String(2 * M + 3)]]);
    const all = parse(orphanNoteHtml(ids(2 * M + 3), Infinity));
    expect(all.ids).toHaveLength(2 * M + 3);
    expect(all.text).not.toContain('more');
  });

  it('escapes the ids, and takes its count from the section', () => {
    expect(orphanNoteHtml(['w_<x>'])).toContain('&lt;x&gt;</code>');
    const state = ready([editor()]);
    const html = commentsSectionHtml(state, 'w_0000aaaa', { orphaned: ids(M + 5), orphansShown: M + 5 });
    expect(parse(html).ids).toHaveLength(M + 5);
    expect(parse(commentsSectionHtml(state, 'w_0000aaaa', { orphaned: ids(M + 5) })).ids).toHaveLength(M);
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
