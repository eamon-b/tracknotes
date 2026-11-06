/**
 * The Resupply tab's legs on the plan page's map: one line per carry, each in
 * its own colour, cut at route breaks, and highlighted together with its
 * datasheet row. A Leaflet stub records every polyline the viewer draws, with
 * its options, tooltip and handlers.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BUNDLED_PLAN_FILLS, inlinePlanShell } from '../../../scripts/lib/plan-shell';

const ROOT = path.resolve(__dirname, '../../..');
const TRAIL_ID = 'leg-lines-fixture';

function bundledPlanPageHtml(): string {
  return inlinePlanShell(
    fs.readFileSync(path.join(ROOT, 'src/web/trails/plan-template.html'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'src/web/trails/plan-shell.html'), 'utf8'),
    BUNDLED_PLAN_FILLS
  );
}

interface StubLine {
  latLngs: Array<Array<[number, number]>>;
  options: { color?: string; weight?: number; opacity?: number };
  tooltip: string | null;
  handlers: Record<string, () => void>;
  onMap: boolean;
}

let lines: StubLine[] = [];
let fitted = 0;
/** The line whose bounds the map was last fitted to, if any. */
let fittedTo: StubLine | null = null;
let breaks: unknown[] | undefined;
/** Waypoints added to the fixture's two towns, for one test. */
let extraWaypoints: Array<[id: string, name: string, km: number]> = [];

function installLeafletStub(): void {
  const layer = (): object => {
    const obj: object = new Proxy({}, { get: () => () => obj });
    return obj;
  };
  const mapObj: object = new Proxy(
    {},
    {
      get: (_, key) =>
        key === 'fitBounds'
          ? (bounds?: { line?: StubLine; isValid?: () => boolean }) => {
              fitted += 1;
              if (bounds?.isValid && !bounds.isValid()) throw new Error('Bounds are not valid.');
              fittedTo = bounds?.line ?? null;
              return mapObj;
            }
          : () => mapObj,
    }
  );
  const L = {
    map: () => mapObj,
    tileLayer: layer,
    control: { scale: layer },
    layerGroup: layer,
    latLngBounds: layer,
    polyline: (latLngs: unknown, options: StubLine['options'] = {}) => {
      const line: StubLine = {
        latLngs: (Array.isArray((latLngs as unknown[][])[0]?.[0]) ? latLngs : [latLngs]) as StubLine['latLngs'],
        options: { ...options },
        tooltip: null,
        handlers: {},
        onMap: false,
      };
      lines.push(line);
      const handle: Record<string, unknown> = {
        addTo: () => {
          line.onMap = true;
          return handle;
        },
        remove: () => {
          line.onMap = false;
          return handle;
        },
        on: (event: string, fn: () => void) => {
          line.handlers[event] = fn;
          return handle;
        },
        bindTooltip: (content: string) => {
          line.tooltip = content;
          return handle;
        },
        bindPopup: () => handle,
        setStyle: (style: StubLine['options']) => {
          line.options = { ...line.options, ...style };
          return handle;
        },
        bringToBack: () => handle,
        bringToFront: () => handle,
        // Leaflet's bounds of a line with no points are not valid, and
        // fitBounds throws on them.
        getBounds: () => ({ line, isValid: () => line.latLngs.some(run => run.length > 0) }),
        getLatLngs: () => [],
      };
      return handle;
    },
    divIcon: (opts: object) => opts,
    marker: () => {
      const handle: Record<string, unknown> = {};
      for (const key of ['on', 'addTo', 'remove', 'setOpacity', 'bindPopup', 'openPopup', 'bindTooltip']) {
        handle[key] = () => handle;
      }
      return handle;
    },
    popup: layer,
  };
  (globalThis as unknown as { L: unknown }).L = L;
}

/** The leg lines on the map now, in leg order. */
const legLines = (): StubLine[] => lines.filter(l => l.onMap && l.tooltip?.startsWith('Leg '));
const legRows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('#datasheet-body tr.resupply-leg')];
const tabButton = (tab: string): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>(`.tab-btn[data-tab="${tab}"]`)!;
const check = (optionId: string): HTMLInputElement =>
  document.getElementById(`resupply-opt-${optionId}`) as HTMLInputElement;

const latOf = (km: number) => -34 - km / 1000;

function makeTrail() {
  const points = Array.from({ length: 31 }, (_, km) => ({ lat: latOf(km), lon: 138 + km / 1000, ele: 100, dist: km }));
  const wp = (id: string, name: string, type: string, totalDistance: number) => ({
    id,
    name,
    type,
    totalDistance,
    lat: latOf(totalDistance),
    lon: 138 + totalDistance / 1000,
  });
  return {
    config: { id: TRAIL_ID, name: 'Leg Fixture', shortName: 'Legs' },
    track: { points, totalDistance: 30, totalAscent: 0, totalDescent: 0, ...(breaks ? { breaks } : {}) },
    waypoints: [
      wp('w_alpha', 'Alpha', 'town', 10),
      ...extraWaypoints.map(([id, name, km]) => wp(id, name, 'town', km)),
      wp('w_bravo', 'Bravo', 'town', 20),
    ],
  };
}

async function boot(): Promise<void> {
  const html = bundledPlanPageHtml();
  document.documentElement.innerHTML = html.replace(/<!DOCTYPE html>/i, '').replace(/<\/?html[^>]*>/gi, '');
  vi.resetModules();
  const { initPlanViewer } = await import('./plan-viewer');
  await initPlanViewer(TRAIL_ID, makeTrail() as never);
}

beforeEach(() => {
  (HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = () =>
    new Proxy({}, { get: () => () => ({ addColorStop() {}, width: 0 }) });
  window.localStorage.clear();
  vi.useFakeTimers();
  lines = [];
  fitted = 0;
  fittedTo = null;
  breaks = undefined;
  extraWaypoints = [];
  installLeafletStub();
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { L?: unknown }).L;
});

describe('resupply legs on the map', () => {
  it('are drawn only while the Resupply tab is showing', async () => {
    await boot();
    expect(legLines()).toHaveLength(0);

    tabButton('resupply').click();
    expect(legLines()).toHaveLength(3);

    tabButton('days').click();
    expect(legLines()).toHaveLength(0);
  });

  it('draws each leg from stop to stop, in colours that tell neighbours apart', async () => {
    await boot();
    tabButton('resupply').click();

    const drawn = legLines();
    expect(drawn.map(l => l.tooltip)).toEqual([
      'Leg 1: Trail Start → Alpha',
      'Leg 2: Alpha → Bravo',
      'Leg 3: Bravo → Trail End',
    ]);
    const ends = drawn.map(l => [l.latLngs[0][0][0], l.latLngs.at(-1)!.at(-1)![0]]);
    expect(ends).toEqual([
      [latOf(0), latOf(10)],
      [latOf(10), latOf(20)],
      [latOf(20), latOf(30)],
    ]);
    const colors = drawn.map(l => l.options.color);
    expect(new Set(colors).size).toBe(3);

    // Each datasheet row carries its line's colour.
    const swatches = legRows().map(row => row.querySelector<HTMLElement>('.leg-swatch')?.style.background);
    expect(swatches).toHaveLength(3);
    expect(swatches.every(Boolean)).toBe(true);
  });

  it('follows the selection: carrying through a town merges its two legs', async () => {
    await boot();
    tabButton('resupply').click();
    check('w_alpha').click();

    expect(legLines().map(l => l.tooltip)).toEqual(['Leg 1: Trail Start → Bravo', 'Leg 2: Bravo → Trail End']);
  });

  it('cuts a leg at a route break rather than drawing the gap as trail', async () => {
    breaks = [{ index: 15, displayIndex: 15, km: 15, straightLineKm: 2, fromTrack: 'North', toTrack: 'South' }];
    await boot();
    tabButton('resupply').click();

    const [, middle] = legLines();
    expect(middle.latLngs).toHaveLength(2);
    expect(middle.latLngs[0].at(-1)![0]).toBe(latOf(14));
    expect(middle.latLngs[1][0][0]).toBe(latOf(15));
  });

  it('highlights a line and its row together, from either side', async () => {
    await boot();
    tabButton('resupply').click();

    legLines()[1].handlers.mouseover();
    expect(legRows().map(row => row.classList.contains('is-highlighted'))).toEqual([false, true, false]);
    expect(legLines()[1].options.weight).toBeGreaterThan(legLines()[0].options.weight!);

    legLines()[1].handlers.mouseout();
    expect(legRows().some(row => row.classList.contains('is-highlighted'))).toBe(false);

    legRows()[2]
      .querySelector('td')!
      .dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(legLines()[2].options.weight).toBeGreaterThan(legLines()[0].options.weight!);
    expect(legRows()[2].classList.contains('is-highlighted')).toBe(true);

    const before = fitted;
    legRows()[2].click();
    expect(fitted).toBe(before + 1);
    expect(fittedTo).toBe(legLines()[2]);
  });

  it('leaves the map alone on a click on a leg too short to draw', async () => {
    extraWaypoints = [['w_alpha_south', 'Alpha South', 10.4]];
    await boot();
    tabButton('resupply').click();
    // Two stops between the same pair of track points: the leg between them
    // has no run to draw, and fitting the map to its empty bounds would throw.
    expect(legLines().map(l => l.tooltip)).toContain('Leg 2: Alpha → Alpha South');
    const before = fitted;
    expect(legLines()[1].latLngs.flat()).toHaveLength(0);
    legRows()[1].click();
    expect(fitted).toBe(before);
  });
});
