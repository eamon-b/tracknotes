/**
 * Smooth the contour lines of an offline contours.mbtiles in place, using the
 * same code the contour tile worker runs on online tiles
 * (workers/contour-tiles/src/contour-smoothing.ts).
 *
 * Why: the per-trail packs were built with tippecanoe `--simplification=14`,
 * which leaves z9-z14 contours as sawtooth polygons; z15 keeps full detail.
 * Rewriting the tiles takes seconds per pack and needs no DEM, GDAL or
 * tippecanoe, where a rebuild needs all three.
 *
 * Every tile at or below `maxZoom` is decompressed (when gzipped), smoothed and
 * recompressed. Higher zooms are untouched. The pack records what was done in
 * a `contour_smoothing` metadata row, and a pack that already has one is left
 * alone: smoothing twice would round the lines further each time.
 *
 * Handles both mbtiles layouts tippecanoe writes: a plain `tiles` table, and
 * the deduplicated `map` + `images` tables behind a `tiles` view. In the
 * latter, a blob shared with a tile above `maxZoom` is copied rather than
 * changed, so the full-detail tile keeps its own bytes.
 */

import * as fs from 'fs';
import * as zlib from 'zlib';
import { createRequire } from 'module';
import {
  smoothContourTile,
  type SmoothingOptions,
} from '../../workers/contour-tiles/src/contour-smoothing.js';

/** The parts of `node:sqlite` used here (this repo's @types/node predates it). */
interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  iterate(...params: unknown[]): Iterable<unknown>;
}
export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}

/**
 * Open an SQLite file with `node:sqlite` (Node 22.5 or later). Required on
 * first use rather than imported: Vite (and so Vitest) does not resolve
 * `node:sqlite` as a builtin yet, and loading it lazily keeps every script that
 * imports tile-pipeline.ts runnable on older Node until it smooths a pack.
 */
export function openDatabase(filePath: string, options?: { readOnly?: boolean }): SqliteDatabase {
  const sqlite = createRequire(import.meta.url)('node:sqlite') as {
    DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;
  };
  return options ? new sqlite.DatabaseSync(filePath, options) : new sqlite.DatabaseSync(filePath);
}

/**
 * The settings for offline packs: the worker's `contours` settings. Every pack,
 * Australian or not, was built with the same coarse `--simplification=14`,
 * so the Australia archive's three passes suit them all.
 */
export const PACK_SMOOTHING: SmoothingOptions = { iterations: 3, tolerance: 2 };

/** Highest zoom smoothed. The packs' maxzoom (15) is what the app overzooms. */
export const PACK_SMOOTHING_MAX_ZOOM = 14;

/**
 * Written to the pack's `contour_smoothing` metadata row. Change it with the
 * algorithm or PACK_SMOOTHING, as the worker's SMOOTHING_VERSION is.
 */
export const PACK_SMOOTHING_VERSION = 'chaikin-1';

export const SMOOTHING_METADATA_KEY = 'contour_smoothing';

export interface PackSmoothingResult {
  /** True when the pack was smoothed already and nothing was changed. */
  alreadySmoothed: boolean;
  /** The metadata value found or written. */
  version: string;
  /** Tile blobs rewritten. */
  tiles: number;
  /** Stored bytes of those blobs before and after. */
  bytesBefore: number;
  bytesAfter: number;
}

const isGzip = (b: Uint8Array): boolean => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;

function smoothBlob(blob: Uint8Array, options: SmoothingOptions): Uint8Array {
  if (isGzip(blob)) {
    const smoothed = smoothContourTile(new Uint8Array(zlib.gunzipSync(blob)), options);
    return new Uint8Array(zlib.gzipSync(smoothed, { level: 9 }));
  }
  return smoothContourTile(blob, options);
}

/** Read the `contour_smoothing` metadata row of an mbtiles, if any. */
export function packSmoothingVersion(filePath: string): string | undefined {
  const db = openDatabase(filePath, { readOnly: true });
  try {
    const row = db.prepare('SELECT value FROM metadata WHERE name = ?').get(SMOOTHING_METADATA_KEY) as
      | { value: string }
      | undefined;
    return row?.value;
  } finally {
    db.close();
  }
}

/**
 * Smooth a contours.mbtiles in place. The file is rewritten inside one
 * transaction and then vacuumed, so a failure leaves it as it was.
 */
export function smoothContourMbtiles(
  filePath: string,
  options: SmoothingOptions = PACK_SMOOTHING,
  maxZoom: number = PACK_SMOOTHING_MAX_ZOOM,
  version: string = PACK_SMOOTHING_VERSION
): PackSmoothingResult {
  if (!fs.existsSync(filePath)) throw new Error(`${filePath} does not exist`);
  const db = openDatabase(filePath);
  try {
    const existing = db.prepare('SELECT value FROM metadata WHERE name = ?').get(SMOOTHING_METADATA_KEY) as
      | { value: string }
      | undefined;
    if (existing) {
      return { alreadySmoothed: true, version: existing.value, tiles: 0, bytesBefore: 0, bytesAfter: 0 };
    }

    const objects = db.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('table', 'view')").all() as {
      type: string;
      name: string;
    }[];
    const has = (type: string, name: string): boolean => objects.some((o) => o.type === type && o.name === name);
    const deduplicated = has('table', 'map') && has('table', 'images');
    if (!deduplicated && !has('table', 'tiles')) {
      throw new Error(`${filePath}: no tiles table, and no map/images tables`);
    }

    let tiles = 0;
    let bytesBefore = 0;
    let bytesAfter = 0;

    db.exec('BEGIN');
    try {
      if (deduplicated) {
        // Which zooms each blob serves.
        const uses = new Map<string, { low: boolean; high: boolean }>();
        for (const row of db.prepare('SELECT tile_id, zoom_level FROM map').all() as {
          tile_id: string;
          zoom_level: number;
        }[]) {
          const use = uses.get(row.tile_id) ?? { low: false, high: false };
          if (row.zoom_level <= maxZoom) use.low = true;
          else use.high = true;
          uses.set(row.tile_id, use);
        }
        const read = db.prepare('SELECT tile_data FROM images WHERE tile_id = ?');
        const update = db.prepare('UPDATE images SET tile_data = ? WHERE tile_id = ?');
        const insert = db.prepare('INSERT INTO images (tile_data, tile_id) VALUES (?, ?)');
        const repoint = db.prepare('UPDATE map SET tile_id = ? WHERE tile_id = ? AND zoom_level <= ?');
        for (const [id, use] of uses) {
          if (!use.low) continue;
          const row = read.get(id) as { tile_data: Uint8Array } | undefined;
          if (!row) continue;
          const out = smoothBlob(row.tile_data, options);
          if (use.high) {
            // Shared with a full-detail tile: give the low zooms their own copy.
            const lowId = `${id}-${version}`;
            insert.run(out, lowId);
            repoint.run(lowId, id, maxZoom);
          } else {
            update.run(out, id);
          }
          tiles++;
          bytesBefore += row.tile_data.length;
          bytesAfter += out.length;
        }
      } else {
        const rows = db.prepare('SELECT rowid, tile_data FROM tiles WHERE zoom_level <= ?').iterate(maxZoom) as
          Iterable<{ rowid: number; tile_data: Uint8Array }>;
        const update = db.prepare('UPDATE tiles SET tile_data = ? WHERE rowid = ?');
        // Collect first: updating a table while iterating it is undefined in SQLite.
        const pending: { rowid: number; out: Uint8Array; before: number }[] = [];
        for (const row of rows) {
          pending.push({ rowid: row.rowid, out: smoothBlob(row.tile_data, options), before: row.tile_data.length });
        }
        for (const { rowid, out, before } of pending) {
          update.run(out, rowid);
          tiles++;
          bytesBefore += before;
          bytesAfter += out.length;
        }
      }
      db.prepare('INSERT INTO metadata (name, value) VALUES (?, ?)').run(SMOOTHING_METADATA_KEY, version);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    db.exec('VACUUM');
    return { alreadySmoothed: false, version, tiles, bytesBefore, bytesAfter };
  } finally {
    db.close();
  }
}
