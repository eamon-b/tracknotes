/**
 * The trail page's waypoint marker popups, through a Leaflet stub that keeps
 * what each marker binds: they name a waypoint's type in words, as the
 * datasheet and the planner do, not by its slug.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');

interface StubMarker {
  title: string;
  popup: (() => string) | string | null;
}

let markers: StubMarker[] = [];

function installLeafletStub(): void {
  const layer = (): object => {
    const obj: object = new Proxy({}, { get: () => () => obj });
    return obj;
  };
  const mapObj: object = new Proxy(
    {},
    {
      get: (_target, key) => {
        if (key === 'getContainer') return () => document.getElementById('trail-map');
        return () => mapObj;
      },
    }
  );
  const L = {
    map: () => mapObj,
    tileLayer: layer,
    control: { scale: layer },
    // `new (L.Control.extend({...}))(…)`: a constructor that returns a layer.
    Control: {
      extend: () =>
        function ExpandControl() {
          return layer();
        },
    },
    layerGroup: layer,
    polyline: layer,
    circleMarker: layer,
    latLngBounds: layer,
    divIcon: (opts: object) => opts,
    marker: (_latLng: [number, number], opts: { title?: string }) => {
      const marker: StubMarker = { title: opts?.title ?? '', popup: null };
      markers.push(marker);
      const handle: object = new Proxy(
        {},
        {
          get: (_target, key) => {
            if (key === 'bindPopup')
              return (content: StubMarker['popup']) => {
                marker.popup = content;
                return handle;
              };
            return () => handle;
          },
        }
      );
      return handle;
    },
  };
  (globalThis as unknown as { L: unknown }).L = L;
}

function wp(name: string, type: string, totalDistance: number) {
  return {
    name,
    type,
    lat: -34 - totalDistance / 1000,
    lon: 138,
    elevation: 100,
    distance: 1,
    totalDistance,
    ascent: 0,
    descent: 0,
    totalAscent: 0,
    totalDescent: 0,
  };
}

function makeTrail() {
  return {
    config: { id: 'cape_to_cape', name: 'Test Trail', region: 'WA' },
    track: {
      points: [
        { lat: -34, lon: 138, ele: 100, dist: 0 },
        { lat: -34.1, lon: 138.1, ele: 200, dist: 70 },
      ],
      totalDistance: 70,
      totalAscent: 100,
      totalDescent: 100,
    },
    waypoints: [wp('Creek Crossing', 'water', 5), wp('Turn-off to Hut', 'hut-access', 20)],
    offTrailWaypoints: [{ name: 'Farm Tank', type: 'water-tank', lat: -34.05, lon: 138.05, distanceFromTrail: 1500 }],
    alternates: [],
    sideTrips: [],
  };
}

const popupText = (marker: StubMarker | undefined): string => {
  const content = marker?.popup;
  const html = typeof content === 'function' ? content() : (content ?? '');
  const div = document.createElement('div');
  div.innerHTML = html;
  return (div.textContent ?? '').replace(/\s+/g, ' ').trim();
};

beforeEach(() => {
  markers = [];
  installLeafletStub();
  (HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = () =>
    new Proxy({}, { get: () => () => ({ addColorStop() {}, width: 0 }) });
  window.requestAnimationFrame = (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  };
  window.localStorage.clear();
});

describe('trail page marker popups', () => {
  it('name the waypoint type in words, on and off the route', async () => {
    const html = fs.readFileSync(path.join(ROOT, 'src/web/my-trail.html'), 'utf8');
    document.documentElement.innerHTML = html.replace(/<!DOCTYPE html>/i, '').replace(/<\/?html[^>]*>/gi, '');
    vi.resetModules();
    const mod = await import('./trail-viewer');
    await mod.initTrailViewer('cape_to_cape', makeTrail() as never);

    const withPopup = markers.filter(m => m.popup !== null).map(popupText);
    const creek = withPopup.find(text => text.startsWith('Creek Crossing'));
    const turnOff = withPopup.find(text => text.startsWith('Turn-off to Hut'));
    const tank = withPopup.find(text => text.startsWith('Farm Tank'));

    expect(creek).toContain('Water source');
    expect(creek).not.toMatch(/Creek Crossing water\b/);
    expect(turnOff).not.toContain('hut-access');
    expect(tank).not.toContain('water-tank');
  });
});
