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
import { parseCoordinate } from '../../../src/lib/parse-coordinate';

// ---------------------------------------------------------------------------
// XML text
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/**
 * The text of an element's content as an XML parser gives it (`textContent`):
 * CDATA sections unwrapped, comments dropped, entities decoded, and the
 * whitespace around it kept.
 */
export function decodeXmlText(raw: string): string {
  return raw.replace(
    /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g,
    (whole, cdata: string | undefined, ref: string | undefined) => {
      if (cdata !== undefined) return cdata;
      if (ref === undefined) return '';
      if (ref.startsWith('#x')) return String.fromCodePoint(parseInt(ref.slice(2), 16));
      if (ref.startsWith('#')) return String.fromCodePoint(parseInt(ref.slice(1), 10));
      return NAMED_ENTITIES[ref] ?? whole;
    }
  );
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
  /** `lat` and `lon` as the file writes them (`-33.855100`). */
  latText: string;
  lonText: string;
  /**
   * Decoded `<name>` as the build reads it: untrimmed, '' when there is none.
   * {@link gpxWaypointBuildName} gives the name the build shows for it.
   */
  name: string;
  /** Decoded `<desc>`, when present. */
  desc?: string;
  /** Decoded `<type>` as the build reads it (untrimmed); absent when there is none or it is empty. */
  type?: string;
  /** Its `<ele>` as written (`745.0`), when present: metres, and the decimals the file keeps. */
  ele?: string;
}

const WPT_PATTERN = /<wpt\b([^>]*?)(\/>|>([\s\S]*?)<\/wpt>)/g;

function attribute(attrs: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(attrs);
  return m ? (m[2] ?? m[3]) : null;
}

/** Stands in for text that is not markup: not whitespace, and never part of a tag. */
const MASK = '\u0000';

/**
 * `xml` with what an XML parser does not read as elements blanked (same
 * length, so offsets still hold): comments whole, and the `<` and `>` inside a
 * CDATA section. The build parses the file, so a `<wpt>` in a comment is not a
 * waypoint, and a `</wpt>` quoted in a CDATA description ends nothing. The
 * masked text is only for finding elements: their content is read from, and
 * every edit is made to, the file as it is.
 */
function maskMarkup(xml: string): string {
  return xml.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, m =>
    m.startsWith('<!--') ? MASK.repeat(m.length) : `<![CDATA[${m.slice(9, -3).replace(/[<>]/g, MASK)}]]>`
  );
}

/**
 * {@link maskMarkup}, and every `<link>` and `<extensions>` block blanked too:
 * a `<link>` carries a `<type>` of its own (a MIME type), and the GPX parser
 * reads only the `<wpt>`'s direct child.
 */
function maskNested(xml: string): string {
  return maskMarkup(xml).replace(/<(link|extensions)\b[^>]*?(?:\/>|>[\s\S]*?<\/\1>)/g, m => MASK.repeat(m.length));
}

/** Offsets of the first `<tag>` element in `masked`, and of its content. */
interface ChildSpan {
  /** Offset of `<tag`. */
  open: number;
  /** Offsets of the content. */
  start: number;
  end: number;
  /** Offset just past `</tag>`. */
  close: number;
}

function findChild(masked: string, tag: string): ChildSpan | null {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}\\s*>`).exec(masked);
  if (!m) return null;
  const start = m.index + m[0].indexOf('>') + 1;
  return { open: m.index, start, end: start + m[1].length, close: m.index + m[0].length };
}

/** The decoded text of `element`'s `<tag>` child (`masked` is {@link maskNested} of `element`), when it has one. */
function childText(element: string, masked: string, tag: string): string | undefined {
  const child = findChild(masked, tag);
  return child ? decodeXmlText(element.slice(child.start, child.end)) : undefined;
}

/**
 * Every `<wpt>` in a GPX file, in file order, read as the build's parser reads
 * it (`parseGpx`): one in a comment is skipped, the `<name>` and `<type>` are
 * taken as written, and a `<wpt>` without a usable `lat` or `lon` throws, as
 * it stops the build.
 */
export function listGpxWaypoints(gpx: string): GpxWaypointSpan[] {
  const spans: GpxWaypointSpan[] = [];
  for (const m of maskMarkup(gpx).matchAll(WPT_PATTERN)) {
    const start = m.index;
    const end = start + m[0].length;
    const element = gpx.slice(start, end);
    const masked = maskNested(element);
    const name = childText(element, masked, 'name') ?? '';
    const latText = attribute(m[1], 'lat');
    const lonText = attribute(m[1], 'lon');
    let lat: number;
    let lon: number;
    try {
      lat = parseCoordinate(latText, 'lat', 'wpt');
      lon = parseCoordinate(lonText, 'lon', 'wpt');
    } catch (error) {
      const which = name.trim() ? `“${name.trim()}”` : `number ${spans.length + 1}`;
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} (<wpt> ${which}): the build stops on this too, so fix the GPX by hand first`,
        { cause: error }
      );
    }
    const span: GpxWaypointSpan = { start, end, lat, lon, latText: latText ?? '', lonText: lonText ?? '', name };
    const desc = childText(element, masked, 'desc');
    if (desc !== undefined) span.desc = desc;
    const type = childText(element, masked, 'type');
    if (type) span.type = type;
    const ele = childText(element, masked, 'ele');
    if (ele !== undefined) span.ele = ele.trim();
    spans.push(span);
  }
  return spans;
}

/** The name the build shows for a raw source name (prefixes like `C ` / `WT: ` removed). */
export function cleanedWaypointName(rawName: string): string {
  return classifyWaypoint(rawName).cleanedName;
}

/**
 * The name the build gives a `<wpt>` whose `<name>` reads `rawName`, exactly
 * as `flattenGpx` does: `Unnamed` when it has none, and the classifier's
 * cleaned name otherwise ('' for one that is only whitespace).
 */
export function gpxWaypointBuildName(rawName: string): string {
  return classifyWaypoint(rawName || 'Unnamed').cleanedName;
}

/**
 * The one `<wpt>` that stands at exactly these coordinates under the name the
 * build shows as `name` ({@link gpxWaypointBuildName}); null when there is
 * none, or more than one. The build copies a waypoint's coordinates from its
 * `<wpt>` unchanged, so the coordinates are exact; the name is required even
 * of the only `<wpt>` on the spot, because two waypoints can share
 * coordinates (the CDT's towns hitched from one pass), and when one is gone
 * the other's `<wpt>` is not its. The editor's join of built ids to `<wpt>`s
 * (`claimSpans` in `trail-state.ts`) applies the same rule, with the type too.
 */
export function findGpxWaypoint(
  spans: readonly GpxWaypointSpan[],
  target: { lat: number; lon: number; name: string }
): GpxWaypointSpan | null {
  const here = spans.filter(
    s => s.lat === target.lat && s.lon === target.lon && gpxWaypointBuildName(s.name) === target.name
  );
  return here.length === 1 ? here[0] : null;
}

/**
 * Coordinates as the editor writes them: six decimals is about 0.1 m.
 * `padded` keeps the trailing zeros (`151.213190`), for a file that writes
 * every coordinate that way ({@link gpxCoordinatesPadded}).
 */
export function formatCoordinate(value: number, padded = false): string {
  const text = value.toFixed(6);
  if (!padded) return Number(text).toString();
  return Number(text) === 0 ? text.replace(/^-/, '') : text;
}

/**
 * Whether a file's `<wpt>`s write their coordinates padded to six decimals
 * (the open-data files do: `lon="151.213190"`): every `lat` and `lon` has
 * exactly six. One written shorter and the file is taken to strip zeros.
 */
export function gpxCoordinatesPadded(spans: readonly GpxWaypointSpan[]): boolean {
  const six = /\.\d{6}$/;
  return spans.length > 0 && spans.every(s => six.test(s.latText.trim()) && six.test(s.lonText.trim()));
}

/**
 * The GPX with one waypoint's `lat`/`lon` attributes replaced, written as the
 * file's `<wpt>`s write theirs ({@link gpxCoordinatesPadded}); nothing else changes.
 */
export function setGpxWaypointPosition(gpx: string, span: GpxWaypointSpan, lat: number, lon: number): string {
  const padded = gpxCoordinatesPadded(listGpxWaypoints(gpx));
  const element = gpx.slice(span.start, span.end);
  const tagEnd = element.indexOf('>');
  const startTag = element.slice(0, tagEnd);
  const replaced = startTag
    .replace(/(\blat\s*=\s*)("[^"]*"|'[^']*')/, (_m, lead: string) => `${lead}"${formatCoordinate(lat, padded)}"`)
    .replace(/(\blon\s*=\s*)("[^"]*"|'[^']*')/, (_m, lead: string) => `${lead}"${formatCoordinate(lon, padded)}"`);
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
 * `raw` (a `<name>` or a CalTopo title as written) renamed so the build shows
 * `newName`, changing the name part alone: the type prefix the classifier
 * strips (`C `, `WT: `, `C:`) stays, with the spacing after it, and so does
 * any whitespace before or after the whole (`"W Old Creek "` → `"W New Ck "`).
 * The GPX and the CalTopo export carry the prefix in the name, and a renamed
 * waypoint keeps it in both files.
 */
export function renameKeepingPrefix(raw: string, newName: string): string {
  const lead = /^\s*/.exec(raw)![0];
  const core = raw.slice(lead.length).trimEnd();
  const trail = raw.slice(lead.length + core.length);
  // What the classifier leaves is the name; whatever came before it is the prefix.
  const cleaned = cleanedWaypointName(core);
  const prefix = cleaned && core.endsWith(cleaned) ? core.slice(0, core.length - cleaned.length) : '';
  return lead + prefix + newName + trail;
}

/**
 * The GPX with the text of one waypoint's `<name>` replaced by `rawName` (or a
 * `<name>` added, if it had none). `rawName` is the whole text: take it from
 * the span's own `name` ({@link renameKeepingPrefix}) to keep the whitespace
 * the file has around it.
 */
export function setGpxWaypointName(gpx: string, span: GpxWaypointSpan, rawName: string): string {
  const element = gpx.slice(span.start, span.end);
  const encoded = encodeXmlText(rawName, gpx);
  const existing = findChild(maskNested(element), 'name');
  let next: string;
  if (existing) {
    next = element.slice(0, existing.start) + encoded + element.slice(existing.end);
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
  const extensions = maskMarkup(element).indexOf('<extensions', tagEnd);
  if (extensions !== -1) return element.slice(0, extensions) + child + lead + element.slice(extensions);
  const at = closeAt - /\s*$/.exec(inner)![0].length;
  return element.slice(0, at) + lead + child + element.slice(at);
}

/** The GPX with one waypoint's `<type>` replaced, or added when it has none. */
export function setGpxWaypointType(gpx: string, span: GpxWaypointSpan, type: string): string {
  const element = gpx.slice(span.start, span.end);
  const encoded = encodeXmlText(type, gpx);
  const existing = findChild(maskNested(element), 'type');
  let next: string;
  if (existing) {
    next = element.slice(0, existing.start) + encoded + element.slice(existing.end);
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
  const existing = findChild(masked, 'desc');
  let next: string;
  if (existing && !desc) {
    next = element.slice(0, whitespaceStart(element, existing.open)) + element.slice(existing.close);
  } else if (existing) {
    next = element.slice(0, existing.start) + encodeXmlText(desc, gpx) + element.slice(existing.end);
  } else if (!desc) {
    return gpx;
  } else {
    const child = `<desc>${encodeXmlText(desc, gpx)}</desc>`;
    const name = findChild(masked, 'name');
    if (!name) {
      next = appendWptChild(element, child);
    } else {
      const cmt = findChild(masked, 'cmt');
      const anchor = cmt && cmt.open > name.open ? cmt : name;
      const lead = element.slice(whitespaceStart(element, name.open), name.open);
      next = element.slice(0, anchor.close) + lead + child + element.slice(anchor.close);
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
 * on one line or one per line as the last `<wpt>` has them (with the file's
 * line ending), its coordinates padded to six decimals when every `<wpt>`'s
 * are, and `<ele>`, `<name>`, `<desc>` and `<type>` in the order the last
 * `<wpt>` uses (an `<ele>` the last one lacks goes first, where GPX 1.1 puts
 * it). A file with no `<wpt>` gets it before its first `<trk>` / `<rte>` (or
 * `</gpx>`).
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
  const padded = gpxCoordinatesPadded(spans);
  const open = `<wpt lat="${formatCoordinate(waypoint.lat, padded)}" lon="${formatCoordinate(waypoint.lon, padded)}">`;
  let element: string;
  // One child per line when the last <wpt> breaks the line after its start
  // tag, not merely when it has a line break somewhere: a one-line <wpt> can
  // carry a <desc> that runs over several lines (Heysen's do).
  const afterOpen = template.slice(template.indexOf('>') + 1);
  const multiLine = /^[ \t]*\r?\n/.test(afterOpen);
  if (multiLine) {
    const eol = template.includes('\r\n') ? '\r\n' : '\n';
    const childIndent = /\n([ \t]*)</.exec(afterOpen)?.[1] ?? '  ';
    const closeIndent = /\n([ \t]*)<\/wpt>$/.exec(template)?.[1] ?? '';
    element = `${open}${parts.map(p => `${eol}${childIndent}${p}`).join('')}${eol}${closeIndent}</wpt>`;
  } else {
    element = `${open}${parts.join('')}</wpt>`;
  }
  if (last) {
    const lead = gpx.slice(whitespaceStart(gpx, last.start), last.start);
    return gpx.slice(0, last.end) + lead + element + gpx.slice(last.end);
  }
  const scan = maskMarkup(gpx);
  const anchors = ['<trk', '<rte', '</gpx>'].map(tag => scan.indexOf(tag)).filter(i => i !== -1);
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
 * (`resolveTrailWaypoints` in `trail-waypoint-sources.ts`).
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

/**
 * A JSON object's text with the string `from`, in the array of strings at its
 * top-level `key`, renamed to `to`; every other byte is left as it was, so a
 * hand-laid-out file (trail.json, which Prettier formats) keeps its layout.
 *
 * - `keepFrom` false: `from` becomes `to` in place (or is dropped, with the
 *   separator that joined it, when `to` is already listed);
 * - `keepFrom` true: `to` is added straight after `from`, separated as its
 *   neighbours are (something else still goes by `from`).
 *
 * Null when the object has no such array, the array has no `from`, or nothing
 * needs to change. Throws when `key` is there but is not an array of strings.
 */
export function renameJsonArrayString(
  text: string,
  source: string,
  key: string,
  from: string,
  to: string,
  keepFrom: boolean
): string | null {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const list = parsed[key];
  if (list === undefined) return null;
  if (!Array.isArray(list) || list.some(item => typeof item !== 'string')) {
    throw new Error(`${source}: "${key}" is not a list of names, so the editor cannot change it`);
  }
  const index = list.indexOf(from);
  if (index === -1) return null;
  const span = jsonValueSpan(text, [key, index]);
  if (!span) throw new Error(`${source}: could not find "${from}" in "${key}"`);
  const listed = list.includes(to);
  const literal = jsonStringLike(to, text);
  if (!keepFrom && !listed) return text.slice(0, span.start) + literal + text.slice(span.end);
  const previous = index > 0 ? jsonValueSpan(text, [key, index - 1]) : null;
  const next = index + 1 < list.length ? jsonValueSpan(text, [key, index + 1]) : null;
  if (keepFrom) {
    if (listed) return null;
    const separator = previous ? text.slice(previous.end, span.start) : next ? text.slice(span.end, next.start) : ', ';
    return text.slice(0, span.end) + separator + literal + text.slice(span.end);
  }
  // `to` is already listed: drop `from`, with the separator on one side of it.
  if (next) return text.slice(0, span.start) + text.slice(next.start);
  if (previous) return text.slice(0, previous.end) + text.slice(span.end);
  return text.slice(0, span.start) + text.slice(span.end);
}

/**
 * A JSON object's text with the string `value` taken out of the array of
 * strings at its top-level `key`, along with the separator that joined it to
 * a neighbour; every other byte is left as it was. An array it was the only
 * entry of is left as `[]`, whatever lines it was laid out over.
 *
 * Null when the object has no such array or the array has no `value`. Throws
 * when `key` is there but is not an array of strings.
 */
export function removeJsonArrayString(text: string, source: string, key: string, value: string): string | null {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const list = parsed[key];
  if (list === undefined) return null;
  if (!Array.isArray(list) || list.some(item => typeof item !== 'string')) {
    throw new Error(`${source}: "${key}" is not a list of names, so the editor cannot change it`);
  }
  const index = list.indexOf(value);
  if (index === -1) return null;
  const span = jsonValueSpan(text, [key, index]);
  if (!span) throw new Error(`${source}: could not find "${value}" in "${key}"`);
  const next = index + 1 < list.length ? jsonValueSpan(text, [key, index + 1]) : null;
  if (next) return text.slice(0, span.start) + text.slice(next.start);
  const previous = index > 0 ? jsonValueSpan(text, [key, index - 1]) : null;
  if (previous) return text.slice(0, previous.end) + text.slice(span.end);
  const whole = jsonValueSpan(text, [key]);
  if (!whole) throw new Error(`${source}: could not find "${key}"`);
  return `${text.slice(0, whole.start)}[]${text.slice(whole.end)}`;
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

/** A marker as the build reads it (`parseCaltopoGeojson` in `trail-waypoint-sources.ts`). */
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
