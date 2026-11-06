/**
 * The planner's filter boxes: narrowing a list of places by what the hiker
 * types. Shared by the web planner (Stops and Resupply tabs) and the phone
 * (Stops list, resupply screen), so "Te Anau" finds the same rows on both.
 *
 * A case- and accent-insensitive substring match on the name: "ohau" finds
 * "Ōhau", "cafe" finds "Café". An empty (or all-space) query matches
 * everything. Filtering is a view: nothing here reads or changes a selection.
 */

/**
 * Letters NFD leaves whole (they are letters of their own, not a base letter
 * plus a mark), folded to what a hiker without the key types for them.
 */
const LETTER_FOLDS: Readonly<Record<string, string>> = {
  ø: 'o',
  ł: 'l',
  đ: 'd',
  ð: 'd',
  ħ: 'h',
  ı: 'i',
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  þ: 'th',
};

/**
 * Lower case, accents and macrons dropped, for comparing names: "Ōhau Café"
 * → "ohau cafe". Combining Latin marks are stripped under NFD and the rest is
 * recomposed (NFC), so a mark outside that block stays on its letter — "が"
 * does not become "か". Letters NFD keeps whole (ø, ł, ß, æ …) fold by
 * `LETTER_FOLDS`; curly quotes and dashes fold to the ASCII ones a keyboard
 * types ("Heysen’s" ↔ "heysen's"); runs of whitespace (the ideographic space
 * included) read as one space.
 */
export function foldForMatch(text: string): string {
  // `normalize` is in every engine we ship to (Hermes included); the guard
  // only keeps an odd runtime from throwing rather than matching less.
  const canNormalize = typeof text.normalize === 'function';
  const decomposed = canNormalize ? text.normalize('NFD') : text;
  const stripped = decomposed.replace(/[\u0300-\u036f]/g, '');
  return (canNormalize ? stripped.normalize('NFC') : stripped)
    .toLowerCase()
    .replace(/[øłđðħıßæœþ]/g, letter => LETTER_FOLDS[letter] ?? letter)
    .replace(/[\u2018\u2019\u201a\u201b\u2032\u02bc]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, ' ');
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
