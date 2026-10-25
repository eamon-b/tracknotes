/**
 * The platform-neutral half of *showing* a resupply option — the `poi-display.ts`
 * pattern: the words live here, the markup and the styling stay with each UI.
 *
 * Every figure that has a unit is formatted by a function the caller passes in,
 * because the web pages are metric and the phone follows the hiker's unit
 * setting. The wording ("hitch", "off trail", "longest carry …") is shared, so
 * the two platforms cannot describe the same place differently.
 *
 * DOM-free and dependency-free beyond `src/lib`.
 */

import type {
  LegRide,
  ResupplyLeg,
  ResupplyOption,
  ResupplyOptionGroup,
  ResupplySummary,
  StopAccess,
} from './resupply-plan';
import type { StoreKind } from './types';

/**
 * Dotted tokens that end no sentence: "U.S. 50", "Mt. Sonder", "approx. 3 km".
 * Initials ("U.S.", "J. R. R. Tolkien") are handled by `isAbbreviationDot`
 * itself; these are the multi-letter ones a trail description uses.
 */
const NON_TERMINAL_ABBREVIATIONS = new Set([
  'mt',
  'mtn',
  'st',
  'hwy',
  'rd',
  'jct',
  'approx',
  'alt',
  'elev',
  'ft',
  'km',
  'mi',
  'no',
  'vs',
  'etc',
  'inc',
  'co',
  'ltd',
]);

/**
 * The lead sentence of a description, which is the part that says what is
 * there. The trail generators prefix their descriptions with `|`-separated
 * metadata ("mi 1947.3 (SOBO mi 1947.3) | off. mi 1955.8 | CO | Leave the CDT
 * here for Salida…"), so the prose is the last segment.
 *
 * A sentence ends at `.`, `!` or `?` followed by whitespace or the end of the
 * text — unless the dot closes an initial or an abbreviation ("U.S. 50",
 * "Mt. Sonder"), which would otherwise cut the sentence to "Store beside U.S."
 */
export function firstSentence(text: string): string {
  const segments = text
    .split('|')
    .map(part => part.trim())
    .filter(part => part !== '');
  const prose = segments.length > 0 ? segments[segments.length - 1] : '';

  const terminator = /[.!?](?=\s|$)/g;
  let match: RegExpExecArray | null;
  while ((match = terminator.exec(prose)) !== null) {
    const end = match.index + 1;
    if (match[0] === '.' && isAbbreviationDot(prose, match.index)) continue;
    return prose.slice(0, end).trim();
  }
  return prose.trim();
}

/** Whether the dot at `index` closes an initial ("U.S.", "J. R. R.") or a listed abbreviation ("Mt."). */
function isAbbreviationDot(prose: string, index: number): boolean {
  const word = prose.slice(0, index).match(/(\S+)$/)?.[1] ?? '';
  // "U.S." — the dot after the S sits behind a single capital letter, itself
  // behind another dotted letter.
  if (/^(?:[A-Z]\.)+[A-Z]$/.test(word)) return true;
  // A lone capital is an initial only inside a run of them: the next word is
  // one too ("J. R."), or the word before was ("R. Tolkien"). Otherwise it is
  // a letter that ends a sentence: "Water from tank B. Camp is beside it."
  if (/^[A-Z]$/.test(word)) {
    const before = prose.slice(0, index - 1).match(/(\S+)\s+$/)?.[1] ?? '';
    const after = prose.slice(index + 1).match(/^\s?(\S+)/)?.[1] ?? '';
    if (!/^[A-Z]/.test(after)) return false;
    return /^[A-Z]\.?$/.test(after) || /^[A-Z]\.$/.test(before);
  }
  return NON_TERMINAL_ABBREVIATIONS.has(word.replace(/^[^a-z]+/i, '').toLowerCase());
}

/**
 * How far off the route the place is, and how you get there.
 *
 * `formatKm` carries the unit: the web passes ``km => `${km.toFixed(1)} km` ``,
 * the phone `km => formatDistance(km, units)`.
 */
export function accessSummary(
  option: Pick<ResupplyOption, 'offTrailKm' | 'accessMode' | 'accessRoute'>,
  formatKm: (km: number) => string
): string {
  const hasKm = typeof option.offTrailKm === 'number' && option.offTrailKm > 0;
  const mode = option.accessMode;
  if (hasKm && option.accessRoute) return `${formatKm(option.offTrailKm!)} on foot via ${option.accessRoute.name}`;
  if (hasKm) return `${formatKm(option.offTrailKm!)} ${mode && mode !== 'on-trail' ? mode : 'off trail'}`;
  if (mode === 'on-trail') return 'on trail';
  return mode ?? '';
}

/**
 * The one line that sits above a set of legs — the web's Resupply datasheet
 * subtitle and the Days-tab collapsible, the phone's Resupply section subtitle.
 *
 * No stops is the full carry, start to end (`computeResupplyLegs` emits it as
 * the one leg), and says so rather than "0 stops · longest carry …".
 */
export function resupplySummaryText(
  summary: ResupplySummary,
  formatKm: (km: number) => string,
  formatFoodKg: (kg: number) => string
): string {
  const days = `${summary.longestDays} day${summary.longestDays === 1 ? '' : 's'}`;
  if (summary.stops === 0) {
    return (
      `No resupply stops · full carry ${formatKm(summary.longestKm)} / ${days} · ` +
      `${formatFoodKg(summary.totalFoodKg)} food`
    );
  }
  const stops = `${summary.stops} stop${summary.stops === 1 ? '' : 's'}`;
  return (
    `${stops} · longest carry ${formatKm(summary.longestKm)} / ${days} · ` +
    `${formatFoodKg(summary.totalFoodKg)} food in total`
  );
}

/**
 * A leg's distance with the trail and off-trail km kept apart:
 * "52.3 km" on the trail alone, "52.3 km + 4.0 km off trail" with a walk into
 * or out of a town. The trail figure is the one the datasheet's km add up to.
 */
export function legDistanceText(
  leg: Pick<ResupplyLeg, 'distanceKm' | 'offTrailWalkKm'>,
  formatKm: (km: number) => string
): string {
  const trail = formatKm(leg.distanceKm);
  return leg.offTrailWalkKm > 0 ? `${trail} + ${formatKm(leg.offTrailWalkKm)} off trail` : trail;
}

/**
 * The side trip a leg's figures include, for a line under its distance:
 * "incl. 2.8 km to Salida and back". Empty when the leg has none.
 */
export function legSideTripText(
  leg: Pick<ResupplyLeg, 'sideTripKm' | 'toName'>,
  formatKm: (km: number) => string,
  toName: string | null = leg.toName
): string {
  if (leg.sideTripKm <= 0) return '';
  // No name for a stop not decided yet: the walk counted is the longest of its
  // places', and naming them all is what made the line unreadable.
  return toName === null
    ? `incl. ${formatKm(leg.sideTripKm)} off trail and back`
    : `incl. ${formatKm(leg.sideTripKm)} to ${toName} and back`;
}

/** What the naming helpers read of a group: its turn-off name and its places' names. */
type NamedGroup = Pick<ResupplyOptionGroup, 'label'> & { options: readonly Pick<ResupplyOption, 'name'>[] };

/** A trailing "(access: …)" — how the data names a place reached from a turn-off. */
const ACCESS_SUFFIX = /\s*\(access:.*\)\s*$/i;
/** A trailing parenthetical, nested ones included: "Monarch Pass (US 50)" → "Monarch Pass". */
const TRAILING_PARENS = /\s*\(.*\)\s*$/;

/**
 * An option's short name, for every row and leg line that shows it: the
 * trailing "(access: Cumbres Pass (CO 17))" goes ("Chama"). Inside a decision
 * group, whose header already says where you leave the route, so does a prefix
 * that repeats the group's place ("Monarch Pass (Monarch Crest Store)" under
 * "Monarch Pass (US 50)" is "Monarch Crest Store"). A name that would be left
 * empty stays whole. UIs keep the full name as a tooltip or accessibility
 * label; a one-place turn-off says where it leaves the route with
 * {@link resupplyTurnOffText}.
 */
export function resupplyOptionShortName(option: Pick<ResupplyOption, 'name'>, group: NamedGroup): string {
  const full = option.name.trim();
  let name = full.replace(ACCESS_SUFFIX, '').trim();
  const place = group.options.length > 1 ? group.label?.replace(TRAILING_PARENS, '').trim() : undefined;
  if (place && name.startsWith(`${place} (`) && name.endsWith(')')) {
    name = name.slice(place.length + 2, -1).trim();
  }
  return name === '' ? full : name;
}

/**
 * Where a one-place group leaves the route, for the row's secondary line —
 * "turn-off at Cumbres Pass (CO 17)" — from the group's label (the data's
 * `accessName`), never parsed out of the place's name. Empty for a decision
 * group (its header says it), a group with no turn-off, or a label that is the
 * place itself.
 */
export function resupplyTurnOffText(group: NamedGroup): string {
  if (group.options.length !== 1 || !group.label) return '';
  const label = group.label.trim();
  const option = group.options[0];
  if (label === option.name.trim() || label === resupplyOptionShortName(option, group)) return '';
  return `turn-off at ${label}`;
}

/** A decision group's name: the turn-off, else its places' short names. */
export function resupplyGroupName(group: NamedGroup): string {
  if (group.label) return group.label;
  return group.options.map(option => resupplyOptionShortName(option, group)).join(' / ');
}

/** The names a leg's two ends go by, and whether the one it arrives at is decided. */
export interface LegEndpointNames {
  from: string;
  to: string;
  /** False when the leg arrives at a group with more than one place still ticked. */
  toDecided: boolean;
}

/**
 * What to call a leg's two ends. A stop with more than one place still ticked
 * (a decision not made yet) is named for its group — "Monarch Pass (US 50)
 * (not decided)" — rather than by every place joined, which is what
 * `resolveResupplyStops` names it; a stop at one place goes by that place's
 * short name ("Salida", not "Salida (access: Monarch Pass (US 50))"); the
 * trail start and end keep the leg's own name.
 *
 * @param selectedIds the plan's `resupplyStops` (`undefined` = every option),
 *   the selection the legs were computed from.
 */
export function legEndpointNames(
  leg: Pick<ResupplyLeg, 'fromName' | 'fromKm' | 'toName' | 'toKm'>,
  groups: readonly (Pick<ResupplyOptionGroup, 'km' | 'label'> & {
    options: readonly Pick<ResupplyOption, 'id' | 'name'>[];
  })[],
  selectedIds: readonly string[] | undefined
): LegEndpointNames {
  const nameAt = (km: number, name: string): { name: string; decided: boolean } | null => {
    for (const group of groups) {
      if (Math.abs(group.km - km) > 1e-6) continue;
      const ticked = group.options.filter(option => !selectedIds || selectedIds.includes(option.id));
      // The stop's own name is its ticked places joined; matching it keeps the
      // trail start or end, at the same km as a group, from being renamed.
      if (ticked.length === 0 || ticked.map(option => option.name).join(' / ') !== name) continue;
      // `resupplyGroupChoice`'s rule: more than one place ticked is undecided.
      if (ticked.length > 1) return { name: `${resupplyGroupName(group)} (not decided)`, decided: false };
      return { name: resupplyOptionShortName(ticked[0], group), decided: true };
    }
    return null;
  };
  const from = nameAt(leg.fromKm, leg.fromName);
  const to = nameAt(leg.toKm, leg.toName);
  return { from: from?.name ?? leg.fromName, to: to?.name ?? leg.toName, toDecided: to?.decided ?? true };
}

/**
 * The off-trail km a leg covers without walking, which its days and food leave
 * out: "35.0 km hitch in · 24.1 km hitch out, not walked". Empty when there are none.
 */
export function legRidesText(leg: Pick<ResupplyLeg, 'rides'>, formatKm: (km: number) => string): string {
  if (leg.rides.length === 0) return '';
  const parts = leg.rides.map(
    ride => `${formatKm(ride.km)} ${rideWord(ride.mode)} ${ride.end === 'to' ? 'in' : 'out'}`
  );
  return `${parts.join(' · ')}, not walked`;
}

/**
 * The extra beyond the turn-off on the way to a stop, for a readout that
 * measures to the turn-off ("12.3 km + 2.0 km off trail"): the walk in, or the
 * ride in. Empty for a stop on the route.
 */
export function stopAccessText(access: StopAccess | undefined, formatKm: (km: number) => string): string {
  if (!access) return '';
  if (access.walkKm > 0) return `+ ${formatKm(access.walkKm)} off trail`;
  if (access.rideKm > 0) return `+ ${formatKm(access.rideKm)} ${rideWord(access.rideMode)}`;
  return '';
}

/** "hitch", "shuttle", "boat" — or, when the data does not say how, "off trail". */
function rideWord(mode: LegRide['mode']): string {
  return mode ?? 'off trail';
}

/** The words for each {@link StoreKind}, the one place both platforms take them from. */
export const STORE_KIND_LABELS: Readonly<Record<StoreKind, string>> = {
  full: 'Full resupply',
  limited: 'Small store',
  meals: 'Meals / parcel only',
  none: 'No shop',
};

/**
 * What a place sells, in words: "Full resupply", "Small store", "Meals /
 * parcel only", "No shop" — and "Box only" for a place with no shop that holds
 * a mailed box (the CDT's Benchmark Wilderness Ranch). Null when the data does
 * not say, so a UI shows nothing rather than guessing.
 */
export function storeLabel(option: Pick<ResupplyOption, 'store' | 'acceptsBoxes'>): string | null {
  if (!option.store) return null;
  if (option.store === 'none' && option.acceptsBoxes === true) return 'Box only';
  return STORE_KIND_LABELS[option.store];
}
