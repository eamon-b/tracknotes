import { describe, expect, it } from 'vitest';
import type * as Leaflet from 'leaflet';
import type { ProcessedTrail } from '@lib/trail-types';
import { adminRouteBounds, adminRouteShapes, drawAdminRouteMap, waypointTooltipHtml } from './admin-route-map';

const XSS = '<img src=x onerror=alert(1)>';

function pt(lat: number, lon: number, km = 0) {
  return { lat, lon, ele: 100, dist: km };
}

function trail(overrides: Partial<ProcessedTrail['track']> = {}, rest: Partial<ProcessedTrail> = {}): ProcessedTrail {
  const points = [pt(-37, 145), pt(-37.01, 145.01), pt(-37.02, 145.02), pt(-37.5, 145.5), pt(-37.51, 145.51)];
  return {
    config: { id: 'c_x', name: 'x' },
    track: { points, displayPoints: points, totalDistance: 10, totalAscent: 0, totalDescent: 0, ...overrides },
    waypoints: [],
    offTrailWaypoints: [],
    alternates: [],
    sideTrips: [],
    climate: null,
    climateLocations: null,
    direction: null,
    ...rest,
  } as unknown as ProcessedTrail;
}

describe('adminRouteShapes', () => {
  it('draws a continuous route as one line', () => {
    const shapes = adminRouteShapes(trail());
    expect(shapes.main).toHaveLength(1);
    expect(shapes.main[0]).toHaveLength(5);
    expect(shapes.breaks).toEqual([]);
    expect(shapes.start).toEqual([-37, 145]);
    expect(shapes.end).toEqual([-37.51, 145.51]);
  });

  it('cuts the line at track.breaks (display index) and draws the gap as a break', () => {
    const display = [pt(-37, 145), pt(-37.02, 145.02), pt(-37.5, 145.5), pt(-37.51, 145.51)];
    const shapes = adminRouteShapes(
      trail({
        displayPoints: display,
        breaks: [{ index: 3, displayIndex: 2, km: 5, straightLineKm: 60, fromTrack: 'a', toTrack: 'b' }],
      })
    );
    expect(shapes.main).toEqual([
      [
        [-37, 145],
        [-37.02, 145.02],
      ],
      [
        [-37.5, 145.5],
        [-37.51, 145.51],
      ],
    ]);
    expect(shapes.breaks).toEqual([{ from: [-37.02, 145.02], to: [-37.5, 145.5], km: 60 }]);
  });

  it('uses the full points (and their break index) when there are no display points', () => {
    const shapes = adminRouteShapes(
      trail({
        displayPoints: [],
        breaks: [{ index: 3, displayIndex: 99, km: 5, straightLineKm: 60, fromTrack: 'a', toTrack: 'b' }],
      })
    );
    expect(shapes.main.map(l => l.length)).toEqual([3, 2]);
  });

  it('includes variants and waypoints, and fits all of them', () => {
    const shapes = adminRouteShapes(
      trail({}, {
        alternates: [{ name: 'Alt', type: 'alternate', points: [pt(-36, 144), pt(-36.1, 144.1)] }],
        sideTrips: [{ name: 'Peak', type: 'side-trip', points: [pt(-38, 146), pt(-38.1, 146.1)] }],
        waypoints: [{ name: 'Hut', type: 'hut', lat: -37.01, lon: 145.01 }],
        offTrailWaypoints: [{ name: 'Spring', type: 'water', lat: -39, lon: 147 }],
      } as unknown as Partial<ProcessedTrail>)
    );
    expect(shapes.variants.map(v => v.name)).toEqual(['Alt', 'Peak']);
    expect(shapes.waypoints.map(w => w.name)).toEqual(['Hut', 'Spring']);
    const bounds = adminRouteBounds(shapes);
    expect(bounds).toContainEqual([-39, 147]);
    expect(bounds).toContainEqual([-36, 144]);
  });
});

describe('waypointTooltipHtml', () => {
  it('escapes the name and type', () => {
    const html = waypointTooltipHtml(`Hut ${XSS}`, `type ${XSS}`);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('drawAdminRouteMap', () => {
  it('puts only escaped names into Leaflet tooltips', () => {
    const tooltips: string[] = [];
    const layer = () => {
      const self = {
        addTo: () => self,
        bindTooltip: (html: string) => {
          tooltips.push(html);
          return self;
        },
      };
      return self;
    };
    const map = { fitBounds: () => map, setView: () => map };
    const fakeL = {
      map: () => map,
      tileLayer: layer,
      polyline: layer,
      circleMarker: layer,
      control: { scale: layer },
      latLngBounds: (b: unknown) => b,
    } as unknown as typeof Leaflet;

    drawAdminRouteMap(
      fakeL,
      document.createElement('div'),
      trail({}, {
        alternates: [{ name: `Alt ${XSS}`, type: 'alternate', points: [pt(-36, 144), pt(-36.1, 144.1)] }],
        waypoints: [{ name: `Hut ${XSS}`, type: 'hut', lat: -37.01, lon: 145.01 }],
      } as unknown as Partial<ProcessedTrail>)
    );
    expect(tooltips.length).toBeGreaterThanOrEqual(2);
    for (const html of tooltips) expect(html).not.toContain('<img');
    expect(tooltips.join('\n')).toContain('Hut &lt;img');
  });
});
