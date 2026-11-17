/**
 * Byte-preserving edits to a bundled trail's waypoint sources, for the local
 * waypoint editor (`src/web/admin-waypoints.html`, served only by `npm run dev`).
 *
 * Every function here is pure text in, text out, so the editor's writes can be
 * tested without a file system. The rule they share: **a save changes only the
 * bytes it means to.** The GPX is edited in place (one `<wpt>` start tag, one
 * `<name>` or one `<ele>`), never re-serialised; a JSON file is re-serialised only after
 * checking that its layout can be reproduced exactly, so an unrelated
 * reformatting (or an unescaped `–`) never rides along with an edit and
 * buries it in the diff.
 */

import { classifyWaypoint, FOLDER_TYPE_MAP } from '../../../src/lib/waypoint-classifier';
import { haversineDistance } from '../../../src/lib/distance';

// ---------------------------------------------------------------------------
// XML text
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** The text of an element's content: CDATA unwrapped, entities decoded. */
export function decodeXmlText(raw: string): string {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
  if (cdata) return cdata[1];
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, ref: string) => {
    if (ref.startsWith('#x')) return String.fromCodePoint(parseInt(ref.slice(2), 16));
    if (ref.startsWith('#')) return String.fromCodePoint(parseInt(ref.slice(1), 10));
    return NAMED_ENTITIES[ref] ?? whole;
  });
}

/**
 * Escape `text` for element content, in the file's own style: apostrophes and
 * quotes become entities only when the file already writes them that way (the
 * CDT and Te Araroa files do; CalTopo exports do not).
 */
export function encodeXmlText(text: string, fileText: string): string {
  let out = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (fileText.includes('&apos;')) out = out.replace(/'/g, '&apos;');
  if (fileText.includes('&quot;')) out = out.replace(/"/g, '&quot;');
  return out;
}

// ---------------------------------------------------------------------------
// GPX waypoints
// ---------------------------------------------------------------------------

/** One `<wpt>` element as it sits in the file. */
export interface GpxWaypointSpan {
  /** Offset of `<wpt` in the file. */
  start: number;
  /** Offset just past `</wpt>` (or past `/>` for an empty element). */
  end: number;
  lat: number;
  lon: number;
  /** Decoded `<name>`, '' when there is none. */
  name: string;
  /** Decoded `<desc>`, when present. */
  desc?: string;
  /** Decoded `<type>`, when present. */
  type?: string;
  /** Its `<ele>` as written (`745.0`), when present: metres, and the decimals the file keeps. */
  ele?: string;
}

const WPT_PATTERN = /<wpt\b([^>]*?)(\/>|>([\s\S]*?)<\/wpt>)/g;

function attribute(attrs: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(attrs);
  return m ? (m[2] ?? m[3]) : null;
}

function childText(body: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(body);
  return m ? decodeXmlText(m[1]) : undefined;
}

/**
 * `xml` with every `<link>` and `<extensions>` block blanked to spaces (same
 * length, so offsets still hold): a `<link>` carries a `<type>` of its own (a
 * MIME type), and the GPX parser reads only the `<wpt>`'s direct child.
 */
function maskNested(xml: string): string {
  return xml.replace(/<(link|extensions)\b[^>]*?(?:\/>|>[\s\S]*?<\/\1>)/g, m => ' '.repeat(m.length));
}

/** Every `<wpt>` in a GPX file, in file order. */
export function listGpxWaypoints(gpx: string): GpxWaypointSpan[] {
  const spans: GpxWaypointSpan[] = [];
  for (const m of gpx.matchAll(WPT_PATTERN)) {
    const lat = Number(attribute(m[1], 'lat'));
    const lon = Number(attribute(m[1], 'lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const body = m[3] ?? '';
    const span: GpxWaypointSpan = {
      start: m.index,
      end: m.index + m[0].length,
      lat,
      lon,
      name: (childText(body, 'name') ?? '').trim(),
    };
    const desc = childText(body, 'desc');
    if (desc !== undefined) span.desc = desc;
    const masked = maskNested(body);
    const type = childText(masked, 'type');
    if (type !== undefined) span.type = type.trim();
    const ele = childText(masked, 'ele');
    if (ele !== undefined) span.ele = ele.trim();
    spans.push(span);
  }
  return spans;
}

/** The name the build shows for a raw source name (prefixes like `C ` / `WT: ` removed). */
export function cleanedWaypointName(rawName: string): string {
  return classifyWaypoint(rawName).cleanedName;
}

/** How a source name relates to the name the build shows. */
function nameScore(raw: string, built: string): number {
  if (raw === built) return 3;
  if (cleanedWaypointName(raw) === built) return 2;
  if (raw.endsWith(built)) return 1;
  return 0;
}

/**
 * The `<wpt>` a built waypoint came from: the build copies a waypoint's
 * coordinates from its `<wpt>` unchanged, so the match is on the exact
 * coordinates, with the name to choose between waypoints that share them (the
 * CDT's towns hitched from one pass). Null when nothing, or more than one
 * equally good candidate, matches.
 */
export function findGpxWaypoint(
  spans: readonly GpxWaypointSpan[],
  target: { lat: number; lon: number; name: string }
): GpxWaypointSpan | null {
  const here = spans.filter(s => s.lat === target.lat && s.lon === target.lon);
  if (here.length === 0) return null;
  if (here.length === 1) return here[0];
  const best = Math.max(...here.map(s => nameScore(s.name, target.name)));
  const winners = here.filter(s => nameScore(s.name, target.name) === best);
  return best > 0 && winners.length === 1 ? winners[0] : null;
}

/** Coordinates as the editor writes them: six decimals is about 0.1 m. */
export function formatCoordinate(value: number): string {
  return Number(value.toFixed(6)).toString();
}

/** The GPX with one waypoint's `lat`/`lon` attributes replaced; nothing else changes. */
export function setGpxWaypointPosition(gpx: string, span: GpxWaypointSpan, lat: number, lon: number): string {
  const element = gpx.slice(span.start, span.end);
  const tagEnd = element.indexOf('>');
  const startTag = element.slice(0, tagEnd);
  const replaced = startTag
    .replace(/(\blat\s*=\s*)("[^"]*"|'[^']*')/, (_m, lead: string) => `${lead}"${formatCoordinate(lat)}"`)
    .replace(/(\blon\s*=\s*)("[^"]*"|'[^']*')/, (_m, lead: string) => `${lead}"${formatCoordinate(lon)}"`);
  return gpx.slice(0, span.start) + replaced + element.slice(tagEnd) + gpx.slice(span.end);
}

/** How many decimals a plain decimal number is written with (`745.0` has 1); null for anything else. */
export function elevationDecimals(text: string): number | null {
  const m = /^-?\d+(?:\.(\d+))?$/.exec(text.trim());
  return m ? (m[1]?.length ?? 0) : null;
}

/** `metres` as an `<ele>`'s text with `decimals` decimals, trailing zeros kept as the files keep them (`745.0`). */
export function formatElevation(metres: number, decimals: number): string {
  const text = metres.toFixed(decimals);
  return Number(text) === 0 ? text.replace(/^-/, '') : text;
}

/**
 * How a file's `<wpt>`s write their `<ele>`, or null when they do not carry
 * one. The rule: at least half of the file's `<wpt>`s have an `<ele>` (the
 * bundled files are all or nothing; half keeps one hand-added `<wpt>` either
 * way from flipping the answer). `decimals` is the count most of them use, the
 * finer one on a tie.
 */
export function gpxWaypointElevationStyle(spans: readonly GpxWaypointSpan[]): { decimals: number } | null {
  const withEle = spans.filter(s => s.ele !== undefined);
  if (withEle.length === 0 || withEle.length * 2 < spans.length) return null;
  const counts = new Map<number, number>();
  for (const span of withEle) {
    const decimals = elevationDecimals(span.ele!);
    if (decimals !== null) counts.set(decimals, (counts.get(decimals) ?? 0) + 1);
  }
  let best = { decimals: 1, count: 0 };
  for (const [decimals, count] of counts) {
    if (count > best.count || (count === best.count && decimals > best.decimals)) best = { decimals, count };
  }
  return { decimals: best.decimals };
}

/**
 * The GPX with the text of one waypoint's `<ele>` replaced; nothing else
 * changes, the spacing inside the element included. A `<wpt>` with no `<ele>`
 * comes back as it was: this never adds one.
 */
export function setGpxWaypointElevation(gpx: string, span: GpxWaypointSpan, text: string): string {
  const element = gpx.slice(span.start, span.end);
  const m = /(<ele\b[^>]*>)(\s*)([^<]*?)\s*<\/ele>/.exec(maskNested(element));
  if (!m) return gpx;
  const at = span.start + m.index + m[1].length + m[2].length;
  return gpx.slice(0, at) + text + gpx.slice(at + m[3].length);
}

/**
 * `raw` renamed so the build shows `newName`, keeping whatever prefix it had
 * (`C Old Hut` → `C New Hut`): the GPX and the CalTopo export carry the type
 * prefix in the name, and a renamed waypoint keeps it in both files.
 */
export function renameKeepingPrefix(raw: string, oldName: string, newName: string): string {
  if (oldName && raw.endsWith(oldName)) return raw.slice(0, raw.length - oldName.length) + newName;
  const prefix = raw.slice(0, raw.length - cleanedWaypointName(raw).length);
  return prefix + newName;
}

/** The GPX with one waypoint's `<name>` replaced (or added, if it had none). */
export function setGpxWaypointName(gpx: string, span: GpxWaypointSpan, rawName: string): string {
  const element = gpx.slice(span.start, span.end);
  const encoded = encodeXmlText(rawName, gpx);
  let next: string;
  if (/<name\b[^>]*>[\s\S]*?<\/name>/.test(element)) {
    next = element.replace(/(<name\b[^>]*>)[\s\S]*?(<\/name>)/, (_m, open: string, close: string) => {
      return `${open}${encoded}${close}`;
    });
  } else if (element.endsWith('/>')) {
    next = `${element.slice(0, -2).trimEnd()}><name>${encoded}</name></wpt>`;
  } else {
    const tagEnd = element.indexOf('>') + 1;
    next = `${element.slice(0, tagEnd)}<name>${encoded}</name>${element.slice(tagEnd)}`;
  }
  return gpx.slice(0, span.start) + next + gpx.slice(span.end);
}

/**
 * `element` (one `<wpt>…</wpt>`) with `child` added as its last child (before
 * any `<extensions>`), spaced like the children it already has: on the same
 * line in a one-line `<wpt>`, on a line of its own in a multi-line one.
 */
function appendWptChild(element: string, child: string): string {
  if (element.endsWith('/>')) return `${element.slice(0, -2).trimEnd()}>${child}</wpt>`;
  const tagEnd = element.indexOf('>') + 1;
  const closeAt = element.lastIndexOf('</wpt>');
  const inner = element.slice(tagEnd, closeAt);
  if (!inner.trim()) return element.slice(0, tagEnd) + child + element.slice(tagEnd);
  const lead = /^\s*/.exec(inner)![0];
  const extensions = element.indexOf('<extensions', tagEnd);
  if (extensions !== -1) return element.slice(0, extensions) + child + lead + element.slice(extensions);
  const at = closeAt - /\s*$/.exec(inner)![0].length;
  return element.slice(0, at) + lead + child + element.slice(at);
}

/** The GPX with one waypoint's `<type>` replaced, or added when it has none. */
export function setGpxWaypointType(gpx: string, span: GpxWaypointSpan, type: string): string {
  const element = gpx.slice(span.start, span.end);
  const encoded = encodeXmlText(type, gpx);
  const m = /(<type\b[^>]*>)([\s\S]*?)<\/type>/.exec(maskNested(element));
  let next: string;
  if (m) {
    const at = m.index + m[1].length;
    next = element.slice(0, at) + encoded + element.slice(at + m[2].length);
  } else {
    next = appendWptChild(element, `<type>${encoded}</type>`);
  }
  return gpx.slice(0, span.start) + next + gpx.slice(span.end);
}

/** Start offset of the whitespace run that ends at `offset`. */
function whitespaceStart(text: string, offset: number): number {
  let at = offset;
  while (at > 0 && /\s/.test(text[at - 1])) at--;
  return at;
}

/**
 * The GPX with one waypoint's `<desc>` replaced, added, or (for '') removed.
 * A new `<desc>` goes after the `<name>` (after a `<cmt>`, when it has one:
 * the GPX schema's order), spaced like the `<name>` is; a removed one takes the
 * spacing before it along, so adding then removing gives the file back.
 */
export function setGpxWaypointDesc(gpx: string, span: GpxWaypointSpan, desc: string): string {
  const element = gpx.slice(span.start, span.end);
  const masked = maskNested(element);
  const existing = /(<desc\b[^>]*>)([\s\S]*?)<\/desc>/.exec(masked);
  let next: string;
  if (existing && !desc) {
    next =
      element.slice(0, whitespaceStart(element, existing.index)) + element.slice(existing.index + existing[0].length);
  } else if (existing) {
    const at = existing.index + existing[1].length;
    next = element.slice(0, at) + encodeXmlText(desc, gpx) + element.slice(at + existing[2].length);
  } else if (!desc) {
    return gpx;
  } else {
    const child = `<desc>${encodeXmlText(desc, gpx)}</desc>`;
    const name = /<name\b[^>]*>[\s\S]*?<\/name>/.exec(masked);
    if (!name) {
      next = appendWptChild(element, child);
    } else {
      const cmt = /<cmt\b[^>]*>[\s\S]*?<\/cmt>/.exec(masked);
      const anchor = cmt && cmt.index > name.index ? cmt : name;
      const at = anchor.index + anchor[0].length;
      const lead = element.slice(whitespaceStart(element, name.index), name.index);
      next = element.slice(0, at) + lead + child + element.slice(at);
    }
  }
  return gpx.slice(0, span.start) + next + gpx.slice(span.end);
}

/** A new waypoint as the editor writes it. */
export interface NewGpxWaypoint {
  lat: number;
  lon: number;
  /** Written as is: the caller makes sure no type prefix rides in it. */
  name: string;
  type: string;
  desc?: string;
  /** The text of its `<ele>` (`formatElevation`); none is written without it. */
  ele?: string;
}

/**
 * The GPX with a new `<wpt>` after the last one, written in the file's own
 * style: the same spacing before it as before the last `<wpt>`, its children
 * on one line or one per line as the last `<wpt>` has them, and `<ele>`,
 * `<name>`, `<desc>` and `<type>` in the order the last `<wpt>` uses (an
 * `<ele>` the last one lacks goes first, where GPX 1.1 puts it). A file with
 * no `<wpt>` gets it before its first `<trk>` / `<rte>` (or `</gpx>`).
 */
export function insertGpxWaypoint(gpx: string, waypoint: NewGpxWaypoint): string {
  const spans = listGpxWaypoints(gpx);
  const last = spans[spans.length - 1];
  const template = last ? gpx.slice(last.start, last.end) : '';
  const masked = maskNested(template);
  const children: Record<string, string | undefined> = {
    ele: waypoint.ele !== undefined ? `<ele>${encodeXmlText(waypoint.ele, gpx)}</ele>` : undefined,
    name: `<name>${encodeXmlText(waypoint.name, gpx)}</name>`,
    desc: waypoint.desc ? `<desc>${encodeXmlText(waypoint.desc, gpx)}</desc>` : undefined,
    type: `<type>${encodeXmlText(waypoint.type, gpx)}</type>`,
  };
  // The order of the tags the last <wpt> has; a tag it lacks goes after its usual predecessor.
  const defaults = ['ele', 'name', 'desc', 'type'];
  const at = (tag: string) => masked.search(new RegExp(`<${tag}\\b`));
  const order = defaults.filter(tag => at(tag) !== -1).sort((a, b) => at(a) - at(b));
  defaults.forEach((tag, i) => {
    if (order.includes(tag)) return;
    const previous = defaults
      .slice(0, i)
      .reverse()
      .find(p => order.includes(p));
    order.splice(previous ? order.indexOf(previous) + 1 : 0, 0, tag);
  });
  const parts = order.map(tag => children[tag]).filter((c): c is string => !!c);
  const open = `<wpt lat="${formatCoordinate(waypoint.lat)}" lon="${formatCoordinate(waypoint.lon)}">`;
  let element: string;
  const multiLine = /\n/.test(template);
  if (multiLine) {
    const childIndent = /\n([ \t]*)</.exec(template)?.[1] ?? '  ';
    const closeIndent = /\n([ \t]*)<\/wpt>$/.exec(template)?.[1] ?? '';
    element = `${open}${parts.map(p => `\n${childIndent}${p}`).join('')}\n${closeIndent}</wpt>`;
  } else {
    element = `${open}${parts.join('')}</wpt>`;
  }
  if (last) {
    const lead = gpx.slice(whitespaceStart(gpx, last.start), last.start);
    return gpx.slice(0, last.end) + lead + element + gpx.slice(last.end);
  }
  const anchors = ['<trk', '<rte', '</gpx>'].map(tag => gpx.indexOf(tag)).filter(i => i !== -1);
  if (!anchors.length) throw new Error('Not a GPX file: no <trk>, <rte> or </gpx> to put a waypoint before');
  const anchor = Math.min(...anchors);
  const lead = gpx.slice(whitespaceStart(gpx, anchor), anchor);
  return gpx.slice(0, anchor) + element + lead + gpx.slice(anchor);
}

/** The GPX without one `<wpt>`, and without the spacing that led up to it. */
export function removeGpxWaypoint(gpx: string, span: GpxWaypointSpan): string {
  return gpx.slice(0, whitespaceStart(gpx, span.start)) + gpx.slice(span.end);
}

// ---------------------------------------------------------------------------
// JSON that must keep its layout
// ---------------------------------------------------------------------------

/** How a JSON file is laid out, as far as the editor can reproduce it. */
export interface JsonLayout {
  indent: number;
  trailingNewline: boolean;
  /** Non-ASCII written as `\uXXXX` (CalTopo exports do this). */
  asciiOnly: boolean;
}

function escapeNonAscii(json: string): string {
  return json.replace(/[\u007f-￿]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** `value` written in `layout`. */
export function stringifyJson(value: unknown, layout: JsonLayout): string {
  const text = JSON.stringify(value, null, layout.indent || undefined);
  return (layout.asciiOnly ? escapeNonAscii(text) : text) + (layout.trailingNewline ? '\n' : '');
}

/**
 * The layout that re-serialises `text` byte for byte, or null when none does
 * (a hand-aligned file, or one Prettier wrapped). The editor refuses to write
 * a file it cannot reproduce rather than reformat it.
 */
export function detectJsonLayout(text: string): JsonLayout | null {
  const value: unknown = JSON.parse(text);
  for (const indent of [0, 2, 4]) {
    for (const trailingNewline of [true, false]) {
      for (const asciiOnly of [false, true]) {
        const layout = { indent, trailingNewline, asciiOnly };
        if (stringifyJson(value, layout) === text) return layout;
      }
    }
  }
  return null;
}

/**
 * Apply `edit` to the parsed `text` and write it back in the same layout.
 * Throws when the layout cannot be reproduced, so nothing is reformatted.
 */
export function editJsonPreservingLayout<T>(text: string, source: string, edit: (value: T) => void): string {
  const layout = detectJsonLayout(text);
  if (!layout) {
    throw new Error(`${source}: its layout cannot be reproduced exactly, so the editor will not rewrite it`);
  }
  const value = JSON.parse(text) as T;
  edit(value);
  return stringifyJson(value, layout);
}

// ---------------------------------------------------------------------------
// CalTopo GeoJSON markers
// ---------------------------------------------------------------------------

interface CaltopoFeature {
  id?: string;
  geometry?: { type?: string; coordinates?: number[] } | null;
  properties?: { class?: string; title?: string; description?: string; folderId?: string };
}

interface CaltopoCollection {
  features?: CaltopoFeature[];
}

/** The marker the build typed a waypoint from, as found in the export. */
export interface CaltopoMarkerRef {
  /** Index into `features`. */
  index: number;
  title: string;
  lat: number;
  lon: number;
  description?: string;
}

/**
 * The CalTopo marker the build takes a waypoint's type (and source description)
 * from: of the markers whose cleaned title is the waypoint's name, the nearest
 * (`resolveTrailWaypoints` in `build-trails.ts`).
 */
export function findCaltopoMarker(
  geojsonText: string,
  target: { lat: number; lon: number; name: string }
): CaltopoMarkerInfo | null {
  const parsed = readCaltopoExport(geojsonText);
  return parsed ? nearestCaltopoMarker(parsed.markers, target) : null;
}

// ---------------------------------------------------------------------------
// Splicing one value into a JSON file
// ---------------------------------------------------------------------------

/** Offsets of one value in a JSON text: `text.slice(start, end)` is the value. */
export interface JsonSpan {
  start: number;
  end: number;
}

/**
 * Where the value at `jsonPath` (object keys and array indices) sits in
 * `text`, or null when there is none. A small scanner rather than a parse:
 * editing a value in place leaves every other byte alone, whatever escaping
 * or spacing the file uses (Heysen's CalTopo export mixes `\u2013` with a raw
 * en dash, which no serialiser reproduces).
 */
export function jsonValueSpan(text: string, jsonPath: readonly (string | number)[]): JsonSpan | null {
  let pos = 0;
  const ws = () => {
    while (pos < text.length && /\s/.test(text[pos])) pos++;
  };
  const skipString = () => {
    pos++; // opening quote
    while (pos < text.length && text[pos] !== '"') pos += text[pos] === '\\' ? 2 : 1;
    pos++; // closing quote
  };
  // Skips one value starting at `pos`; returns its span.
  const skipValue = (): JsonSpan => {
    ws();
    const start = pos;
    const ch = text[pos];
    if (ch === '"') skipString();
    else if (ch === '{' || ch === '[') {
      let depth = 0;
      while (pos < text.length) {
        const c = text[pos];
        if (c === '"') {
          skipString();
          continue;
        }
        if (c === '{' || c === '[') depth++;
        else if (c === '}' || c === ']') depth--;
        pos++;
        if (depth === 0) break;
      }
    } else {
      while (pos < text.length && !/[\s,\]}]/.test(text[pos])) pos++;
    }
    return { start, end: pos };
  };
  const find = (depth: number): JsonSpan | null => {
    ws();
    if (depth === jsonPath.length) return skipValue();
    const want = jsonPath[depth];
    const open = text[pos];
    if (open === '{' && typeof want === 'string') {
      pos++;
      for (;;) {
        ws();
        if (text[pos] === '}') return null;
        const keyStart = pos;
        skipString();
        const key = JSON.parse(text.slice(keyStart, pos)) as string;
        ws();
        pos++; // colon
        if (key === want) return find(depth + 1);
        skipValue();
        ws();
        if (text[pos] === ',') pos++;
      }
    }
    if (open === '[' && typeof want === 'number') {
      pos++;
      for (let index = 0; ; index++) {
        ws();
        if (text[pos] === ']') return null;
        if (index === want) return find(depth + 1);
        skipValue();
        ws();
        if (text[pos] === ',') pos++;
      }
    }
    return null;
  };
  return find(0);
}

/** A JSON string literal for `value`, escaping non-ASCII when the file mostly does. */
function jsonStringLike(value: string, fileText: string): string {
  const escapes = (fileText.match(/\\u[0-9a-fA-F]{4}/g) ?? []).length;
  const raw = (fileText.match(/[\u0080-\uffff]/g) ?? []).length;
  const literal = JSON.stringify(value);
  return escapes > raw ? escapeNonAscii(literal) : literal;
}

/** The export with one marker moved and/or retitled; every other byte is left as it was. */
export function editCaltopoMarker(
  geojsonText: string,
  source: string,
  marker: CaltopoMarkerRef,
  edit: { lat?: number; lon?: number; title?: string }
): string {
  const collection = JSON.parse(geojsonText) as CaltopoCollection;
  if (collection.features?.[marker.index]?.properties?.title !== marker.title) {
    throw new Error(`${source}: marker "${marker.title}" is no longer where it was read`);
  }
  const splices: { span: JsonSpan; text: string }[] = [];
  if (edit.lat !== undefined && edit.lon !== undefined) {
    const span = jsonValueSpan(geojsonText, ['features', marker.index, 'geometry', 'coordinates']);
    if (!span) throw new Error(`${source}: marker "${marker.title}" has no coordinates`);
    // CalTopo writes [lon, lat, ele, time]: replace the first two numbers, keep the rest and the spacing.
    const parts = geojsonText.slice(span.start + 1, span.end - 1).split(',');
    const swap = (part: string, value: number) => part.replace(/[^\s]+/, formatCoordinate(value));
    parts[0] = swap(parts[0], edit.lon);
    parts[1] = swap(parts[1], edit.lat);
    splices.push({ span, text: `[${parts.join(',')}]` });
  }
  if (edit.title !== undefined) {
    const span = jsonValueSpan(geojsonText, ['features', marker.index, 'properties', 'title']);
    if (!span) throw new Error(`${source}: marker "${marker.title}" has no title`);
    splices.push({ span, text: jsonStringLike(edit.title, geojsonText) });
  }
  let out = geojsonText;
  for (const { span, text } of splices.sort((a, b) => b.span.start - a.span.start)) {
    out = out.slice(0, span.start) + text + out.slice(span.end);
  }
  return out;
}

// ---------------------------------------------------------------------------
// CalTopo folders: where a marker's type comes from
// ---------------------------------------------------------------------------

/** A marker as the build reads it (`parseCaltopoGeojson` in `build-trails.ts`). */
export interface CaltopoMarkerInfo extends CaltopoMarkerRef {
  /** The cleaned title the build keys markers by. */
  cleanedName: string;
  folderId?: string;
  /** The folder's title, when the marker is in one. */
  folderTitle?: string;
  /** The type the build gives a waypoint this marker types. */
  type: string;
  /** True when the folder decides `type`; otherwise the title does (a prefix, a known town, or nothing). */
  typedByFolder: boolean;
}

export interface CaltopoFolder {
  index: number;
  id: string;
  title: string;
}

export interface CaltopoExport {
  markers: CaltopoMarkerInfo[];
  folders: CaltopoFolder[];
}

/**
 * The markers and folders of a CalTopo export, typed exactly as the build
 * types them: `classifyWaypoint(title, { folderName })`, so a folder whose
 * title is in `FOLDER_TYPE_MAP` decides, and otherwise the title does. Null
 * when the text is not JSON (the build then types from the GPX alone).
 */
export function readCaltopoExport(geojsonText: string): CaltopoExport | null {
  let collection: CaltopoCollection;
  try {
    collection = JSON.parse(geojsonText) as CaltopoCollection;
  } catch {
    return null;
  }
  const features = collection.features ?? [];
  const folders: CaltopoFolder[] = [];
  features.forEach((feature, index) => {
    if (feature.properties?.class === 'Folder' && typeof feature.id === 'string') {
      folders.push({ index, id: feature.id, title: feature.properties.title ?? '' });
    }
  });
  const folderTitles = new Map(folders.map(f => [f.id, f.title]));
  const markers: CaltopoMarkerInfo[] = [];
  features.forEach((feature, index) => {
    if (feature.properties?.class !== 'Marker') return;
    const title = feature.properties.title ?? '';
    const folderId = feature.properties.folderId;
    const folderTitle = folderId ? folderTitles.get(folderId) : undefined;
    const classification = classifyWaypoint(title, { folderName: (folderTitle ?? '').toLowerCase() });
    const [lon, lat] = feature.geometry?.coordinates ?? [];
    if (typeof lat !== 'number' || typeof lon !== 'number') return;
    const marker: CaltopoMarkerInfo = {
      index,
      title,
      lat,
      lon,
      cleanedName: classification.cleanedName,
      type: classification.type,
      typedByFolder: classification.source === 'folder',
    };
    if (feature.properties.description) marker.description = feature.properties.description;
    if (folderId) marker.folderId = folderId;
    if (folderTitle !== undefined) marker.folderTitle = folderTitle;
    markers.push(marker);
  });
  return { markers, folders };
}

/** Of the markers titled `name` (cleaned), the nearest to the position: the one the build types a waypoint from. */
export function nearestCaltopoMarker(
  markers: readonly CaltopoMarkerInfo[],
  target: { lat: number; lon: number; name: string }
): CaltopoMarkerInfo | null {
  let best: CaltopoMarkerInfo | null = null;
  let bestDistance = Infinity;
  for (const marker of markers) {
    if (marker.cleanedName !== target.name) continue;
    const distance = haversineDistance(target.lat, target.lon, marker.lat, marker.lon);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = marker;
    }
  }
  return best;
}

/** Folder titles that type their markers as `type` (`FOLDER_TYPE_MAP`, lower case). */
export function folderTitlesForType(type: string): string[] {
  return Object.entries(FOLDER_TYPE_MAP)
    .filter(([, mapped]) => mapped === type)
    .map(([title]) => title);
}

/** The title a new folder for `type` gets (`Water tanks`), or null when no folder title maps to it. */
export function newFolderTitle(type: string): string | null {
  const title = folderTitlesForType(type)[0];
  return title ? title.charAt(0).toUpperCase() + title.slice(1) : null;
}

function assertMarkerAt(geojsonText: string, source: string, marker: { index: number; title: string }): void {
  const collection = JSON.parse(geojsonText) as CaltopoCollection;
  if (collection.features?.[marker.index]?.properties?.title !== marker.title) {
    throw new Error(`${source}: marker "${marker.title}" is no longer where it was read`);
  }
}

/** The export with one marker put in folder `folderId`; every other byte is left as it was. */
export function setCaltopoMarkerFolder(
  geojsonText: string,
  source: string,
  marker: { index: number; title: string },
  folderId: string
): string {
  assertMarkerAt(geojsonText, source, marker);
  const literal = JSON.stringify(folderId);
  const existing = jsonValueSpan(geojsonText, ['features', marker.index, 'properties', 'folderId']);
  if (existing) return geojsonText.slice(0, existing.start) + literal + geojsonText.slice(existing.end);
  const properties = jsonValueSpan(geojsonText, ['features', marker.index, 'properties']);
  if (!properties) throw new Error(`${source}: marker "${marker.title}" has no properties`);
  const close = properties.end - 1;
  const empty = !geojsonText.slice(properties.start + 1, close).trim();
  return `${geojsonText.slice(0, close)}${empty ? '' : ','}"folderId":${literal}${geojsonText.slice(close)}`;
}

/**
 * The export with a new folder feature first in `features`, shaped like
 * CalTopo's own (`{"geometry":null,"id":…,"type":"Feature","properties":{"title":…,"class":"Folder"}}`).
 */
export function addCaltopoFolder(geojsonText: string, source: string, folder: { id: string; title: string }): string {
  const features = jsonValueSpan(geojsonText, ['features']);
  if (!features || geojsonText[features.start] !== '[') throw new Error(`${source}: no features array`);
  const empty = !geojsonText.slice(features.start + 1, features.end - 1).trim();
  const feature =
    `{"geometry":null,"id":${JSON.stringify(folder.id)},"type":"Feature",` +
    `"properties":{"title":${jsonStringLike(folder.title, geojsonText)},"class":"Folder"}}`;
  const at = features.start + 1;
  return geojsonText.slice(0, at) + feature + (empty ? '' : ',') + geojsonText.slice(at);
}

/** The export without one marker feature (and the comma that joined it to its neighbour). */
export function removeCaltopoFeature(
  geojsonText: string,
  source: string,
  marker: { index: number; title: string }
): string {
  assertMarkerAt(geojsonText, source, marker);
  const span = jsonValueSpan(geojsonText, ['features', marker.index]);
  if (!span) throw new Error(`${source}: marker "${marker.title}" is not in the features array`);
  const next = jsonValueSpan(geojsonText, ['features', marker.index + 1]);
  if (next) return geojsonText.slice(0, span.start) + geojsonText.slice(next.start);
  if (marker.index > 0) {
    const previous = jsonValueSpan(geojsonText, ['features', marker.index - 1])!;
    return geojsonText.slice(0, previous.end) + geojsonText.slice(span.end);
  }
  return geojsonText.slice(0, span.start) + geojsonText.slice(span.end);
}
