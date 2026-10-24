/**
 * Today's plan: the planned day whose date is today, and the waypoints along it.
 *
 * A plan has dates once it has a start date (`computePlanDays` dates every day,
 * pushed back by rest days). On the trail the question is "what am I walking
 * today?", and the answer is one day of the plan — from the stop the hiker slept
 * at to the one they have entered for tonight — with every waypoint between,
 * each with the distance, climb and descent from the row before it.
 *
 * Between the waypoints sit the OpenStreetMap points of interest the hiker's
 * POI filter shows — the konbini, the café, the bus stop — so the day reads as
 * "where can I eat and buy food today?" as well as "where is the water?". They
 * are leads, not checked trail data: they never split a waypoint's leg (the
 * leg figures stay waypoint to waypoint), and they are drawn as OSM rows.
 *
 * Only a *planned* day counts: the "not planned yet" tail does not end at a stop
 * the hiker entered, so a date that falls in it has no plan for today.
 *
 * Pure and React-free; the screen is `app/guide/[trailId]/today.tsx` and the
 * hook `use-today-plan.ts`.
 */

import { addPlaceWalks } from '@lib/day-calculator';
import { KM_EPSILON } from '@lib/plan-direction';
import { interleavePoisByDistance, poisBetween } from '@lib/poi-display';
import type { ComputedDay, SectionConfig } from '@lib/plan-types';
import { routeBreakStarts } from '@lib/route-breaks';
import { calculateElevationBetween } from '@lib/track-geometry';
import type { TrailPOI } from '@lib/trail-types';
import type { TrailJson, TrailJsonWaypoint } from '../../services/trail-assets';
import { placeOffTrailMeters } from '../guide/waypoint-detail';
import type { PlanGlance } from './plan-glance';
import { kmRangeFromParams } from './plan-section';

/** What the plan says about today. */
export type TodayPlan =
  /** A walking day. */
  | { kind: 'walk'; day: ComputedDay }
  /**
   * A rest day at the stop `day` ended at. `restDay` is which of its
   * `restDays` (1-based) today is.
   */
  | { kind: 'rest'; day: ComputedDay; restDay: number; restDays: number };

/** The phone's local calendar date as `YYYY-MM-DD` — the plan's date format. */
export function localIsoDate(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Milliseconds from `now` to the next local midnight, when today's date changes. */
export function msUntilLocalMidnight(now: Date): number {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return midnight.getTime() - now.getTime();
}

/** Whole days from `a` to `b`, both `YYYY-MM-DD`. */
function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/**
 * The planned day dated `today`, or the rest day it falls on; null when the
 * plan has no start date, or today is before its first day or after its last
 * planned one.
 */
export function todayPlan(glance: PlanGlance, today: string): TodayPlan | null {
  for (const day of glance.days) {
    if (day.date === undefined) return null;
    if (day.date === today) return { kind: 'walk', day };
    const restDays = day.restDays ?? 0;
    if (restDays > 0) {
      const after = daysBetween(day.date, today);
      if (after >= 1 && after <= restDays) {
        return { kind: 'rest', day, restDay: after, restDays };
      }
    }
  }
  return null;
}

/** Why there is no walking day to show. */
export function emptyMessage(
  today: TodayPlan | null,
  date: string,
  hasStops: boolean,
  hasStartDate: boolean,
): string {
  if (today?.kind === 'rest') {
    const which = today.restDays > 1 ? ` (${today.restDay} of ${today.restDays})` : '';
    return `A rest day at ${today.day.endName}${which}.`;
  }
  if (!hasStops)
    return 'Your plan has no stops yet. Add the camps you will stop at in the planner.';
  if (!hasStartDate)
    return 'Your plan has no start date, so no day is dated today. Set one in the planner.';
  return `No planned day is dated ${date}.`;
}

/** One row of today's waypoint list. */
export interface TodayRow {
  /** Stable list key. */
  key: string;
  /** The waypoint behind the row, when there is one (the day's ends may have none). */
  waypoint?: TrailJsonWaypoint;
  name: string;
  type: string;
  /** Where the row sits: the day's start, a waypoint on the way, or tonight's stop. */
  role: 'start' | 'via' | 'end';
  /** Active-direction km along the route. */
  km: number;
  /** km from the day's start. */
  fromStartKm: number;
  /** The leg from the row before (all zero on the start row). */
  legKm: number;
  legAscentM: number;
  legDescentM: number;
  /** Climb and descent so far today. */
  totalAscentM: number;
  totalDescentM: number;
  /**
   * How far the row's place is from the trail line (a turn-off's own
   * `offTrailKm`); absent for an end with no waypoint. The km above is where
   * the route passes it, so a place well off the line is badged as such.
   */
  offTrailM?: number | null;
}

/**
 * The day's start, every waypoint on the way, and its end, in walking order,
 * each with the leg from the row before it.
 *
 * `trail` is the route the plan walks, direction applied (`use-plan-route`),
 * so waypoint `totalDistance` and the day's km are in the same space. The ends
 * take the waypoint at their km when there is one (the camp the hiker
 * entered), else just the day's start/end name (the trail start).
 */
export function todayRows(trail: TrailJson, day: ComputedDay): TodayRow[] {
  const points = trail.track.points;
  const breakStarts = routeBreakStarts(trail.track.breaks, 'points');
  const offTrail = placeOffTrailMeters(trail).byWaypoint;
  const near = (a: number, b: number) => Math.abs(a - b) < KM_EPSILON;

  const sorted = trail.waypoints
    .filter((w) => w.totalDistance !== undefined)
    .sort((a, b) => (a.totalDistance ?? 0) - (b.totalDistance ?? 0));
  const at = (km: number, name: string) => {
    const here = sorted.filter((w) => near(w.totalDistance ?? 0, km));
    return here.find((w) => w.name === name) ?? here[0];
  };
  const startWp = at(day.startKm, day.startName);
  const endWp = at(day.endKm, day.endName);
  const via = sorted.filter((w) => {
    const km = w.totalDistance ?? 0;
    return (
      km > day.startKm - KM_EPSILON && km < day.endKm + KM_EPSILON && w !== startWp && w !== endWp
    );
  });

  type Stop = { waypoint?: TrailJsonWaypoint; name: string; role: TodayRow['role']; km: number };
  const stops: Stop[] = [
    { waypoint: startWp, name: day.startName, role: 'start', km: day.startKm },
    ...via.map((w): Stop => ({
      waypoint: w,
      name: w.name,
      role: 'via',
      // A waypoint sharing a km with an end sits on it, not a hair beyond.
      km: Math.min(day.endKm, Math.max(day.startKm, w.totalDistance ?? 0)),
    })),
    { waypoint: endWp, name: day.endName, role: 'end', km: day.endKm },
  ];

  // An off-route stop either end is walked to and from (`computeDays`): the
  // walk back out joins the first leg, the walk in the last, so the rows add
  // up to the day.
  const walkOut = day.walkOut;
  const walkIn = day.walkIn;
  const rows: TodayRow[] = [];
  let totalAscentM = 0;
  let totalDescentM = 0;
  let walkedOffRoute = 0;
  stops.forEach((stop, i) => {
    const prevKm = i === 0 ? stop.km : stops[i - 1].km;
    const route = Math.max(0, stop.km - prevKm);
    const route_ =
      route > 0
        ? calculateElevationBetween(prevKm, stop.km, points, breakStarts)
        : { gain: 0, loss: 0 };
    const walked = addPlaceWalks(
      { distanceKm: route, ascentM: route_.gain, descentM: route_.loss },
      i === 1 ? walkOut : null,
      stop.role === 'end' && i > 0 ? walkIn : null,
    );
    const legKm = walked.distanceKm;
    const gain = walked.ascentM;
    const loss = walked.descentM;
    walkedOffRoute += walked.offTrailKm;
    totalAscentM += gain;
    totalDescentM += loss;
    rows.push({
      key: `${stop.role}:${stop.waypoint?.id ?? `${stop.name}@${stop.km.toFixed(3)}`}:${i}`,
      ...(stop.waypoint ? { waypoint: stop.waypoint } : {}),
      name: stop.waypoint?.name ?? stop.name,
      type: stop.waypoint?.type ?? 'waypoint',
      role: stop.role,
      km: stop.km,
      fromStartKm: stop.km - day.startKm + walkedOffRoute,
      legKm,
      legAscentM: gain,
      legDescentM: loss,
      totalAscentM,
      totalDescentM,
      ...(stop.waypoint ? { offTrailM: offTrail.get(stop.waypoint) ?? null } : {}),
    });
  });
  return rows;
}

/**
 * Every POI along the day, start to tonight's stop, before any filter — what
 * the Today screen's filter chips count. Duplicates of curated waypoints are
 * kept here and dropped by `visiblePois`/`countPoisByCategory`, as everywhere.
 *
 * `trail` is the route the plan walks (as for `todayRows`): its POIs are in
 * route km, direction applied. A POI found along a taken alternate is placed
 * along it (`plannedRouteTrail`), so an alternate's stretch has the POIs its
 * own corridor turned up; an empty stretch means none were found there.
 */
export function todayPois(trail: Pick<TrailJson, 'pois'>, day: ComputedDay): TrailPOI[] {
  return poisBetween(trail.pois, day.startKm, day.endKm);
}

/** One entry of the Today list: a waypoint row, or an OSM point of interest. */
export type TodayEntry =
  | { kind: 'row'; key: string; row: TodayRow }
  | {
      kind: 'poi';
      key: string;
      poi: TrailPOI;
      /** km from the day's start. */
      fromStartKm: number;
    };

/**
 * The day's waypoint rows with the POIs among them, each at its km. A POI at
 * the same km as a waypoint follows it (`interleavePoisByDistance`), so the
 * Start row stays first; one at tonight's km follows the Tonight row.
 *
 * `pois` is what the filter shows (`visiblePois` over `todayPois`).
 */
export function todayEntries(
  rows: readonly TodayRow[],
  pois: readonly TrailPOI[],
  day: ComputedDay,
): TodayEntry[] {
  return interleavePoisByDistance(rows, pois, (row) => row.km).map((entry, i): TodayEntry =>
    entry.kind === 'item'
      ? { kind: 'row', key: entry.item.key, row: entry.item }
      : {
          kind: 'poi',
          key: `poi:${entry.poi.type}/${entry.poi.id}:${i}`,
          poi: entry.poi,
          fromStartKm: Math.max(0, entry.poi.distanceAlongTrail - day.startKm),
        },
  );
}

/**
 * A day as Expo Router params, for the Day screen a Plan screen day card opens.
 *
 * The day travels whole, with the section it was computed over: the Plan
 * screen's days are scoped to its section (a local choice the Day screen
 * cannot see), so "day 3" there need not be day 3 of the whole plan. The Day
 * screen rebuilds the day from the plan over that section (`currentPlanDay`).
 */
export function dayRouteParams(day: ComputedDay, section?: SectionConfig): Record<string, string> {
  return {
    ...(section
      ? {
          sectionStartKm: String(section.startKm),
          sectionEndKm: String(section.endKm),
          sectionStartName: section.startName,
          sectionEndName: section.endName,
        }
      : {}),
    dayNumber: String(day.dayNumber),
    ...(day.date !== undefined ? { date: day.date } : {}),
    startName: day.startName,
    endName: day.endName,
    startKm: String(day.startKm),
    endKm: String(day.endKm),
    distanceKm: String(day.distanceKm),
    ascentM: String(day.ascentM),
    descentM: String(day.descentM),
    estimatedHours: String(day.estimatedHours),
    waterSources: String(day.waterSources),
    ...(day.restDays !== undefined ? { restDays: String(day.restDays) } : {}),
  };
}

/** The day back out of `dayRouteParams`; null when a param is missing or not a number. */
export function dayFromRouteParams(
  params: Partial<Record<string, string | string[]>>,
): ComputedDay | null {
  const str = (key: string): string | undefined => {
    const value = params[key];
    return typeof value === 'string' ? value : undefined;
  };
  const num = (key: string): number | null => {
    const value = str(key);
    if (value === undefined || value.trim() === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const dayNumber = num('dayNumber');
  const startKm = num('startKm');
  const endKm = num('endKm');
  const distanceKm = num('distanceKm');
  const ascentM = num('ascentM');
  const descentM = num('descentM');
  const estimatedHours = num('estimatedHours');
  const startName = str('startName');
  const endName = str('endName');
  if (
    dayNumber === null ||
    startKm === null ||
    endKm === null ||
    distanceKm === null ||
    ascentM === null ||
    descentM === null ||
    estimatedHours === null ||
    startName === undefined ||
    endName === undefined ||
    endKm < startKm
  ) {
    return null;
  }
  const date = str('date');
  const restDays = num('restDays');
  return {
    dayNumber,
    ...(date !== undefined ? { date } : {}),
    startName,
    endName,
    startKm,
    endKm,
    distanceKm,
    ascentM,
    descentM,
    estimatedHours,
    waterSources: num('waterSources') ?? 0,
    ...(restDays !== null ? { restDays } : {}),
  };
}

/** The Plan screen's section out of `dayRouteParams`; undefined when absent or unusable. */
export function sectionFromRouteParams(
  params: Partial<Record<string, string | string[]>>,
): SectionConfig | undefined {
  const range = kmRangeFromParams(params.sectionStartKm, params.sectionEndKm);
  const { sectionStartName: startName, sectionEndName: endName } = params;
  if (!range || typeof startName !== 'string' || typeof endName !== 'string') return undefined;
  return { ...range, startName, endName };
}

/**
 * `section` when it still lies on a route of `totalKm`, else undefined (the
 * whole route). The Plan screen resets its section when the route changes —
 * an alternate taken or dropped from a screen pushed over the Day screen —
 * and a section measured on the old route would run past the new one's end.
 */
export function sectionOnRoute(
  section: SectionConfig | undefined,
  totalKm: number,
): SectionConfig | undefined {
  if (!section) return undefined;
  return section.startKm >= 0 && section.endKm <= totalKm + KM_EPSILON ? section : undefined;
}

/** What the plan says now about the day a screen was opened with. */
export type CurrentPlanDay =
  /** The plan still has a day from the same place. */
  | { kind: 'day'; day: ComputedDay }
  /** From that place on, the plan is "not planned yet": no stop within a day. */
  | { kind: 'unplanned'; day: ComputedDay }
  /** No day of the plan starts there any more. */
  | { kind: 'gone' };

/**
 * The plan's current version of `opened`, the day a screen was opened with:
 * the day that starts where it started. The start is the stop slept at, which
 * survives the edits that renumber or re-date the days (a stop added before
 * it, a new start date, more nights somewhere), while a date or a day number
 * would quietly land on another stretch. When the stretch from there is now
 * the "not planned yet" tail, or no day starts there, the screen says so
 * rather than repeating figures the plan no longer has.
 */
export function currentPlanDay(glance: PlanGlance, opened: ComputedDay): CurrentPlanDay {
  const sameStart = (d: ComputedDay) => Math.abs(d.startKm - opened.startKm) <= KM_EPSILON;
  const day = glance.days.find(sameStart);
  if (day) return { kind: 'day', day };
  if (glance.unplanned && sameStart(glance.unplanned)) {
    return { kind: 'unplanned', day: glance.unplanned };
  }
  return { kind: 'gone' };
}
