/**
 * Byte-preserving edits to a bundled trail's waypoint sources, for the local
 * waypoint editor (`src/web/admin-waypoints.html`, served only by `npm run dev`).
 *
 * Every function here is pure text in, text out, so the editor's writes can be
 * tested without a file system. The rule they share: **a save changes only the
 * bytes it means to.** The GPX is edited in place (one `<wpt>` start tag or one
 * `<name>`), never re-serialised; a JSON file is re-serialised only after
 * checking that its layout can be reproduced exactly, so an unrelated
 * reformatting (or an unescaped `–`) never rides along with an edit and
 * buries it in the diff.
 */

import { classifyWaypoint } from '../../../src/lib/waypoint-classifier';
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
    const type = childText(body, 'type');
    if (type !== undefined) span.type = type.trim();
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
): CaltopoMarkerRef | null {
  const collection = JSON.parse(geojsonText) as CaltopoCollection;
  let best: CaltopoMarkerRef | null = null;
  let bestDistance = Infinity;
  (collection.features ?? []).forEach((feature, index) => {
    if (feature.properties?.class !== 'Marker') return;
    const title = feature.properties.title ?? '';
    if (cleanedWaypointName(title.trim()) !== target.name) return;
    const [lon, lat] = feature.geometry?.coordinates ?? [];
    if (typeof lat !== 'number' || typeof lon !== 'number') return;
    const distance = haversineDistance(target.lat, target.lon, lat, lon);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = { index, title, lat, lon };
      if (feature.properties.description) best.description = feature.properties.description;
    }
  });
  return best;
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
