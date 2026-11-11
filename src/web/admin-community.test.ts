/**
 * The admin queue renders text from users and from the AI review: route
 * names, credits, report notes, the review's summary, concerns and error, and
 * the last status note. None of it may reach the page as markup.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const XSS = '<img src=x onerror=alert(1)>';

function loadPage(): void {
  const html = fs.readFileSync(path.join(ROOT, 'src/web/admin-community.html'), 'utf8');
  document.documentElement.innerHTML = html.replace(/<!DOCTYPE html>/i, '').replace(/<\/?html[^>]*>/gi, '');
}

/**
 * Poll until `cond` holds. Bounded by wall-clock time rather than a number of
 * polls, which a loaded machine could use up before the page got there (#251).
 */
async function waitFor(cond: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!cond() && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
}

const route = {
  id: 'c_abcdefghijklmnop',
  name: `Name ${XSS}`,
  status: 'hidden',
  country: 'AU',
  state: 'VIC',
  lengthKm: 12,
  ascentM: 300,
  hasElevation: true,
  waypointCount: 3,
  bbox: [0, 0, 1, 1],
  start: { lat: 0, lon: 0 },
  submittedBy: `Sam ${XSS}`,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  verifiedAt: null,
  reviewed: true,
  trailUrl: null,
  md5: '0'.repeat(32),
  bytes: 1,
  description: `Description ${XSS}`,
  credit: `Credit ${XSS}`,
  licence: 'CC0-1.0',
  checks: [{ id: 'metadata', level: 'warn', message: `Check ${XSS}` }],
  statusNote: `Note ${XSS}`,
  reportCount: 1,
  reports: [{ reason: 'spam', note: `Report ${XSS}`, createdAt: '2026-10-02T00:00:00Z' }],
  review: {
    status: 'done',
    verdict: 'reject',
    confidence: 0.9,
    summary: `Summary ${XSS}`,
    concerns: [`Concern ${XSS}`],
    error: `Error ${XSS}`,
    suggestedCountry: 'AU',
    suggestedState: 'VIC',
  },
};

beforeEach(() => {
  vi.resetModules();
  window.localStorage.clear();
  window.localStorage.setItem(
    'tracknotes.webSession',
    JSON.stringify({ userId: 'u1', token: 'tok', displayName: 'Admin', expiresAt: null })
  );
  vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.test');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: '',
      text: async () => JSON.stringify({ routes: [route] }),
    }))
  );
  loadPage();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('admin-community.html', () => {
  it('escapes every user and review string it renders', async () => {
    await import('./admin-community');
    const list = document.getElementById('admin-list')!;
    await waitFor(() => list.querySelector('.admin-row') !== null);

    expect(list.querySelector('.admin-row')).not.toBeNull();
    expect(list.querySelector('img')).toBeNull();
    const text = list.textContent ?? '';
    for (const label of [
      'Name',
      'Sam',
      'Description',
      'Credit',
      'Check',
      'Note',
      'Report',
      'Summary',
      'Concern',
      'Error',
    ]) {
      expect(text, label).toContain(`${label} ${XSS}`);
    }
    expect(document.getElementById('admin-identity')!.textContent).toContain('Admin');
  });

  describe('the Map section', () => {
    const storedTrail = {
      config: { id: route.id, name: route.name },
      track: {
        points: [
          { lat: -37, lon: 145, ele: 1, dist: 0 },
          { lat: -37.1, lon: 145.1, ele: 1, dist: 12 },
        ],
        displayPoints: [],
        totalDistance: 12,
        totalAscent: 0,
        totalDescent: 0,
      },
      waypoints: [],
      offTrailWaypoints: [],
      alternates: [],
      sideTrips: [],
    };

    /** A Leaflet stand-in that records the containers it was asked to draw into. */
    function fakeLeaflet(drawnInto: HTMLElement[]): unknown {
      const layer = () => {
        const self = { addTo: () => self, bindTooltip: () => self };
        return self;
      };
      return {
        map: (container: HTMLElement) => {
          drawnInto.push(container);
          container.appendChild(document.createElement('div'));
          const map = { fitBounds: () => map, setView: () => map, remove: () => {}, invalidateSize: () => {} };
          return map;
        },
        tileLayer: layer,
        polyline: layer,
        circleMarker: layer,
        control: { scale: layer },
        latLngBounds: (b: unknown) => b,
      };
    }

    function stubFetch(trailResponse: { status: number; body: unknown }) {
      const fetchMock = vi.fn(async (input: string, _init?: RequestInit) => {
        const isTrail = input.endsWith('/trail');
        const status = isTrail ? trailResponse.status : 200;
        return {
          ok: status >= 200 && status < 300,
          status,
          statusText: '',
          text: async () => JSON.stringify(isTrail ? trailResponse.body : { routes: [route] }),
        };
      });
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    async function openMap(): Promise<HTMLDetailsElement> {
      await import('./admin-community');
      const list = document.getElementById('admin-list')!;
      await waitFor(() => list.querySelector('[data-map-for]') !== null);
      const details = list.querySelector<HTMLDetailsElement>('[data-map-for]')!;
      details.open = true; // jsdom fires `toggle` for this, as browsers do
      return details;
    }

    it('fetches the stored trail from the admin endpoint with the token, and draws it', async () => {
      const drawnInto: HTMLElement[] = [];
      vi.stubGlobal('L', fakeLeaflet(drawnInto));
      const fetchMock = stubFetch({ status: 200, body: storedTrail });
      const details = await openMap();
      await waitFor(() => drawnInto.length > 0);

      const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/trail'));
      expect(call?.[0]).toBe(`https://api.example.test/v1/admin/community/routes/${route.id}/trail`);
      expect((call?.[1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' });
      expect(drawnInto[0]).toBe(details.querySelector('[data-map]'));
      expect(details.querySelector<HTMLElement>('[data-map-status]')!.hidden).toBe(true);
    });

    it('shows a refusal as text, not markup', async () => {
      vi.stubGlobal('L', fakeLeaflet([]));
      stubFetch({ status: 403, body: { error: { code: 'forbidden', message: `No ${XSS}` } } });
      const details = await openMap();
      const status = details.querySelector<HTMLElement>('[data-map-status]')!;
      await waitFor(() => (status.textContent ?? '').includes('forbidden'));
      expect(status.textContent).toContain(`No ${XSS}`);
      expect(details.querySelector('img')).toBeNull();
    });
  });
});
