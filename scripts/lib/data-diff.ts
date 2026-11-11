/**
 * Compare two builds of the trail data, file by file, for
 * `npm run check:data-unchanged` (scripts/check-data-unchanged.ts).
 *
 * A snapshot is a map from a path (`generated/bibbulmun.json`,
 * `mobile/index.json`, `waypoint-ids.json`) to the file's bytes. Two builds of
 * the same tree differ in only the fields `normalizeForCompare` drops; anything
 * else that differs is a change the build would ship, and is reported with the
 * keys it touched and how array lengths moved.
 *
 * Pure (no file system, no git) so it can be tested.
 */

/** One file's verdict. */
export type FileDiff =
  { path: string; status: 'added' | 'removed' } | { path: string; status: 'changed'; changes: string[] };

/**
 * Clock fields, by file kind. Two consecutive builds of one tree are
 * byte-identical (checked 2026-11-11, all 21 trails); these move only when the
 * build stamps "now", which a baseline built at another ref can do for data
 * that is otherwise the same:
 *
 * - `generated/<trail>.json` `dataUpdatedAt`: the build time whenever the
 *   app's committed copy is not this exact data (`webDataTime`), so a baseline
 *   built at another ref, against another app index, stamps another time.
 * - `mobile/index.json` `updatedAt`/`dataVersion`: stamped "now" when a
 *   trail's md5 moves. The md5 and byte count stay compared, so a content
 *   change is still caught there and in the trail's own file.
 */
const TRAIL_CLOCK_KEYS = ['dataUpdatedAt'];
const MOBILE_INDEX_CLOCK_KEYS = ['updatedAt', 'dataVersion'];

/** True for the per-trail generated files (not the generated index). */
function isGeneratedTrail(path: string): boolean {
  return path.startsWith('generated/') && path.endsWith('.json') && path !== 'generated/index.json';
}

/**
 * The parsed file with its clock fields removed, or `undefined` when the file
 * is not JSON (compared as bytes).
 */
export function normalizeForCompare(path: string, text: string): unknown {
  if (!path.endsWith('.json')) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (isGeneratedTrail(path) && isRecord(value)) {
    return omit(value, TRAIL_CLOCK_KEYS);
  }
  if (path === 'mobile/index.json' && Array.isArray(value)) {
    return value.map(entry => (isRecord(entry) ? omit(entry, MOBILE_INDEX_CLOCK_KEYS) : entry));
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function omit(record: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const copy = { ...record };
  for (const key of keys) delete copy[key];
  return copy;
}

function same(a: unknown, b: unknown): boolean {
  // Key order counts: the rule is byte-identical output, and a reordered key
  // is a byte change.
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The `id` of each element, when every element is a record with a string id. */
function ids(values: unknown[]): string[] | undefined {
  const out: string[] = [];
  for (const value of values) {
    if (!isRecord(value) || typeof value.id !== 'string') return undefined;
    out.push(value.id);
  }
  return out;
}

function listed(items: string[], max = 5): string {
  return items.length <= max ? items.join(', ') : `${items.slice(0, max).join(', ')}, … ${items.length - max} more`;
}

function describeArray(at: string, before: unknown[], after: unknown[]): string {
  const beforeIds = ids(before);
  const afterIds = ids(after);
  if (beforeIds && afterIds) {
    const was = new Set(beforeIds);
    const now = new Set(afterIds);
    const added = afterIds.filter(id => !was.has(id));
    const removed = beforeIds.filter(id => !now.has(id));
    const byId = new Map(before.map(value => [(value as { id: string }).id, value]));
    const changed = after.filter(value => {
      const id = (value as { id: string }).id;
      return was.has(id) && !same(byId.get(id), value);
    }).length;
    const parts = [`${before.length} → ${after.length} items`];
    if (added.length > 0) parts.push(`+${added.length} (${listed(added)})`);
    if (removed.length > 0) parts.push(`-${removed.length} (${listed(removed)})`);
    if (changed > 0) parts.push(`${changed} changed`);
    if (added.length === 0 && removed.length === 0 && changed === 0) parts.push('reordered');
    return `${at}: ${parts.join(', ')}`;
  }
  if (before.length !== after.length) return `${at}: ${before.length} → ${after.length} items`;
  const changed = before.filter((value, i) => !same(value, after[i])).length;
  return `${at}: ${changed} of ${before.length} items changed`;
}

function scalar(value: unknown): string {
  const text = JSON.stringify(value);
  return text === undefined ? 'absent' : text.length > 40 ? `${text.slice(0, 37)}…` : text;
}

/**
 * What differs between two parsed values, as one line per changed key, down
 * to `depth` levels of object keys (`track.points: 12034 → 12040 items`,
 * `config.lengthKm: 3056.8 → 3057.1`). Arrays are summarised, not descended:
 * their length, and for arrays of `{ id }` records which ids came, went or
 * changed.
 */
export function describeChanges(before: unknown, after: unknown, depth = 2, at = ''): string[] {
  if (same(before, after)) return [];
  const label = at || '(root)';
  if (Array.isArray(before) && Array.isArray(after)) return [describeArray(label, before, after)];
  if (isRecord(before) && isRecord(after)) {
    if (depth === 0) return [`${label}: changed`];
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    const lines: string[] = [];
    for (const key of keys) {
      const path = at ? `${at}.${key}` : key;
      if (!(key in before)) lines.push(`${path}: added`);
      else if (!(key in after)) lines.push(`${path}: removed`);
      else lines.push(...describeChanges(before[key], after[key], depth - 1, path));
    }
    // Same keys, same values, different order.
    return lines.length > 0 ? lines : [`${label}: keys reordered`];
  }
  return [`${label}: ${scalar(before)} → ${scalar(after)}`];
}

/** Compare one file present in both snapshots; `null` when it is unchanged. */
export function diffFile(path: string, before: string, after: string): FileDiff | null {
  if (before === after) return null;
  const a = normalizeForCompare(path, before);
  const b = normalizeForCompare(path, after);
  if (a === undefined || b === undefined) {
    return { path, status: 'changed', changes: [`bytes differ (${before.length} → ${after.length})`] };
  }
  if (same(a, b)) {
    // Only clock fields moved, if both files are laid out alike; a change of
    // indentation is still a change of every byte.
    const layout = layoutOf(before);
    return layout !== undefined && layout === layoutOf(after)
      ? null
      : { path, status: 'changed', changes: ['formatting only (same values, different bytes)'] };
  }
  return { path, status: 'changed', changes: describeChanges(a, b) };
}

/**
 * How a JSON text was written — `JSON.stringify` with an indent of 2 or none,
 * with or without a trailing newline — or `undefined` when it is neither.
 */
export function layoutOf(text: string): string | undefined {
  const value: unknown = JSON.parse(text);
  for (const indent of [2, 0]) {
    const written = JSON.stringify(value, null, indent);
    if (text === written) return `indent ${indent}`;
    if (text === `${written}\n`) return `indent ${indent}, newline`;
  }
  return undefined;
}

/** Every file that differs between two snapshots, sorted by path. */
export function diffSnapshots(before: Map<string, string>, after: Map<string, string>): FileDiff[] {
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const diffs: FileDiff[] = [];
  for (const path of paths) {
    const a = before.get(path);
    const b = after.get(path);
    if (a === undefined) diffs.push({ path, status: 'added' });
    else if (b === undefined) diffs.push({ path, status: 'removed' });
    else {
      const diff = diffFile(path, a, b);
      if (diff) diffs.push(diff);
    }
  }
  return diffs;
}

/** The report printed for a set of differences. */
export function formatReport(diffs: FileDiff[]): string {
  return diffs
    .map(diff =>
      diff.status === 'changed'
        ? [`  ${diff.path}`, ...diff.changes.map(line => `      ${line}`)].join('\n')
        : `  ${diff.path} (${diff.status})`
    )
    .join('\n');
}
