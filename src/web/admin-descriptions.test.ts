/**
 * The live description editor renders waypoint names and descriptions (the
 * synced ones written through the API included): none may reach the page as
 * markup. It reads the committed descriptions.json bundled into the page,
 * tells a live edit the file does not match (drift, exported) from a row that
 * only waits for an upload (neither), writes only through the admin PUT with
 * the version it read, and offers editing only to an admin's linked browser.
 * A later pass of a revisited place shows its first pass's synced text, and is
 * edited there: nothing is ever saved under its own id.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const XSS = '<img src=x onerror=alert(1)>';

const heysenFile = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/trails/heysen/descriptions.json'), 'utf8')) as {
  descriptions: { waypointId: string; name: string; description: string }[];
};
const [first, second] = heysenFile.descriptions;

function loadPage(): void {
  const html = fs.readFileSync(path.join(ROOT, 'src/web/admin-descriptions.html'), 'utf8');
  document.documentElement.innerHTML = html.replace(/<!DOCTYPE html>/i, '').replace(/<\/?html[^>]*>/gi, '');
}

async function waitFor(cond: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!cond() && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
}

function wp(id: string, name: string, km: number, description: string) {
  return { id, name, type: 'campsite', lat: -35, lon: 138, description, totalDistance: km };
}

const trail = {
  track: { points: [] },
  waypoints: [
    wp(first.waypointId, first.name, 0, first.description),
    wp(second.waypointId, second.name, 5, second.description),
    wp('w_xss00001', `Name ${XSS}`, 9, `Bundled ${XSS}`),
  ],
  offTrailWaypoints: [],
  alternates: [],
  sideTrips: [],
};

/** Three Passes walks back out through Lobuche: two passes of one place, and no descriptions.json. */
const LOBUCHE = 'w_07233ee1';
const LOBUCHE_2 = 'w_07233ee1_2';
const passesTrail = {
  track: { points: [] },
  waypoints: [
    wp(LOBUCHE, 'Lobuche', 60, 'Bundled Lobuche.'),
    wp('w_00176641', 'Gorak Shep', 65, 'Bundled Gorak Shep.'),
    wp(LOBUCHE_2, 'Lobuche', 70, 'Bundled Lobuche.'),
  ],
  offTrailWaypoints: [],
  alternates: [],
  sideTrips: [],
};

interface Row {
  waypointId: string;
  description: string;
  updatedAt: string;
  source?: 'live' | 'upload';
}

/** The API's rows for heysen. */
let synced: Row[];
/** The API's rows for three_passes. */
let passesSynced: Row[];
let isAdmin: boolean;
/** What `GET /v1/me` answers with. */
let meStatus: number;
/**
 * False for a worker that predates the `source` marker and the `ifUpdatedAt`
 * check: it stores no origin, checks no precondition, and its read carries no
 * `writeFeatures`.
 */
let workerRecordsSource: boolean;
/** A PUT answered without a `source`, by a worker whose read said it records one. */
let putOmitsSource: boolean;
/** A read answered without `writeFeatures`, whatever the worker's PUT does. */
let readOmitsFeatures: boolean;
/** Awaited by the stubbed PUT before it answers, to hold a save in flight. */
let holdPut: Promise<void> | null;
let putClock: number;
let fetchMock: ReturnType<typeof vi.fn>;

function respond(status: number, body: unknown) {
  return { ok: status < 400, status, statusText: '', text: async () => JSON.stringify(body), json: async () => body };
}

/** The worker's PUT (`workers/comments-api/src/descriptions.ts`), in its response shapes. */
function workerPut(
  trailId: string,
  waypointId: string,
  body: { description: string; source?: 'live' | 'upload'; ifUpdatedAt?: string | null }
) {
  const stored = trailId === 'heysen' ? synced : passesSynced;
  const current = stored.find(s => s.waypointId === waypointId);
  const checked = workerRecordsSource && body.ifUpdatedAt !== undefined;
  const stale =
    checked && (body.ifUpdatedAt === null ? current !== undefined : current?.updatedAt !== body.ifUpdatedAt);
  if (current && current.description === body.description) return respond(200, current);
  if (stale) {
    return respond(409, {
      error: { code: 'description_conflict', message: 'This description has changed since it was read' },
      current: current ?? null,
    });
  }
  const row: Row = {
    waypointId,
    description: body.description,
    updatedAt: new Date(Date.UTC(2026, 10, 17, 0, 0, putClock++)).toISOString(),
    ...(workerRecordsSource && !putOmitsSource ? { source: body.source ?? 'upload' } : {}),
  };
  const next = [...stored.filter(s => s.waypointId !== waypointId), row];
  if (trailId === 'heysen') synced = next;
  else passesSynced = next;
  return respond(200, row);
}

beforeEach(() => {
  vi.resetModules();
  window.localStorage.clear();
  window.localStorage.setItem(
    'tracknotes.webSession',
    JSON.stringify({ userId: 'u1', token: 'tok', displayName: 'Admin', expiresAt: null })
  );
  vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.test');
  isAdmin = true;
  meStatus = 200;
  workerRecordsSource = true;
  putOmitsSource = false;
  readOmitsFeatures = false;
  holdPut = null;
  putClock = 0;
  synced = [
    {
      waypointId: first.waypointId,
      description: first.description,
      updatedAt: '2026-11-01T00:00:00.000Z',
      source: 'upload',
    },
    {
      waypointId: second.waypointId,
      description: `Corrected live ${XSS}`,
      updatedAt: '2026-11-02T00:00:00.000Z',
      source: 'live',
    },
  ];
  passesSynced = [];
  fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    if (input.endsWith('data/generated/index.json')) {
      return respond(200, [
        { id: 'aawt', name: 'Australian Alps Walking Track' },
        { id: 'heysen', name: 'Heysen Trail' },
        { id: 'three_passes', name: 'Everest Three Passes' },
      ]);
    }
    if (input.endsWith('data/generated/heysen.json')) return respond(200, trail);
    if (input.endsWith('data/generated/three_passes.json')) return respond(200, passesTrail);
    if (input.endsWith('data/generated/aawt.json')) return respond(200, { ...trail, waypoints: [] });
    if (input === 'https://api.example.test/v1/me') {
      return meStatus === 200
        ? respond(200, { userId: 'u1', displayName: 'Admin', isAdmin })
        : respond(meStatus, { error: { code: 'unavailable', message: 'Service unavailable' } });
    }
    if (input.startsWith('https://api.example.test/v1/trails/') && input.endsWith('/descriptions')) {
      return respond(200, {
        descriptions: input.includes('/heysen/') ? synced : input.includes('/three_passes/') ? passesSynced : [],
        syncedAt: 'now',
        ...(workerRecordsSource && !readOmitsFeatures ? { writeFeatures: ['source', 'ifUpdatedAt'] } : {}),
      });
    }
    const put = /\/v1\/admin\/trails\/(heysen|three_passes)\/descriptions\/([^/]+)$/.exec(input);
    if (put && init?.method === 'PUT') {
      if (holdPut) await holdPut;
      return workerPut(put[1], put[2], JSON.parse(String(init.body)) as Parameters<typeof workerPut>[2]);
    }
    return respond(404, { error: { code: 'not_found', message: input } });
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('CSS', { escape: (s: string) => s });
  window.history.replaceState(null, '', '/admin-descriptions.html?trail=heysen');
  loadPage();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const rowFor = (id: string) => document.querySelector<HTMLElement>(`[data-row="${id}"]`)!;
const badge = (id: string) => rowFor(id)?.querySelector('.desc-badge')?.textContent;
const summaryText = () => document.getElementById('desc-summary')!.textContent!;
/** The banner that says why nothing can be saved. */
const unguarded = () => document.getElementById('desc-unguarded')!;
const puts = () =>
  fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')
    .map(([url, init]) => ({ url: String(url), body: JSON.parse(String((init as RequestInit).body)) as unknown }));

async function loaded(): Promise<void> {
  await import('./admin-descriptions');
  await waitFor(() => document.querySelectorAll('.desc-row').length === 3);
}

function edit(id: string, text: string): HTMLTextAreaElement {
  rowFor(id).querySelector<HTMLButtonElement>('[data-action="edit"]')!.click();
  const box = rowFor(id).querySelector<HTMLTextAreaElement>('textarea')!;
  box.value = text;
  box.dispatchEvent(new Event('input', { bubbles: true }));
  return box;
}

const save = (id: string) => rowFor(id).querySelector<HTMLButtonElement>('[data-action="save"]')!.click();

/** The file the Download button hands over. */
async function downloaded(): Promise<typeof heysenFile & { trailId: string }> {
  const created: Blob[] = [];
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: (b: Blob) => (created.push(b), 'blob:x'), revokeObjectURL: () => {} })
  );
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  document.getElementById('desc-download')!.click();
  return JSON.parse(await created[0].text()) as typeof heysenFile & { trailId: string };
}

describe('admin-descriptions.html', () => {
  it('shows bundled and synced side by side, escaped, with the drift against descriptions.json', async () => {
    await loaded();

    const page = document.querySelector('.community-page')!;
    expect(page.querySelector('img')).toBeNull();
    expect(page.textContent).toContain(`Name ${XSS}`);
    expect(page.textContent).toContain(`Bundled ${XSS}`);
    expect(page.textContent).toContain(`Corrected live ${XSS}`);
    expect((document.getElementById('desc-trail') as HTMLSelectElement).value).toBe('heysen');

    expect(badge(first.waypointId)).toBe('in sync');
    expect(badge(second.waypointId)).toBe('drift');
    expect(rowFor(second.waypointId).querySelector('.desc-cell.is-different')).not.toBeNull();
    expect(summaryText()).toContain('1 live edit is not in descriptions.json');
    expect(summaryText()).toContain('data/trails/heysen/descriptions.json');
    expect(document.getElementById('desc-identity')!.textContent).toContain('(admin)');
  });

  it('does not call a merged file change that awaits its upload drift, or export the API’s older text', async () => {
    // descriptions.json changed and the site redeployed; the Upload
    // descriptions run is still waiting for approval, so the API holds what
    // the last upload sent. One entry was also deleted from the file.
    synced = [
      {
        waypointId: first.waypointId,
        description: 'Before the merge.',
        updatedAt: '2026-10-01T00:00:00.000Z',
        source: 'upload',
      },
      {
        waypointId: second.waypointId,
        description: second.description,
        updatedAt: '2026-10-01T00:00:00.000Z',
        source: 'upload',
      },
      {
        waypointId: 'w_xss00001',
        description: 'Entry deleted from the file.',
        updatedAt: '2026-10-01T00:00:00.000Z',
        source: 'upload',
      },
    ];
    await loaded();

    expect(badge(first.waypointId)).toBe('awaiting upload');
    expect(badge('w_xss00001')).toBe('awaiting upload');
    expect(rowFor(first.waypointId).classList.contains('admin-row-attention')).toBe(false);
    expect(rowFor(first.waypointId).querySelector('.desc-next')!.textContent).toContain('Nothing to commit');
    expect(summaryText()).toContain('No drift');
    expect(summaryText()).toContain('2 rows wait for an Upload descriptions run');
    expect(document.getElementById('desc-download')).toBeNull();
    expect(document.getElementById('desc-copy')).toBeNull();
  });

  it('exports a live edit beside rows that await an upload, leaving those as the file has them', async () => {
    synced = [
      {
        waypointId: first.waypointId,
        description: 'Before the merge.',
        updatedAt: '2026-10-01T00:00:00.000Z',
        source: 'upload',
      },
      {
        waypointId: second.waypointId,
        description: 'Tank closed.',
        updatedAt: '2026-11-02T00:00:00.000Z',
        source: 'live',
      },
      {
        waypointId: 'w_xss00001',
        description: 'Entry deleted from the file.',
        updatedAt: '2026-10-01T00:00:00.000Z',
        source: 'upload',
      },
    ];
    await loaded();
    expect(badge(second.waypointId)).toBe('drift');
    const exported = await downloaded();
    expect(exported.descriptions).toHaveLength(heysenFile.descriptions.length);
    expect(exported.descriptions[0]).toEqual(first);
    expect(exported.descriptions[1]).toEqual({ ...second, description: 'Tank closed.' });
    expect(exported.descriptions.some(e => e.waypointId === 'w_xss00001')).toBe(false);
  });

  it('saves a new synced text as a live edit, with the version it read, then shows it as drift to commit', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await loaded();

    rowFor('w_xss00001').querySelector<HTMLButtonElement>('[data-action="edit"]')!.click();
    const box = rowFor('w_xss00001').querySelector<HTMLTextAreaElement>('textarea')!;
    expect(box.value).toBe(`Bundled ${XSS}`);
    box.value = '  You should fill up here  ';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    expect(rowFor('w_xss00001').querySelector('.desc-hints')!.textContent).toContain('should');

    save('w_xss00001');
    await waitFor(() => badge('w_xss00001') === 'drift');

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toContain('the next Upload descriptions run overwrites it');
    const put = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')!;
    expect(put[0]).toBe('https://api.example.test/v1/admin/trails/heysen/descriptions/w_xss00001');
    expect((put[1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' });
    // No row was read for it, so the precondition is "none".
    expect(puts()[0].body).toEqual({ description: 'You should fill up here', source: 'live', ifUpdatedAt: null });
    expect(summaryText()).toContain('2 live edits are not in');
    expect(rowFor('w_xss00001').querySelector('textarea')).toBeNull();
  });

  it('clears a synced text with an empty PUT, and flags a clear of an id the file lists', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await loaded();

    rowFor(second.waypointId).querySelector<HTMLButtonElement>('[data-action="clear"]')!.click();
    await waitFor(() => badge(second.waypointId) === 'drift: cleared live');
    expect(confirm.mock.calls[0][0]).toContain('the next upload re-sends the file’s text');
    expect(puts()[0].body).toEqual({ description: '', source: 'live', ifUpdatedAt: '2026-11-02T00:00:00.000Z' });
    expect(summaryText()).toContain('1 waypoint was cleared live while descriptions.json still lists it');
    expect(summaryText()).not.toContain('No drift');
    expect(rowFor(second.waypointId).querySelector('.desc-next')!.textContent).toContain(
      'the next upload re-sends the file’s text'
    );
    // A clear is not something the export can carry: the entry stays.
    expect(document.getElementById('desc-download')).toBeNull();
  });

  it('keeps the draft and shows the server’s text when someone else saved first (409)', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await loaded();

    // Admin A opens the editor on what this page read…
    const box = edit(second.waypointId, 'A’s typo fix.');
    // …admin B saves on the same waypoint from another browser…
    synced = synced.map(s =>
      s.waypointId === second.waypointId
        ? { ...s, description: `B’s correction ${XSS}`, updatedAt: '2026-11-16T08:00:00.000Z' }
        : s
    );
    // …and A saves.
    save(second.waypointId);
    await waitFor(() => rowFor(second.waypointId).querySelector('[data-conflict]') !== null);

    expect(puts()[0].body).toMatchObject({ ifUpdatedAt: '2026-11-02T00:00:00.000Z' });
    expect(synced.find(s => s.waypointId === second.waypointId)!.description).toBe(`B’s correction ${XSS}`);
    const row = rowFor(second.waypointId);
    expect(row.querySelector('img')).toBeNull();
    expect(row.querySelector('[data-conflict]')!.textContent).toContain(`B’s correction ${XSS}`);
    expect(row.querySelector('[data-conflict]')!.textContent).toContain('Your draft is kept');
    expect(row.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('A’s typo fix.');
    expect(row.querySelector('.desc-cell.is-different')!.textContent).toContain('B’s correction');
    expect(box.isConnected).toBe(false);

    // Saving again, having seen B's text, is checked against B's version and goes through.
    save(second.waypointId);
    await waitFor(() => rowFor(second.waypointId).querySelector('textarea') === null);
    expect(puts()[1].body).toEqual({
      description: 'A’s typo fix.',
      source: 'live',
      ifUpdatedAt: '2026-11-16T08:00:00.000Z',
    });
    expect(synced.find(s => s.waypointId === second.waypointId)!.description).toBe('A’s typo fix.');
  });

  it('refuses a clear of a text someone else changed since, and shows theirs', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await loaded();
    synced = synced.map(s =>
      s.waypointId === second.waypointId
        ? { ...s, description: 'Changed by B.', updatedAt: '2026-11-16T08:00:00.000Z' }
        : s
    );
    rowFor(second.waypointId).querySelector<HTMLButtonElement>('[data-action="clear"]')!.click();
    await waitFor(() => !rowFor(second.waypointId).querySelector<HTMLElement>('[data-error]')!.hidden);
    expect(rowFor(second.waypointId).querySelector('[data-error]')!.textContent).toContain('Not cleared');
    expect(rowFor(second.waypointId).textContent).toContain('Changed by B.');
    expect(synced.find(s => s.waypointId === second.waypointId)!.description).toBe('Changed by B.');
    expect(rowFor(second.waypointId).querySelector<HTMLButtonElement>('[data-action="clear"]')!.disabled).toBe(false);
  });

  it('leaves an open edit box alone while another row is saved and the list refreshes', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await loaded();

    const typing = edit(first.waypointId, 'Half-typed corr');
    typing.focus();
    typing.setSelectionRange(4, 4);
    edit('w_xss00001', 'Saved in another row.');
    typing.focus();
    const reads = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/heysen/descriptions')).length;
    const before = reads();
    save('w_xss00001');
    await waitFor(() => badge('w_xss00001') === 'drift' && reads() > before);
    await new Promise(r => setTimeout(r, 20));

    // The same textarea, still focused, caret where it was.
    expect(rowFor(first.waypointId).querySelector('textarea')).toBe(typing);
    expect(typing.value).toBe('Half-typed corr');
    expect(document.activeElement).toBe(typing);
    expect(typing.selectionStart).toBe(4);
  });

  it('does not draw a save that lands after a switch of trail into the other trail’s list', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await loaded();
    let release!: () => void;
    holdPut = new Promise<void>(resolve => (release = resolve));
    edit('w_xss00001', 'Still in flight.');
    save('w_xss00001');

    const select = document.getElementById('desc-trail') as HTMLSelectElement;
    select.value = 'aawt';
    select.dispatchEvent(new Event('change'));
    await waitFor(() => document.getElementById('desc-list')!.textContent!.includes('No waypoints match'));
    release();
    await waitFor(() => !document.getElementById('desc-notice')!.hidden);
    await new Promise(r => setTimeout(r, 20));

    expect(document.querySelectorAll('.desc-row')).toHaveLength(0);
    expect(document.getElementById('desc-list')!.textContent).toContain('No waypoints match');
    expect(summaryText()).toContain('0 waypoints');
    expect(document.getElementById('desc-notice-text')!.textContent).toContain('on heysen');
    expect(synced.some(s => s.waypointId === 'w_xss00001')).toBe(true);
  });

  it('refuses a draft over the limit without a request', async () => {
    await loaded();
    rowFor('w_xss00001').querySelector<HTMLButtonElement>('[data-action="edit"]')!.click();
    const box = rowFor('w_xss00001').querySelector<HTMLTextAreaElement>('textarea')!;
    box.value = 'a'.repeat(4001);
    box.dispatchEvent(new Event('input', { bubbles: true }));
    expect(rowFor('w_xss00001').querySelector('.desc-too-long')).not.toBeNull();
    save('w_xss00001');
    expect(rowFor('w_xss00001').querySelector('[data-error]')!.textContent).toContain('Too long');
    expect(puts()).toHaveLength(0);
  });

  it('is read-only for a linked account that is not an admin', async () => {
    isAdmin = false;
    await loaded();
    expect(document.querySelector('[data-action="edit"]')).toBeNull();
    expect(document.getElementById('desc-identity')!.textContent).toContain('not an admin');
    expect(document.getElementById('desc-check-retry')!.hidden).toBe(true);
  });

  it('says the account check failed, with a retry, instead of "not an admin"', async () => {
    meStatus = 503;
    await loaded();
    const identity = document.getElementById('desc-identity')!;
    const retry = document.getElementById('desc-check-retry') as HTMLButtonElement;
    // Still there after the trail loaded (a load clears only its own error).
    expect(identity.textContent).toContain('Could not check whether this account is an admin');
    expect(identity.textContent).toContain('Service unavailable');
    expect(identity.textContent).not.toContain('not an admin');
    expect(retry.hidden).toBe(false);
    expect(document.querySelector('[data-action="edit"]')).toBeNull();

    // Loading another trail does not wipe it either. The rows of the last load stay in the
    // (hidden) list while the next is in flight, so wait for the list to be shown again.
    const list = document.getElementById('desc-section')!;
    document.getElementById('desc-reload')!.click();
    await waitFor(() => !list.hidden && document.querySelectorAll('.desc-row').length === 3);
    expect(identity.textContent).toContain('Could not check');

    meStatus = 200;
    retry.click();
    await waitFor(() => identity.textContent!.includes('(admin)'));
    expect(retry.hidden).toBe(true);
    expect(document.querySelector('[data-action="edit"]')).not.toBeNull();
  });

  it('is read-only, with a link button, for a browser that is not linked', async () => {
    window.localStorage.removeItem('tracknotes.webSession');
    await loaded();
    expect(document.querySelector('[data-action="edit"]')).toBeNull();
    expect(document.getElementById('desc-link-button')!.hidden).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/v1/me'))).toBe(false);
  });

  it('exports the drift as the updated descriptions.json for that trail', async () => {
    await loaded();
    const exported = await downloaded();
    expect(exported.trailId).toBe('heysen');
    expect(exported.descriptions).toHaveLength(heysenFile.descriptions.length);
    expect(exported.descriptions[1]).toEqual({ ...second, description: `Corrected live ${XSS}` });
    expect(exported.descriptions[0]).toEqual(first);
  });

  describe('against a worker that predates the source marker', () => {
    beforeEach(() => {
      workerRecordsSource = false;
      synced = synced.map(({ source: _source, ...row }) => row);
    });

    it('calls a differing row "origin unknown", not drift, and does not export it', async () => {
      await loaded();
      expect(badge(first.waypointId)).toBe('in sync');
      expect(badge(second.waypointId)).toBe('origin unknown');
      expect(summaryText()).toContain('No drift');
      expect(summaryText()).toContain('this API does not say whether a live edit or an upload wrote it');
      expect(document.getElementById('desc-download')).toBeNull();
    });

    it('is read-only for an admin, and says the API has not been deployed with description provenance', async () => {
      await loaded();
      expect(document.getElementById('desc-identity')!.textContent).toContain('(admin)');
      expect(document.querySelector('[data-action="edit"]')).toBeNull();
      expect(document.querySelector('[data-action="clear"]')).toBeNull();
      expect(unguarded().hidden).toBe(false);
      expect(unguarded().textContent).toContain(
        'Read-only: the comments API has not been deployed with description provenance yet'
      );
      expect(unguarded().textContent).toContain('docs/deploys.md');
      expect(puts()).toHaveLength(0);
    });

    it('is read-only on a trail with no synced rows too, where there is no row to tell the worker by', async () => {
      synced = [];
      await loaded();
      expect(document.querySelectorAll('.desc-row')).toHaveLength(3);
      expect(document.querySelector('[data-action="edit"]')).toBeNull();
      expect(unguarded().hidden).toBe(false);
    });

    it('sends nothing even when a save or a clear is forced past the missing buttons', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      await loaded();
      const row = rowFor(second.waypointId);
      const force = (action: string): void => {
        row.insertAdjacentHTML(
          'beforeend',
          `<button type="button" data-action="${action}" data-id="${second.waypointId}"></button>`
        );
        row.querySelector<HTMLButtonElement>(`button[data-action="${action}"]:last-of-type`)!.click();
      };
      force('clear');
      force('edit');
      // No edit box opened, so there is no draft to save; a forged one is refused as well.
      expect(rowFor(second.waypointId).querySelector('textarea')).toBeNull();
      force('save');
      await new Promise(r => setTimeout(r, 30));
      expect(puts()).toHaveLength(0);
      expect(rowFor(second.waypointId).querySelector('[data-error]')!.textContent).toContain(
        'Not sent: the comments API has not been deployed with description provenance yet'
      );
      expect(window.confirm).not.toHaveBeenCalled();
    });

    it('offers editing once a reload finds the worker deployed', async () => {
      await loaded();
      expect(document.querySelector('[data-action="edit"]')).toBeNull();
      workerRecordsSource = true;
      synced = synced.map(row => ({ ...row, source: 'upload' as const }));
      document.getElementById('desc-reload')!.click();
      await waitFor(() => document.querySelector('[data-action="edit"]') !== null);
      expect(unguarded().hidden).toBe(true);
    });
  });

  it('offers editing on a trail with no synced rows when the API says it guards writes', async () => {
    synced = [];
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await loaded();
    expect(unguarded().hidden).toBe(true);
    edit('w_xss00001', 'First synced text on this trail.');
    save('w_xss00001');
    await waitFor(() => puts().length === 1);
    expect(puts()[0].body).toEqual({
      description: 'First synced text on this trail.',
      source: 'live',
      ifUpdatedAt: null,
    });
  });

  it('stops offering edits, keeping an open draft, when a refresh finds the API no longer guards writes', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await loaded();
    edit('w_xss00001', 'Typed before the worker was rolled back.');
    // Another row is saved; the refresh that follows is answered without the marker.
    edit(first.waypointId, 'A correction that was saved in time.');
    readOmitsFeatures = true;
    save(first.waypointId);
    await waitFor(() => !unguarded().hidden);
    expect(puts()).toHaveLength(1);
    expect(document.querySelector('[data-action="edit"]')).toBeNull();
    expect(document.querySelector('[data-action="clear"]')).toBeNull();
    // The draft is still there to copy out, and its save is refused in the row.
    const box = rowFor('w_xss00001').querySelector<HTMLTextAreaElement>('textarea')!;
    expect(box.value).toBe('Typed before the worker was rolled back.');
    save('w_xss00001');
    await new Promise(r => setTimeout(r, 30));
    expect(puts()).toHaveLength(1);
    expect(rowFor('w_xss00001').querySelector('[data-error]')!.textContent).toContain('Not sent');
  });

  it('goes read-only when a save’s answer names no source, and says to commit it', async () => {
    // The read said the worker records the origin. An older worker replaces it
    // before the save: the PUT's answer names no source, and nor does a read after it.
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await loaded();
    putOmitsSource = true;
    readOmitsFeatures = true;
    edit('w_xss00001', 'Saved as the worker was rolled back.');
    save('w_xss00001');
    await waitFor(() => !document.getElementById('desc-notice')!.hidden);
    expect(document.getElementById('desc-notice-text')!.textContent).toContain('did not record it as a live edit');
    expect(unguarded().hidden).toBe(false);
    expect(document.querySelector('[data-action="edit"]')).toBeNull();
    expect(document.querySelector('[data-action="clear"]')).toBeNull();
    await new Promise(r => setTimeout(r, 30));
    expect(unguarded().hidden).toBe(false);
    expect(puts()).toHaveLength(1);
  });

  describe('a revisited place (<id>_2)', () => {
    const liveRow = (waypointId: string, description: string): Row => ({
      waypointId,
      description,
      updatedAt: '2026-11-05T00:00:00.000Z',
      source: 'live',
    });
    const syncedCellOf = (id: string) => rowFor(id).querySelectorAll<HTMLElement>('.desc-cell')[1];

    async function loadedPasses(): Promise<void> {
      window.history.replaceState(null, '', '/admin-descriptions.html?trail=three_passes');
      await import('./admin-descriptions');
      await waitFor(() => document.querySelectorAll('.desc-row').length === 3);
    }

    it('shows a live edit on the first pass on its later pass too, as phones do, and exports the first pass only', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      await loadedPasses();

      expect(badge(LOBUCHE_2)).toBe('follows first pass');
      expect(syncedCellOf(LOBUCHE_2).textContent).toContain('No synced row on the first pass');
      // Nothing is offered that would save under the later pass's id.
      expect(rowFor(LOBUCHE_2).querySelector('[data-action="edit"]')).toBeNull();
      expect(rowFor(LOBUCHE_2).querySelector('[data-action="clear"]')).toBeNull();

      edit(LOBUCHE, 'Lodge closed until March.');
      save(LOBUCHE);
      await waitFor(() => badge(LOBUCHE) === 'drift');

      // Said once, to the admin sending it: older app builds, and every pass.
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(confirm.mock.calls[0][0]).toContain(`the text shows on every pass (also ${LOBUCHE_2})`);
      expect(confirm.mock.calls[0][0]).toContain('has not been updated since later passes began following');
      expect(puts()).toHaveLength(1);
      expect(puts()[0].url).toBe(`https://api.example.test/v1/admin/trails/three_passes/descriptions/${LOBUCHE}`);

      // The later pass shows what phones show there, straight away.
      expect(syncedCellOf(LOBUCHE_2).textContent).toContain('Lodge closed until March.');
      expect(syncedCellOf(LOBUCHE_2).querySelector('h4')!.textContent).toContain(`the first pass’s, ${LOBUCHE}`);
      expect(syncedCellOf(LOBUCHE_2).classList.contains('is-different')).toBe(true);
      expect(badge(LOBUCHE_2)).toBe('follows first pass');
      expect(rowFor(LOBUCHE_2).querySelector('.desc-next')!.textContent).toContain('Follows the first pass');
      // An id that merely ends in digits is no pass of anything.
      expect(rowFor('w_00176641').querySelector('.desc-pass')).toBeNull();
      expect(syncedCellOf('w_00176641').textContent).toContain('No synced row.');

      // One live edit, on the place; the later pass is not exported.
      expect(summaryText()).toContain('1 live edit is held only by the API');
      const exported = await downloaded();
      expect(exported.descriptions.map(e => e.waypointId)).toEqual([LOBUCHE]);
      expect(passesSynced.map(s => s.waypointId)).toEqual([LOBUCHE]);
    });

    it('opens the first pass’s edit box from a later pass, even when a filter hides the first pass', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      passesSynced = [liveRow(LOBUCHE, 'Lodge closed.')];
      await loadedPasses();
      const search = document.getElementById('desc-search') as HTMLInputElement;
      search.value = LOBUCHE_2;
      search.dispatchEvent(new Event('input'));
      expect(document.querySelectorAll('.desc-row')).toHaveLength(1);

      rowFor(LOBUCHE_2).querySelector<HTMLButtonElement>('[data-action="edit-first"]')!.click();

      // Both passes of the place are listed, and the edit box is the first pass's.
      expect([...document.querySelectorAll<HTMLElement>('.desc-row')].map(r => r.dataset.row)).toEqual([
        LOBUCHE,
        LOBUCHE_2,
      ]);
      expect(rowFor(LOBUCHE_2).querySelector('textarea')).toBeNull();
      const box = rowFor(LOBUCHE).querySelector<HTMLTextAreaElement>('textarea')!;
      expect(box.value).toBe('Lodge closed.');
      box.value = 'Lodge open again.';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      save(LOBUCHE);
      await waitFor(() => syncedCellOf(LOBUCHE_2).textContent!.includes('Lodge open again.'));
      expect(puts().map(p => p.url)).toEqual([
        `https://api.example.test/v1/admin/trails/three_passes/descriptions/${LOBUCHE}`,
      ]);
    });

    it('never saves under a later pass’s id, even when an edit is forced past the missing buttons', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      await loadedPasses();
      const row = rowFor(LOBUCHE_2);
      for (const action of ['edit', 'save']) {
        row.insertAdjacentHTML(
          'beforeend',
          `<button type="button" data-action="${action}" data-id="${LOBUCHE_2}"></button>`
        );
        row.querySelector<HTMLButtonElement>(`button[data-action="${action}"]:last-of-type`)!.click();
        expect(rowFor(LOBUCHE_2).querySelector('textarea')).toBeNull();
        expect(rowFor(LOBUCHE_2).querySelector('[data-error]')!.textContent).toContain(
          `edited on the first pass (${LOBUCHE})`
        );
      }
      await new Promise(r => setTimeout(r, 30));
      expect(puts()).toHaveLength(0);
      expect(window.confirm).not.toHaveBeenCalled();
    });

    it('clears text a later pass holds under its own id, so that it follows the first pass again', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      // Saved on each pass, as the page once advised.
      passesSynced = [liveRow(LOBUCHE, 'Lodge closed until March.'), liveRow(LOBUCHE_2, 'Lodge closed.')];
      await loadedPasses();

      expect(badge(LOBUCHE_2)).toBe('drift');
      expect(syncedCellOf(LOBUCHE_2).querySelector('h4')!.textContent).toContain('Synced on this pass’s own id');
      expect(syncedCellOf(LOBUCHE_2).textContent).toContain('Lodge closed.');
      expect(summaryText()).toContain('1 later pass of a revisited place has synced text under its own id');
      expect(rowFor(LOBUCHE_2).querySelector('[data-action="edit"]')).toBeNull();

      rowFor(LOBUCHE_2).querySelector<HTMLButtonElement>('[data-action="clear"]')!.click();
      await waitFor(() => badge(LOBUCHE_2) === 'follows first pass');

      expect(confirm.mock.calls[0][0]).toContain(`phones show the first pass’s synced text here (${LOBUCHE})`);
      expect(puts()).toHaveLength(1);
      expect(puts()[0].url).toBe(`https://api.example.test/v1/admin/trails/three_passes/descriptions/${LOBUCHE_2}`);
      expect(puts()[0].body).toEqual({ description: '', source: 'live', ifUpdatedAt: '2026-11-05T00:00:00.000Z' });
      expect(syncedCellOf(LOBUCHE_2).textContent).toContain('Lodge closed until March.');
      expect(rowFor(LOBUCHE_2).querySelector('[data-action="clear"]')).toBeNull();
    });

    it('lets the later pass fall back with the first when the first is cleared', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      passesSynced = [liveRow(LOBUCHE, 'Lodge closed.')];
      await loadedPasses();
      expect(syncedCellOf(LOBUCHE_2).textContent).toContain('Lodge closed.');

      rowFor(LOBUCHE).querySelector<HTMLButtonElement>('[data-action="clear"]')!.click();
      await waitFor(() => syncedCellOf(LOBUCHE_2).textContent!.includes('The first pass is cleared'));
      expect(syncedCellOf(LOBUCHE_2).classList.contains('is-different')).toBe(false);
      expect(puts().map(p => p.url)).toEqual([
        `https://api.example.test/v1/admin/trails/three_passes/descriptions/${LOBUCHE}`,
      ]);
    });
  });
});
