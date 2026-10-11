import { describe, it, expect } from 'vitest';
import type { GeoTIFFImage } from 'geotiff';
import { CopernicusDem } from './dem-sampler';
import type { DemTile } from './world-grid';

/**
 * A fake 1° tile of 100 × 100 pixels whose height is its longitude offset in
 * pixels (0 at the west edge, 99 at the east), counting every window it reads.
 */
function fakeTile(tile: DemTile, reads: { count: number }): GeoTIFFImage {
  const size = 100;
  return {
    getBoundingBox: () => [tile.lon, tile.lat, tile.lon + 1, tile.lat + 1],
    getWidth: () => size,
    getHeight: () => size,
    readRasters: async ({ window: [x0, y0, x1, y1] }: { window: number[] }) => {
      reads.count++;
      const data = new Float32Array((x1 - x0) * (y1 - y0));
      for (let y = 0; y < y1 - y0; y++) for (let x = 0; x < x1 - x0; x++) data[y * (x1 - x0) + x] = x0 + x;
      return [data];
    },
  } as unknown as GeoTIFFImage;
}

const urlOf = (tile: DemTile) => `${tile.lat},${tile.lon}`;
const tileOf = (url: string): DemTile => {
  const [lat, lon] = url.split(',').map(Number);
  return { lat, lon };
};

describe('CopernicusDem', () => {
  it('reads heights from the loaded windows', async () => {
    const reads = { count: 0 };
    const dem = new CopernicusDem(urlOf, async url => fakeTile(tileOf(url), reads));
    await dem.load({ west: 138.1, south: -34.9, east: 138.3, north: -34.7 });
    // 138.2 is 20 pixels into the tile; pixel centres sit half a pixel in.
    expect(dem.at(-34.8, 138.2)).toBeCloseTo(19.5, 5);
    expect(dem.at(-34.8, 139.5)).toBeNull();
  });

  it('does not download an area it already holds again', async () => {
    const reads = { count: 0 };
    const dem = new CopernicusDem(urlOf, async url => fakeTile(tileOf(url), reads));
    await dem.load({ west: 138.1, south: -34.9, east: 138.3, north: -34.7 });
    await dem.load({ west: 138.15, south: -34.85, east: 138.25, north: -34.75 });
    expect(reads.count).toBe(1);
    await dem.load({ west: 138.25, south: -34.85, east: 138.4, north: -34.75 });
    expect(reads.count).toBe(2);
  });

  it('reads across the seam between two tiles', async () => {
    const reads = { count: 0 };
    const dem = new CopernicusDem(urlOf, async url => fakeTile(tileOf(url), reads));
    await dem.load({ west: 138.9, south: -34.9, east: 139.1, north: -34.7 });
    expect(dem.at(-34.8, 138.95)).toBeCloseTo(94.5, 5);
    expect(dem.at(-34.8, 139.05)).toBeCloseTo(4.5, 5);
  });

  it('takes a tile the bucket lacks as open ocean', async () => {
    const dem = new CopernicusDem(urlOf, async () => null);
    await dem.load({ west: 138.1, south: -34.9, east: 138.3, north: -34.7 });
    expect(dem.at(-34.8, 138.2)).toBeNull();
  });

  it('fails a load it cannot read, and asks again next time', async () => {
    const reads = { count: 0 };
    let attempts = 0;
    const dem = new CopernicusDem(urlOf, async url => {
      attempts++;
      if (attempts === 1) throw new Error('DEM tile: HTTP 403');
      return fakeTile(tileOf(url), reads);
    });
    const bbox = { west: 138.1, south: -34.9, east: 138.3, north: -34.7 };
    await expect(dem.load(bbox)).rejects.toThrow(/403/);
    await dem.load(bbox);
    expect(dem.at(-34.8, 138.2)).toBeCloseTo(19.5, 5);
  });
});
