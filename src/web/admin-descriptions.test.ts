/**
 * The live description editor renders waypoint names and descriptions (the
 * synced ones written through the API included): none may reach the page as
 * markup. It reads the committed descriptions.json bundled into the page, shows
 * drift against it, writes only through the admin PUT, and offers editing only
 * to an admin's linked browser.
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

let synced: { waypointId: string; description: string; updatedAt: string }[];
let isAdmin: boolean;
let fetchMock: ReturnType<typeof vi.fn>;

function respond(status: number, body: unknown) {
  return { ok: status < 400, status, statusText: '', text: async () => JSON.stringify(body), json: async () => body };
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
  synced = [
    { waypointId: first.waypointId, description: first.description, updatedAt: '2026-11-01T00:00:00.000Z' },
    { waypointId: second.waypointId, description: `Corrected live ${XSS}`, updatedAt: '2026-11-02T00:00:00.000Z' },
  ];
  fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    if (input.endsWith('data/generated/index.json')) {
      return respond(200, [
        { id: 'aawt', name: 'Australian Alps Walking Track' },
        { id: 'heysen', name: 'Heysen Trail' },
      ]);
    }
    if (input.endsWith('data/generated/heysen.json')) return respond(200, trail);
    if (input.endsWith('data/generated/aawt.json')) return respond(200, { ...trail, waypoints: [] });
    if (input === 'https://api.example.test/v1/me') {
      return respond(200, { userId: 'u1', displayName: 'Admin', isAdmin });
    }
    if (input.startsWith('https://api.example.test/v1/trails/') && input.endsWith('/descriptions')) {
      return respond(200, { descriptions: input.includes('/heysen/') ? synced : [], syncedAt: 'now' });
    }
    const put = /\/v1\/admin\/trails\/heysen\/descriptions\/([^/]+)$/.exec(input);
    if (put && init?.method === 'PUT') {
      const { description } = JSON.parse(String(init.body)) as { description: string };
      const row = { waypointId: put[1], description, updatedAt: '2026-11-17T00:00:00.000Z' };
      synced = [...synced.filter(s => s.waypointId !== put[1]), row];
      return respond(200, row);
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

describe('admin-descriptions.html', () => {
  it('shows bundled and synced side by side, escaped, with the drift against descriptions.json', async () => {
    await import('./admin-descriptions');
    await waitFor(() => document.querySelectorAll('.desc-row').length === 3);

    const page = document.querySelector('.community-page')!;
    expect(page.querySelector('img')).toBeNull();
    expect(page.textContent).toContain(`Name ${XSS}`);
    expect(page.textContent).toContain(`Bundled ${XSS}`);
    expect(page.textContent).toContain(`Corrected live ${XSS}`);
    expect((document.getElementById('desc-trail') as HTMLSelectElement).value).toBe('heysen');

    expect(rowFor(first.waypointId).querySelector('.desc-badge')!.textContent).toBe('in sync');
    expect(rowFor(second.waypointId).querySelector('.desc-badge')!.textContent).toBe('drift');
    expect(rowFor(second.waypointId).querySelector('.desc-cell.is-different')).not.toBeNull();
    const summary = document.getElementById('desc-summary')!.textContent!;
    expect(summary).toContain('1 synced description is not in descriptions.json');
    expect(summary).toContain('data/trails/heysen/descriptions.json');
    expect(document.getElementById('desc-identity')!.textContent).toContain('(admin)');
  });

  it('saves a new synced text through the admin PUT, then shows it as drift to commit', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await import('./admin-descriptions');
    await waitFor(() => document.querySelectorAll('.desc-row').length === 3);

    rowFor('w_xss00001').querySelector<HTMLButtonElement>('[data-action="edit"]')!.click();
    const box = rowFor('w_xss00001').querySelector<HTMLTextAreaElement>('textarea')!;
    expect(box.value).toBe(`Bundled ${XSS}`);
    box.value = '  You should fill up here  ';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    expect(rowFor('w_xss00001').querySelector('.desc-hints')!.textContent).toContain('should');

    rowFor('w_xss00001').querySelector<HTMLButtonElement>('[data-action="save"]')!.click();
    await waitFor(() => rowFor('w_xss00001').querySelector('.desc-badge')?.textContent === 'drift');

    expect(confirm).toHaveBeenCalledTimes(1);
    const put = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')!;
    expect(put[0]).toBe('https://api.example.test/v1/admin/trails/heysen/descriptions/w_xss00001');
    expect((put[1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' });
    expect(JSON.parse(String((put[1] as RequestInit).body))).toEqual({ description: 'You should fill up here' });
    expect(document.getElementById('desc-summary')!.textContent).toContain('2 synced descriptions are not in');
  });

  it('clears a synced text with an empty PUT', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await import('./admin-descriptions');
    await waitFor(() => document.querySelectorAll('.desc-row').length === 3);

    rowFor(second.waypointId).querySelector<HTMLButtonElement>('[data-action="clear"]')!.click();
    await waitFor(() => rowFor(second.waypointId).querySelector('.desc-badge')?.textContent === 'cleared');
    const put = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')!;
    expect(JSON.parse(String((put[1] as RequestInit).body))).toEqual({ description: '' });
    expect(document.getElementById('desc-summary')!.textContent).toContain('No drift');
  });

  it('refuses a draft over the limit without a request', async () => {
    await import('./admin-descriptions');
    await waitFor(() => document.querySelectorAll('.desc-row').length === 3);
    rowFor('w_xss00001').querySelector<HTMLButtonElement>('[data-action="edit"]')!.click();
    const box = rowFor('w_xss00001').querySelector<HTMLTextAreaElement>('textarea')!;
    box.value = 'a'.repeat(4001);
    box.dispatchEvent(new Event('input', { bubbles: true }));
    expect(rowFor('w_xss00001').querySelector('.desc-too-long')).not.toBeNull();
    rowFor('w_xss00001').querySelector<HTMLButtonElement>('[data-action="save"]')!.click();
    expect(rowFor('w_xss00001').querySelector('[data-error]')!.textContent).toContain('Too long');
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')).toBe(false);
  });

  it('is read-only for a linked account that is not an admin', async () => {
    isAdmin = false;
    await import('./admin-descriptions');
    await waitFor(() => document.querySelectorAll('.desc-row').length === 3);
    expect(document.querySelector('[data-action="edit"]')).toBeNull();
    expect(document.getElementById('desc-identity')!.textContent).toContain('not an admin');
  });

  it('is read-only, with a link button, for a browser that is not linked', async () => {
    window.localStorage.removeItem('tracknotes.webSession');
    await import('./admin-descriptions');
    await waitFor(() => document.querySelectorAll('.desc-row').length === 3);
    expect(document.querySelector('[data-action="edit"]')).toBeNull();
    expect(document.getElementById('desc-link-button')!.hidden).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/v1/me'))).toBe(false);
  });

  it('exports the drift as the updated descriptions.json for that trail', async () => {
    const created: Blob[] = [];
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: (b: Blob) => (created.push(b), 'blob:x'), revokeObjectURL: () => {} })
    );
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await import('./admin-descriptions');
    await waitFor(() => document.querySelectorAll('.desc-row').length === 3);

    document.getElementById('desc-download')!.click();
    expect(click).toHaveBeenCalled();
    const exported = JSON.parse(await created[0].text()) as typeof heysenFile & { trailId: string };
    expect(exported.trailId).toBe('heysen');
    expect(exported.descriptions).toHaveLength(heysenFile.descriptions.length);
    expect(exported.descriptions[1]).toEqual({ ...second, description: `Corrected live ${XSS}` });
    expect(exported.descriptions[0]).toEqual(first);
  });
});
