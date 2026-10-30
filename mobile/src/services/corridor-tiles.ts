/**
 * Which map tiles a corridor pack needs: every z/x/y tile within a chosen
 * distance of a route, at every zoom the pack carries.
 *
 * Pure and platform-neutral — no file system, no network — so the Offline maps
 * screen can show a tile count before anything is fetched, and the geometry is
 * unit-tested on its own. The downloader is `services/corridor-pack`.
 *
 * ## The rule
 *
 * A route is cut into lines: the main track split at its route breaks (a ferry
 * or a lake is never walked, so the corridor never spans one — `@lib/route-breaks`),
 * plus each alternate and side trip whole. Along each line the walk samples a
 * point at least every half tile width at the deepest zoom, and every tile that
 * intersects a ±buffer box around a sample is in. The box is the buffer in
 * degrees — latitude straight, longitude widened by 1/cos(lat) — so it errs a
 * little wide. On a dense track, vertices within one sample spacing of the last
 * sample are skipped, so the edge may fall up to that spacing (half a z15 tile,
 * ~600 m at the equator) short of the buffer where the route bends: noise
 * beside a 2–20 km corridor.
 *
 * Every shallower zoom is the deepest zoom's parents (`x >> 1, y >> 1`), which
 * cover exactly the same ground.
 *
 * Tiles are held as merged x-ranges per tile row rather than as one entry per
 * tile: a 20 km corridor along a 3,000 km route is a few hundred thousand
 * tiles, and counting them must not allocate a set that size on a phone.
 *
 * Latitude is clamped to Web Mercator's ±85.0511°, and a box that crosses the
 * antimeridian wraps to the other edge of the tile grid.
 */

import { splitAtRouteBreaks } from '@lib/route-breaks';
import type { RouteBreak } from '@lib/trail-types';

/** Deepest zoom of every pack, bundled or corridor (`scripts/tile-pipeline.ts`). */
export const CORRIDOR_MAX_ZOOM = 15;
/** Shallowest basemap zoom, as the bundled packs. */
export const BASE_MIN_ZOOM = 4;
/** Shallowest contour zoom, as the bundled packs. */
export const CONTOUR_MIN_ZOOM = 9;

/** Web Mercator's latitude limit. */
const MAX_LAT = 85.05112878;
const EARTH_CIRCUMFERENCE_M = 40_075_016.686;
const M_PER_DEG_LAT = 111_320;
/** Floor on cos(lat), so a box near the pole spans the row rather than dividing by ~0. */
const MIN_COS_LAT = 0.01;

export interface CorridorPoint {
  lat: number;
  lon: number;
}

/** The parts of a trail a corridor is drawn around. Full `points`, never `displayPoints`. */
export interface CorridorTrailInput {
  track?: {
    points?: readonly CorridorPoint[];
    breaks?: RouteBreak[];
  };
  alternates?: readonly { points?: readonly CorridorPoint[] }[];
  sideTrips?: readonly { points?: readonly CorridorPoint[] }[];
}

/** An inclusive run of tile columns, `[x0, x1]`. */
export type TileRange = [number, number];

/** One zoom's tiles: merged column ranges by tile row (XYZ, y from the north). */
export interface ZoomTiles {
  zoom: number;
  rows: Map<number, TileRange[]>;
  count: number;
}

/** The tiles at each zoom from `minZoom` to `maxZoom`. */
export interface CorridorTileSet {
  minZoom: number;
  maxZoom: number;
  levels: Map<number, ZoomTiles>;
}

export interface TileXYZ {
  z: number;
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

function isFinitePoint(p: CorridorPoint | null | undefined): p is CorridorPoint {
  return !!p && Number.isFinite(p.lat) && Number.isFinite(p.lon);
}

/**
 * The lines a corridor follows: the main track cut at its breaks (indices into
 * `points`), then each alternate and side trip. Points without a finite
 * position are dropped.
 */
export function corridorLines(trail: CorridorTrailInput | null | undefined): CorridorPoint[][] {
  const lines: CorridorPoint[][] = [];
  const points = trail?.track?.points ?? [];
  if (points.length > 0) {
    for (const stretch of splitAtRouteBreaks(
      points as CorridorPoint[],
      trail?.track?.breaks,
      'points',
    )) {
      lines.push(stretch.filter(isFinitePoint));
    }
  }
  for (const variant of [...(trail?.alternates ?? []), ...(trail?.sideTrips ?? [])]) {
    lines.push((variant.points ?? []).filter(isFinitePoint));
  }
  return lines.filter((line) => line.length > 0);
}

// ---------------------------------------------------------------------------
// Tile maths
// ---------------------------------------------------------------------------

function clampLat(lat: number): number {
  return Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
}

/** Fractional tile column of a longitude (may fall outside 0..n for a wrapped box). */
function lonToTileX(lon: number, n: number): number {
  return ((lon + 180) / 360) * n;
}

/** Fractional tile row of a latitude, clamped to the grid. */
function latToTileY(lat: number, n: number): number {
  const rad = (clampLat(lat) * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
}

/** Longitude of a tile column's west edge. */
function tileXToLon(x: number, n: number): number {
  return (x / n) * 360 - 180;
}

/** Latitude of a tile row's north edge. */
function tileYToLat(y: number, n: number): number {
  const merc = Math.PI * (1 - (2 * y) / n);
  return (Math.atan(Math.sinh(merc)) * 180) / Math.PI;
}

/** Width of a tile at `zoom` and `lat`, in metres. */
function tileWidthM(lat: number, zoom: number): number {
  return (EARTH_CIRCUMFERENCE_M * Math.cos((clampLat(lat) * Math.PI) / 180)) / 2 ** zoom;
}

/** Longitude difference b − a, taken the short way round (−180..180). */
function lonDelta(a: number, b: number): number {
  let d = b - a;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

/** Equirectangular distance between two points in metres: exact enough at sample spacing. */
function distanceM(a: CorridorPoint, b: CorridorPoint): number {
  const midCos = Math.cos((clampLat((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot(
    (b.lat - a.lat) * M_PER_DEG_LAT,
    lonDelta(a.lon, b.lon) * M_PER_DEG_LAT * midCos,
  );
}

/** Collects column ranges per row, merging once at the end. */
class RowAccumulator {
  private readonly raw = new Map<number, number[]>();

  constructor(private readonly n: number) {}

  /** Columns [x0, x1] of row y; x may run off either edge and wraps. */
  add(y: number, x0: number, x1: number): void {
    const n = this.n;
    if (x1 - x0 + 1 >= n) {
      this.push(y, 0, n - 1);
    } else if (x0 < 0) {
      this.push(y, x0 + n, n - 1);
      this.push(y, 0, x1);
    } else if (x1 >= n) {
      this.push(y, x0, n - 1);
      this.push(y, 0, x1 - n);
    } else {
      this.push(y, x0, x1);
    }
  }

  private push(y: number, x0: number, x1: number): void {
    if (x1 < x0) return;
    let list = this.raw.get(y);
    if (!list) {
      list = [];
      this.raw.set(y, list);
    }
    list.push(x0, x1);
  }

  finish(zoom: number): ZoomTiles {
    const rows = new Map<number, TileRange[]>();
    let count = 0;
    const ys = [...this.raw.keys()].sort((a, b) => a - b);
    for (const y of ys) {
      const flat = this.raw.get(y)!;
      const pairs: TileRange[] = [];
      for (let i = 0; i < flat.length; i += 2) pairs.push([flat[i], flat[i + 1]]);
      const merged = mergeRanges(pairs);
      for (const [a, b] of merged) count += b - a + 1;
      rows.set(y, merged);
    }
    return { zoom, rows, count };
  }
}

/** Sort and merge overlapping or adjacent ranges. */
function mergeRanges(ranges: TileRange[]): TileRange[] {
  ranges.sort((a, b) => a[0] - b[0]);
  const out: TileRange[] = [];
  for (const [a, b] of ranges) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) {
      if (b > last[1]) last[1] = b;
    } else {
      out.push([a, b]);
    }
  }
  return out;
}

/** Add every tile intersecting the ±buffer box around one point. */
function addBox(acc: RowAccumulator, p: CorridorPoint, bufferM: number, n: number): void {
  const dLat = bufferM / M_PER_DEG_LAT;
  const cos = Math.max(MIN_COS_LAT, Math.cos((clampLat(p.lat) * Math.PI) / 180));
  const dLon = bufferM / (M_PER_DEG_LAT * cos);

  const x0 = Math.floor(lonToTileX(p.lon - dLon, n));
  const x1 = Math.floor(lonToTileX(p.lon + dLon, n));
  const yTop = Math.max(0, Math.floor(latToTileY(p.lat + dLat, n)));
  const yBottom = Math.min(n - 1, Math.floor(latToTileY(p.lat - dLat, n)));
  for (let y = yTop; y <= yBottom; y++) acc.add(y, x0, Math.min(x1, x0 + n));
}

// ---------------------------------------------------------------------------
// Tile sets
// ---------------------------------------------------------------------------

/**
 * The tiles within `bufferM` metres of any of `lines`, at every zoom from
 * `minZoom` to `maxZoom`.
 */
export function corridorTileSet(
  lines: readonly (readonly CorridorPoint[])[],
  bufferM: number,
  minZoom: number,
  maxZoom: number,
): CorridorTileSet {
  const n = 2 ** maxZoom;
  const acc = new RowAccumulator(n);
  const buffer = Math.max(0, bufferM);

  for (const line of lines) {
    if (line.length === 0) continue;
    addBox(acc, line[0], buffer, n);
    // The last point boxed. A dense track (a GPS fix every few metres) has many
    // vertices within one sample spacing; boxing each would repeat the same rows
    // thousands of times over for no tile the spacing does not already reach.
    let last = line[0];
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1];
      const b = line[i];
      const dLon = lonDelta(a.lon, b.lon);
      const dLat = b.lat - a.lat;
      // Half a tile at the narrower (higher-latitude) end of the segment.
      const spacing = Math.max(
        1,
        Math.min(tileWidthM(a.lat, maxZoom), tileWidthM(b.lat, maxZoom)) / 2,
      );
      const steps = Math.ceil(distanceM(a, b) / spacing);
      for (let k = 1; k < steps; k++) {
        const t = k / steps;
        last = { lat: a.lat + dLat * t, lon: a.lon + dLon * t };
        addBox(acc, last, buffer, n);
      }
      if (steps > 1 || i === line.length - 1 || distanceM(last, b) >= spacing) {
        addBox(acc, b, buffer, n);
        last = b;
      }
    }
  }

  const levels = new Map<number, ZoomTiles>();
  let level = acc.finish(maxZoom);
  levels.set(maxZoom, level);
  for (let z = maxZoom - 1; z >= minZoom; z--) {
    level = parentLevel(level);
    levels.set(z, level);
  }
  return { minZoom, maxZoom, levels };
}

/** The parents of every tile in a level: exactly the same ground, one zoom up. */
function parentLevel(child: ZoomTiles): ZoomTiles {
  const acc = new RowAccumulator(2 ** (child.zoom - 1));
  for (const [y, ranges] of child.rows) {
    for (const [a, b] of ranges) acc.add(y >> 1, a >> 1, b >> 1);
  }
  return acc.finish(child.zoom - 1);
}

/** How many tiles a set holds between two zooms (inclusive). */
export function countTiles(set: CorridorTileSet, minZoom: number, maxZoom: number): number {
  let total = 0;
  for (let z = minZoom; z <= maxZoom; z++) total += set.levels.get(z)?.count ?? 0;
  return total;
}

/** Every tile between two zooms, shallowest zoom first, row by row. */
export function listTiles(set: CorridorTileSet, minZoom: number, maxZoom: number): TileXYZ[] {
  const out: TileXYZ[] = [];
  for (let z = minZoom; z <= maxZoom; z++) {
    const level = set.levels.get(z);
    if (!level) continue;
    for (const [y, ranges] of level.rows) {
      for (const [a, b] of ranges) {
        for (let x = a; x <= b; x++) out.push({ z, x, y });
      }
    }
  }
  return out;
}

/**
 * `[west, south, east, north]` of a level's tiles, for mbtiles `bounds`
 * metadata. A level that wraps the antimeridian reports the whole width.
 */
export function levelBounds(level: ZoomTiles): [number, number, number, number] | null {
  if (level.count === 0) return null;
  const n = 2 ** level.zoom;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [y, ranges] of level.rows) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    for (const [a, b] of ranges) {
      if (a < minX) minX = a;
      if (b > maxX) maxX = b;
    }
  }
  const wraps = minX === 0 && maxX === n - 1;
  return [
    wraps ? -180 : tileXToLon(minX, n),
    tileYToLat(maxY + 1, n),
    wraps ? 180 : tileXToLon(maxX + 1, n),
    tileYToLat(minY, n),
  ];
}

// ---------------------------------------------------------------------------
// Route fingerprint
// ---------------------------------------------------------------------------

/**
 * A fingerprint of the geometry a corridor is drawn around — the lines from
 * {@link corridorLines}, positions rounded to ~1 m. A corridor pack records it
 * as its `sourceVersion`, and a different value now means the route has
 * changed since the map was built. Only the geometry decides which tiles a
 * pack holds, so an edit to a route's name or notes does not count.
 *
 * FNV-1a (32-bit) over the rounded coordinates, prefixed with the point count.
 */
export function corridorFingerprint(lines: readonly (readonly CorridorPoint[])[]): string {
  let hash = 0x811c9dc5;
  let count = 0;
  const mix = (value: number) => {
    let v = value | 0;
    for (let i = 0; i < 4; i++) {
      hash ^= v & 0xff;
      hash = Math.imul(hash, 0x01000193);
      v >>>= 8;
    }
  };
  for (const line of lines) {
    mix(0x7fffffff); // line boundary: the same points split differently differ
    for (const p of line) {
      mix(Math.round(p.lat * 1e5));
      mix(Math.round(p.lon * 1e5));
      count++;
    }
  }
  return `${count.toString(36)}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
