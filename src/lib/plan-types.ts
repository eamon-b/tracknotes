/**
 * Shared planning types used by the web trip planner and the mobile app.
 *
 * These interfaces are designed to be JSON-serialisable so that plan state
 * can be stored in localStorage / SQLite and later encoded in URL params or
 * QR codes.
 */

import type { PlanDirection } from './plan-direction';
import type { WaypointAccess } from './types';

/** Pace preset. Maps to a flat-ground walking speed (km/h). */
export type Pace = 'slow' | 'average' | 'fast';

/**
 * Flat-ground base walking speed (km/h) per pace preset. This is the Naismith
 * base speed threaded into `estimateHikingTime` / the time index: Slow walks the
 * same terrain-aware formula at 3 km/h flat-speed, Fast at 5. The daily target is
 * expressed in *hours* (used raw), so pace shortens/lengthens the km a day covers
 * without inflating its hours. 'average' == 4 preserves the identity "flat day
 * hours ≈ your daily hours" (8 h flat ≈ 32 km).
 *
 * Lives here rather than beside either UI so the web plan page and the phone's
 * plan screen cannot drift apart on what "Average" means.
 */
export const PACE_KMH: Record<Pace, number> = {
  slow: 3,
  average: 4,
  fast: 5,
};

/** Whether a stored value is one of the three presets — a persistence guard. */
export function isPace(value: unknown): value is Pace {
  return value === 'slow' || value === 'average' || value === 'fast';
}

/**
 * The hiker's planning thresholds: the figures that turn a carry into a
 * judgement ("dry stretch", "long carry") or a weight. Like pace and hours they
 * are the hiker's inputs, never constants the calculators decide — the water
 * and resupply calculators require them — and like pace and hours they are kept
 * per device, beside them (the web's `PlanUiPrefs`, the phone's
 * `plan-inputs-store`), not in the synced `PlanDocument`: they say how much one
 * hiker eats and how far they are happy to carry water, and a shared plan is
 * read against the reader's own figures, not its author's.
 */
export interface PlanThresholds {
  /** A water carry at least this long is flagged a dry stretch (km). */
  dryStretchKm: number;
  /** Food carried per day, for each resupply leg's food weight (grams). */
  foodGramsPerDay: number;
  /** A resupply leg of more than this many days is flagged a long carry. */
  longCarryDays: number;
}

/**
 * The initial value of each threshold input — what the calculators used to
 * hard-code. A starting point the hiker sees and can change, not a fallback the
 * calculators reach for.
 */
export const DEFAULT_PLAN_THRESHOLDS: Readonly<PlanThresholds> = {
  dryStretchKm: 15,
  foodGramsPerDay: 680,
  longCarryDays: 5,
};

/** The range each threshold input accepts, shared so web and phone agree. */
export const PLAN_THRESHOLD_BOUNDS: Readonly<Record<keyof PlanThresholds, { min: number; max: number }>> = {
  dryStretchKm: { min: 1, max: 100 },
  foodGramsPerDay: { min: 200, max: 2000 },
  longCarryDays: { min: 1, max: 30 },
};

/** Every threshold, once, so a store's loader and scrubber cannot miss a new one. */
export const PLAN_THRESHOLD_KEYS = Object.keys(PLAN_THRESHOLD_BOUNDS) as readonly (keyof PlanThresholds)[];

/**
 * One step of each threshold input, in metric (km, grams, days) — the web's
 * number inputs and the phone's metric steppers both move on this grid, and
 * each initial value sits on it. The phone's imperial steppers move a mile or
 * an ounce instead.
 */
export const PLAN_THRESHOLD_STEPS: Readonly<Record<keyof PlanThresholds, number>> = {
  dryStretchKm: 1,
  foodGramsPerDay: 20,
  longCarryDays: 1,
};

/** Clamp a threshold into its input's range; NaN/±Infinity give its initial value. */
export function clampPlanThreshold(key: keyof PlanThresholds, value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_PLAN_THRESHOLDS[key];
  const { min, max } = PLAN_THRESHOLD_BOUNDS[key];
  return Math.min(max, Math.max(min, value));
}

/**
 * A stored threshold an input could have produced, or undefined — the
 * persistence guard, so a hand-edited or corrupt value falls back to the
 * input's initial value instead of reaching a calculator that would refuse it.
 */
export function usablePlanThreshold(key: keyof PlanThresholds, value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const { min, max } = PLAN_THRESHOLD_BOUNDS[key];
  return value >= min && value <= max ? value : undefined;
}

/** A planned overnight stop for the web planner. Ordered by km. */
export interface StopData {
  km: number; // totalDistance position on trail
  waypointName: string; // display name
}

/** Configuration for section hiking — start/end boundaries. */
export interface SectionConfig {
  startKm: number;
  endKm: number;
  startName: string;
  endName: string;
}

/** Runtime-computed day segment between two stops (or trail start/end). */
export interface ComputedDay {
  dayNumber: number;
  date?: string; // ISO date if startDate set, otherwise undefined
  startName: string;
  endName: string;
  startKm: number;
  endKm: number;
  distanceKm: number;
  ascentM: number;
  descentM: number;
  estimatedHours: number;
  waterSources: number;
  /**
   * Of `distanceKm`, the km walked off the route: to this day's end stop and
   * back out from its start stop, when they are off it (`placeWalk`). Their
   * climb is in `ascentM`/`descentM` and the walk in `estimatedHours`.
   * Absent when the day stays on the route.
   */
  offTrailKm?: number;
  /** The walk back to the route from this day's start stop, when it is off the route. */
  walkOut?: { km: number; ascentM: number; descentM: number };
  /** The walk in to this day's end stop (measured walking in), when it is off the route. */
  walkIn?: { km: number; ascentM: number; descentM: number };
  /**
   * Rest days taken at this day's end stop: `nights - 1` of that stop, 0 at
   * the trail end. A rest day is not a day of its own; the next walking
   * day's `date` is pushed back by this many days.
   */
  restDays?: number;
}

/**
 * One overnight stop of a `PlanDocument`. Keyed by waypoint id when the trail
 * has one; `km` is the display position always and the key when the id is
 * absent (a plan migrated from a km-only `PlanState` that matched nothing).
 * `km` is NOBO-absolute — see `plan-direction.ts` for the km-space contract.
 */
export interface PlanStop {
  /** Registry id (`data/waypoint-ids.json`) or `uw_…` for an imported trail. */
  waypointId?: string;
  km: number;
  name: string;
  /** Nights spent here, >= 1. Two nights = one rest day. */
  nights: number;
  /** Free text, <= 500 chars after trimming. */
  note?: string;
  booked?: boolean;
  /**
   * The alternate this stop is on (`PlanDocument.alternates` names it). Absent
   * for a stop on the main route. On an alternate `km` is the alternate's own
   * absolute scale — branch km plus km along it — not main-route km; see
   * `plan-alternates.ts`.
   */
  alternate?: string;
}

/** Limits enforced on a `PlanDocument` by the editor, the web page and the server alike. */
export const PLAN_LIMITS = {
  nameMax: 80,
  /** A stop's name: required (non-blank), at most this many characters. */
  stopNameMax: 200,
  noteMax: 500,
  stopsMax: 500,
  /** Entries in `resupplyStops`. */
  resupplyStopsMax: 500,
  /** Entries in `resupplyZeroDays`. */
  resupplyZeroDaysMax: 500,
  /** The most zero days one resupply stop may hold (in half-day steps from 0). */
  zeroDaysMax: 14,
  /** Entries in `alternates`. */
  alternatesMax: 100,
  /** An alternate's name, as `alternates` and a stop's `alternate` hold it. */
  alternateNameMax: 200,
  nightsMax: 14,
  /** Serialised JSON byte ceiling. */
  documentBytes: 64 * 1024,
} as const;

/**
 * What every waypoint id in a plan (a stop's `waypointId`, a `resupplyStops`
 * entry) must look like: the registry's `w_…` and an import's `uw_…` both do.
 * The server refuses a document carrying any other.
 */
export const PLAN_WAYPOINT_ID_PATTERN = /^[a-z0-9_-]{4,64}$/;

/**
 * A zero-day count a plan may store for a resupply stop: a whole or half
 * number of days, more than 0 and at most `PLAN_LIMITS.zeroDaysMax`. (0 is
 * meaningful to an editor — it clears the entry — but is never stored.) The
 * one rule the editor, the clients' loaders and the server share.
 */
export function isStoredZeroDays(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= PLAN_LIMITS.zeroDaysMax &&
    Number.isInteger(value * 2)
  );
}

/**
 * The plan document: one per trail per user. It is the wire shape
 * (`PUT /v1/plans/:id`), the mobile `plans.document_json` column, the web
 * `localStorage` value and the shared-plan payload. Supersedes `PlanState`,
 * which is kept only for the one-off web migration.
 */
export interface PlanDocument {
  /** Client-minted uuid v4; the server's idempotency key, as for comments. */
  id: string;
  trailId: string;
  name: string;
  direction: PlanDirection;
  /** ISO date (`YYYY-MM-DD`) or null. */
  startDate: string | null;
  /** Sorted by km ascending; trail start and end are implicit. */
  stops: PlanStop[];
  /** Ticked resupply options, as waypoint ids — unchanged from `PlanState`. */
  resupplyStops?: string[];
  /**
   * Zero days the hiker takes at each resupply stop, by option (waypoint) id:
   * half-day steps, more than 0 and at most `PLAN_LIMITS.zeroDaysMax`
   * ({@link isStoredZeroDays}). A missing entry is none, and the map is absent
   * rather than empty, so a plan without zero days is byte-identical to one
   * saved before the field existed. Edited through `setResupplyZeroDays`; fed
   * to `computeResupplyLegs` as `zeroDays`.
   */
  resupplyZeroDays?: Record<string, number>;
  /**
   * The alternates this plan takes instead of the main route, by name (sorted).
   * Absent = the main route all the way. See `plan-alternates.ts`.
   */
  alternates?: string[];
  /** Server clock on the copy that last came from or went to the server; the client's own clock before that. */
  updatedAt: string;
  /**
   * The newest trail data (`updatedAt` of the trail's published copy, ISO
   * time) the plan has been saved against. Every save raises it to the saving
   * device's data and never lowers it, so a device whose data is older can
   * tell, and does not move stops back to where its data has the places
   * (`refreshStopKms`). Absent on plans saved before it existed, and on
   * trails with no published data (imports).
   */
  dataUpdatedAt?: string;
  version: 1;
}

/**
 * Persisted plan state (JSON-serialisable).
 *
 * LEGACY: the web page saved this shape under `trail-plan-<trailId>` until
 * the day planner landed. New code reads and writes `PlanDocument`; this
 * type exists so `migratePlanState` in `plan-editor.ts` can read old saves.
 */
export interface PlanState {
  name: string;
  startDate: string | null; // ISO date string or null
  stops: StopData[]; // sorted by km, excludes trail start/end (implicit)
  /**
   * Hiking direction. Absent = 'NOBO' (plans saved before the direction
   * toggle existed). Stop km stay NOBO-absolute regardless of direction —
   * see src/lib/plan-direction.ts for the km-space contract.
   */
  direction?: PlanDirection;
  /**
   * The resupply options the hiker has ticked, as waypoint ids. Absent means
   * "nothing chosen yet", which resolves to every option — see
   * `resolveResupplyStops`. Ids are direction-agnostic, so a saved selection
   * survives a direction flip untouched.
   */
  resupplyStops?: string[];
  /**
   * The hiker's pace preset. Absent on a plan saved before the input existed =
   * 'average'. That default is the *initial value of an input they can see and
   * change*, not a constant the page decides for them.
   */
  pace?: Pace;
  /**
   * Walking hours per day. Absent on a plan saved before the input existed = 8,
   * on the same footing as `pace`.
   */
  dailyHours?: number;
}

/** Gap between consecutive resupply points. */
export interface ResupplyGap {
  fromName: string;
  toName: string;
  fromKm: number;
  toKm: number;
  distanceKm: number;
}

/** Gap between consecutive water sources. */
export interface WaterGap {
  fromName: string;
  toName: string;
  fromKm: number;
  toKm: number;
  /**
   * The carry: route km from one source to the next, plus the walk back to
   * the route from `fromName` and the walk in to `toName` when either is off
   * the route.
   */
  distanceKm: number;
  isDryStretch: boolean; // >= dryStretchThreshold km
  /** Of `distanceKm`, the walk back to the route from the source it starts at. */
  fromOffTrailKm?: number;
  /** Of `distanceKm`, the walk off the route to the source it ends at. */
  toOffTrailKm?: number;
}

/** Minimal track point shape required by plan calculators. */
export interface PlanTrackPoint {
  lat: number;
  lon: number;
  ele: number;
  dist: number; // cumulative km along trail
}

/** Minimal waypoint shape required by plan calculators. */
export interface PlanWaypoint extends WaypointAccess {
  /** Stable waypoint id, when the caller has one — a resupply selection is a list of these. */
  id?: string;
  name?: string;
  type?: string;
  lat?: number;
  lon?: number;
  totalDistance?: number; // cumulative km along trail
  description?: string;
}
