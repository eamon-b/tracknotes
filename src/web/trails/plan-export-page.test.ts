/**
 * The plan page's Export menu, driven through the real plan viewer in jsdom:
 * the GPX download, the calendar (disabled until there is a start date), and
 * the printed summary. The file formats themselves are `@lib/plan-export`'s
 * tests; this checks the page hands them what it shows.
 *
 * Helpers are copied from `plan-stop-refresh-page.test.ts` rather than shared.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BUNDLED_PLAN_FILLS, inlinePlanShell } from '../../../scripts/lib/plan-shell';
import { parseGpx } from '@lib/gpx-parser';
import type { PlanDocument } from '@lib/plan-types';
import { ICS_REEXPORT_NOTE } from '@lib/plan-export';
import { ICS_NEEDS_START_DATE, planPrintHtml } from './plan-export-ui';

const ROOT = path.resolve(__dirname, '../../..');
const TRAIL_ID = 'export-fixture';
const TOTAL_KM = 60;

vi.mock('./plan-sync', () => ({
  initPlanSync: () => ({ onLocalSave() {}, destroy() {} }),
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
  return {
    config: { id: TRAIL_ID, name: 'Export Fixture', shortName: 'Fixture' },
    track: {
      points,
      totalDistance: TOTAL_KM,
      totalAscent: 0,
      totalDescent: 0,
      breaks: [{ index: 31, displayIndex: 31, km: 31, fromTrack: 'A', toTrack: 'B', straightLineKm: 1 }],
    },
    waypoints: [
      wp('w_start', 'Trailhead', 'endpoint', 0),
      wp('w_c20', 'Camp <20>', 'campsite', 20),
      wp('w_town', 'Town', 'town', 40),
      wp('w_end', 'Trail End', 'endpoint', TOTAL_KM),
    ],
  };
}

function storedPlan(startDate: string | null): PlanDocument {
  return {
    id: 'plan-fixture',
    trailId: TRAIL_ID,
    name: 'Fixture <plan>',
    direction: 'NOBO',
    startDate,
    stops: [
      { waypointId: 'w_c20', km: 20, name: 'Camp <20>', nights: 2, note: '<img src=x onerror=alert(1)>' },
      { waypointId: 'w_town', km: 40, name: 'Town', nights: 1 },
    ],
    resupplyStops: ['w_town'],
    updatedAt: '2026-10-01T00:00:00.000Z',
    version: 1,
  };
}

/** jsdom's Blob has no `text()`. */
function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

let downloads: Array<{ name: string; text: Promise<string> }> = [];

async function boot(startDate: string | null): Promise<void> {
  localStorage.setItem(`trail-plan-doc-${TRAIL_ID}`, JSON.stringify(storedPlan(startDate)));
  document.documentElement.innerHTML = bundledPlanPageHtml()
    .replace(/<!DOCTYPE html>/i, '')
    .replace(/<\/?html[^>]*>/gi, '');
  vi.resetModules();
  const { initPlanViewer } = await import('./plan-viewer');
  await initPlanViewer(TRAIL_ID, makeTrail() as never);
}

beforeEach(() => {
  localStorage.clear();
  installLeafletStub();
  downloads = [];
  let pending: Blob | null = null;
  URL.createObjectURL = vi.fn((blob: Blob) => {
    pending = blob;
    return 'blob:fixture';
  }) as never;
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    if (pending) downloads.push({ name: this.download, text: blobText(pending) });
    pending = null;
  });
  window.print = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.innerHTML = '';
});

const button = (id: string) => document.getElementById(id) as HTMLButtonElement;

describe('plan page export', () => {
  it('downloads the plan as GPX: the route split at its break, the stops as waypoints', async () => {
    await boot(null);
    button('export-gpx').click();
    expect(downloads).toHaveLength(1);
    expect(downloads[0].name).toBe('fixture-plan.gpx');
    const parsed = parseGpx(await downloads[0].text);
    expect(parsed.tracks[0].segments).toHaveLength(2);
    expect(parsed.waypoints.map(wp => wp.name)).toEqual(['Camp <20>', 'Town', 'Town']);
    expect(parsed.waypoints.map(wp => wp.type)).toEqual(['night-stop', 'night-stop', 'resupply']);
  });

  it('offers the calendar only once the plan has a start date', async () => {
    await boot(null);
    expect(button('export-ics').disabled).toBe(true);
    expect(button('export-ics').title).toBe(ICS_NEEDS_START_DATE);
    expect(document.getElementById('export-ics-note')?.hidden).toBe(false);
    expect(document.getElementById('export-ics-reexport')?.hidden).toBe(true);

    const date = document.getElementById('plan-start-date') as HTMLInputElement;
    date.value = '2027-03-01';
    date.dispatchEvent(new Event('change'));
    expect(button('export-ics').disabled).toBe(false);
    expect(document.getElementById('export-ics-note')?.hidden).toBe(true);
    // What a re-export leaves behind (#284).
    expect(document.getElementById('export-ics-reexport')?.hidden).toBe(false);
    expect(document.getElementById('export-ics-reexport')?.textContent).toBe(ICS_REEXPORT_NOTE);

    button('export-ics').click();
    expect(downloads[0].name).toBe('fixture-plan.ics');
    const ics = (await downloads[0].text).replace(/\r\n /g, '');
    expect(ics).toContain('SUMMARY:Day 1: Trailhead → Camp <20>\\, 20.0 km');
    expect(ics).toContain('SUMMARY:Rest day at Camp <20>');
    // Day 2 is pushed back by the rest day.
    expect(ics).toContain('DTSTART;VALUE=DATE:20270303');
  });

  it('prints a summary of the plan, escaped', async () => {
    await boot('2027-03-01');
    button('export-print').click();
    expect(window.print).toHaveBeenCalledTimes(1);
    const printed = document.getElementById('plan-print')!;
    expect(printed.querySelector('h1')?.textContent).toBe('Fixture <plan>');
    expect(printed.querySelector('img')).toBeNull();
    expect(printed.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(printed.textContent).toContain('Rest day at Camp <20>');
    expect(printed.textContent).toContain('Resupply');
  });

  it('fills the summary for a print started from the browser too', async () => {
    await boot(null);
    window.dispatchEvent(new Event('beforeprint'));
    expect(document.getElementById('plan-print')?.textContent).toContain('Fixture <plan>');
  });
});

describe('planPrintHtml', () => {
  it('has no resupply table without legs', () => {
    const html = planPrintHtml(
      {
        plan: storedPlan(null),
        trail: { config: { name: 'T' }, track: { points: [], totalDistance: 60 } },
        days: [],
      },
      { trailName: 'T', paceLabel: 'average pace (4 km/h)', dailyHours: 8 }
    );
    expect(html).not.toContain('<h2>Resupply</h2>');
    expect(html).toContain('Fixture &lt;plan&gt;');
  });

  it('lists a resupply stop at the trail end, and not the run in to the end', () => {
    const leg = (toName: string, toKm: number) =>
      ({ toName, toKm, walkedKm: 30, estimatedDays: 1, food: { weightKg: 0.7 }, zeroDays: 0 }) as never;
    const html = planPrintHtml(
      {
        plan: storedPlan(null),
        trail: { config: { name: 'T' }, track: { points: [], totalDistance: 60 } },
        days: [],
        resupplyLegs: [leg('Midtown', 30), leg('Endtown', 60)],
      },
      { trailName: 'T', paceLabel: 'average pace (4 km/h)', dailyHours: 8 }
    );
    expect(html).toContain('Endtown');
    const withRunIn = planPrintHtml(
      {
        plan: storedPlan(null),
        trail: { config: { name: 'T' }, track: { points: [], totalDistance: 60 } },
        days: [],
        resupplyLegs: [leg('Midtown', 30), leg('Trail End', 60)],
      },
      { trailName: 'T', paceLabel: 'average pace (4 km/h)', dailyHours: 8 }
    );
    expect(withRunIn).toContain('Midtown');
    expect(withRunIn).not.toContain('Trail End');
  });

  it('lists the zero days before day 1 in the heading and as dated rows', () => {
    const html = planPrintHtml(
      {
        plan: { ...storedPlan('2026-12-30'), startZeroDays: 2.5 },
        trail: { config: { name: 'T' }, track: { points: [], totalDistance: 60 } },
        days: [],
      },
      { trailName: 'T', paceLabel: 'average pace (4 km/h)', dailyHours: 8 }
    );
    expect(html).toContain('2.5 zero days before day 1');
    expect(html.match(/Zero day before day 1/g)).toHaveLength(2);
  });
});
