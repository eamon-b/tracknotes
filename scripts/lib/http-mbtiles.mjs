/**
 * Read the tiles of one zoom level out of an mbtiles file on a web server,
 * with HTTP Range requests and no download of the rest.
 *
 * An offline pack's contours.mbtiles runs to hundreds of MB (the CDT's is
 * over half a GB), and `check:tile-packs` runs weekly in CI with a ten-minute
 * budget, so checking a pack's z9 by downloading it is out. Its z9 tiles are
 * a handful of rows, reached through the zoom index in a few page reads.
 *
 * This is a read-only walker of the SQLite file format
 * (https://www.sqlite.org/fileformat2.html), just enough for mbtiles: the
 * schema table, table b-trees by rowid, index b-trees by key prefix, records,
 * and overflow pages. It reads both mbtiles layouts:
 *   - `tiles` as a table with an index on (zoom_level, tile_column, tile_row);
 *   - tippecanoe's de-duplicated layout, where `tiles` is a view over
 *     `map` (zoom_level, tile_column, tile_row, tile_id) and
 *     `images` (tile_data, tile_id), each indexed.
 *
 * Plain JavaScript and Node built-ins only: scripts/e2e-tile-check.mjs runs in
 * CI without `npm ci`.
 */

import { TextDecoder, TextEncoder } from 'node:util';

/**
 * @typedef {(start: number, end: number) => Promise<Uint8Array>} RangeReader
 *   Bytes [start, end] inclusive of the file.
 */

/** 429s retried before giving up: the data domain rate-limits bursts. */
const RATE_LIMIT_RETRIES = 6;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * A RangeReader over HTTP. Throws on anything but a 206 of the right length,
 * after waiting out a 429 (Retry-After, else 5 s doubling) a few times: a
 * pack read is hundreds of small requests, enough to trip the zone's
 * rate limit when several packs are read at once.
 */
export function httpRangeReader(url, fetchFn = fetch, sleep = delay) {
  return async (start, end) => {
    let res;
    for (let attempt = 0; ; attempt++) {
      res = await fetchFn(url, { headers: { Range: `bytes=${start}-${end}` } });
      if (res.status !== 429 || attempt === RATE_LIMIT_RETRIES) break;
      const retryAfter = Number(res.headers?.get?.('retry-after'));
      await sleep(retryAfter > 0 ? retryAfter * 1000 : 5000 * 2 ** attempt);
    }
    if (res.status !== 206) {
      throw new Error(`range request for ${url} → HTTP ${res.status} (expected 206)`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length !== end - start + 1) {
      throw new Error(`range request for ${url} returned ${bytes.length} bytes, expected ${end - start + 1}`);
    }
    return bytes;
  };
}

const TEXT = new TextDecoder();

/** SQLite varint at `pos`: [value, next position]. Numbers stay exact to 2^53. */
function readVarint(buf, pos) {
  let value = 0;
  for (let i = 0; i < 8; i++) {
    const byte = buf[pos + i];
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return [value, pos + i + 1];
  }
  return [value * 256 + buf[pos + 8], pos + 9];
}

function readUint(buf, pos, bytes) {
  let value = 0;
  for (let i = 0; i < bytes; i++) value = value * 256 + buf[pos + i];
  return value;
}

/** Signed big-endian integer of 1–8 bytes (serial types 1–6). */
function readInt(buf, pos, bytes) {
  let value = readUint(buf, pos, bytes);
  const limit = 2 ** (8 * bytes - 1);
  if (value >= limit) value -= 2 * limit;
  return value;
}

/** Parse a record: an array of null | number | string | Uint8Array. */
export function parseRecord(payload) {
  const [headerSize, first] = readVarint(payload, 0);
  const types = [];
  let pos = first;
  while (pos < headerSize) {
    let type;
    [type, pos] = readVarint(payload, pos);
    types.push(type);
  }
  const values = [];
  let body = headerSize;
  for (const type of types) {
    if (type === 0) values.push(null);
    else if (type >= 1 && type <= 6) {
      const bytes = [0, 1, 2, 3, 4, 6, 8][type];
      values.push(readInt(payload, body, bytes));
      body += bytes;
    } else if (type === 7) {
      values.push(new DataView(payload.buffer, payload.byteOffset + body, 8).getFloat64(0));
      body += 8;
    } else if (type === 8 || type === 9) values.push(type - 8);
    else if (type >= 12) {
      const length = Math.floor((type - 12) / 2);
      const bytes = payload.subarray(body, body + length);
      values.push(type % 2 === 0 ? bytes : TEXT.decode(bytes));
      body += length;
    } else {
      throw new Error(`unsupported record serial type ${type}`);
    }
  }
  return values;
}

/** SQLite's ordering across storage classes: NULL < numbers < text < blob. */
function compareValues(a, b) {
  const rank = v => (v === null ? 0 : typeof v === 'number' ? 1 : typeof v === 'string' ? 2 : 3);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return 0;
  if (ra === 1) return a - b;
  // BINARY collation compares UTF-8 bytes, which for text is code point order.
  const ba = ra === 2 ? new TextEncoder().encode(a) : a;
  const bb = rb === 2 ? new TextEncoder().encode(b) : b;
  for (let i = 0; i < Math.min(ba.length, bb.length); i++) {
    if (ba[i] !== bb[i]) return ba[i] - bb[i];
  }
  return ba.length - bb.length;
}

/** Compare an index key against a prefix (the prefix's columns only). */
function comparePrefix(key, prefix) {
  for (let i = 0; i < prefix.length; i++) {
    const c = compareValues(key[i], prefix[i]);
    if (c !== 0) return c;
  }
  return 0;
}

export class RemoteSqlite {
  /** @param {RangeReader} read */
  constructor(read) {
    this.read = read;
    this.pages = new Map();
  }

  async open() {
    const header = await this.read(0, 99);
    if (TEXT.decode(header.subarray(0, 16)) !== 'SQLite format 3\0') {
      throw new Error('not an SQLite database');
    }
    const size = readUint(header, 16, 2);
    this.pageSize = size === 1 ? 65536 : size;
    this.usable = this.pageSize - header[20];
    if (readUint(header, 56, 4) > 1) throw new Error('only UTF-8 databases are supported');
    // The file's length in pages, which read-ahead must not run past. The
    // header field is valid only when its version-valid-for number matches
    // the change counter (SQLite 3.7.0+ writers); without it, no read-ahead.
    this.pageCount = readUint(header, 92, 4) === readUint(header, 24, 4) ? readUint(header, 28, 4) : 0;
    this.schema = [];
    for await (const { payload } of this.scanTable(1)) {
      const [type, name, tblName, rootPage, sql] = parseRecord(payload);
      this.schema.push({ type, name, tblName, rootPage, sql: sql ?? '' });
    }
    return this;
  }

  async page(number) {
    let pending = this.pages.get(number);
    if (!pending) {
      const start = (number - 1) * this.pageSize;
      pending = this.read(start, start + this.pageSize - 1);
      this.pages.set(number, pending);
    }
    return pending;
  }

  /**
   * Fetch `count` consecutive pages from `first` in one range request (the
   * ones not already cached), so an overflow chain — normally contiguous —
   * costs one round trip rather than one per page.
   */
  readAhead(first, count) {
    count = Math.min(count, this.pageCount - first + 1);
    let start = first;
    while (start < first + count && this.pages.has(start)) start++;
    let end = start;
    while (end < first + count && !this.pages.has(end)) end++;
    if (end === start) return;
    const block = this.read((start - 1) * this.pageSize, (end - 1) * this.pageSize - 1);
    for (let n = start; n < end; n++) {
      const offset = (n - start) * this.pageSize;
      const page = block.then(b => b.subarray(offset, offset + this.pageSize));
      // A page read ahead may never be asked for (the chain jumped): a failed
      // read must reject only whoever awaits it, not crash the process.
      page.catch(() => {});
      this.pages.set(n, page);
    }
  }

  /** The b-tree page `number`: its kind and its cells' offsets. */
  async btreePage(number) {
    const buf = await this.page(number);
    const at = number === 1 ? 100 : 0;
    const kind = buf[at];
    const interior = kind === 2 || kind === 5;
    if (![2, 5, 10, 13].includes(kind)) throw new Error(`page ${number} is not a b-tree page`);
    const count = readUint(buf, at + 3, 2);
    const cells = [];
    const pointers = at + (interior ? 12 : 8);
    for (let i = 0; i < count; i++) cells.push(readUint(buf, pointers + 2 * i, 2));
    return {
      buf,
      kind,
      cells,
      rightChild: interior ? readUint(buf, at + 8, 4) : 0,
    };
  }

  /** A cell's full payload, following its overflow chain. */
  async payload(buf, pos, size, isTable) {
    const u = this.usable;
    const maxLocal = isTable ? u - 35 : Math.floor(((u - 12) * 64) / 255) - 23;
    if (size <= maxLocal) return buf.subarray(pos, pos + size);
    const minLocal = Math.floor(((u - 12) * 32) / 255) - 23;
    const k = minLocal + ((size - minLocal) % (u - 4));
    const local = k <= maxLocal ? k : minLocal;
    const out = new Uint8Array(size);
    out.set(buf.subarray(pos, pos + local), 0);
    let written = local;
    let next = readUint(buf, pos + local, 4);
    while (written < size) {
      if (next === 0) throw new Error('overflow chain ends early');
      // Overflow pages are usually consecutive: read the rest of the chain as
      // one range from here. A chain that jumps elsewhere just reads again.
      this.readAhead(next, Math.ceil((size - written) / (u - 4)));
      const page = await this.page(next);
      const take = Math.min(u - 4, size - written);
      out.set(page.subarray(4, 4 + take), written);
      written += take;
      next = readUint(page, 0, 4);
    }
    return out;
  }

  /** Every row of a table b-tree, in rowid order. */
  async *scanTable(root) {
    const page = await this.btreePage(root);
    if (page.kind === 5) {
      for (const cell of page.cells) yield* this.scanTable(readUint(page.buf, cell, 4));
      yield* this.scanTable(page.rightChild);
      return;
    }
    if (page.kind !== 13) throw new Error(`page ${root} is not a table b-tree page`);
    for (const cell of page.cells) {
      const [size, p1] = readVarint(page.buf, cell);
      const [rowid, p2] = readVarint(page.buf, p1);
      yield { rowid, payload: await this.payload(page.buf, p2, size, true) };
    }
  }

  /** The row `rowid` of a table b-tree, or null. */
  async findRow(root, rowid) {
    let number = root;
    for (;;) {
      const page = await this.btreePage(number);
      if (page.kind === 5) {
        let child = page.rightChild;
        for (const cell of page.cells) {
          const [key] = readVarint(page.buf, cell + 4);
          if (rowid <= key) {
            child = readUint(page.buf, cell, 4);
            break;
          }
        }
        number = child;
        continue;
      }
      if (page.kind !== 13) throw new Error(`page ${number} is not a table b-tree page`);
      for (const cell of page.cells) {
        const [size, p1] = readVarint(page.buf, cell);
        const [id, p2] = readVarint(page.buf, p1);
        if (id === rowid) return parseRecord(await this.payload(page.buf, p2, size, true));
      }
      return null;
    }
  }

  /** An index cell's key (its record; the last column is the rowid). */
  async indexKey(page, cell) {
    const pos = page.kind === 2 ? cell + 4 : cell;
    const [size, p1] = readVarint(page.buf, pos);
    return parseRecord(await this.payload(page.buf, p1, size, false));
  }

  /** Every key of an index b-tree that begins with `prefix`, in order. */
  async *scanIndex(root, prefix) {
    const page = await this.btreePage(root);
    if (page.kind === 2) {
      let previous = null;
      for (const cell of page.cells) {
        const key = await this.indexKey(page, cell);
        // The left child holds the keys between the previous cell's and this one's.
        if ((previous === null || comparePrefix(previous, prefix) <= 0) && comparePrefix(key, prefix) >= 0) {
          yield* this.scanIndex(readUint(page.buf, cell, 4), prefix);
        }
        if (comparePrefix(key, prefix) === 0) yield key;
        if (comparePrefix(key, prefix) > 0) return;
        previous = key;
      }
      if (previous === null || comparePrefix(previous, prefix) <= 0) {
        yield* this.scanIndex(page.rightChild, prefix);
      }
      return;
    }
    if (page.kind !== 10) throw new Error(`page ${root} is not an index b-tree page`);
    for (const cell of page.cells) {
      const key = await this.indexKey(page, cell);
      const c = comparePrefix(key, prefix);
      if (c === 0) yield key;
      else if (c > 0) return;
    }
  }

  table(name) {
    const entry = this.schema.find(e => e.type === 'table' && e.name === name);
    return entry ? { ...entry, columns: tableColumns(entry.sql) } : null;
  }

  /** An index on `table` whose leading columns are `columns`, or null. */
  index(table, columns) {
    return (
      this.schema.find(e => {
        if (e.type !== 'index' || e.tblName !== table) return false;
        const indexed = indexColumns(e.sql);
        return columns.every((c, i) => indexed[i] === c);
      }) ?? null
    );
  }
}

/** Column names of a `CREATE TABLE name (a type, b type, ...)` statement. */
export function tableColumns(sql) {
  const body = sql.slice(sql.indexOf('(') + 1, sql.lastIndexOf(')'));
  const columns = [];
  let depth = 0;
  let item = '';
  for (const ch of body + ',') {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      const name = item
        .trim()
        .split(/\s+/)[0]
        ?.replace(/^["`[]|["`\]]$/g, '');
      if (name && !/^(primary|unique|check|foreign|constraint)$/i.test(name)) {
        columns.push({ name: name.toLowerCase(), rowidAlias: /integer\s+primary\s+key/i.test(item) });
      }
      item = '';
    } else {
      item += ch;
    }
  }
  return columns;
}

/** Column names of a `CREATE [UNIQUE] INDEX name ON table (a, b, ...)` statement. */
export function indexColumns(sql) {
  const m = sql.match(/\(([^)]*)\)\s*$/);
  if (!m) return [];
  return m[1].split(',').map(c =>
    c
      .trim()
      .split(/\s+/)[0]
      .replace(/^["`[]|["`\]]$/g, '')
      .toLowerCase()
  );
}

function column(row, table, name, rowid) {
  const i = table.columns.findIndex(c => c.name === name);
  if (i < 0) throw new Error(`table ${table.name} has no column ${name}`);
  return table.columns[i].rowidAlias ? rowid : row[i];
}

const ZOOM_INDEX = ['zoom_level', 'tile_column', 'tile_row'];

/**
 * Every tile of one zoom level: `{ x, y (TMS row), data }`, where `data` is
 * the tile blob as stored (tippecanoe gzips it).
 */
export async function readZoomTiles(read, zoom) {
  const db = await new RemoteSqlite(read).open();
  const tiles = [];

  const plain = db.table('tiles');
  if (plain) {
    const index = db.index('tiles', ZOOM_INDEX);
    if (!index) throw new Error('the tiles table has no (zoom_level, tile_column, tile_row) index');
    for await (const key of db.scanIndex(index.rootPage, [zoom])) {
      const rowid = key[key.length - 1];
      const row = await db.findRow(plain.rootPage, rowid);
      if (!row) throw new Error(`tiles row ${rowid} named by the index is missing`);
      tiles.push({ x: key[1], y: key[2], data: column(row, plain, 'tile_data', rowid) });
    }
    return tiles;
  }

  const map = db.table('map');
  const images = db.table('images');
  if (!map || !images) throw new Error('neither a tiles table nor map/images tables');
  const mapIndex = db.index('map', ZOOM_INDEX);
  // tippecanoe keys images by tile_id; tile-join (2.79.0, so every tiered
  // pack) by (zoom_level, tile_id), deduplicating within a zoom only.
  const imagesById = db.index('images', ['tile_id']);
  const imagesIndex = imagesById ?? db.index('images', ['zoom_level', 'tile_id']);
  if (!mapIndex || !imagesIndex) throw new Error('map/images are missing their indexes');
  for await (const key of db.scanIndex(mapIndex.rootPage, [zoom])) {
    const mapRowid = key[key.length - 1];
    const mapRow = await db.findRow(map.rootPage, mapRowid);
    if (!mapRow) throw new Error(`map row ${mapRowid} named by the index is missing`);
    const tileId = column(mapRow, map, 'tile_id', mapRowid);
    let data = null;
    const imageKeyPrefix = imagesById ? [tileId] : [zoom, tileId];
    for await (const imageKey of db.scanIndex(imagesIndex.rootPage, imageKeyPrefix)) {
      const imageRowid = imageKey[imageKey.length - 1];
      const imageRow = await db.findRow(images.rootPage, imageRowid);
      if (imageRow) data = column(imageRow, images, 'tile_data', imageRowid);
      break;
    }
    if (data === null) throw new Error(`no image for tile ${zoom}/${key[1]}/${key[2]}`);
    tiles.push({ x: key[1], y: key[2], data });
  }
  return tiles;
}
