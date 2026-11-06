/**
 * A plan, written out for other apps: GPX for a GPS or mapping app, iCalendar
 * (.ics) for a calendar. Both are text; the platforms decide how a file is
 * handed over (a download on the web, the share sheet on the phone).
 *
 * Nothing here plans anything. Both writers take what the planner has already
 * worked out — the days from `computePlanDays`, the resupply stops and legs
 * from `resolveResupplyStops`/`computeResupplyLegs` — over the trail it worked
 * them out on, so the file says exactly what the page or screen does.
 *
 * **What the caller passes.** `trail` is the route the plan walks, oriented in
 * the plan's direction: the trail with the plan's alternates spliced in
 * (`plannedRouteTrail`) and reversed for SOBO — the web page's `activeTrail()`,
 * the phone's `usePlanRoute().trail`. `plan` is the document in route km
 * (`planToRoute`), the one handed to `computePlanDays`; its stops are mirrored
 * into the active direction here, as `computePlanDays` does. Every km in the
 * files is the active direction's km along the route as planned.
 *
 * RN-safe: no DOM, no Node, no crypto.
 */

import { hashString } from './gpx-import';
import { KM_EPSILON, stopsToActive, type PlanDirection } from './plan-direction';
import { startZeroDateOffset, startZeroDaysOf } from './plan-editor';
import type { ComputedDay, PlanStop } from './plan-types';
import { legsArrivingAtStops, type ResupplyLeg, type ResupplyStop } from './resupply-plan';
import { routeBreakStarts, sliceAcrossRouteBreaks } from './route-breaks';
import type { RouteBreak } from './trail-types';
import { findNearestByDistance } from './track-geometry';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** A track point of the route as planned. */
export interface PlanExportPoint {
  lat: number;
  lon: number;
  ele?: number | null;
  /** Cumulative km along the route, in the active direction. */
  dist: number;
}

/** What the writers read of the trail: structural, so both platforms' trails fit. */
export interface PlanExportTrail {
  config: { name: string };
  track: {
    points: readonly PlanExportPoint[];
    totalDistance: number;
    breaks?: readonly Pick<RouteBreak, 'index' | 'displayIndex'>[];
  };
  waypoints?: readonly { id?: string; lat?: number; lon?: number }[];
}

/** The plan as the planner holds it (route km, stored direction). */
export interface PlanExportPlan {
  id: string;
  trailId: string;
  name: string;
  direction: PlanDirection;
  startDate: string | null;
  /** Zero days before day 1 (`PlanDocument.startZeroDays`); absent is none. */
  startZeroDays?: number;
  stops: readonly PlanStop[];
}

export interface PlanExportInput {
  plan: PlanExportPlan;
  /** The route the plan walks, oriented in its direction (see the module comment). */
  trail: PlanExportTrail;
  /** The planned days (`computePlanDays`, after `splitUnplannedTail`). */
  days: readonly ComputedDay[];
  /** The stretch after the last stop that is not planned yet, when there is one. */
  unplanned?: ComputedDay | null;
  /** The planned resupply stops, active km (`resolveResupplyStops`). */
  resupplyStops?: readonly ResupplyStop[];
  /**
   * The resupply legs (`computeResupplyLegs` with `days` and the plan's
   * `resupplyZeroDays`): where each arrives, and its zero days.
   */
  resupplyLegs?: readonly ResupplyLeg[];
  /** km → display text; the hiker's units. Default "12.3 km". */
  formatDistance?: (km: number) => string;
  /** metres → display text. Default "450 m". */
  formatElevation?: (m: number) => string;
}

export interface PlanIcsInput extends PlanExportInput {
  /** The DTSTAMP of every event — the export time. Passed in so output is reproducible. */
  dtstamp: Date | string;
}

const defaultDistance = (km: number): string => `${km.toFixed(1)} km`;
const defaultElevation = (m: number): string => `${Math.round(m)} m`;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Whether a character (one code point) may appear in an XML 1.0 document. A
 * lone surrogate comes out of `for…of` as a single unit and is refused too.
 */
function isXmlChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  if (code === 0x9 || code === 0xa || code === 0xd) return true;
  if (code < 0x20) return false;
  if (code >= 0xd800 && code <= 0xdfff) return false;
  return code !== 0xfffe && code !== 0xffff;
}

/** Text for an XML element or attribute: escaped, and stripped of what XML cannot carry. */
export function xmlText(value: unknown): string {
  if (value == null) return '';
  let clean = '';
  for (const char of String(value)) if (isXmlChar(char)) clean += char;
  return clean
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** A stop of the plan in the active direction, matched to the day it ends. */
function stopEndingDay(stops: readonly PlanStop[], day: ComputedDay): PlanStop | undefined {
  return stops.find(stop => Math.abs(stop.km - day.endKm) <= KM_EPSILON);
}

function activeStops(input: PlanExportInput): PlanStop[] {
  return stopsToActive([...input.plan.stops], input.plan.direction, input.trail.track.totalDistance);
}

/** The point of the route at `km` (the nearest track point at or after it). */
function pointAtKm(points: readonly PlanExportPoint[], km: number): PlanExportPoint | undefined {
  if (points.length === 0) return undefined;
  return points[findNearestByDistance(points as PlanExportPoint[], km)];
}

/** Where a place is: its waypoint's own position when the trail has it, else the route at `km`. */
function placePosition(
  input: PlanExportInput,
  waypointId: string | undefined,
  km: number
): { lat: number; lon: number; ele?: number | null } | undefined {
  if (waypointId) {
    const wp = (input.trail.waypoints ?? []).find(w => w.id === waypointId);
    if (wp && isCoordinate(wp.lat, wp.lon)) return { lat: wp.lat as number, lon: wp.lon as number };
  }
  return pointAtKm(input.trail.track.points, km);
}

function isCoordinate(lat: unknown, lon: unknown): boolean {
  return (
    typeof lat === 'number' &&
    typeof lon === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180
  );
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * "1.5 zero days before day 1", or null when the plan has none. The planner's
 * own wording, for the GPX description and the printed heading.
 */
export function startZeroDaysText(plan: Pick<PlanExportPlan, 'startZeroDays'>): string | null {
  const n = startZeroDaysOf(plan);
  return n > 0 ? `${plural(n, 'zero day')} before day 1` : null;
}

/**
 * The dates of the whole zero days before day 1: the start date onwards, one
 * per whole day (`startZeroDateOffset`; a half day is spent on day 1's own
 * date). Empty without a start date.
 */
export function startZeroDayDates(plan: Pick<PlanExportPlan, 'startDate' | 'startZeroDays'>): string[] {
  if (!plan.startDate) return [];
  const whole = startZeroDateOffset(plan);
  return Array.from({ length: whole }, (_, i) => addDays(plan.startDate as string, i));
}

/** The zero days of the leg arriving at a stop at `km`, 0 when none does. */
function zeroDaysAt(legs: readonly ResupplyLeg[] | undefined, km: number): number {
  const leg = (legs ?? []).find(l => Math.abs(l.toKm - km) <= KM_EPSILON);
  return leg?.zeroDays ?? 0;
}

/**
 * A safe file name for a plan's export: the plan's (else the trail's) name
 * slugged, then the extension. `tracknotes-plan` when nothing usable is left.
 */
export function planExportFileName(name: string, extension: 'gpx' | 'ics'): string {
  const slug = String(name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return `${slug || 'tracknotes-plan'}.${extension}`;
}

function planTitle(input: PlanExportInput): string {
  return input.plan.name.trim() || input.trail.config.name;
}

// ---------------------------------------------------------------------------
// GPX
// ---------------------------------------------------------------------------

function wptLines(
  lines: string[],
  pos: { lat: number; lon: number; ele?: number | null },
  name: string,
  type: string,
  desc: string
): void {
  lines.push(`  <wpt lat="${pos.lat}" lon="${pos.lon}">`);
  if (typeof pos.ele === 'number' && Number.isFinite(pos.ele)) lines.push(`    <ele>${round1(pos.ele)}</ele>`);
  lines.push(`    <name>${xmlText(name)}</name>`);
  if (desc) lines.push(`    <desc>${xmlText(desc)}</desc>`);
  lines.push(`    <type>${xmlText(type)}</type>`);
  lines.push(`  </wpt>`);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * The plan as a GPX 1.1 document.
 *
 * - One `<trk>`, the route as planned (alternates the plan takes in place of
 *   the main route they bypass) from the first day's start to the end of the
 *   last day — or of the part not planned yet — with one `<trkseg>` per
 *   walkable stretch: a route break is never joined by a straight line.
 * - A `<wpt>` (`<type>night-stop</type>`) for every night stop a day ends at,
 *   at its place, with its km, nights, booking and note in `<desc>`.
 * - A `<wpt>` (`<type>resupply</type>`) for every planned resupply stop in
 *   range, at the place when one is chosen (else at the turn-off), with its km
 *   and zero days.
 */
export function planToGpx(input: PlanExportInput): string {
  const fmtKm = input.formatDistance ?? defaultDistance;
  const { trail, days } = input;
  const title = planTitle(input);
  const stops = activeStops(input);
  const points = trail.track.points;
  const rangeDays = [...days, ...(input.unplanned ? [input.unplanned] : [])];
  const startKm = rangeDays.length > 0 ? rangeDays[0].startKm : 0;
  const endKm = rangeDays.length > 0 ? rangeDays[rangeDays.length - 1].endKm : trail.track.totalDistance;

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<gpx version="1.1" creator="Tracknotes" xmlns="http://www.topografix.com/GPX/1/1">');
  lines.push('  <metadata>');
  lines.push(`    <name>${xmlText(title)}</name>`);
  const metaDesc = [
    trail.config.name,
    input.plan.direction,
    input.plan.startDate ? `starting ${input.plan.startDate}` : null,
    startZeroDaysText(input.plan),
    plural(days.length, 'day'),
    fmtKm(Math.max(0, endKm - startKm)),
  ]
    .filter(Boolean)
    .join(', ');
  lines.push(`    <desc>${xmlText(metaDesc)}</desc>`);
  lines.push('  </metadata>');

  for (const day of days) {
    const stop = stopEndingDay(stops, day);
    if (!stop) continue;
    const pos = placePosition(input, stop.waypointId, stop.km);
    if (!pos) continue;
    const parts = [`Night ${day.dayNumber}`, `km ${day.endKm.toFixed(1)}`];
    if (stop.nights > 1) parts.push(plural(stop.nights, 'night'));
    if (stop.booked) parts.push('booked');
    const desc = parts.join(' · ') + (stop.note ? `\n${stop.note}` : '');
    wptLines(lines, pos, stop.name, 'night-stop', desc);
  }

  for (const stop of input.resupplyStops ?? []) {
    if (stop.km < startKm - KM_EPSILON || stop.km > endKm + KM_EPSILON) continue;
    const pos = placePosition(input, stop.optionIds.length === 1 ? stop.optionIds[0] : undefined, stop.km);
    if (!pos) continue;
    const parts = ['Resupply', `km ${stop.km.toFixed(1)}`];
    const zero = zeroDaysAt(input.resupplyLegs, stop.km);
    if (zero > 0) parts.push(plural(zero, 'zero day'));
    if (stop.optionIds.length > 1) parts.push('not decided yet');
    wptLines(lines, pos, stop.name, 'resupply', parts.join(' · '));
  }

  lines.push('  <trk>');
  lines.push(`    <name>${xmlText(title)}</name>`);
  if (points.length > 0) {
    const from = findNearestByDistance(points as PlanExportPoint[], startKm);
    const to = findNearestByDistance(points as PlanExportPoint[], endKm);
    const pieces = sliceAcrossRouteBreaks(points, from, to, routeBreakStarts(trail.track.breaks, 'points'));
    for (const piece of pieces) {
      if (piece.length < 2) continue;
      lines.push('    <trkseg>');
      for (const pt of piece) {
        lines.push(`      <trkpt lat="${pt.lat}" lon="${pt.lon}">`);
        if (typeof pt.ele === 'number' && Number.isFinite(pt.ele)) lines.push(`        <ele>${round1(pt.ele)}</ele>`);
        lines.push('      </trkpt>');
      }
      lines.push('    </trkseg>');
    }
  }
  lines.push('  </trk>');
  lines.push('</gpx>');
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// iCalendar
// ---------------------------------------------------------------------------

/** RFC 5545 TEXT escaping: backslash, semicolon, comma and newlines; control characters dropped. */
export function icsText(value: string): string {
  return (
    value
      .replace(/\r\n?/g, '\n')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\n/g, '\\n')
  );
}

function utf8Length(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (code < 0x10000) return 3;
  return 4;
}

/**
 * Fold a content line at 75 octets (RFC 5545 §3.1): each continuation starts
 * with one space, which counts toward its 75. Never splits a UTF-8 sequence.
 */
export function foldIcsLine(line: string): string {
  const out: string[] = [];
  let current = '';
  let octets = 0;
  for (const char of line) {
    const len = utf8Length(char);
    if (octets + len > 75) {
      out.push(current);
      current = ' ';
      octets = 1;
    }
    current += char;
    octets += len;
  }
  out.push(current);
  return out.join('\r\n');
}

function icsDate(iso: string): string {
  return iso.slice(0, 10).replace(/-/g, '');
}

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function icsStamp(value: Date | string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) throw new RangeError('planToIcs: dtstamp is not a valid time');
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/** Whether `planToIcs` can write a calendar: the plan has a start date and a planned day. */
export function canExportIcs(input: Pick<PlanExportInput, 'plan' | 'days'>): boolean {
  return Boolean(input.plan.startDate) && input.days.some(day => typeof day.date === 'string');
}

interface IcsEvent {
  uid: string;
  date: string;
  summary: string;
  description: string;
}

/**
 * The plan as an RFC 5545 calendar: one all-day event per walking day
 * ("Day 3: Hut A → Hut B, 21.4 km") and one per rest day ("Rest day at Hut
 * B"), dated as the planner dates them (`computePlanDays`: a stop's extra
 * nights push every later day back). Null without a start date.
 *
 * Resupply zero days are a separate input that does not move the camp plan's
 * dates (see `computeResupplyLegs`), so the calendar does not add them either:
 * the day that arrives at a resupply stop says so, rest days taken there are
 * labelled as at a resupply stop, and zero days beyond the nights planned
 * there are named in the description, so the hiker can add nights to put them
 * in the calendar.
 *
 * UIDs are derived from the trail id, the plan id and the day, so importing a
 * re-export updates the same events instead of adding a second set.
 */
export function planToIcs(input: PlanIcsInput): string | null {
  if (!canExportIcs(input)) return null;
  const fmtKm = input.formatDistance ?? defaultDistance;
  const fmtEle = input.formatElevation ?? defaultElevation;
  const stamp = icsStamp(input.dtstamp);
  const stops = activeStops(input);
  // Not the run in to the end of the range, which is no stop.
  const legs = legsArrivingAtStops(input.resupplyLegs ?? []);
  const uidBase = `plan-${hashString(`${input.plan.trailId}|${input.plan.id}`)}`;
  const events: IcsEvent[] = [];

  // Zero days before day 1: one event per whole day from the start date. A
  // half day falls on day 1's own date, so it is said on that day's event.
  const startZero = startZeroDaysOf(input.plan);
  const startZeroDates = startZeroDayDates(input.plan);
  const firstDay = input.days.find(day => typeof day.date === 'string');
  startZeroDates.forEach((date, i) => {
    events.push({
      uid: `${uidBase}-start-zero-${i + 1}@tracknotes.info`,
      date,
      summary: firstDay ? `Zero day before day 1 at ${firstDay.startName}` : 'Zero day before day 1',
      description: `${startZeroDaysText(input.plan)}: this is day ${i + 1} of them.`,
    });
  });
  const halfStartZero = startZero % 1 !== 0;

  for (const day of input.days) {
    if (!day.date) continue;
    const stop = stopEndingDay(stops, day);
    // The stops this day reaches: past its start, up to and including its end.
    const arriving = legs.filter(leg => leg.toKm > day.startKm + KM_EPSILON && leg.toKm <= day.endKm + KM_EPSILON);
    const desc: string[] = [];
    if (halfStartZero && day === firstDay) desc.push('Half a zero day first, then the walk.');
    const climb = `↑${fmtEle(day.ascentM)} ↓${fmtEle(day.descentM)}`;
    desc.push(`${fmtKm(day.distanceKm)}, ${climb}, about ${day.estimatedHours.toFixed(1)} h walking.`);
    if (day.offTrailKm && day.offTrailKm > 0) desc.push(`Includes ${fmtKm(day.offTrailKm)} off the route.`);
    desc.push(`Route km ${day.startKm.toFixed(1)} to ${day.endKm.toFixed(1)}.`);
    if (stop) {
      const night = [`Night at ${stop.name}`];
      if (stop.nights > 1) night.push(plural(stop.nights, 'night'));
      if (stop.booked) night.push('booked');
      desc.push(night.join(', ') + '.');
      if (stop.note) desc.push(stop.note);
    }
    const rest = day.restDays ?? 0;
    for (const leg of arriving) {
      const atEnd = Math.abs(leg.toKm - day.endKm) <= KM_EPSILON;
      desc.push(`Resupply at ${leg.toName}${atEnd ? '' : ` (km ${leg.toKm.toFixed(1)})`}.`);
      const uncovered = leg.zeroDays - (atEnd ? rest : 0);
      if (leg.zeroDays > 0 && uncovered > 0) {
        desc.push(
          `${plural(leg.zeroDays, 'zero day')} planned at ${leg.toName}` +
            (atEnd && rest > 0 ? `, ${plural(rest, 'night')} of which are in these dates` : '') +
            '. Add nights at this stop to put the rest in the calendar.'
        );
      }
    }
    events.push({
      uid: `${uidBase}-day-${day.dayNumber}@tracknotes.info`,
      date: day.date,
      summary: `Day ${day.dayNumber}: ${day.startName} → ${day.endName}, ${fmtKm(day.distanceKm)}`,
      description: desc.join('\n'),
    });

    const resupplyHere = arriving.some(leg => Math.abs(leg.toKm - day.endKm) <= KM_EPSILON);
    for (let k = 1; k <= rest; k++) {
      events.push({
        uid: `${uidBase}-day-${day.dayNumber}-rest-${k}@tracknotes.info`,
        date: addDays(day.date, k),
        summary: `Rest day at ${day.endName}`,
        description: resupplyHere ? `Rest day ${k} of ${rest} at a resupply stop.` : `Rest day ${k} of ${rest}.`,
      });
    }
  }

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Tracknotes//Plan export//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsText(planTitle(input))}`,
  ];
  for (const event of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${event.uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${icsDate(event.date)}`,
      `DTEND;VALUE=DATE:${icsDate(addDays(event.date, 1))}`,
      `SUMMARY:${icsText(event.summary)}`,
      `DESCRIPTION:${icsText(event.description)}`,
      'TRANSP:TRANSPARENT',
      'END:VEVENT'
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldIcsLine).join('\r\n') + '\r\n';
}
