/**
 * Writing an MBTiles file on the phone, for corridor packs (`corridor-pack`).
 *
 * The schema is the one tile-join writes for the bundled packs, so everything
 * that reads a pack — validation, `buildTopoStyle`, MapLibre's mbtiles:// source
 * — cannot tell the two apart:
 *
 * - `metadata(name TEXT, value TEXT)`, unique on name;
 * - `tiles(zoom_level, tile_column, tile_row, tile_data)`, unique on (z, x, y),
 *   with `tile_row` in TMS order — `(1 << z) - 1 - y` — as the MBTiles spec has it.
 *
 * Tile bytes are stored as given; the caller gzips them, as tile-join does.
 * The database is opened on its own connection, as `validateMbtilesFile` opens
 * one, and each batch of tiles goes in under one transaction.
 */

import { openDatabaseAsync } from 'expo-sqlite';

/** Metadata key a corridor build stamps on its staging file, for resume. */
export const CORRIDOR_KEY_METADATA = 'tracknotes_corridor_key';

export interface TileRow {
  z: number;
  x: number;
  y: number;
  data: Uint8Array;
}

export interface MbtilesWriter {
  /** Every metadata value currently stored. */
  readMetadata(): Promise<Record<string, string>>;
  /** Replace the given metadata values. */
  setMetadata(entries: Record<string, string>): Promise<void>;
  /** The tiles already stored, as XYZ `z/x/y` keys. */
  existingTiles(): Promise<Set<string>>;
  /** Insert (or replace) a batch of XYZ tiles, in one transaction. */
  putTiles(tiles: readonly TileRow[]): Promise<void>;
  /** Tile count and zoom range stored, or null when there are no tiles. */
  stats(): Promise<{ count: number; minZoom: number; maxZoom: number } | null>;
  close(): Promise<void>;
}

/** TMS row of an XYZ tile — the MBTiles spec's `tile_row`. */
export function tmsRow(z: number, y: number): number {
  return (1 << z) - 1 - y;
}

/** The `z/x/y` key of a tile. */
export function tileKey(z: number, x: number, y: number): string {
  return `${z}/${x}/${y}`;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS metadata (name TEXT, value TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS metadata_name ON metadata (name);
CREATE TABLE IF NOT EXISTS tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);
CREATE UNIQUE INDEX IF NOT EXISTS tile_index ON tiles (zoom_level, tile_column, tile_row);
`;

/**
 * Open (creating if absent) an MBTiles file `fileName` in the directory at
 * `dirPath` — a bare filesystem path, as `uriToPath` gives.
 */
export async function openMbtilesWriter(dirPath: string, fileName: string): Promise<MbtilesWriter> {
  const db = await openDatabaseAsync(fileName, { useNewConnection: true }, dirPath);
  try {
    await db.execAsync(SCHEMA);
  } catch (err) {
    await db.closeAsync().catch(() => undefined);
    throw err;
  }

  return {
    async readMetadata() {
      const rows = await db.getAllAsync<{ name: string; value: string }>(
        'SELECT name, value FROM metadata',
      );
      const out: Record<string, string> = {};
      for (const row of rows) out[row.name] = row.value;
      return out;
    },

    async setMetadata(entries) {
      await db.withTransactionAsync(async () => {
        for (const [name, value] of Object.entries(entries)) {
          await db.runAsync('INSERT OR REPLACE INTO metadata (name, value) VALUES (?, ?)', [
            name,
            value,
          ]);
        }
      });
    },

    async existingTiles() {
      const rows = await db.getAllAsync<{
        zoom_level: number;
        tile_column: number;
        tile_row: number;
      }>('SELECT zoom_level, tile_column, tile_row FROM tiles');
      const keys = new Set<string>();
      for (const r of rows) {
        keys.add(tileKey(r.zoom_level, r.tile_column, tmsRow(r.zoom_level, r.tile_row)));
      }
      return keys;
    },

    async putTiles(tiles) {
      if (tiles.length === 0) return;
      await db.withTransactionAsync(async () => {
        for (const t of tiles) {
          await db.runAsync(
            'INSERT OR REPLACE INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)',
            [t.z, t.x, tmsRow(t.z, t.y), t.data],
          );
        }
      });
    },

    async stats() {
      const row = await db.getFirstAsync<{
        count: number;
        minZoom: number | null;
        maxZoom: number | null;
      }>(
        'SELECT COUNT(*) AS count, MIN(zoom_level) AS minZoom, MAX(zoom_level) AS maxZoom FROM tiles',
      );
      if (!row || !row.count || row.minZoom == null || row.maxZoom == null) return null;
      return { count: row.count, minZoom: row.minZoom, maxZoom: row.maxZoom };
    },

    async close() {
      await db.closeAsync();
    },
  };
}
