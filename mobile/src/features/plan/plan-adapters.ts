/**
 * Plan adapters — turn a direction-applied guide trail + the hiker's inputs
 * into the shapes the shared @lib calculators consume.
 *
 * Reuse the shared calculators, don't reimplement them. The guide's
 * `TrailJson` is already structurally compatible with the calculators'
 * `PlanTrail` / `PlanWaypoint` / `PlanTrackPoint` params (config.name,
 * track.points{lat,lon,ele,dist}, track.totalDistance,
 * waypoints{name,type,totalDistance,description}), so conversion is near-zero.
 * Nothing here generates day boundaries: the day planner's days come from the
 * stops the hiker chose (`computePlanDays`).
 *
 * What is here: the day card's shape (`PlanDay`), the section steppers' pick
 * options, and the two cards the Plan screen shows beside its days — resupply
 * and water (`computePlanExtras`). Resupply is the one place this module
 * composes rather than passes through: the trail's options are listed and
 * grouped, the hiker's ticked ids resolved into stops, and the legs between
 * those stops measured — all in `@lib/resupply-plan`, driven by the hiker's
 * own pace and hours.
 *
 * Pure + React-free so every derivation is unit-testable.
 */

import type { PlanTrail } from '@lib/day-calculator';
import {
  computeResupplyLegs,
  listResupplyOptions,
  resupplyCandidates,
  resolveResupplyStops,
  summariseResupplyPlan,
  type ResupplyLeg,
  type ResupplyOptionGroup,
  type ResupplyPlanSummary,
  type ResupplyStop,
} from '@lib/resupply-plan';
import { analyzeWaterCarryForSection, type WaterCarryAnalysis } from '@lib/water-carry-calculator';
import type { ComputedDay, PlanThresholds, SectionConfig, WaterGap } from '@lib/plan-types';
import type { TrailJson } from '../../services/trail-assets';
import { KM_EPSILON } from '@lib/plan-direction';
import { overnightCandidates } from '@lib/plan-editor';
import { planFloorHours, planWindowHours } from '@lib/plan-suggest';

/**
 * Pace preset and its flat-ground base speed, shared with the web through
 * `@lib/plan-types` so the two platforms cannot drift. Re-exported because the
 * store and the inputs card import them from here.
 */
export { PACE_KMH, type Pace } from '@lib/plan-types';

/**
 * How a day's end boundary was resolved, for the day card's glyph:
 *  - `camp`   — a campsite/shelter waypoint.
 *  - `stop`   — a stop the hiker chose that is NOT a camp or hut: a town, a
 *    road crossing, a river.
 *  - `finish` — the section end itself (the last day): it lands on whatever
 *    the section ends at (town, hut, trailhead, …).
 */
export type DayEndKind = 'camp' | 'stop' | 'finish';

/** A day card: the calculator's ComputedDay plus how its end boundary resolved. */
export interface PlanDay extends ComputedDay {
  endKind: DayEndKind;
}

/** The km of every bed on the trail (`overnightWaypoints`), for `toPlanDay`. */
export function campKmsOf(trail: TrailJson): Set<number> {
  return new Set(overnightWaypoints(trail).map((c) => c.km));
}

/**
 * A computed day as a day card: a day ending at `finishKm` (the section's or
 * the route's end) is the finish, one ending at a bed (`campKmsOf`) a camp,
 * anything else a stop. The Plan screen and a shared plan both draw theirs so.
 */
export function toPlanDay(
  day: ComputedDay,
  finishKm: number,
  campKms: ReadonlySet<number>,
): PlanDay {
  const endKind: DayEndKind =
    day.endKm >= finishKm - KM_EPSILON ? 'finish' : campKms.has(day.endKm) ? 'camp' : 'stop';
  return { ...day, endKind };
}

/** A pickable section boundary (a waypoint). */
export interface WaypointOption {
  id: string;
  name: string;
  km: number;
  type: string;
}

/**
 * Waypoints that are a bed: the camp + shelter families (campsite/hut/etc.),
 * in km order. The Plan screen reads it to give a day that ends at one the
 * camp glyph.
 *
 * The membership rule itself is `@lib/plan-editor`'s `overnightCandidates`, so
 * the phone and the shared day planner agree on what a bed is (it also does
 * the turn-off exclusion: `hut-access` colours as a hut but is a roadside, and
 * the hut is somewhere off the route). `includeTowns: false`: a town stop is a
 * stop, not a campsite.
 */
export function overnightWaypoints(trail: TrailJson): WaypointOption[] {
  return overnightCandidates(trail.waypoints, { includeTowns: false })
    .map(toOption)
    .sort((a, b) => a.km - b.km);
}

/** All waypoints as ordered pick options for the section steppers. */
export function waypointOptions(trail: TrailJson): WaypointOption[] {
  return trail.waypoints.map(toOption).sort((a, b) => a.km - b.km);
}

function toOption(wp: TrailJson['waypoints'][number], i: number): WaypointOption {
  return {
    id: wp.id ?? `wp_${i}_${Math.round((wp.totalDistance ?? 0) * 1000)}`,
    name: wp.name,
    km: wp.totalDistance ?? 0,
    type: wp.type,
  };
}

/**
 * The day-length bands (± hours around the target, and the final-day
 * allowance). They live in `@lib/plan-suggest`, because the web plan page and
 * the suggestion search judge days against the same bands; re-exported for the
 * day cards' over-target hint.
 */
export { planFloorHours, planWindowHours };

/** The Plan screen's resupply and water cards for a section. */
export interface PlanExtras {
  /** Every resupply the trail offers, clustered by turn-off — the picker's list. */
  resupplyGroups: ResupplyOptionGroup[];
  /** The resupply planner's headline figures (the Plan screen's Resupply row). */
  resupplyPlanSummary: ResupplyPlanSummary;
  water: WaterCarryAnalysis;
  /** Longest water carries in the section, biggest first (top N). */
  topWaterCarries: WaterGap[];
}

/** What the cards need beyond the section: the hiker's pace, hours, thresholds and ticks. */
export interface PlanExtrasInputs {
  dailyHours: number;
  baseKmh: number;
  /** Dry stretch, food per day and long carry — the hiker's, from `plan-inputs-store`. */
  thresholds: PlanThresholds;
  /** The ticked resupply option ids; `undefined` resolves to every option. */
  resupplyStops?: readonly string[];
  /** The hiker's zero days per resupply option id (`PlanDocument.resupplyZeroDays`). */
  zeroDays?: Readonly<Record<string, number>>;
  /** The zero days before day 1 (`PlanDocument.startZeroDays`), counted in the total days. */
  startZeroDays?: number;
}

/**
 * Resupply headline and water carries for a section. No arrival days: no
 * surface shows a leg's arrival day, and a camp plan's rest days next to the
 * resupply zero days would count the same days twice.
 *
 * `groups` may be passed in by a caller that memoises them on the trail alone
 * (`resupplyGroupsFor`), as `computeResupplyPlan` takes them.
 */
export function computePlanExtras(
  trail: TrailJson,
  section: SectionConfig,
  inputs: PlanExtrasInputs,
  groups?: ResupplyOptionGroup[],
): PlanExtras {
  const resupply = computeResupplyPlan(
    trail,
    section,
    {
      dailyHours: inputs.dailyHours,
      baseKmh: inputs.baseKmh,
      longCarryDays: inputs.thresholds.longCarryDays,
      foodGramsPerDay: inputs.thresholds.foodGramsPerDay,
      resupplyStops: inputs.resupplyStops,
      zeroDays: inputs.zeroDays,
      startZeroDays: inputs.startZeroDays,
    },
    groups,
  );

  const water = analyzeWaterCarryForSection(
    trail.waypoints,
    section.startKm,
    section.endKm,
    inputs.thresholds.dryStretchKm,
  );
  const topWaterCarries = [...water.gaps].sort((a, b) => b.distanceKm - a.distanceKm).slice(0, 5);

  return {
    resupplyGroups: resupply.groups,
    resupplyPlanSummary: resupply.summary,
    water,
    topWaterCarries,
  };
}

/** The hiker's figures the resupply legs are measured with (all from `plan-inputs-store`). */
export interface ResupplyPlanInputs {
  dailyHours: number;
  baseKmh: number;
  longCarryDays: number;
  foodGramsPerDay: number;
  /** The ticked resupply option ids; `undefined` resolves to every option. */
  resupplyStops?: readonly string[];
  /** Zero days per option id. */
  zeroDays?: Readonly<Record<string, number>>;
  /** Zero days before day 1, counted in the summary's total days. */
  startZeroDays?: number;
  /**
   * The day cards the legs report arrival days against (the Plan screen's
   * export); the resupply screen never passes one.
   */
  days?: ComputedDay[];
}

export interface ResupplyPlan {
  /** Every resupply the trail offers, clustered by turn-off (trail-wide). */
  groups: ResupplyOptionGroup[];
  /** What the selection resolves to: one stop per group with a tick. */
  stops: ResupplyStop[];
  /** The carries between them, scoped to the section. */
  legs: ResupplyLeg[];
  /** The headline figures over those legs. */
  summary: ResupplyPlanSummary;
}

/**
 * The resupply half of a plan — options, stops, legs and headline figures, all
 * from `@lib/resupply-plan`. The resupply screen and the Plan screen's
 * Resupply row both come through here, so the two cannot disagree.
 *
 * The option list is trail-wide (the hiker sections later, and the choice is
 * about the trail); only the legs are section-scoped, which the calculator
 * does itself. Side-trip towns are offered too: the trail draws the walk to
 * them. `groups` may be passed in by a caller that memoises them on the trail
 * alone — grouping the CDT's options is not free.
 */
export function computeResupplyPlan(
  trail: TrailJson,
  section: SectionConfig | null,
  inputs: ResupplyPlanInputs,
  groups: ResupplyOptionGroup[] = listResupplyOptions(resupplyCandidates(trail)),
): ResupplyPlan {
  const stops = resolveResupplyStops(groups, inputs.resupplyStops);
  const legs = computeResupplyLegs(trail as unknown as PlanTrail, stops, {
    dailyHours: inputs.dailyHours,
    baseKmh: inputs.baseKmh,
    longThresholdDays: inputs.longCarryDays,
    gramsPerDay: inputs.foodGramsPerDay,
    section,
    ...(inputs.days ? { days: inputs.days } : {}),
    ...(inputs.zeroDays ? { zeroDays: inputs.zeroDays } : {}),
  });
  const summary = summariseResupplyPlan(legs, inputs.dailyHours, {
    startZeroDays: inputs.startZeroDays,
  });
  return { groups, stops, legs, summary };
}
