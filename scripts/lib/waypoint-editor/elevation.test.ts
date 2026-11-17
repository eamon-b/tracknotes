import type { GeoTIFFImage } from 'geotiff';
import { describe, expect, it } from 'vitest';
import { CopernicusDem } from '../dem-sampler';
import type { DemTile } from '../world-grid';
import {
  copernicusDemSource,
  lookupElevation,
  onRouteMeters,
  routeElevation,
  type DemSource,
  type ElevationTrail,
} from './elevation';

// A route due south along a meridian, a point every 0.01° (about 1.11 km).
const POINTS = [
  { lat: -36.0, lon: 148, ele: 100, dist: 0 },
  { lat: -36.01, lon: 148, ele: 200, dist: 1.112 },
  { lat: -36.02, lon: 148, ele: 180, dist: 2.224 },
  { lat: -36.03, lon: 148, ele: 260, dist: 3.336 },
];

function trail(config: ElevationTrail['config'] = {}, breaks?: ElevationTrail['track']['breaks']): ElevationTrail {
  return { config, track: breaks ? { points: POINTS, breaks } : { points: POINTS } };
}

/** A DEM that answers `metres` and counts how often it was asked. */
function fakeDem(metres: number | null): DemSource & { asked: [number, number][] } {
  const asked: [number, number][] = [];
  const dem = async (lat: number, lon: number) => {
    asked.push([lat, lon]);
    return metres;
  };
  return Object.assign(dem, { asked });
}

describe('routeElevation', () => {
  it('interpolates between the track points either side of a position on the route', () => {
    // Halfway from the first point to the second, 9 m east of the line.
    const halfway = routeElevation(trail(), -36.005, 148.0001);
    expect(halfway.source).toBe('route');
    expect(halfway.metres).toBeCloseTo(150, 1);
    expect(halfway.offRouteMeters).toBeCloseTo(9, 0);
    // A quarter of the way down the second segment, which falls 20 m.
    expect(routeElevation(trail(), -36.0125, 148).metres).toBeCloseTo(195, 1);
    // On a track point, and past the end of the line.
    expect(routeElevation(trail(), -36.02, 148).metres).toBe(180);
    expect(routeElevation(trail(), -36.031, 148).metres).toBe(260);
  });

  it('answers only within the distance the build matches a waypoint to the route', () => {
    expect(onRouteMeters(trail())).toBe(500);
    expect(onRouteMeters(trail({ waypointMaxDistance: 3000 }))).toBe(3000);
    // About 900 m east of the line.
    const off = routeElevation(trail(), -36.005, 148.01);
    expect(off).toMatchObject({ lat: -36.005, lon: 148.01, metres: null });
    expect(off.source).toBeUndefined();
    expect(off.why).toMatch(/^it is (89\d|90\d) m from the route$/);
    expect(routeElevation(trail({ waypointMaxDistance: 3000 }), -36.005, 148.01).metres).toBeCloseTo(150, 1);
    expect(routeElevation(trail(), -36.005, 148.1).why).toMatch(/^it is \d\.\d km from the route$/);
  });

  it('never reads a height across a route break', () => {
    // 333 m short of the third point: 186 m on a continuous route.
    expect(routeElevation(trail(), -36.017, 148).metres).toBeCloseTo(186, 1);
    // With the third point the first after a break, nothing lies between the
    // second and the third: the nearest route is the third point itself.
    const broken = trail({}, [{ index: 2, displayIndex: 2 }]);
    const at = routeElevation(broken, -36.017, 148);
    expect(at.metres).toBe(180);
    expect(at.offRouteMeters).toBeGreaterThan(300);
    // Midway across the break is over 500 m from either landing: off the route.
    expect(routeElevation(broken, -36.015, 148).metres).toBeNull();
    // The stretch after the break still interpolates.
    expect(routeElevation(broken, -36.025, 148).metres).toBeCloseTo(220, 1);
  });

  it('gives nothing when the track has no real elevations', () => {
    const none = routeElevation(trail({ elevationSource: 'none' }), -36.005, 148);
    expect(none).toMatchObject({ metres: null, why: 'the route has no elevations' });
    const flat: ElevationTrail = { track: { points: POINTS.map(p => ({ ...p, ele: 0 })) } };
    expect(routeElevation(flat, -36.005, 148).metres).toBeNull();
    expect(routeElevation({ track: { points: [] } }, -36.005, 148)).toMatchObject({
      metres: null,
      why: 'the trail has no route',
    });
  });
});

describe('lookupElevation', () => {
  it('takes the route when the position is on it, without asking the DEM', async () => {
    const dem = fakeDem(999);
    const found = await lookupElevation(trail(), -36.005, 148.0001, dem);
    expect(found.source).toBe('route');
    expect(found.metres).toBeCloseTo(150, 1);
    expect(dem.asked).toEqual([]);
  });

  it('asks the DEM off the route, and on a route with no elevations', async () => {
    const dem = fakeDem(640.25);
    const off = await lookupElevation(trail(), -36.005, 148.03, dem);
    expect(off).toMatchObject({ metres: 640.25, source: 'dem' });
    expect(off.why).toMatch(/^it is 2\.\d km from the route$/);
    const flat = await lookupElevation(trail({ elevationSource: 'none' }), -36.005, 148, dem);
    expect(flat).toMatchObject({ metres: 640.25, source: 'dem', why: 'the route has no elevations' });
    expect(dem.asked).toEqual([
      [-36.005, 148.03],
      [-36.005, 148],
    ]);
  });

  it('finds nothing, and says why, when the DEM has no height, fails, or does not answer in time', async () => {
    const sea = await lookupElevation(trail(), -36.005, 148.03, fakeDem(null));
    expect(sea.metres).toBeNull();
    expect(sea.why).toMatch(/from the route, and the Copernicus DEM has no height there$/);
    expect((await lookupElevation(trail(), -36.005, 148.03, fakeDem(NaN))).metres).toBeNull();

    const failing: DemSource = () => Promise.reject(new Error('fetch failed', { cause: new Error('ECONNREFUSED') }));
    const failed = await lookupElevation(trail(), -36.005, 148.03, failing);
    expect(failed.metres).toBeNull();
    expect(failed.why).toMatch(/the Copernicus DEM could not be read \(fetch failed: ECONNREFUSED\)$/);
    const throwing: DemSource = () => {
      throw new Error('not even a promise');
    };
    expect((await lookupElevation(trail(), -36.005, 148.03, throwing)).why).toMatch(/not even a promise/);

    const hanging: DemSource = () => new Promise(() => {});
    const started = Date.now();
    const timedOut = await lookupElevation(trail(), -36.005, 148.03, hanging, 30);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(timedOut.metres).toBeNull();
    expect(timedOut.why).toMatch(/could not be read \(no answer in 0\.03 s\)$/);
  });

  it('gives the route’s answer alone when there is no DEM to ask', async () => {
    expect(await lookupElevation(trail(), -36.005, 148.03)).toEqual(routeElevation(trail(), -36.005, 148.03));
  });
});

describe('copernicusDemSource', () => {
  /** A fake 1° tile of 100 × 100 pixels whose height is 10 × its pixel row from the north edge. */
  function fakeTile(tile: DemTile, reads: { count: number }): GeoTIFFImage {
    const size = 100;
    return {
      getBoundingBox: () => [tile.lon, tile.lat, tile.lon + 1, tile.lat + 1],
      getWidth: () => size,
      getHeight: () => size,
      readRasters: async ({ window: [x0, y0, x1, y1] }: { window: number[] }) => {
        reads.count++;
        const data = new Float32Array((x1 - x0) * (y1 - y0));
        for (let y = 0; y < y1 - y0; y++) for (let x = 0; x < x1 - x0; x++) data[y * (x1 - x0) + x] = (y0 + y) * 10;
        return [data];
      },
    } as unknown as GeoTIFFImage;
  }
  const sampler = (reads: { count: number }) =>
    new CopernicusDem(
      tile => `${tile.lat},${tile.lon}`,
      async url => {
        const [lat, lon] = url.split(',').map(Number);
        return fakeTile({ lat, lon }, reads);
      }
    );

  it('reads one small window around the position, once', async () => {
    const reads = { count: 0 };
    const dem = copernicusDemSource(async () => sampler(reads));
    // 0.2° south of the tile's north edge is 20 pixels down; pixel centres sit half a pixel in.
    expect(await dem(-36.2, 148.5)).toBeCloseTo(195, 3);
    expect(await dem(-36.2, 148.5)).toBeCloseTo(195, 3);
    expect(reads.count).toBe(1);
    // As the source of a lookup: off the route, so the DEM's height is the answer.
    const found = await lookupElevation(trail(), -36.2, 148.5, dem);
    expect(found.source).toBe('dem');
    expect(found.metres).toBeCloseTo(195, 3);
  });

  it('tries again after a sampler that could not be made', async () => {
    let attempts = 0;
    const reads = { count: 0 };
    const dem = copernicusDemSource(async () => {
      if (attempts++ === 0) throw new Error('no geotiff');
      return sampler(reads);
    });
    expect((await lookupElevation(trail(), -36.2, 148.5, dem)).why).toMatch(/could not be read \(no geotiff\)$/);
    expect((await lookupElevation(trail(), -36.2, 148.5, dem)).metres).toBeCloseTo(195, 3);
    expect(attempts).toBe(2);
  });
});
