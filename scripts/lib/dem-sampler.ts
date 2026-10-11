/**
 * Heights from the Copernicus GLO-30 DEM, read straight out of the public
 * Cloud-Optimised GeoTIFFs on AWS with HTTP range requests — only the blocks a
 * bounding box covers are downloaded, never a whole 1° tile.
 *
 * Usage: `await dem.load(bbox)` once per area (async: it fetches), then
 * `dem.at(lat, lon)` as often as you like (sync, bilinear). A point outside
 * every loaded area, or on a tile the bucket does not have (open ocean), is
 * `null`. Any other failure to read a tile — a timeout, a proxy refusing the
 * request — makes `load` throw rather than pass the area off as flat sea.
 *
 * Node's built-in fetch ignores `HTTPS_PROXY`; behind a proxy run with
 * `NODE_USE_ENV_PROXY=1` (Node ≥ 22.21).
 */

import { fromUrl, type GeoTIFFImage } from 'geotiff';
import { copernicusTileUrl, type DemTile } from './world-grid.js';

export interface Bbox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** A window of one tile's raster held in memory. */
interface Region {
  bbox: Bbox;
  /** Pixel-centre grid: column 0 is at `lon0`, row 0 at `lat0`, steps of `res`. */
  lon0: number;
  lat0: number;
  resLon: number;
  resLat: number;
  width: number;
  height: number;
  data: Float32Array | Float64Array;
}

export class CopernicusDem {
  private readonly images = new Map<string, Promise<GeoTIFFImage | null>>();
  /** Loaded windows by 1° tile (`tileKey`), newest last. */
  private readonly regions = new Map<string, Region[]>();

  constructor(
    private readonly tileUrl: (tile: DemTile) => string = copernicusTileUrl,
    private readonly open: (url: string) => Promise<GeoTIFFImage | null> = openTile
  ) {}

  /** Fetch the heights covering `bbox`. Throws when a tile cannot be read. */
  async load(bbox: Bbox): Promise<void> {
    for (let lat = Math.floor(bbox.south); lat <= Math.floor(bbox.north); lat++) {
      for (let lon = Math.floor(bbox.west); lon <= Math.floor(bbox.east); lon++) {
        const part: Bbox = {
          west: Math.max(bbox.west, lon),
          south: Math.max(bbox.south, lat),
          east: Math.min(bbox.east, lon + 1),
          north: Math.min(bbox.north, lat + 1),
        };
        const key = tileKey(lat, lon);
        const loaded = this.regions.get(key) ?? [];
        // Overlapping areas (neighbouring clusters of places) share their
        // windows rather than download and hold the same blocks again.
        if (loaded.some(region => contains(region.bbox, part))) continue;
        const image = await this.image({ lat, lon });
        if (!image) continue;
        loaded.push(await readRegion(image, part));
        this.regions.set(key, loaded);
      }
    }
  }

  /** Height in metres, bilinear between pixel centres, or null where nothing is loaded. */
  at(lat: number, lon: number): number | null {
    const tileLat = Math.floor(lat);
    const tileLon = Math.floor(lon);
    const own = this.sample(this.regions.get(tileKey(tileLat, tileLon)), lat, lon);
    if (own !== null) return own;
    // A point on a tile's edge can read its neighbour's edge pixel.
    for (let dLat = -1; dLat <= 1; dLat++) {
      for (let dLon = -1; dLon <= 1; dLon++) {
        if (dLat === 0 && dLon === 0) continue;
        const value = this.sample(this.regions.get(tileKey(tileLat + dLat, tileLon + dLon)), lat, lon);
        if (value !== null) return value;
      }
    }
    return null;
  }

  private sample(regions: readonly Region[] | undefined, lat: number, lon: number): number | null {
    if (!regions) return null;
    for (let i = regions.length - 1; i >= 0; i--) {
      const region = regions[i];
      // A point within a pixel of the edge — between the last pixel centres of
      // two neighbouring 1° tiles — reads the edge pixel rather than nothing.
      const rawX = (lon - region.lon0) / region.resLon;
      const rawY = (region.lat0 - lat) / region.resLat;
      if (rawX < -1 || rawY < -1 || rawX > region.width || rawY > region.height) continue;
      const x = Math.min(Math.max(rawX, 0), region.width - 1);
      const y = Math.min(Math.max(rawY, 0), region.height - 1);
      const x0 = Math.min(Math.floor(x), region.width - 2);
      const y0 = Math.min(Math.floor(y), region.height - 2);
      const fx = x - x0;
      const fy = y - y0;
      const v = (cx: number, cy: number) => region.data[cy * region.width + cx];
      const top = v(x0, y0) * (1 - fx) + v(x0 + 1, y0) * fx;
      const bottom = v(x0, y0 + 1) * (1 - fx) + v(x0 + 1, y0 + 1) * fx;
      return top * (1 - fy) + bottom * fy;
    }
    return null;
  }

  private image(tile: DemTile): Promise<GeoTIFFImage | null> {
    const key = tileKey(tile.lat, tile.lon);
    let image = this.images.get(key);
    if (!image) {
      image = this.open(this.tileUrl(tile));
      // A failure is not remembered: the caller's next pass asks again.
      image.catch(() => this.images.delete(key));
      this.images.set(key, image);
    }
    return image;
  }
}

function tileKey(lat: number, lon: number): string {
  return `${lat},${lon}`;
}

function contains(outer: Bbox, inner: Bbox): boolean {
  return outer.west <= inner.west && outer.south <= inner.south && outer.east >= inner.east && outer.north >= inner.north;
}

/**
 * Open one tile, or null when the bucket does not have it (open ocean: S3
 * answers 404). geotiff reports every failed request alike, so the tile is
 * asked for with a HEAD first; anything but a 404 or a readable tile throws.
 */
async function openTile(url: string): Promise<GeoTIFFImage | null> {
  const head = await fetch(url, { method: 'HEAD' });
  if (head.status === 404) return null;
  if (!head.ok) throw new Error(`DEM tile ${url}: HTTP ${head.status}`);
  const tiff = await fromUrl(url);
  return tiff.getImage();
}

async function readRegion(image: GeoTIFFImage, part: Bbox): Promise<Region> {
  const [west, south, east, north] = image.getBoundingBox();
  const fullWidth = image.getWidth();
  const fullHeight = image.getHeight();
  const resLon = (east - west) / fullWidth;
  const resLat = (north - south) / fullHeight;
  // Two pixels of margin, so bilinear reads at the edge of the box have both neighbours.
  const x0 = Math.max(0, Math.floor((part.west - west) / resLon) - 2);
  const x1 = Math.min(fullWidth, Math.ceil((part.east - west) / resLon) + 2);
  const y0 = Math.max(0, Math.floor((north - part.north) / resLat) - 2);
  const y1 = Math.min(fullHeight, Math.ceil((north - part.south) / resLat) + 2);
  const rasters = await image.readRasters({ window: [x0, y0, x1, y1], samples: [0] });
  return {
    bbox: part,
    lon0: west + (x0 + 0.5) * resLon,
    lat0: north - (y0 + 0.5) * resLat,
    resLon,
    resLat,
    width: x1 - x0,
    height: y1 - y0,
    data: rasters[0] as Float32Array,
  };
}
