import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import {
  openDatabase,
  type SqliteDatabase,
  smoothContourMbtiles,
  packSmoothingVersion,
  PACK_SMOOTHING_VERSION,
  SMOOTHING_METADATA_KEY,
} from './contour-pack-smoothing';

// Mt Sonder, NT: contours/13/7112/4648 as served on 2026-10-07 (uncompressed MVT).
const FIXTURE = fs.readFileSync(
  path.resolve(__dirname, '../../workers/contour-tiles/test-fixtures/contours-13-7112-4648.pbf')
);
const GZ = zlib.gzipSync(FIXTURE);

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-smoothing-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function metadata(db: SqliteDatabase): void {
  db.exec('CREATE TABLE metadata (name TEXT, value TEXT); CREATE UNIQUE INDEX name ON metadata (name);');
  db.prepare("INSERT INTO metadata VALUES ('format', 'pbf')").run();
}

/** tippecanoe's deduplicated layout: map + images behind a tiles view. */
function dedupPack(file: string): void {
  const db = openDatabase(file);
  metadata(db);
  db.exec(`
    CREATE TABLE map (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_id TEXT);
    CREATE UNIQUE INDEX map_index ON map (zoom_level, tile_column, tile_row);
    CREATE TABLE images (tile_data BLOB, tile_id TEXT);
    CREATE UNIQUE INDEX images_id ON images (tile_id);
    CREATE VIEW tiles AS SELECT map.zoom_level AS zoom_level, map.tile_column AS tile_column,
      map.tile_row AS tile_row, images.tile_data AS tile_data
      FROM map JOIN images ON images.tile_id = map.tile_id;
  `);
  const image = db.prepare('INSERT INTO images VALUES (?, ?)');
  const map = db.prepare('INSERT INTO map VALUES (?, ?, ?, ?)');
  image.run(GZ, 'low');
  image.run(GZ, 'shared');
  image.run(GZ, 'high');
  map.run(13, 1, 1, 'low');
  map.run(14, 2, 2, 'shared'); // the same blob serves a z14 and a z15 tile
  map.run(15, 4, 4, 'shared');
  map.run(15, 5, 5, 'high');
  db.close();
}

function plainPack(file: string, compress: boolean): void {
  const db = openDatabase(file);
  metadata(db);
  db.exec('CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);');
  const insert = db.prepare('INSERT INTO tiles VALUES (?, ?, ?, ?)');
  const blob = compress ? GZ : FIXTURE;
  insert.run(13, 1, 1, blob);
  insert.run(14, 2, 2, blob);
  insert.run(15, 4, 4, blob);
  db.close();
}

function tileAt(file: string, z: number, x: number, y: number): Buffer {
  const db = openDatabase(file, { readOnly: true });
  try {
    const row = db
      .prepare('SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?')
      .get(z, x, y) as { tile_data: Uint8Array };
    return Buffer.from(row.tile_data);
  } finally {
    db.close();
  }
}

function integrity(file: string): string {
  const db = openDatabase(file, { readOnly: true });
  try {
    return (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
  } finally {
    db.close();
  }
}

describe('smoothContourMbtiles', () => {
  it('smooths z9-z14 of a deduplicated pack and leaves z15 byte for byte', () => {
    const file = path.join(dir, 'contours.mbtiles');
    dedupPack(file);

    const result = smoothContourMbtiles(file);

    expect(result).toMatchObject({ alreadySmoothed: false, version: PACK_SMOOTHING_VERSION, tiles: 2 });
    expect(integrity(file)).toBe('ok');
    // Low zooms: still gzip, now different (smoothed) geometry.
    for (const [z, x, y] of [[13, 1, 1], [14, 2, 2]]) {
      const tile = tileAt(file, z, x, y);
      expect(tile.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
      expect(zlib.gunzipSync(tile).equals(FIXTURE)).toBe(false);
    }
    // z15, including the one that shared its blob with z14, is untouched.
    expect(tileAt(file, 15, 4, 4).equals(GZ)).toBe(true);
    expect(tileAt(file, 15, 5, 5).equals(GZ)).toBe(true);
    expect(packSmoothingVersion(file)).toBe(PACK_SMOOTHING_VERSION);
  });

  it('handles a plain tiles table, compressed or not', () => {
    for (const compress of [true, false]) {
      const file = path.join(dir, `plain-${compress}.mbtiles`);
      plainPack(file, compress);

      expect(smoothContourMbtiles(file).tiles).toBe(2);
      const low = tileAt(file, 13, 1, 1);
      expect(compress ? zlib.gunzipSync(low).equals(FIXTURE) : low.equals(FIXTURE)).toBe(false);
      expect(tileAt(file, 15, 4, 4).equals(compress ? GZ : FIXTURE)).toBe(true);
      expect(integrity(file)).toBe('ok');
    }
  });

  it('never smooths a pack twice', () => {
    const file = path.join(dir, 'contours.mbtiles');
    dedupPack(file);
    smoothContourMbtiles(file);
    const once = tileAt(file, 13, 1, 1);

    const again = smoothContourMbtiles(file);

    expect(again).toMatchObject({ alreadySmoothed: true, version: PACK_SMOOTHING_VERSION, tiles: 0 });
    expect(tileAt(file, 13, 1, 1).equals(once)).toBe(true);
  });

  it('leaves the pack unchanged when a tile cannot be parsed', () => {
    const file = path.join(dir, 'contours.mbtiles');
    plainPack(file, true);
    const db = openDatabase(file);
    db.prepare('UPDATE tiles SET tile_data = ? WHERE zoom_level = 14').run(zlib.gzipSync(FIXTURE.subarray(0, 100)));
    db.close();

    expect(() => smoothContourMbtiles(file)).toThrow();
    expect(tileAt(file, 13, 1, 1).equals(GZ)).toBe(true);
    expect(packSmoothingVersion(file)).toBeUndefined();
  });

  it('records the version under the metadata key the uploader can read', () => {
    expect(SMOOTHING_METADATA_KEY).toBe('contour_smoothing');
  });
});
