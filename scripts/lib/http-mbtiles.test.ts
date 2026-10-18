// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gzipSync } from 'zlib';
import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import { httpRangeReader, readZoomTiles, tableColumns, indexColumns } from './http-mbtiles.mjs';
import { checkZ9Tiered, contourElevations } from './mvt-contours.mjs';

// --- A minimal vector tile encoder, enough to build contour tiles ---

function varint(n: number): number[] {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
  return out;
}

function field(num: number, bytes: number[]): number[] {
  return [...varint(num * 8 + 2), ...varint(bytes.length), ...bytes];
}

function vfield(num: number, value: number): number[] {
  return [...varint(num * 8), ...varint(value)];
}

const utf8 = (s: string) => [...Buffer.from(s, 'utf8')];

/** A tile with one `contour` layer holding a line per elevation. */
function contourTile(elevations: number[], layerName = 'contour', valueField = 4): Uint8Array {
  const distinct = [...new Set(elevations)];
  const layer = [
    ...vfield(15, 2),
    ...field(1, utf8(layerName)),
    ...elevations.flatMap(e =>
      field(2, [
        ...field(2, [...varint(0), ...varint(distinct.indexOf(e))]),
        ...vfield(3, 2),
        ...field(4, [...varint(9), 0, 0, ...varint(10), 2, 2]),
      ])
    ),
    ...field(3, utf8('elevation')),
    // sint values for negative elevations, int for the rest: both decode.
    ...distinct.flatMap(e => field(4, e < 0 ? vfield(6, -2 * e - 1) : vfield(valueField, e))),
    ...vfield(5, 4096),
  ];
  return Uint8Array.from(field(3, layer));
}

// --- Fixtures: mbtiles in both layouts, written with node:sqlite ---

let dir: string;

function readerFor(file: string) {
  const bytes = fs.readFileSync(file);
  const reads: Array<[number, number]> = [];
  const read = async (start: number, end: number) => {
    reads.push([start, end]);
    return new Uint8Array(bytes.subarray(start, end + 1));
  };
  return { read, reads, size: bytes.length };
}

interface Tile { z: number; x: number; y: number; data: Uint8Array }

/** Tiles at z9–z12, big enough (≈6 KB, incompressible) to overflow a page. */
function fixtureTiles(): Tile[] {
  const tiles: Tile[] = [];
  const noise = (n: number) => new Uint8Array(randomBytes(n));
  for (let z = 9; z <= 12; z++) {
    const span = 2 ** (z - 7);
    for (let x = 0; x < span; x++) {
      for (let y = 0; y < span; y++) {
        const elevations = z === 9 ? [100 * (x + 1), 200 * (y + 1)] : [10 * (x + 1), 20 * (y + 1)];
        const tile = contourTile(elevations);
        // Noise after the tile is a second, unknown layer-free field run: keep
        // the tile decodable by wrapping it as an ignored field 99.
        const padded = Uint8Array.from([...tile, ...field(99, [...noise(z === 9 ? 6000 : 300)])]);
        tiles.push({ z, x, y, data: gzipSync(padded) });
      }
    }
  }
  return tiles;
}

const hex = (bytes: Uint8Array) => `x'${Buffer.from(bytes).toString('hex')}'`;

/** Run SQL through the sqlite3 CLI (stdin: the inserts run to megabytes). */
function sqlite(file: string, pageSize: number, statements: string[]): void {
  const sql = [`PRAGMA page_size = ${pageSize};`, 'BEGIN;', ...statements, 'COMMIT;'].join('\n');
  execFileSync('sqlite3', [file], { input: sql });
}

function writePlain(file: string, tiles: Tile[], pageSize: number): void {
  sqlite(file, pageSize, [
    'CREATE TABLE metadata (name text, value text);',
    'CREATE TABLE tiles (zoom_level integer, tile_column integer, tile_row integer, tile_data blob);',
    'CREATE UNIQUE INDEX tile_index on tiles (zoom_level, tile_column, tile_row);',
    // Reversed, so rowid order is not zoom order and the index must be used.
    ...[...tiles].reverse().map(t => `INSERT INTO tiles VALUES (${t.z}, ${t.x}, ${t.y}, ${hex(t.data)});`),
  ]);
}

function writeDeduplicated(file: string, tiles: Tile[], pageSize: number): void {
  sqlite(file, pageSize, [
    'CREATE TABLE metadata (name text, value text);',
    'CREATE TABLE map (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_id TEXT);',
    'CREATE UNIQUE INDEX map_index ON map (zoom_level, tile_column, tile_row);',
    'CREATE TABLE images (tile_data blob, tile_id text);',
    'CREATE UNIQUE INDEX images_id ON images (tile_id);',
    'CREATE VIEW tiles AS SELECT map.zoom_level AS zoom_level, map.tile_column AS tile_column, ' +
      'map.tile_row AS tile_row, images.tile_data AS tile_data FROM map JOIN images ON images.tile_id = map.tile_id;',
    ...[...tiles].reverse().flatMap(t => {
      const id = `${t.z}-${t.x}-${t.y}-${'h'.repeat(40)}`;
      return [
        `INSERT INTO map VALUES (${t.z}, ${t.x}, ${t.y}, '${id}');`,
        `INSERT INTO images VALUES (${hex(t.data)}, '${id}');`,
      ];
    }),
  ]);
}

const tiles = fixtureTiles();
const z9 = tiles.filter(t => t.z === 9);

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-mbtiles-'));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function sortTiles<T extends { x: number; y: number }>(list: T[]): T[] {
  return [...list].sort((a, b) => a.x - b.x || a.y - b.y);
}

describe('readZoomTiles', () => {
  for (const pageSize of [512, 4096]) {
    it(`reads one zoom from a plain tiles table (page size ${pageSize})`, async () => {
      const file = path.join(dir, `plain-${pageSize}.mbtiles`);
      writePlain(file, tiles, pageSize);
      const { read, reads, size } = readerFor(file);
      const got = await readZoomTiles(read, 9);
      expect(sortTiles(got).map(t => [t.x, t.y, Buffer.from(t.data).toString('hex')])).toEqual(
        sortTiles(z9).map(t => [t.x, t.y, Buffer.from(t.data).toString('hex')])
      );
      // The point of the exercise: nowhere near the whole file.
      const bytesRead = reads.reduce((a, [s, e]) => a + e - s + 1, 0);
      expect(bytesRead).toBeLessThan(size / 4);
      // Each z9 tile overflows into a run of pages (≈12 at 512 bytes): read
      // ahead, a tile costs a few requests, not one per page.
      expect(reads.length).toBeLessThan(z9.length * 6);
    });

    it(`reads one zoom from tippecanoe's map/images layout (page size ${pageSize})`, async () => {
      const file = path.join(dir, `dedup-${pageSize}.mbtiles`);
      writeDeduplicated(file, tiles, pageSize);
      const { read } = readerFor(file);
      const got = await readZoomTiles(read, 9);
      expect(sortTiles(got).map(t => [t.x, t.y, Buffer.from(t.data).toString('hex')])).toEqual(
        sortTiles(z9).map(t => [t.x, t.y, Buffer.from(t.data).toString('hex')])
      );
      expect(await readZoomTiles(read, 10)).toHaveLength(64);
      expect(await readZoomTiles(read, 8)).toEqual([]);
    });
  }

  it('refuses a file that is not SQLite', async () => {
    const bytes = new Uint8Array(200);
    await expect(readZoomTiles(async (s: number, e: number) => bytes.subarray(s, e + 1), 9)).rejects.toThrow(/not an SQLite/);
  });
});

describe('httpRangeReader', () => {
  it('asks for the range and refuses a server that ignores it', async () => {
    const calls: Array<{ url: string; range: string }> = [];
    const ok = httpRangeReader('https://x/a.mbtiles', (async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, range: init.headers.Range });
      return { status: 206, arrayBuffer: async () => new Uint8Array(4).buffer };
    }) as unknown as typeof fetch);
    expect(await ok(10, 13)).toHaveLength(4);
    expect(calls).toEqual([{ url: 'https://x/a.mbtiles', range: 'bytes=10-13' }]);

    const ignored = httpRangeReader('https://x/a.mbtiles', (async () => ({
      status: 200,
      arrayBuffer: async () => new Uint8Array(4).buffer,
    })) as unknown as typeof fetch);
    await expect(ignored(10, 13)).rejects.toThrow(/HTTP 200/);
  });
});

describe('schema parsing', () => {
  it('reads table and index columns', () => {
    expect(tableColumns('CREATE TABLE tiles (zoom_level integer, tile_column integer, tile_row integer, tile_data blob)').map(c => c.name))
      .toEqual(['zoom_level', 'tile_column', 'tile_row', 'tile_data']);
    expect(tableColumns('CREATE TABLE t (id INTEGER PRIMARY KEY, v text, PRIMARY KEY (id))'))
      .toEqual([{ name: 'id', rowidAlias: true }, { name: 'v', rowidAlias: false }]);
    expect(indexColumns('CREATE UNIQUE INDEX map_index ON map (zoom_level, tile_column, tile_row)'))
      .toEqual(['zoom_level', 'tile_column', 'tile_row']);
  });
});

describe('checkZ9Tiered', () => {
  it('passes a tile of 100 m lines, gzipped or not', () => {
    const tile = contourTile([100, 200, 1300, -100]);
    expect(checkZ9Tiered(tile)).toEqual({ ok: true, features: 4, offInterval: 0 });
    expect(checkZ9Tiered(gzipSync(tile)).ok).toBe(true);
    expect(contourElevations(tile).elevations).toEqual([100, 200, 1300, -100]);
  });

  it('reads a uint value as unsigned and an int value as two\'s complement', () => {
    expect(contourElevations(contourTile([2 ** 63], 'contour', 5)).elevations).toEqual([2 ** 63]);
    expect(contourElevations(contourTile([2 ** 63], 'contour', 4)).elevations).toEqual([-(2 ** 63)]);
  });

  it('fails an untiered tile, and one without the contour layer', () => {
    const untiered = checkZ9Tiered(contourTile([100, 110, 120, 150, 200]));
    expect(untiered.ok).toBe(false);
    expect(untiered.offInterval).toBe(3);
    expect(untiered.reason).toMatch(/3 of 5 features are not 100 m lines/);
    expect(checkZ9Tiered(contourTile([100], 'contour_z9')).reason).toBe('no contour layer');
  });
});
