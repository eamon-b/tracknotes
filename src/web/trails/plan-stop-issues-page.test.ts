/**
 * The web plan page keeping stops the trail data no longer explains on screen
 * (`planStopIssues`): the notice above the days and the stops, the badge on the
 * day a placed one ends, and its Remove button. Driven through the real plan
 * viewer in jsdom, with the sync arm mocked.
 *
 * Helpers are copied from `plan-stop-refresh-page.test.ts` rather than shared.
 *
 *   track — 101 points, one every km, flat, 100 km, data published PAGE_DATA
 *
 *     w_start   Trailhead   endpoint   km 0
 *     w_c8 …    Camp 8 …    campsite   every 8 km, km 8 … 96
 *     w_end     Trail End   endpoint   km 100
 *
 * Stops are saved at a place this data no longer has, and past its end.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BUNDLED_PLAN_FILLS, inlinePlanShell } from '../../../scripts/lib/plan-shell';
import type { PlanDocument } from '@lib/plan-types';

const ROOT = path.resolve(__dirname, '../../..');
const TRAIL_ID = 'stop-issues-fixture';
const TOTAL_KM = 100;
const PAGE_DATA = '2026-10-10T00:00:00.000Z';

/** What the mocked sync arm was given and told. */
const sync = vi.hoisted(() => ({
  host: null as unknown,
  localSaves: 0,
}));

vi.mock('./plan-sync', () => ({
  initPlanSync: (host: unknown) => {
    sync.host = host;
    return { onLocalSave: () => void sync.localSaves++, destroy() {} };
  },
}));

function bundledPlanPageHtml(): string {
  return inlinePlanShell(
    fs.readFileSync(path.join(ROOT, 'src/web/trails/plan-template.html'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'src/web/trails/plan-shell.html'), 'utf8'),
    BUNDLED_PLAN_FILLS,
  );
}

function installLeafletStub(): void {
  const layer = (): object => {
    const obj: object = new Proxy({}, { get: () => () => obj });
    return obj;
  };
  const L = new Proxy({}, { get: (_t, prop) => (prop === 'control' ? { scale: layer } : layer) });
  (globalThis as unknown as { L: unknown }).L = L;
}

const latAt = (km: number): number => -34 - km / 1000;
const lonAt = (km: number): number => 138 + km / 1000;

function makeTrail() {
  const points = Array.from({ length: TOTAL_KM + 1 }, (_, km) => ({
    lat: latAt(km),
    lon: lonAt(km),
    ele: 100,
    dist: km,
  }));
  const wp = (id: string, name: string, type: string, totalDistance: number) => ({
    id,
    name,
    type,
    totalDistance,
    lat: latAt(totalDistance),
    lon: lonAt(totalDistance),
  });
  const camps = [];
  for (let km = 8; km < TOTAL_KM; km += 8) camps.push(wp(`w_c${km}`, `Camp ${km}`, 'campsite', km));
  return {
    config: { id: TRAIL_ID, name: 'Stop Refresh Fixture', shortName: 'Fixture' },
    track: { points, totalDistance: TOTAL_KM, totalAscent: 0, totalDescent: 0 },
    waypoints: [wp('w_start', 'Trailhead', 'endpoint', 0), ...camps, wp('w_end', 'Trail End', 'endpoint', TOTAL_KM)],
    dataUpdatedAt: PAGE_DATA,
  };
}

/** A plan with these stops, saved against the page's data. */
function planWith(stops: PlanDocument['stops']): PlanDocument {
  return {
    id: 'plan-fixture',
    trailId: TRAIL_ID,
    name: 'Fixture plan',
    direction: 'NOBO',
    startDate: '2026-11-01',
    stops,
    updatedAt: '2026-10-01T00:00:00.000Z',
    dataUpdatedAt: PAGE_DATA,
    version: 1,
  };
}

async function boot(trail: object = makeTrail()): Promise<void> {
  document.documentElement.innerHTML = bundledPlanPageHtml()
    .replace(/<!DOCTYPE html>/i, '')
    .replace(/<\/?html[^>]*>/gi, '');
  vi.resetModules();
  const { initPlanViewer } = await import('./plan-viewer');
  await initPlanViewer(TRAIL_ID, trail as never);
}

const savedDocument = (): PlanDocument => {
  const raw = localStorage.getItem(`trail-plan-doc-${TRAIL_ID}`);
  if (!raw) throw new Error('nothing saved');
  return JSON.parse(raw);
};

/** Let the 800 ms debounced save land. */
const flushSave = (): void => void vi.advanceTimersByTime(900);

beforeEach(() => {
  (HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = () =>
    new Proxy({}, { get: () => () => ({ addColorStop() {}, width: 0 }) });
  window.localStorage.clear();
  vi.useFakeTimers();
  installLeafletStub();
  sync.host = null;
  sync.localSaves = 0;
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { L?: unknown }).L;
});

describe('stops that need checking', () => {
  const issuesPlan = () => planWith([
    { waypointId: 'w_c8', km: 8, name: 'Camp 8', nights: 1 },
    { waypointId: 'w_gone', km: 15, name: 'Old Camp', nights: 1 },
    { km: 104, name: 'Past the End', nights: 2 },
  ]);

  it('says nothing for a plan whose stops all match the data', async () => {
    localStorage.setItem(`trail-plan-doc-${TRAIL_ID}`, JSON.stringify(planWith([
      { waypointId: 'w_c8', km: 8, name: 'Camp 8', nights: 1 },
    ])));
    await boot();
    expect(document.querySelector('.stop-issues')).toBeNull();
    expect(document.querySelector('.stop-issue-badge')).toBeNull();
  });

  it('lists each one above the days, and flags the day a placed one ends', async () => {
    localStorage.setItem(`trail-plan-doc-${TRAIL_ID}`, JSON.stringify(issuesPlan()));
    await boot();

    const notice = document.querySelector('#days-list .stop-issues');
    expect(notice?.querySelector('.stop-issues-notice')?.textContent).toContain(
      '2 stops need checking after a trail data update. 2 nights are left out of the dates',
    );
    const rows = [...(notice?.querySelectorAll('.stop-issue') ?? [])]
      .map(row => row.textContent?.replace(/\s+/g, ' ').trim());
    expect(rows[0]).toContain('Old Camp');
    expect(rows[0]).toContain('This place is no longer in the trail data \u00B7 Ends day 2');
    expect(rows[1]).toContain('Past the End');
    expect(rows[1]).toContain('Past the end of the updated trail \u00B7 2 nights, not in the dates');

    // Old Camp still ends its day, with the warning on the card.
    const cards = [...document.querySelectorAll('.day-card[data-day-index]')];
    expect(cards[1].querySelector('.day-card-route')?.textContent).toContain('Old Camp');
    expect(cards[1].querySelector('.stop-issue-badge')?.textContent)
      .toContain('This place is no longer in the trail data');
  });

  it('removes a stop the route view cannot show, and saves the plan without it', async () => {
    localStorage.setItem(`trail-plan-doc-${TRAIL_ID}`, JSON.stringify(issuesPlan()));
    await boot();

    const buttons = document.querySelectorAll<HTMLButtonElement>('#days-list .stop-issue-remove');
    expect(buttons).toHaveLength(2);
    buttons[1].click();
    flushSave();

    expect(savedDocument().stops.map(stop => stop.name)).toEqual(['Camp 8', 'Old Camp']);
    expect(document.querySelector('#days-list .stop-issues-notice')?.textContent).toContain(
      '1 stop needs checking after a trail data update.',
    );
  });

  it('judges the stops as it moved them on a page that cannot date its data', async () => {
    // Camp 8's stop is at km 6: the refresh would move it, but this page has
    // no publish time to set against the plan's, so it leaves it — and the
    // notice says why rather than claiming another stop holds km 8.
    localStorage.setItem(`trail-plan-doc-${TRAIL_ID}`, JSON.stringify(planWith([
      { waypointId: 'w_c8', km: 6, name: 'Camp 8', nights: 1 },
    ])));
    await boot({ ...makeTrail(), dataUpdatedAt: undefined });
    const row = document.querySelector('#days-list .stop-issue')?.textContent?.replace(/\s+/g, ' ');
    expect(row).toContain('Saved against newer trail data than this device has');
    expect(row).not.toContain('moved');
  });
});
