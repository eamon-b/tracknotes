/**
 * Heights from the Copernicus GLO-30 DEM, read straight out of the public
 * Cloud-Optimised GeoTIFFs on AWS with HTTP range requests — only the blocks a
 * bounding box covers are downloaded, never a whole 1° tile.
 *
 * Usage: `await dem.load(bbox)` once per area (async: it fetches), then
 * `dem.at(lat, lon)` as often as you like (sync, bilinear). A point outside
 * every loaded area, or on a tile the bucket does not have (open ocean), is
 * `null`.
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
  private readonly regions: Region[] = [];

  constructor(private readonly tileUrl: (tile: DemTile) => string = copernicusTileUrl) {}

  /** Fetch the heights covering `bbox`. */
  async load(bbox: Bbox): Promise<void> {
    for (let lat = Math.floor(bbox.south); lat <= Math.floor(bbox.north); lat++) {
      for (let lon = Math.floor(bbox.west); lon <= Math.floor(bbox.east); lon++) {
        const image = await this.image({ lat, lon });
        if (!image) continue;
        const part: Bbox = {
          west: Math.max(bbox.west, lon),
          south: Math.max(bbox.south, lat),
          east: Math.min(bbox.east, lon + 1),
          north: Math.min(bbox.north, lat + 1),
        };
        this.regions.push(await readRegion(image, part));
      }
    }
  }

  /** Height in metres, bilinear between pixel centres, or null where nothing is loaded. */
  at(lat: number, lon: number): number | null {
    for (let i = this.regions.length - 1; i >= 0; i--) {
      const region = this.regions[i];
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
    const key = `${tile.lat},${tile.lon}`;
    let image = this.images.get(key);
    if (!image) {
      // A tile the bucket lacks is open ocean: no height, not an error.
      image = fromUrl(this.tileUrl(tile))
        .then(tiff => tiff.getImage())
        .catch(() => null);
      this.images.set(key, image);
    }
    return image;
  }
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
