/**
 * The planner's filter boxes: narrowing a list of places by what the hiker
 * types. Shared by the web planner (Stops and Resupply tabs) and the phone
 * (Stops list, resupply screen), so "Te Anau" finds the same rows on both.
 *
 * A case- and accent-insensitive substring match on the name: "ohau" finds
 * "Ōhau", "cafe" finds "Café". An empty (or all-space) query matches
 * everything. Filtering is a view: nothing here reads or changes a selection.
 */

/** Lower case with combining marks stripped (NFD), for comparing names. */
export function foldForMatch(text: string): string {
  // `normalize` is in every engine we ship to (Hermes included); the guard
  // only keeps an odd runtime from throwing rather than matching less.
  const decomposed = typeof text.normalize === 'function' ? text.normalize('NFD') : text;
  return decomposed.replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** The query as it is compared: folded and trimmed; '' means "no filter". */
export function nameQuery(query: string): string {
  return foldForMatch(query.trim());
}

/** Whether a name contains the query. A missing name matches only an empty query. */
export function nameMatches(name: string | null | undefined, query: string): boolean {
  const needle = nameQuery(query);
  if (needle === '') return true;
  return foldForMatch(name ?? '').includes(needle);
}

/** The items whose name contains the query, in order; all of them for an empty query. */
export function filterByName<T>(
  items: readonly T[],
  query: string,
  nameOf: (item: T) => string | null | undefined
): T[] {
  const needle = nameQuery(query);
  if (needle === '') return items.slice();
  return items.filter(item => foldForMatch(nameOf(item) ?? '').includes(needle));
}

/** A resupply decision group, as far as the filter cares: its turn-off and its places. */
export interface NamedGroup<O extends { name: string }> {
  label?: string | null;
  options: readonly O[];
}

/**
 * Whether a query matches a group at all: its turn-off's name or any of its
 * places'. For a list that shows a decision whole (the phone's radios) rather
 * than trimming it to the matching places.
 */
export function groupMatchesName(group: NamedGroup<{ name: string }>, query: string): boolean {
  const needle = nameQuery(query);
  if (needle === '') return true;
  if (group.label && foldForMatch(group.label).includes(needle)) return true;
  return group.options.some(option => foldForMatch(option.name).includes(needle));
}

/**
 * The groups a query keeps, each with the options it keeps. A turn-off whose
 * own name matches keeps every place reached from it (searching "Monarch Pass"
 * is asking for Salida and Buena Vista); otherwise a group keeps the places
 * whose names match and is dropped when none do. Empty query: every group, whole.
 */
export function filterGroupsByName<O extends { name: string }, G extends NamedGroup<O>>(
  groups: readonly G[],
  query: string
): G[] {
  const needle = nameQuery(query);
  if (needle === '') return groups.slice();
  const kept: G[] = [];
  for (const group of groups) {
    if (group.label && foldForMatch(group.label).includes(needle)) {
      kept.push(group);
      continue;
    }
    const options = group.options.filter(option => foldForMatch(option.name).includes(needle));
    if (options.length > 0) kept.push({ ...group, options });
  }
  return kept;
}
