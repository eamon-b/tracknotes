/**
 * The resupply page's view: one row per candidate stop, the legs between the
 * chosen ones, and the summary strip above them — as pure functions of the
 * shared calculators' output, so the page module only wires state and events.
 *
 * Nothing here computes a leg. `computeResupplyLegs` and
 * `summariseResupplyPlan` (`@lib/resupply-plan`) are the one implementation of
 * the figures; this module places them against the rows (a leg belongs to the
 * row of the stop it arrives at) and words them through `@lib/resupply-display`.
 * Every string that comes from trail data goes through `escapeHtml`.
 */

import type { StopServices } from '@lib/plan-editor';
import { PLAN_LIMITS } from '@lib/plan-types';
import {
  optionAccess,
  resupplyGroupChoice,
  type ResupplyGroupChoice,
  type ResupplyLeg,
  type ResupplyOption,
  type ResupplyOptionGroup,
  type ResupplyPlanSummary,
} from '@lib/resupply-plan';
import {
  firstSentence,
  legDistanceText,
  legRidesText,
  legEndpointNames,
  legSideTripText,
  resupplyGroupName,
  resupplyOptionShortName,
  resupplyTurnOffText,
  storeLabel,
  type LegEndpointNames,
} from '@lib/resupply-display';
import { baseWaypointType, waypointTypeLabel } from '@lib/waypoint-taxonomy';
import { escapeHtml } from '../web-utils';
import { servicesStripHtml } from './stop-services';

// The web pages are metric; the shared display helpers take the formatter so
// the phone can follow the hiker's unit setting with the same words.
export const formatKm = (km: number): string => `${km.toFixed(1)} km`;

/** Two legs, or a leg and a group, at one km: the scale is rounded to 0.1 km and below. */
const KM_MATCH = 1e-6;

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

/** One option of a group, as the table shows it. */
export interface ResupplyOptionRow {
  option: ResupplyOption;
  /** The hiker goes here: the group's choice is this option. */
  chosen: boolean;
  /** The leg arriving here, when this option is the group's choice. */
  leg: ResupplyLeg | null;
  /** The hiker's zero days here (0 when none are stored). */
  zeroDays: number;
}

/** A group of options reached from one point on the route. */
export interface ResupplyGroupRow {
  group: ResupplyOptionGroup;
  choice: ResupplyGroupChoice;
  /**
   * More than one option: a decision (pick one, or none). One option is a
   * plain Yes/No.
   */
  isDecision: boolean;
  options: ResupplyOptionRow[];
  /**
   * The leg arriving at the group while it is undecided: the calculator counts
   * every ticked option as one stop until the hiker picks, and the figures sit
   * on the group's own row rather than on any one option.
   */
  undecidedLeg: ResupplyLeg | null;
}

export interface ResupplyView {
  startName: string;
  endName: string;
  /** Active-direction km of the trail end. */
  endKm: number;
  groups: ResupplyGroupRow[];
  /** The leg arriving at the trail end — the carry out of the last chosen stop. */
  endLeg: ResupplyLeg | null;
  /** Groups with more than one option still ticked. */
  undecidedCount: number;
  /**
   * What each leg's ends are called (`legEndpointNames`): a stop not decided
   * yet goes by its group, not by every place still ticked.
   */
  legNames: ReadonlyMap<ResupplyLeg, LegEndpointNames>;
}

export interface ResupplyViewInput {
  /** Active-direction groups, `listResupplyOptions(resupplyCandidates(trail))`. */
  groups: readonly ResupplyOptionGroup[];
  /** The plan's `resupplyStops`; `undefined` = every option, as everywhere else. */
  selectedIds: readonly string[] | undefined;
  /** `computeResupplyLegs` over the same groups and selection. */
  legs: readonly ResupplyLeg[];
  /** The plan's zero days, by option id. */
  zeroDays: Readonly<Record<string, number>> | undefined;
  /** Active-direction km of the trail end. */
  totalKm: number;
}

/**
 * Lay the legs against the rows. A leg belongs to the stop it arrives at: the
 * group at its `toKm` that still has an option ticked (the calculator merges
 * stops at one km, keeping the first, so the first such group takes it), and
 * the last leg — the run to the trail end — to the end row.
 */
export function buildResupplyView(input: ResupplyViewInput): ResupplyView {
  const legs = input.legs;
  const lastLeg = legs.length > 0 ? legs[legs.length - 1] : null;
  const arriving = lastLeg ? legs.slice(0, -1) : [];
  const claimed = new Set<number>();

  const legAt = (km: number): ResupplyLeg | null => {
    for (let i = 0; i < arriving.length; i++) {
      if (claimed.has(i)) continue;
      if (Math.abs(arriving[i].toKm - km) < KM_MATCH) {
        claimed.add(i);
        return arriving[i];
      }
    }
    return null;
  };

  let undecidedCount = 0;
  const groups: ResupplyGroupRow[] = input.groups.map(group => {
    const choice = resupplyGroupChoice(group, input.selectedIds);
    const leg = choice.kind === 'none' ? null : legAt(group.km);
    if (choice.kind === 'undecided') undecidedCount++;
    const options = group.options.map(option => {
      const chosen = choice.kind === 'chosen' && choice.optionId === option.id;
      return {
        option,
        chosen,
        leg: chosen ? leg : null,
        zeroDays: zeroDaysFor(input.zeroDays, option.id),
      };
    });
    return {
      group,
      choice,
      isDecision: group.options.length > 1,
      options,
      undecidedLeg: choice.kind === 'undecided' ? leg : null,
    };
  });

  const legNames = new Map<ResupplyLeg, LegEndpointNames>();
  for (const leg of legs) legNames.set(leg, legEndpointNames(leg, input.groups, input.selectedIds));

  return {
    startName: legs.length > 0 ? legs[0].fromName : 'Trail Start',
    endName: lastLeg ? lastLeg.toName : 'Trail End',
    endKm: input.totalKm,
    groups,
    endLeg: lastLeg,
    undecidedCount,
    legNames,
  };
}

function zeroDaysFor(zeroDays: Readonly<Record<string, number>> | undefined, id: string): number {
  if (!zeroDays || !Object.prototype.hasOwnProperty.call(zeroDays, id)) return 0;
  const value = zeroDays[id];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

// ---------------------------------------------------------------------------
// Per-option wording
// ---------------------------------------------------------------------------

/** How the place is reached from the route: "On trail", "Walk", "Hitch", … */
export function accessModeText(option: ResupplyOption): string {
  const access = optionAccess(option);
  if (!access) return 'On trail';
  if (access.walkKm > 0) return access.via ? `Walk via ${access.via}` : 'Walk';
  switch (access.rideMode) {
    case 'hitch':
      return 'Hitch';
    case 'shuttle':
      return 'Shuttle';
    case 'boat':
      return 'Boat';
    default:
      // A distance the data gives no way for, too long to count as a walk:
      // the calculator reports it as not walked, so the row says why.
      return 'Way not given (not walked)';
  }
}

/** The one-way distance off the route, or null for a place on it. */
export function offTrailKmOneWay(option: ResupplyOption): number | null {
  return typeof option.offTrailKm === 'number' && option.offTrailKm > 0 ? option.offTrailKm : null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface ResupplyRenderOptions {
  /** The planner focused on this option ("show on map"), or null for none. */
  mapHref: (optionId: string) => string | null;
  /**
   * What is within a kilometre of the point on the route, from the trail's
   * OSM POIs; undefined when the trail has no POI data.
   */
  services?: (km: number) => StopServices | undefined;
}

const COLUMNS: ReadonlyArray<{ key: string; label: string; numeric?: boolean }> = [
  { key: 'km', label: 'km', numeric: true },
  { key: 'stop', label: 'Stop' },
  { key: 'store', label: 'Store' },
  { key: 'off', label: 'Off trail km (one way)', numeric: true },
  { key: 'access', label: 'Access' },
  { key: 'boxes', label: 'Boxes' },
  { key: 'go', label: 'Go?' },
  { key: 'zero', label: 'Zero days', numeric: true },
  { key: 'leg', label: 'Leg km', numeric: true },
  { key: 'ascent', label: 'Ascent m', numeric: true },
  { key: 'descent', label: 'Descent m', numeric: true },
  { key: 'days', label: 'Days', numeric: true },
  { key: 'food', label: 'Food kg', numeric: true },
  { key: 'notes', label: 'Services & notes' },
];

/** One cell, labelled for the stacked phone layout. */
function td(key: string, content: string, extraClass = ''): string {
  const column = COLUMNS.find(col => col.key === key)!;
  const classes = [`rs-c-${key}`, column.numeric ? 'rs-num' : '', extraClass].filter(Boolean).join(' ');
  const empty = content.trim() === '' ? ' rs-empty' : '';
  return `<td class="${classes}${empty}" data-label="${escapeHtml(column.label)}"><div class="rs-v">${content}</div></td>`;
}

/** The five leg cells: distance (with side trip and rides), climb, days, food. */
function legCells(leg: ResupplyLeg | null, view: ResupplyView): string {
  if (!leg) return ['leg', 'ascent', 'descent', 'days', 'food'].map(key => td(key, '')).join('');
  const names = view.legNames.get(leg) ?? { from: leg.fromName, to: leg.toName, toDecided: true };
  // An undecided stop's walk is the longest of its places': no name for it.
  const sideTrip = legSideTripText(leg, formatKm, names.toDecided ? names.to : null);
  const rides = legRidesText(leg, formatKm);
  const distance =
    `<span class="rs-figure" title="${escapeHtml(legDistanceText(leg, formatKm))}">${leg.walkedKm.toFixed(1)}</span>` +
    `<span class="rs-sub" title="${escapeHtml(leg.fromName)}">from ${escapeHtml(names.from)}</span>` +
    (sideTrip ? `<span class="rs-sub">${escapeHtml(sideTrip)}</span>` : '') +
    (rides ? `<span class="rs-sub rs-rides">${escapeHtml(rides)}</span>` : '');
  const days =
    `<span class="rs-figure" title="${escapeHtml(`${leg.estimatedHours} h walking`)}">${leg.estimatedDays}</span>` +
    (leg.isLong ? '<span class="rs-flag" title="Longer than your long-carry threshold">Long carry</span>' : '');
  return [
    td('leg', distance),
    td('ascent', `<span class="rs-figure">${leg.ascentM}</span>`),
    td('descent', `<span class="rs-figure">${leg.descentM}</span>`),
    td('days', days, leg.isLong ? 'is-long' : ''),
    td('food', `<span class="rs-figure">${leg.food.weightKg.toFixed(1)}</span>`),
  ].join('');
}

/** The services strip (on-route places only) and the description, its full text expandable. */
function notesCell(option: ResupplyOption, opts: ResupplyRenderOptions): string {
  // The POIs are measured along the route, so they describe a place on it, not
  // a town a hitch away from the turn-off.
  const off = offTrailKmOneWay(option);
  const services = off === null || off <= 1 ? servicesStripHtml(opts.services?.(option.km)) : '';
  const description = option.description?.trim() ?? '';
  let notes = '';
  if (description) {
    const lead = firstSentence(description);
    notes =
      lead && lead !== description
        ? `<details class="rs-notes"><summary>${escapeHtml(lead)}</summary><p>${escapeHtml(description)}</p></details>`
        : `<p class="rs-notes">${escapeHtml(description)}</p>`;
  }
  return services + notes;
}

/**
 * The stop's name, its kind, and the "show on map" link. The name is the short
 * one (`resupplyOptionShortName`), the full one kept as its tooltip.
 */
function stopCell(option: ResupplyOption, opts: ResupplyRenderOptions, group: ResupplyOptionGroup): string {
  const href = opts.mapHref(option.id);
  const link = href ? ` <a class="rs-map-link" href="${escapeHtml(href)}">show on map</a>` : '';
  const short = resupplyOptionShortName(option, group);
  const title = short !== option.name ? ` title="${escapeHtml(option.name)}"` : '';
  // A one-place turn-off has no group header, so its row says where it leaves
  // the route: "Town · turn-off at Cumbres Pass (CO 17)".
  const turnOff = resupplyTurnOffText(group);
  const kind = turnOff
    ? `${waypointTypeLabel(baseWaypointType(option.type))} · ${turnOff}`
    : waypointTypeLabel(option.type);
  return (
    `<span class="rs-name"${title}>${escapeHtml(short)}</span>` +
    `<span class="rs-sub">${escapeHtml(kind)}${link}</span>`
  );
}

function zeroDaysInput(row: ResupplyOptionRow, readOnly: boolean): string {
  if (!row.chosen) return '';
  const id = `rs-zero-${row.option.id}`;
  return (
    `<label class="rs-visually-hidden" for="${escapeHtml(id)}">Zero days at ${escapeHtml(row.option.name)}</label>` +
    `<input type="number" class="rs-zero" id="${escapeHtml(id)}" min="0" max="${PLAN_LIMITS.zeroDaysMax}" step="0.5" inputmode="decimal"` +
    ` data-option-id="${escapeHtml(row.option.id)}" value="${row.zeroDays}"${readOnly ? ' disabled' : ''} />`
  );
}

/** The cells every option row shares, before its choice control. */
function optionInfoCells(option: ResupplyOption, opts: ResupplyRenderOptions, group: ResupplyOptionGroup): string {
  const off = offTrailKmOneWay(option);
  const boxes = option.acceptsBoxes === true ? 'Yes' : option.acceptsBoxes === false ? 'No' : '';
  return [
    td('km', option.km.toFixed(1)),
    td('stop', stopCell(option, opts, group)),
    td('store', escapeHtml(storeLabel(option) ?? '')),
    td('off', off === null ? '' : off.toFixed(1)),
    td('access', escapeHtml(accessModeText(option))),
    td('boxes', boxes),
  ].join('');
}

function radio(name: string, value: string, checked: boolean, label: string, readOnly: boolean): string {
  return (
    `<label class="rs-choice"><input type="radio" name="${escapeHtml(name)}" value="${escapeHtml(value)}"` +
    `${checked ? ' checked' : ''}${readOnly ? ' disabled' : ''} /> ${escapeHtml(label)}</label>`
  );
}

/** A single-option group: one row, Yes or No. */
function singleGroupHtml(
  row: ResupplyGroupRow,
  opts: ResupplyRenderOptions,
  readOnly: boolean,
  view: ResupplyView
): string {
  const optionRow = row.options[0];
  const name = `rs-group-${row.group.key}`;
  const yes = row.choice.kind === 'chosen';
  const choice =
    `<div class="rs-yesno" role="radiogroup" aria-label="${escapeHtml(`Resupply at ${optionRow.option.name}?`)}">` +
    radio(name, optionRow.option.id, yes, 'Yes', readOnly) +
    radio(name, '', !yes, 'No', readOnly) +
    '</div>';
  return `<tbody class="rs-group${yes ? ' is-chosen' : ''}" data-group-key="${escapeHtml(row.group.key)}">
    <tr class="rs-row rs-option${yes ? ' is-chosen' : ''}" data-option-id="${escapeHtml(optionRow.option.id)}">
      ${optionInfoCells(optionRow.option, opts, row.group)}${td('go', choice)}${td('zero', zeroDaysInput(optionRow, readOnly))}${legCells(optionRow.leg, view)}${td('notes', notesCell(optionRow.option, opts))}
    </tr>
  </tbody>`;
}

/** A decision group: a header row, one radio row per option, and "None – carry through". */
function decisionGroupHtml(
  row: ResupplyGroupRow,
  opts: ResupplyRenderOptions,
  readOnly: boolean,
  view: ResupplyView
): string {
  const name = `rs-group-${row.group.key}`;
  const undecided = row.choice.kind === 'undecided';
  const label = resupplyGroupName(row.group);
  const state =
    row.choice.kind === 'undecided'
      ? '<span class="rs-undecided">Not decided yet</span>'
      : row.choice.kind === 'none'
        ? '<span class="rs-state">Carrying through</span>'
        : '';
  const header = `<tr class="rs-row rs-group-head${undecided ? ' is-undecided' : ''}">
      ${td('km', row.group.km.toFixed(1))}
      <td class="rs-c-group" colspan="7" data-label="Decision">
        <span class="rs-group-title">${escapeHtml(label)}</span>
        <span class="rs-sub">Pick one place, or none.</span> ${state}
        ${undecided ? '<span class="rs-sub">Until you pick, the leg counts every option still ticked as one stop.</span>' : ''}
      </td>
      ${legCells(row.undecidedLeg, view)}
      ${td('notes', '')}
    </tr>`;

  const options = row.options
    .map(
      optionRow => `<tr class="rs-row rs-option${optionRow.chosen ? ' is-chosen' : ''}" data-option-id="${escapeHtml(optionRow.option.id)}">
      ${optionInfoCells(optionRow.option, opts, row.group)}${td('go', radio(name, optionRow.option.id, optionRow.chosen, 'Go here', readOnly))}${td('zero', zeroDaysInput(optionRow, readOnly))}${legCells(optionRow.leg, view)}${td('notes', notesCell(optionRow.option, opts))}
    </tr>`
    )
    .join('');

  const none = `<tr class="rs-row rs-none">
      <td class="rs-c-none" colspan="${COLUMNS.length}">${radio(name, '', row.choice.kind === 'none', 'None – carry through', readOnly)}</td>
    </tr>`;

  return `<tbody class="rs-group is-decision${undecided ? ' is-undecided' : ''}" data-group-key="${escapeHtml(row.group.key)}">
    ${header}${options}${none}
  </tbody>`;
}

/** The start or end of the trail: a row of its own, so the first and last carries read off the table. */
function endpointHtml(
  kind: 'start' | 'end',
  name: string,
  km: number,
  leg: ResupplyLeg | null,
  view: ResupplyView
): string {
  return `<tbody class="rs-endpoint">
    <tr class="rs-row rs-${kind}">
      ${td('km', km.toFixed(1))}
      <td class="rs-c-stop" colspan="7" data-label="Stop"><span class="rs-name">${escapeHtml(name)}</span></td>
      ${legCells(leg, view)}
      ${td('notes', '')}
    </tr>
  </tbody>`;
}

/** The whole table: header, trail start, one group per turn-off, trail end. */
export function renderResupplyTable(view: ResupplyView, opts: ResupplyRenderOptions, readOnly = false): string {
  const head = COLUMNS.map(
    col => `<th scope="col" class="rs-c-${col.key}${col.numeric ? ' rs-num' : ''}">${escapeHtml(col.label)}</th>`
  ).join('');
  const groups = view.groups
    .map(row =>
      row.isDecision ? decisionGroupHtml(row, opts, readOnly, view) : singleGroupHtml(row, opts, readOnly, view)
    )
    .join('');
  return `<table class="rs-table">
    <thead><tr>${head}</tr></thead>
    ${endpointHtml('start', view.startName, 0, null, view)}
    ${groups}
    ${endpointHtml('end', view.endName, view.endKm, view.endLeg, view)}
  </table>`;
}

/** One figure of the summary strip. */
function tile(label: string, value: string, note = ''): string {
  return `<div class="rs-tile"><span class="rs-tile-label">${escapeHtml(label)}</span><span class="rs-tile-value">${escapeHtml(value)}</span>${
    note ? `<span class="rs-tile-note">${escapeHtml(note)}</span>` : ''
  }</div>`;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The totals strip: `summariseResupplyPlan`'s figures, and how many decisions are still open. */
export function renderResupplySummary(
  summary: ResupplyPlanSummary,
  undecidedCount: number,
  { canClear = false, readOnly = false }: { canClear?: boolean; readOnly?: boolean } = {}
): string {
  if (!summary.hasData) return '<p class="rs-empty-note">Nothing to plan on this trail.</p>';
  const tiles = [
    tile('Stops chosen', String(summary.stopsChosen)),
    tile('Longest leg', formatKm(summary.longestLegKm), 'as walked'),
    tile('Most climbing on a leg', `${summary.mostClimbM} m`),
    tile('Longest carry', plural(summary.longestCarryDays, 'day')),
    tile('Heaviest food carry', `${summary.heaviestFoodKg.toFixed(1)} kg`),
    tile('Total walking', formatKm(summary.totalWalkingKm), 'trail and side trips'),
    tile(
      'Total days',
      String(summary.totalDays),
      summary.zeroDays > 0 ? `incl. ${plural(summary.zeroDays, 'zero day')}` : 'no zero days'
    ),
  ].join('');
  const open =
    undecidedCount > 0
      ? `<p class="rs-open-note">${escapeHtml(plural(undecidedCount, 'decision'))} not made yet — until you pick, each counts every option still ticked as one stop.</p>`
      : '';
  // Back to "no resupply plan made" (the phone's Clear choices): the choices
  // and the zero days go. Offered only once there is something to clear.
  const clear =
    canClear && !readOnly
      ? '<button type="button" id="rs-clear" class="plan-header-btn rs-clear">Clear choices</button>'
      : '';
  const row = open || clear ? `<div class="rs-open-row">${open}${clear}</div>` : '';
  return `<div class="rs-tiles">${tiles}</div>${row}`;
}
