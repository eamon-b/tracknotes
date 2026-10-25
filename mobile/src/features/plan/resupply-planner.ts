/**
 * The resupply screen's view-model: what each row says, and the plan edits its
 * controls make. Pure and React-free, so the screen stays a thin shell and all
 * of this is unit-tested.
 *
 * The screen reads like the hiker's planning spreadsheet: one row per decision
 * group (the places reached from one turn-off), and between each pair of
 * chosen stops the leg that connects them — start → leg → stop → leg → … →
 * end. A leg is drawn just above the stop it arrives at, so its side trip
 * ("incl. 2.8 km to Salida and back") sits next to the place it walks to.
 *
 * Nothing here measures anything: options, groups, choices, legs and the
 * summary are `@lib/resupply-plan`'s, and the words `@lib/resupply-display`'s.
 * This only arranges them and words the few things the shared module does
 * not (a group's "Not decided yet", the zero-days stepper).
 */

import {
  resupplyGroupChoice,
  type ResupplyGroupChoice,
  type ResupplyLeg,
  type ResupplyOption,
  type ResupplyOptionGroup,
  type ResupplyPlanSummary,
} from '@lib/resupply-plan';
import { accessSummary, firstSentence, storeLabel } from '@lib/resupply-display';
import { chooseResupplyOption, setResupplyStops, setResupplyZeroDays } from '@lib/plan-editor';
import type { Pace, PlanDocument } from '@lib/plan-types';
import type { Units } from '../../state/settings-store';
import { formatFoodPerDay, PACE_LABELS } from './plan-format';

/** The section the legs are scoped to, with the names its two ends go by. */
export interface PlannerRange {
  startKm: number;
  endKm: number;
  startName: string;
  endName: string;
}

/** One row of the screen, top to bottom. */
export type PlannerRow =
  | { kind: 'start'; key: string; name: string; km: number }
  | { kind: 'end'; key: string; name: string; km: number }
  | {
      kind: 'group';
      key: string;
      group: ResupplyOptionGroup;
      choice: ResupplyGroupChoice;
      /** Inside the section the legs cover; a group outside it is shown, dimmed, but has no leg. */
      inSection: boolean;
      /** The chosen option's zero days (0 when none are set, or nothing is chosen). */
      zeroDays: number;
    }
  | { kind: 'leg'; key: string; leg: ResupplyLeg };

/** Floating-point slack when matching a leg's end to a group's km. */
const KM_EPSILON = 1e-6;

/** Zero days move in half days. */
export const ZERO_DAYS_STEP = 0.5;
/** The stepper's ceiling: a bound on the control, not a judgement of the hiker's. */
export const ZERO_DAYS_MAX = 30;

function inRange(km: number, range: PlannerRange): boolean {
  return km >= range.startKm - KM_EPSILON && km <= range.endKm + KM_EPSILON;
}

/**
 * The rows for a trail's groups under a selection (`undefined` = every
 * option), with the legs `computeResupplyLegs` measured for it.
 *
 * Groups are walked in km order (the trail passed to the calculator is
 * direction-applied, so that is walking order). A group that resolves to a
 * stop takes the next leg when that leg ends at its km; whatever legs are left
 * after the last group — the run-in to the end — go before the end row.
 */
export function plannerRows(
  groups: readonly ResupplyOptionGroup[],
  selectedIds: readonly string[] | undefined,
  legs: readonly ResupplyLeg[],
  range: PlannerRange,
  zeroDays: Readonly<Record<string, number>> | undefined,
): PlannerRow[] {
  const rows: PlannerRow[] = [];
  const sorted = [...groups].sort((a, b) => a.km - b.km);
  let legIdx = 0;
  let startPlaced = false;
  let endPlaced = false;

  const placeStart = () => {
    if (startPlaced) return;
    startPlaced = true;
    rows.push({ kind: 'start', key: 'start', name: range.startName, km: range.startKm });
  };
  // The legs left over (the run-in to the end), then the end itself.
  const placeEnd = () => {
    if (endPlaced) return;
    endPlaced = true;
    placeStart();
    for (; legIdx < legs.length; legIdx++) {
      rows.push({ kind: 'leg', key: `leg-${legIdx}`, leg: legs[legIdx] });
    }
    rows.push({ kind: 'end', key: 'end', name: range.endName, km: range.endKm });
  };

  for (const group of sorted) {
    // Groups outside the section are listed where they fall, dimmed, either side of it.
    if (group.km >= range.startKm - KM_EPSILON) placeStart();
    if (group.km > range.endKm + KM_EPSILON) placeEnd();
    const choice = resupplyGroupChoice(group, selectedIds);
    const inSection = inRange(group.km, range);

    if (inSection && choice.kind !== 'none') {
      // A leg ending short of this stop (one the calculator merged away) is
      // still shown, in order, rather than holding up every leg after it.
      while (legIdx < legs.length && legs[legIdx].toKm < group.km - KM_EPSILON) {
        rows.push({ kind: 'leg', key: `leg-${legIdx}`, leg: legs[legIdx] });
        legIdx++;
      }
      const leg = legs[legIdx];
      if (leg && Math.abs(leg.toKm - group.km) < KM_EPSILON) {
        rows.push({ kind: 'leg', key: `leg-${legIdx}`, leg });
        legIdx++;
      }
    }

    const chosenId = choice.kind === 'chosen' ? choice.optionId : null;
    rows.push({
      kind: 'group',
      key: `group-${group.key}`,
      group,
      choice,
      inSection,
      zeroDays: chosenId !== null ? zeroDaysOf(zeroDays, chosenId) : 0,
    });
  }
  placeEnd();
  return rows;
}

/** A stored zero-days figure, read the way the calculator reads it (anything unusable is 0). */
function zeroDaysOf(zeroDays: Readonly<Record<string, number>> | undefined, id: string): number {
  if (!zeroDays || !Object.prototype.hasOwnProperty.call(zeroDays, id)) return 0;
  const value = zeroDays[id];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** How many groups inside the section still have more than one place ticked. */
export function undecidedCount(
  groups: readonly ResupplyOptionGroup[],
  selectedIds: readonly string[] | undefined,
  range: Pick<PlannerRange, 'startKm' | 'endKm'> | null,
): number {
  return groups.filter(
    (group) =>
      (!range ||
        (group.km >= range.startKm - KM_EPSILON && group.km <= range.endKm + KM_EPSILON)) &&
      resupplyGroupChoice(group, selectedIds).kind === 'undecided',
  ).length;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * The Plan screen's Resupply row: "5 stops · longest 7 days", plus how many
 * groups are still to decide. No stop in the section is the full carry, and
 * says so.
 */
export function resupplyEntryText(
  summary: ResupplyPlanSummary,
  opts: { hasOptions: boolean; undecided: number },
): string {
  if (!summary.hasData) return opts.hasOptions ? 'Choose where to resupply' : 'No resupply data';
  const carry = `${plural(summary.longestCarryDays, 'day')}`;
  const head = !opts.hasOptions
    ? `No resupply on this trail · full carry ${carry}`
    : summary.stopsChosen === 0
      ? `No stops · full carry ${carry}`
      : `${plural(summary.stopsChosen, 'stop')} · longest ${carry}`;
  return opts.undecided > 0 ? `${head} · ${opts.undecided} to decide` : head;
}

/** What a row says about one option, in the order the screen shows it. */
export interface OptionFacts {
  /** "Full resupply", "Small store", … — null when the data does not say. */
  store: string | null;
  /** "22.5 km hitch", "1.2 km on foot via …", or "On trail". */
  access: string;
  acceptsBoxes: boolean;
  /** The description's first sentence; '' when there is none. */
  lead: string;
  /** The whole description's prose, when it says more than the first sentence. */
  more: string | null;
}

export function optionFacts(option: ResupplyOption, formatKm: (km: number) => string): OptionFacts {
  const offTrail = typeof option.offTrailKm === 'number' && option.offTrailKm > 0;
  const prose = option.description ? descriptionProse(option.description) : '';
  const lead = option.description ? firstSentence(option.description) : '';
  return {
    store: storeLabel(option),
    access: offTrail ? accessSummary(option, formatKm) : 'On trail',
    acceptsBoxes: option.acceptsBoxes === true,
    lead,
    more: prose !== '' && prose !== lead ? prose : null,
  };
}

/**
 * The prose of a description: the generators prefix theirs with `|`-separated
 * metadata ("mi 1947.3 | CO | Leave the CDT here…"), which `firstSentence`
 * also skips, so the expanded text starts where the first sentence does.
 */
function descriptionProse(text: string): string {
  const segments = text
    .split('|')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  return segments.length > 0 ? segments[segments.length - 1] : '';
}

/**
 * The hiker's figures the legs were measured with, as one line above them:
 * "Average pace · 8 h/day · 680 g food/day · long carry over 5 days".
 */
export function resupplyInputsLine(
  inputs: {
    pace: Pace;
    dailyHours: number;
    foodGramsPerDay: number;
    longCarryDays: number;
  },
  units: Units,
): string {
  return [
    `${PACE_LABELS[inputs.pace]} pace`,
    `${inputs.dailyHours} h/day`,
    `${formatFoodPerDay(inputs.foodGramsPerDay, units)} food/day`,
    `long carry over ${plural(inputs.longCarryDays, 'day')}`,
  ].join(' · ');
}

/** One half-day step up or down, held inside the stepper's bounds. */
export function stepZeroDays(current: number, direction: 1 | -1): number {
  const snapped = Math.round(current / ZERO_DAYS_STEP) * ZERO_DAYS_STEP;
  return Math.min(ZERO_DAYS_MAX, Math.max(0, snapped + direction * ZERO_DAYS_STEP));
}

/** "No zero days", "½ day", "1 day", "1½ days". */
export function formatZeroDays(days: number): string {
  if (days <= 0) return 'None';
  const whole = Math.floor(days);
  const half = days - whole >= ZERO_DAYS_STEP - KM_EPSILON;
  const figure = `${whole > 0 ? whole : ''}${half ? '½' : ''}`;
  return `${figure} ${days <= 1 ? 'day' : 'days'}`;
}

/**
 * The selection an edit starts from: the document's, or — only while it has
 * none — the device-local one an older build left behind (read when the edit
 * runs, as every reader does), made explicit on the document first.
 */
function withSelection(plan: PlanDocument, legacy: readonly string[] | undefined): PlanDocument {
  return plan.resupplyStops === undefined && legacy !== undefined
    ? setResupplyStops(plan, legacy)
    : plan;
}

/**
 * The edit for picking one place in a group, or none of it (`null`). Built
 * from the document it is handed when it runs, so two quick taps on different
 * groups each build on the other.
 */
export function chooseResupplyEditor(
  groups: readonly ResupplyOptionGroup[],
  groupKey: string,
  optionId: string | null,
  legacy: () => readonly string[] | undefined,
): (plan: PlanDocument) => PlanDocument {
  return (plan) => chooseResupplyOption(withSelection(plan, legacy()), groups, groupKey, optionId);
}

/**
 * The edit for one press of the zero-days stepper: a step from whatever the
 * document holds when it runs, not from the figure the screen rendered with.
 */
export function zeroDaysStepEditor(
  optionId: string,
  direction: 1 | -1,
): (plan: PlanDocument) => PlanDocument {
  return (plan) =>
    setResupplyZeroDays(
      plan,
      optionId,
      stepZeroDays(zeroDaysOf(plan.resupplyZeroDays, optionId), direction),
    );
}
