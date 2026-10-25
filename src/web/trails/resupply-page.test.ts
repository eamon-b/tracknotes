/**
 * The resupply page, booted in jsdom from the shipped template with a
 * preloaded trail, and the planner's two ends of the link between them (the
 * Resupply tab's link, and `?focus=` from "show on map").
 *
 * What matters here is that the page edits the planner's own document and
 * preferences — so the assertions read `localStorage` the way the planner
 * does — and that it never computes a figure of its own (the view tests cover
 * the rows; these check the wiring).
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fillTemplate } from '../../../scripts/lib/fill-template';
import { BUNDLED_PLAN_FILLS, inlinePlanShell } from '../../../scripts/lib/plan-shell';

const ROOT = path.resolve(__dirname, '../../..');
const TRAIL_ID = 'resupply-page-fixture';
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function makeTrail() {
  const ELE = [0, 100, 300, 200, 600, 700];
  const points = ELE.map((ele, i) => ({ lat: -34 - i / 100, lon: 138 + i / 100, ele, dist: i * 10 }));
  const wp = (id: string, name: string, type: string, totalDistance: number, extra: Record<string, unknown> = {}) => ({
    id,
    name,
    type,
    lat: -34 - totalDistance / 1000,
    lon: 138 + totalDistance / 1000,
    totalDistance,
    ...extra,
  });
  return {
    config: { id: TRAIL_ID, name: 'Resupply Page Fixture', shortName: 'Fixture' },
    track: { points, totalDistance: 50, totalAscent: 800, totalDescent: 100 },
    waypoints: [
      wp('w_start', 'Trailhead', 'endpoint', 0),
      wp('w_001', 'Alpha', 'town', 10),
      wp('w_002', 'Bravo', 'town-access', 20, { accessName: 'Mill Road', offTrailKm: 22, accessMode: 'hitch' }),
      wp('w_003', 'Charlie', 'food', 20.05, { accessName: 'Mill Road' }),
      wp('w_004', 'Delta', 'resupply', 30),
      wp('w_005', 'Echo', 'town', 40),
    ],
  };
}

const $ = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
};

function loadPage(html: string): void {
  document.documentElement.innerHTML = html.replace(/<!DOCTYPE html>/i, '').replace(/<\/?html[^>]*>/gi, '');
}

async function bootResupply(): Promise<void> {
  loadPage(
    fillTemplate(read('src/web/trails/resupply-template.html'), { TRAIL_ID, TRAIL_NAME: 'Resupply Page Fixture' })
  );
  vi.resetModules();
  const { initResupplyPage } = await import('./resupply-page');
  await initResupplyPage(TRAIL_ID, makeTrail() as never, {
    plannerHref: focus => (focus ? `plan.html?focus=${focus}` : 'plan.html'),
  });
}

const storedDoc = (): Record<string, unknown> =>
  JSON.parse(window.localStorage.getItem(`trail-plan-doc-${TRAIL_ID}`) ?? 'null');
const storedPrefs = (): Record<string, unknown> =>
  JSON.parse(window.localStorage.getItem(`trail-plan-ui-${TRAIL_ID}`) ?? 'null');

/** Let the 800 ms debounced save land. */
const flushSave = (): void => void vi.advanceTimersByTime(900);

/** Pick a radio and fire the change the browser would. */
function pick(input: HTMLInputElement): void {
  input.checked = true;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

const radio = (groupSelector: string, value: string): HTMLInputElement => {
  const node = document.querySelector<HTMLInputElement>(`${groupSelector} input[type="radio"][value="${value}"]`);
  if (!node) throw new Error(`no radio ${value} in ${groupSelector}`);
  return node;
};

const tileValue = (label: string): string => {
  const tile = [...document.querySelectorAll('.rs-tile')].find(
    el => el.querySelector('.rs-tile-label')?.textContent === label
  );
  return (tile?.querySelector('.rs-tile-value')?.textContent ?? '').trim();
};

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the resupply page', () => {
  it('lists every candidate stop with the hiker inputs and the totals', async () => {
    await bootResupply();

    const rows = [...document.querySelectorAll<HTMLElement>('tr.rs-option')].map(tr => tr.dataset.optionId);
    expect(rows).toEqual(['w_001', 'w_002', 'w_003', 'w_004', 'w_005']);
    expect(document.querySelector('.rs-group.is-undecided')?.textContent).toContain('Not decided yet');
    expect(tileValue('Stops chosen')).toBe('4');

    // The hiker's figures, shown at their initial values and editable.
    expect(($('rs-pace') as HTMLSelectElement).value).toBe('average');
    expect(($('rs-hours') as HTMLInputElement).value).toBe('8');
    expect(($('rs-food-grams') as HTMLInputElement).value).not.toBe('');
    expect(($('rs-long-carry') as HTMLInputElement).value).not.toBe('');
    // The sync dialogs are mounted for plan-sync.ts (and removed by it when
    // the build has no API, as here).
    expect(document.getElementById('sync-btn')).toBeNull();
  });

  it('writes a decision into the planner’s document', async () => {
    await bootResupply();

    pick(radio('tbody.is-decision', 'w_002'));
    flushSave();
    expect(storedDoc().resupplyStops).toEqual(['w_001', 'w_002', 'w_004', 'w_005']);
    expect(document.querySelector('tbody.is-decision')?.classList.contains('is-undecided')).toBe(false);
    expect(document.querySelector('tr[data-option-id="w_002"]')?.classList.contains('is-chosen')).toBe(true);

    // "No" at a single-option stop drops it, and the legs merge across it.
    pick(radio('tbody[data-group-key="w_004"]', ''));
    flushSave();
    expect(storedDoc().resupplyStops).toEqual(['w_001', 'w_002', 'w_005']);
    expect(tileValue('Stops chosen')).toBe('3');

    // "None – carry through" at the decision.
    pick(radio('tbody.is-decision', ''));
    flushSave();
    expect(storedDoc().resupplyStops).toEqual(['w_001', 'w_005']);
  });

  it('stores zero days per chosen stop and adds them to the total once', async () => {
    await bootResupply();
    const before = Number(tileValue('Total days'));

    const input = document.querySelector<HTMLInputElement>('input.rs-zero[data-option-id="w_001"]')!;
    input.value = '1.5';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    flushSave();

    expect(storedDoc().resupplyZeroDays).toEqual({ w_001: 1.5 });
    expect(Number(tileValue('Total days'))).toBe(before + 1.5);
    expect(document.querySelector<HTMLInputElement>('input.rs-zero[data-option-id="w_001"]')?.value).toBe('1.5');
  });

  it('keeps pace and hours in the planner’s per-browser prefs', async () => {
    await bootResupply();
    const days = () => document.querySelector('tr.rs-end .rs-c-days .rs-figure')?.textContent;

    const hours = $('rs-hours') as HTMLInputElement;
    hours.value = '1';
    hours.dispatchEvent(new Event('change'));
    expect(storedPrefs().dailyHours).toBe(1);
    // Echo → trail end, 10 km and 100 m up, is more than one hour's walking.
    expect(Number(days())).toBeGreaterThan(1);

    const pace = $('rs-pace') as HTMLSelectElement;
    pace.value = 'fast';
    pace.dispatchEvent(new Event('change'));
    expect(storedPrefs().pace).toBe('fast');
    // Nothing of this is in the synced document.
    flushSave();
    expect(window.localStorage.getItem(`trail-plan-doc-${TRAIL_ID}`)).toBeNull();
  });

  it('turns the trail round the way the planner does', async () => {
    await bootResupply();
    $('rs-direction').click();
    flushSave();
    expect(storedDoc().direction).toBe('SOBO');
    const first = document.querySelector<HTMLElement>('tr.rs-option');
    expect(first?.dataset.optionId).toBe('w_005');
    expect(first?.querySelector('.rs-c-km')?.textContent).toBe('10.0');
  });

  it('links each stop to the planner focused on it', async () => {
    await bootResupply();
    const link = document.querySelector<HTMLAnchorElement>('tr[data-option-id="w_004"] .rs-map-link');
    expect(link?.getAttribute('href')).toBe('plan.html?focus=w_004');
    expect($('rs-planner-link').getAttribute('href')).toBe('plan.html');
  });

  it('follows a save the planner makes in another tab', async () => {
    await bootResupply();

    // Make and save one edit here, then let "the planner" replace it.
    pick(radio('tbody.is-decision', 'w_003'));
    flushSave();
    const planner = { ...storedDoc(), resupplyStops: ['w_005'] };
    window.localStorage.setItem(`trail-plan-doc-${TRAIL_ID}`, JSON.stringify(planner));
    window.dispatchEvent(new StorageEvent('storage', { key: `trail-plan-doc-${TRAIL_ID}` }));

    expect(tileValue('Stops chosen')).toBe('1');
  });
});

// ---------------------------------------------------------------------------
// The planner's side of the link
// ---------------------------------------------------------------------------

async function bootPlanner(): Promise<void> {
  (HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = () =>
    new Proxy({}, { get: () => () => ({ addColorStop() {}, width: 0 }) });
  loadPage(
    inlinePlanShell(
      read('src/web/trails/plan-template.html'),
      read('src/web/trails/plan-shell.html'),
      BUNDLED_PLAN_FILLS
    )
  );
  vi.resetModules();
  const { initPlanViewer } = await import('./plan-viewer');
  await initPlanViewer(TRAIL_ID, makeTrail() as never, { resupplyPageHref: 'resupply.html' });
}

describe('the planner', () => {
  it('links its Resupply tab to the resupply page', async () => {
    await bootPlanner();
    const link = $('resupply-page-link') as HTMLAnchorElement;
    expect(link.hidden).toBe(false);
    expect(link.getAttribute('href')).toBe('resupply.html');
  });

  it('opens on the Resupply tab at the option "show on map" named', async () => {
    window.history.replaceState(null, '', '/?focus=w_004');
    await bootPlanner();
    expect(document.querySelector('.tab-btn.active')?.getAttribute('data-tab')).toBe('resupply');
    expect(document.querySelector('.resupply-row[data-id="w_004"]')?.classList.contains('is-focused')).toBe(true);
  });
});
