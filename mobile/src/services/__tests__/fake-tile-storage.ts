/**
 * An in-memory file system and SQLite for the corridor-pack tests: enough of
 * expo-file-system's File/Directory and expo-sqlite's database to write, read,
 * validate, rename and delete MBTiles files the way the real code does.
 *
 * Wire it in with factories that `require` this module, so the test and the
 * mocks share one state:
 *
 *   jest.mock('expo-file-system', () => require('./fake-tile-storage').fileSystemModule);
 *   jest.mock('expo-sqlite', () => require('./fake-tile-storage').sqliteModule);
 */

/** One stored MBTiles database. */
export interface FakeMbtiles {
  metadata: Map<string, string>;
  /** Keyed `z/x/tmsRow`. */
  tiles: Map<string, { z: number; x: number; row: number; data: Uint8Array }>;
}

interface FakeEntry {
  /** Plain text content (manifest.json). */
  text?: string;
  /** Raw size for a non-database file. */
  size: number;
  db?: FakeMbtiles;
}

export const storage = {
  files: new Map<string, FakeEntry>(),
  dirs: new Set<string>(),
  /** Databases opened and not yet closed, by uri. */
  open: new Map<string, number>(),
};

export function resetStorage(): void {
  storage.files.clear();
  storage.dirs.clear();
  storage.open.clear();
}

function dbSize(db: FakeMbtiles): number {
  let size = 4096;
  for (const t of db.tiles.values()) size += t.data.length;
  return size + db.metadata.size * 32;
}

function entrySize(entry: FakeEntry): number {
  return entry.db ? dbSize(entry.db) : entry.size;
}

function uriOf(args: unknown[]): string {
  const parts: string[] = [];
  for (const a of args) {
    if (typeof a === 'string') parts.push(a.replace(/^file:\/\//, '').replace(/\/$/, ''));
    else if (a && typeof a === 'object' && 'uri' in a) {
      parts.push((a as { uri: string }).uri.replace(/^file:\/\//, '').replace(/\/$/, ''));
    }
  }
  return 'file://' + parts.join('/');
}

class MockFile {
  uri: string;
  constructor(...args: unknown[]) {
    this.uri = uriOf(args);
  }
  get exists(): boolean {
    return storage.files.has(this.uri);
  }
  get size(): number {
    const entry = storage.files.get(this.uri);
    return entry ? entrySize(entry) : 0;
  }
  get name(): string {
    return this.uri.slice(this.uri.lastIndexOf('/') + 1);
  }
  textSync(): string {
    return storage.files.get(this.uri)?.text ?? '';
  }
  writeSync(data: string): void {
    storage.files.set(this.uri, { text: data, size: data.length });
  }
  delete(): void {
    storage.files.delete(this.uri);
  }
  rename(newName: string): void {
    const target = this.uri.slice(0, this.uri.lastIndexOf('/') + 1) + newName;
    const entry = storage.files.get(this.uri);
    if (!entry) throw new Error('rename: source does not exist');
    if (storage.files.has(target)) throw new Error('rename: destination already exists');
    storage.files.set(target, entry);
    storage.files.delete(this.uri);
    this.uri = target;
  }
}

class MockDirectory {
  uri: string;
  constructor(...args: unknown[]) {
    this.uri = uriOf(args);
  }
  get exists(): boolean {
    return storage.dirs.has(this.uri);
  }
  get name(): string {
    return this.uri.slice(this.uri.lastIndexOf('/') + 1);
  }
  create(): void {
    storage.dirs.add(this.uri);
  }
  delete(): void {
    storage.dirs.delete(this.uri);
    for (const key of [...storage.files.keys()]) {
      if (key.startsWith(`${this.uri}/`)) storage.files.delete(key);
    }
  }
  list(): MockFile[] {
    return [...storage.files.keys()]
      .filter((key) => key.startsWith(`${this.uri}/`))
      .filter((key) => !key.slice(this.uri.length + 1).includes('/'))
      .map((key) => new MockFile(key));
  }
}

export const fileSystemModule = {
  __esModule: true,
  File: MockFile,
  Directory: MockDirectory,
  Paths: { document: '/mock/document', cache: '/mock/cache', availableDiskSpace: 1e12 },
  readAsStringAsync: jest.fn(),
  writeAsStringAsync: jest.fn(),
  documentDirectory: '/mock/document/',
  cacheDirectory: '/mock/cache/',
};

/** The stored database at a pack-directory-relative path, e.g. `u_x/base-1.mbtiles`. */
export function dbAt(relative: string): FakeMbtiles | undefined {
  return storage.files.get(`file:///mock/document/tiles/${relative}`)?.db;
}

/** Names in a pack directory. */
export function packDirNames(trailId: string): string[] {
  const prefix = `file:///mock/document/tiles/${trailId}/`;
  return [...storage.files.keys()]
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length))
    .sort();
}

const IN_LIST = /WHERE name IN \(([^)]*)\)/;

function openFakeDatabase(fileName: string, _options: unknown, dirPath: string) {
  const uri = `file://${dirPath}/${fileName}`;
  let entry = storage.files.get(uri);
  if (!entry) {
    entry = { size: 0 };
    storage.files.set(uri, entry);
  }
  if (!entry.db) entry.db = { metadata: new Map(), tiles: new Map() };
  storage.open.set(uri, (storage.open.get(uri) ?? 0) + 1);
  const db = (): FakeMbtiles => {
    const current = storage.files.get(uri)?.db;
    if (!current) throw new Error(`database ${uri} is gone`);
    return current;
  };

  return {
    execAsync: jest.fn(async () => undefined),
    runAsync: jest.fn(async (sql: string, params: unknown[]) => {
      if (/INTO metadata/.test(sql)) {
        db().metadata.set(String(params[0]), String(params[1]));
      } else if (/INTO tiles/.test(sql)) {
        const [z, x, row, data] = params as [number, number, number, Uint8Array];
        db().tiles.set(`${z}/${x}/${row}`, { z, x, row, data });
      } else {
        throw new Error(`fake sqlite: unexpected run ${sql}`);
      }
      return { changes: 1, lastInsertRowId: 0 };
    }),
    getAllAsync: jest.fn(async (sql: string) => {
      if (/FROM metadata/.test(sql)) {
        const names = IN_LIST.exec(sql)?.[1]
          .split(',')
          .map((n) => n.trim().replace(/'/g, ''));
        return [...db().metadata]
          .filter(([name]) => !names || names.includes(name))
          .map(([name, value]) => ({ name, value }));
      }
      if (/FROM tiles/.test(sql)) {
        return [...db().tiles.values()].map((t) => ({
          zoom_level: t.z,
          tile_column: t.x,
          tile_row: t.row,
        }));
      }
      throw new Error(`fake sqlite: unexpected query ${sql}`);
    }),
    getFirstAsync: jest.fn(async (sql: string) => {
      const tiles = [...db().tiles.values()];
      if (/COUNT\(\*\)/.test(sql)) {
        if (tiles.length === 0) return { count: 0, minZoom: null, maxZoom: null };
        return {
          count: tiles.length,
          minZoom: Math.min(...tiles.map((t) => t.z)),
          maxZoom: Math.max(...tiles.map((t) => t.z)),
        };
      }
      if (/FROM tiles LIMIT 1/.test(sql)) return tiles[0] ? { zoom_level: tiles[0].z } : null;
      throw new Error(`fake sqlite: unexpected query ${sql}`);
    }),
    withTransactionAsync: jest.fn(async (fn: () => Promise<void>) => fn()),
    closeAsync: jest.fn(async () => {
      const n = (storage.open.get(uri) ?? 1) - 1;
      if (n <= 0) storage.open.delete(uri);
      else storage.open.set(uri, n);
    }),
  };
}

export const sqliteModule = {
  openDatabaseAsync: jest.fn(async (fileName: string, options: unknown, dirPath: string) =>
    openFakeDatabase(fileName, options, dirPath),
  ),
  openDatabaseSync: jest.fn(),
};
