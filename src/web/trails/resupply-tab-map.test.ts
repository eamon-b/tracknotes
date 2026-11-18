/**
 * What a click on a waypoint marker does on the plan page's map, per tab.
 *
 * `resupply-tab.test.ts` runs without Leaflet; this file stubs just enough of
 * it to capture the marker click handlers the viewer installs, so the two
 * meanings of "click a town" can be told apart: on the Days and Stops tabs it
 * opens a popup whose button adds or removes a camp stop, on the Resupply tab
 * it ticks or unticks the resupply option — the thing that tab highlights on
 * the map.
 *
 * The popup content is a real element the viewer builds and wires, so the stub
 * only has to remember what it was handed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BUNDLED_PLAN_FILLS, inlinePlanShell } from '../../../scripts/lib/plan-shell';

const ROOT = path.resolve(__dirname, '../../..');

/**
 * The bundled plan page as `build-trails.ts` assembles it: `plan-template.html`
 * with the shared `plan-shell.html` markup inlined at its marker.
 */
function bundledPlanPageHtml(): string {
  return inlinePlanShell(
    fs.readFileSync(path.join(ROOT, 'src/web/trails/plan-template.html'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'src/web/trails/plan-shell.html'), 'utf8'),
    BUNDLED_PLAN_FILLS
  );
}

const TRAIL_ID = 'resupply-map-fixture';

interface StubMarker {
  html: string;
  opacity: number;
  handlers: Record<string, () => void>;
  /** The element passed to `bindPopup`, i.e. what the last click opened. */
  popup: HTMLElement | null;
}

let markers: StubMarker[] = [];
/** Where each ⛺ stop flag was dropped. */
let flagPositions: Array<[number, number]> = [];
/** Every dotted walk in drawn (`access-path.ts`), by its path. */
let dottedPaths: Array<Array<[number, number]>> = [];
/** Extra fields for Camp One, to put it off the route. */
let campAccess: Record<string, unknown> = {};

/** The least Leaflet the plan viewer needs to boot and draw markers. */
function installLeafletStub(): void {
  // A layer answers every method with itself (addTo, on, bringToBack, …); only
  // markers need real behaviour.
  const layer = (): object => {
    const obj: object = new Proxy({}, { get: () => () => obj });
    return obj;
  };
  const mapObj = layer();
  const L = {
    map: () => mapObj,
    tileLayer: layer,
    control: { scale: layer },
    layerGroup: layer,
    polyline: (latLngs: Array<[number, number]>, opts?: { dashArray?: string }) => {
      if (opts?.dashArray === '1 8') dottedPaths.push(latLngs);
      return layer();
    },
    divIcon: (opts: { html: string }) => opts,
    marker: (latLng: [number, number], opts: { icon: { html: string } }) => {
      if (opts.icon.html.includes('stop-flag-icon')) flagPositions.push(latLng);
      const marker: StubMarker = { html: opts.icon.html, opacity: 1, handlers: {}, popup: null };
      markers.push(marker);
      const handle = {
        on: (event: string, fn: () => void) => void (marker.handlers[event] = fn),
        addTo: () => undefined,
        remove: () => void markers.splice(markers.indexOf(marker), 1),
        setOpacity: (value: number) => void (marker.opacity = value),
        setIcon: (icon: { html: string }) => {
          marker.html = icon.html;
          return handle;
        },
        isPopupOpen: () => false,
        closePopup: () => handle,
        bindPopup: (content: HTMLElement) => {
          marker.popup = content;
          return handle;
        },
        openPopup: () => handle,
      };
      return handle;
    },
  };
  (globalThis as unknown as { L: unknown }).L = L;
}

/**
 * The waypoint marker for a place — not the ⛺ flag that is dropped on top of
 * it once it is a stop, which carries the same `title` and no handlers.
 */
const marker = (name: string): StubMarker => {
  const found = markers.find(m => m.html.includes('waypoint-marker') && m.html.includes(`title="${name}"`));
  if (!found) throw new Error(`no marker for ${name}`);
  return found;
};

const check = (optionId: string): HTMLInputElement =>
  document.getElementById(`resupply-opt-${optionId}`) as HTMLInputElement;

const tabButton = (tab: string): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>(`.tab-btn[data-tab="${tab}"]`)!;

const savedPlan = (): { stops: unknown[]; resupplyStops?: string[] } => {
  vi.advanceTimersByTime(900);
  return JSON.parse(localStorage.getItem(`trail-plan-doc-${TRAIL_ID}`) ?? '{"stops":[]}');
};

/** Click a marker, then press the "Stop here" / "Remove stop" button it opened. */
const pressPopupButton = (name: string): void => {
  const found = marker(name);
  found.handlers.click();
  const button = found.popup?.querySelector<HTMLButtonElement>('.wp-popup-btn');
  if (!button) throw new Error(`the popup for ${name} has no stop button`);
  button.click();
};

function makeTrail() {
  const points = [0, 10, 20, 30].map(km => ({ lat: -34 - km / 1000, lon: 138 + km / 1000, ele: 100, dist: km }));
  const wp = (id: string, name: string, type: string, totalDistance: number) => ({
    id,
    name,
    type,
    totalDistance,
    lat: -34 - totalDistance / 1000,
    lon: 138 + totalDistance / 1000,
  });
  return {
    config: { id: TRAIL_ID, name: 'Map Fixture', shortName: 'Map' },
    track: { points, totalDistance: 30, totalAscent: 0, totalDescent: 0 },
    waypoints: [
      wp('w_alpha', 'Alpha', 'town', 10),
      { ...wp('w_camp', 'Camp One', 'campsite', 15), ...campAccess },
      wp('w_bravo', 'Bravo', 'town', 20),
    ],
  };
}

async function boot(options: { readOnly?: boolean; preloadedPlan?: unknown } = {}): Promise<void> {
  const html = bundledPlanPageHtml();
  document.documentElement.innerHTML = html.replace(/<!DOCTYPE html>/i, '').replace(/<\/?html[^>]*>/gi, '');
  vi.resetModules();
  const { initPlanViewer } = await import('./plan-viewer');
  await initPlanViewer(TRAIL_ID, makeTrail() as never, options as never);
}

beforeEach(() => {
  (HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = () =>
    new Proxy({}, { get: () => () => ({ addColorStop() {}, width: 0 }) });
  window.localStorage.clear();
  vi.useFakeTimers();
  markers = [];
  flagPositions = [];
  dottedPaths = [];
  campAccess = {};
  installLeafletStub();
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { L?: unknown }).L;
});

describe('clicking a waypoint marker', () => {
  it('opens a popup rather than silently toggling a stop', async () => {
    await boot();
    marker('Alpha').handlers.click();

    const popup = marker('Alpha').popup;
    expect(popup?.querySelector('.wp-popup-name')?.textContent).toBe('Alpha');
    expect(popup?.querySelector('.wp-popup-btn')?.textContent?.trim()).toBe('Stop here');
    // The click itself changed nothing — that is the whole point of the popup.
    expect(savedPlan().stops).toHaveLength(0);
  });

  it('toggles a camp stop from the popup button on the Days tab', async () => {
    await boot();
    pressPopupButton('Alpha');

    expect(savedPlan().stops).toHaveLength(1);
    expect(savedPlan().resupplyStops).toBeUndefined();

    // Re-opened, the popup now offers to take the stop away again.
    marker('Alpha').handlers.click();
    expect(marker('Alpha').popup?.querySelector('.wp-popup-btn')?.textContent?.trim()).toBe('Remove stop');
    pressPopupButton('Alpha');
    expect(savedPlan().stops).toHaveLength(0);
  });

  it('toggles the resupply tick on the Resupply tab, not a camp stop', async () => {
    await boot();
    tabButton('resupply').click();
    expect(check('w_alpha').checked).toBe(true);

    marker('Alpha').handlers.click();

    expect(marker('Alpha').popup).toBeNull();
    expect(check('w_alpha').checked).toBe(false);
    expect(check('w_bravo').checked).toBe(true);
    expect(savedPlan().resupplyStops).toEqual(['w_bravo']);
    expect(savedPlan().stops).toHaveLength(0);

    marker('Alpha').handlers.click();
    expect(check('w_alpha').checked).toBe(true);
  });

  it('fades an unticked option on the map and restores it when re-ticked', async () => {
    await boot();
    tabButton('resupply').click();
    check('w_bravo').click();
    expect(marker('Bravo').opacity).toBe(0.4);
    expect(marker('Alpha').opacity).toBe(1);

    check('w_bravo').click();
    expect(marker('Bravo').opacity).toBe(1);
  });

  it('rings a planned stop on every tab, and only once a plan exists', async () => {
    await boot();
    // A fresh plan has every option ticked for the carries, but nothing planned.
    expect(markers.some(m => m.html.includes('planned-resupply'))).toBe(false);

    tabButton('resupply').click();
    check('w_bravo').click(); // an explicit selection: everything but Bravo

    expect(marker('Alpha').html).toContain('planned-resupply');
    expect(marker('Bravo').html).not.toContain('planned-resupply');
    // The camp-stop marker is not a resupply option, so it never gets the ring.
    expect(marker('Camp One').html).not.toContain('planned-resupply');

    // The ring stays when the hiker leaves the tab that made the plan.
    tabButton('days').click();
    expect(marker('Alpha').html).toContain('planned-resupply');
  });

  it('still offers a camp stop for a waypoint that is not a resupply option', async () => {
    await boot();
    tabButton('resupply').click();
    pressPopupButton('Camp One');

    expect(savedPlan().stops).toHaveLength(1);
    expect(check('w_alpha').checked).toBe(true);
    expect(check('w_bravo').checked).toBe(true);
  });
});

describe('a shared (read-only) plan', () => {
  const shared = {
    id: 'plan-shared',
    trailId: TRAIL_ID,
    name: 'Their plan',
    direction: 'NOBO',
    startDate: null,
    stops: [],
    resupplyStops: ['w_alpha'],
    updatedAt: '2026-07-01T10:00:00.000Z',
    version: 1,
  };

  it('opens the popup for a resupply option on the Resupply tab, since nothing can be ticked', async () => {
    await boot({ readOnly: true, preloadedPlan: shared });
    tabButton('resupply').click();

    marker('Bravo').handlers.click();

    const popup = marker('Bravo').popup;
    expect(popup?.querySelector('.wp-popup-name')?.textContent).toBe('Bravo');
    // A reader has nothing to press in it, and the plan is untouched.
    expect(popup?.querySelector('.wp-popup-btn')).toBeNull();
    expect(marker('Bravo').opacity).toBe(0.4);
    expect(localStorage.getItem(`trail-plan-doc-${TRAIL_ID}`)).toBeNull();
  });
});

describe('preferences another tab changed', () => {
  it('show in the header inputs and the Stops switch, not only in the numbers', async () => {
    await boot();
    const input = (id: string) => document.getElementById(id) as HTMLInputElement;
    expect(input('stops-show-all').checked).toBe(false);

    // The resupply page (or this planner in a second tab) saves new prefs.
    const prefs = {
      showAllWaypoints: true,
      pace: 'fast',
      dailyHours: 10,
      dryStretchKm: 35,
      foodGramsPerDay: 900,
      longCarryDays: 6,
    };
    localStorage.setItem(`trail-plan-ui-${TRAIL_ID}`, JSON.stringify(prefs));
    window.dispatchEvent(new StorageEvent('storage', { key: `trail-plan-ui-${TRAIL_ID}` }));

    expect((document.getElementById('plan-pace') as HTMLSelectElement).value).toBe('fast');
    expect(input('plan-daily-hours').value).toBe('10');
    expect(input('plan-dry-stretch').value).toBe('35');
    expect(input('plan-food-grams').value).toBe('900');
    expect(input('plan-long-carry').value).toBe('6');
    expect(input('stops-show-all').checked).toBe(true);
  });
});

describe('the waypoint markers across renders', () => {
  it('are restyled in place when only the plan changes', async () => {
    await boot();
    const alpha = marker('Alpha');
    const made = markers.length;
    expect(alpha.html).not.toContain('is-stop');

    pressPopupButton('Alpha');

    expect(marker('Alpha')).toBe(alpha);
    expect(alpha.html).toContain('is-stop');
    // Only the ⛺ flag dropped on the new stop was made.
    expect(markers.length).toBe(made + 1);

    pressPopupButton('Alpha');
    expect(marker('Alpha')).toBe(alpha);
    expect(alpha.html).not.toContain('is-stop');
  });

  it('fade and restore in place on the Resupply tab', async () => {
    await boot();
    tabButton('resupply').click();
    const bravo = marker('Bravo');
    check('w_bravo').click();
    expect(marker('Bravo')).toBe(bravo);
    expect(bravo.opacity).toBe(0.4);
  });

  it('are made again when the tab or the direction changes', async () => {
    await boot();
    const alpha = marker('Alpha');

    tabButton('resupply').click();
    const onResupply = marker('Alpha');
    expect(onResupply).not.toBe(alpha);
    // The old ones are gone from the map, not left beneath the new ones.
    expect(markers.filter(m => m.html.includes('title="Alpha"'))).toHaveLength(1);

    tabButton('days').click();
    const onDays = marker('Alpha');
    expect(onDays).not.toBe(onResupply);

    document.getElementById('direction-toggle')!.click();
    expect(marker('Alpha')).not.toBe(onDays);
    expect(markers.filter(m => m.html.includes('title="Alpha"'))).toHaveLength(1);
  });
});

describe("an off-route place's walk in", () => {
  const walkIn: Array<[number, number]> = [
    [-34.015, 138.015],
    [-34.02, 138.02],
  ];
  beforeEach(() => {
    campAccess = { offTrailKm: 0.8, accessMode: 'foot', offTrailPath: walkIn };
  });

  it('is dotted while its popup is open', async () => {
    await boot();
    expect(dottedPaths).toEqual([]);
    marker('Camp One').handlers.popupopen();
    expect(dottedPaths).toEqual([walkIn]);
    expect(marker('Alpha').handlers.popupopen).toBeUndefined();
  });

  it('stays on the map while the place is a stop', async () => {
    await boot();
    pressPopupButton('Camp One');
    expect(dottedPaths).toContainEqual(walkIn);

    dottedPaths = [];
    pressPopupButton('Camp One');
    expect(dottedPaths).toEqual([]);
  });

  it('is not drawn for a stop saved without its waypoint id, which the days do not walk', async () => {
    localStorage.setItem(
      `trail-plan-doc-${TRAIL_ID}`,
      JSON.stringify({
        id: 'plan-1',
        trailId: TRAIL_ID,
        name: 'No id',
        direction: 'NOBO',
        startDate: null,
        stops: [{ km: 15, name: 'Camp One', nights: 1 }],
        updatedAt: '2026-07-01T10:00:00.000Z',
        version: 1,
      })
    );
    await boot();
    // The flag is still dropped on the place, matched by km…
    expect(flagPositions).toHaveLength(1);
    // …but no walk is drawn, because `computePlanDays` counts none for it.
    expect(dottedPaths).toEqual([]);
  });
});

describe('a stop whose waypoint a rebuild has moved', () => {
  it('is matched by its waypoint id on the map, as the Stops tab matches it', async () => {
    // Saved against Alpha when Alpha sat at km 15; a rebuild has since moved it
    // to km 10, and Camp One now sits at the stop's old km.
    localStorage.setItem(
      `trail-plan-doc-${TRAIL_ID}`,
      JSON.stringify({
        id: 'plan-1',
        trailId: TRAIL_ID,
        name: 'Moved',
        direction: 'NOBO',
        startDate: null,
        stops: [{ waypointId: 'w_alpha', km: 15, name: 'Alpha', nights: 1 }],
        updatedAt: '2026-07-01T10:00:00.000Z',
        version: 1,
      })
    );
    await boot();

    expect(marker('Alpha').html).toContain('is-stop');
    expect(marker('Camp One').html).not.toContain('is-stop');
    // The ⛺ flag goes on Alpha's marker position, not on Camp One's.
    const flags = markers.filter(m => m.html.includes('stop-flag-icon'));
    expect(flags).toHaveLength(1);
    expect(flags[0].html).toContain('title="Alpha"');
    expect(flagPositions).toEqual([[-34 - 10 / 1000, 138 + 10 / 1000]]);

    // And the Stops tab says the same.
    tabButton('stops').click();
    const ticked = [...document.querySelectorAll('#stops-list .stop-item.is-stop .stop-name')].map(node =>
      (node.textContent ?? '').trim()
    );
    expect(ticked).toEqual(['Alpha']);
  });
});
