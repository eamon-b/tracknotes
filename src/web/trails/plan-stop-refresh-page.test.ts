/**
 * The web plan page moving a stop with its place (`refreshStopKms`), driven
 * through the real plan viewer in jsdom: at load, and when the sync arm hands
 * it the server's copy (`adoptServerPlan`). The sync arm itself is mocked to
 * capture the host it is given; `plan-sync.test.ts` covers the arm.
 *
 * Helpers are copied from `plan-next-days-page.test.ts` rather than shared.
 *
 *   track — 101 points, one every km, flat, 100 km, data published PAGE_DATA
 *
 *     w_start   Trailhead   endpoint   km 0
 *     w_c8 …    Camp 8 …    campsite   every 8 km, km 8 … 96
 *     w_end     Trail End   endpoint   km 100
 *
 * Camp 32's stop is saved at km 30: where older data had the place.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BUNDLED_PLAN_FILLS, inlinePlanShell } from '../../../scripts/lib/plan-shell';
import type { PlanDocument } from '@lib/plan-types';
import type { PlanSyncHost } from './plan-sync';

const ROOT = path.resolve(__dirname, '../../..');
const TRAIL_ID = 'stop-refresh-fixture';
const TOTAL_KM = 100;
const PAGE_DATA = '2026-10-10T00:00:00.000Z';

/** What the mocked sync arm was given and told. */
const sync = vi.hoisted(() => ({
  host: null as PlanSyncHost | null,
  localSaves: 0,
}));

vi.mock('./plan-sync', () => ({
  initPlanSync: (host: PlanSyncHost) => {
    sync.host = host;
    return { onLocalSave: () => void sync.localSaves++, destroy() {} };
  },
}));

function bundledPlanPageHtml(): string {
  return inlinePlanShell(
    fs.readFileSync(path.join(ROOT, 'src/web/trails/plan-template.html'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'src/web/trails/plan-shell.html'), 'utf8'),
    BUNDLED_PLAN_FILLS
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

/** A plan with Camp 32's stop at `km`, saved against `dataUpdatedAt`. */
function planWithCamp32At(km: number, dataUpdatedAt?: string): PlanDocument {
  return {
    id: 'plan-fixture',
    trailId: TRAIL_ID,
    name: 'Fixture plan',
    direction: 'NOBO',
    startDate: null,
    stops: [{ waypointId: 'w_c32', km, name: 'Camp 32', nights: 1 }],
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...(dataUpdatedAt ? { dataUpdatedAt } : {}),
    version: 1,
  };
}

async function boot(): Promise<void> {
  document.documentElement.innerHTML = bundledPlanPageHtml()
    .replace(/<!DOCTYPE html>/i, '')
    .replace(/<\/?html[^>]*>/gi, '');
  vi.resetModules();
  const { initPlanViewer } = await import('./plan-viewer');
  await initPlanViewer(TRAIL_ID, makeTrail() as never);
}

const savedDocument = (): PlanDocument => {
  const raw = localStorage.getItem(`trail-plan-doc-${TRAIL_ID}`);
  if (!raw) throw new Error('nothing saved');
  return JSON.parse(raw);
};

const host = (): PlanSyncHost => {
  if (!sync.host) throw new Error('the sync arm was never started');
  return sync.host;
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

describe('loading a plan', () => {
  it('moves a stop to its place and saves it stamped with the page data', async () => {
    localStorage.setItem(`trail-plan-doc-${TRAIL_ID}`, JSON.stringify(planWithCamp32At(30)));
    await boot();
    flushSave();

    expect(savedDocument().stops[0].km).toBe(32);
    expect(savedDocument().dataUpdatedAt).toBe(PAGE_DATA);
    expect(sync.localSaves).toBe(1);
  });

  it('leaves the stops of a plan saved against newer data than the page has', async () => {
    const newer = planWithCamp32At(30, '2026-10-15T00:00:00.000Z');
    localStorage.setItem(`trail-plan-doc-${TRAIL_ID}`, JSON.stringify(newer));
    await boot();
    flushSave();

    expect(savedDocument()).toEqual(newer);
    expect(sync.localSaves).toBe(0);
    expect(host().getPlan().stops[0].km).toBe(30);
  });
});

describe("the server's copy (adoptServerPlan)", () => {
  it('stores a stale copy corrected, then saves and sends it back stamped', async () => {
    await boot();
    host().adoptServerPlan(planWithCamp32At(30, '2026-09-01T00:00:00.000Z'));

    // Stored corrected at once, sent back after the debounce.
    expect(savedDocument().stops[0].km).toBe(32);
    expect(sync.localSaves).toBe(0);
    flushSave();
    expect(sync.localSaves).toBe(1);
    expect(savedDocument().stops[0].km).toBe(32);
    expect(savedDocument().dataUpdatedAt).toBe(PAGE_DATA);
  });

  it('stores a copy saved against newer data as it came, and sends nothing back', async () => {
    await boot();
    const newer = planWithCamp32At(30, '2026-10-15T00:00:00.000Z');
    host().adoptServerPlan(newer);
    flushSave();

    expect(savedDocument()).toEqual(newer);
    expect(sync.localSaves).toBe(0);
  });

  it('stores a copy whose stops are at their places as it came', async () => {
    await boot();
    const current = planWithCamp32At(32, PAGE_DATA);
    host().adoptServerPlan(current);
    flushSave();

    expect(savedDocument()).toEqual(current);
    expect(sync.localSaves).toBe(0);
  });
});
