/**
 * Today's plan for the open guide — the hook over `today-plan.ts`.
 *
 * Reads the plan at a glance (`use-plan-glance`: the saved plan's days over the
 * route it walks) and picks out the day dated today. The date is the phone's
 * local one, re-read whenever the app comes back to the foreground, so a guide
 * left open overnight moves on to the next day.
 *
 * The day's OSM points of interest come through the guide's one POI filter
 * (`usePoiFilter`, the map's layers sheet and the Today screen's chips edit
 * it), so the list, the map and the planner agree on which kinds are shown.
 */

import { useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';
import { visiblePois } from '@lib/poi-display';
import type { TrailPOI } from '@lib/trail-types';
import type { TrailJson } from '../../services/trail-assets';
import { usePoiFilter } from '../guide/use-visible-pois';
import {
  localIsoDate,
  todayEntries,
  todayPlan,
  todayPois,
  todayRows,
  type TodayEntry,
  type TodayPlan,
  type TodayRow,
} from './today-plan';
import { usePlanGlance } from './use-plan-glance';

export interface TodayPlanState {
  /** Today's day of the plan, or null when the plan has none for today. */
  today: TodayPlan | null;
  /** The walking day's rows; empty on a rest day or with no plan for today. */
  rows: TodayRow[];
  /** The rows with the POIs the filter shows among them, in walking order. */
  entries: TodayEntry[];
  /** Every POI along the walking day, unfiltered — what the filter chips count. */
  pois: TrailPOI[];
  /** Today's date, `YYYY-MM-DD`. */
  date: string;
  /** The route the rows are measured on. */
  trail: TrailJson;
  /** False until the plan has a start date — without one no day has a date. */
  hasStartDate: boolean;
  /** False until the plan has a stop. */
  hasStops: boolean;
}

/** The local date, refreshed on every return to the foreground. */
export function useLocalDate(): string {
  const [date, setDate] = useState(() => localIsoDate(new Date()));
  useEffect(() => {
    const sub = AppState.addEventListener('change', (status) => {
      if (status === 'active') setDate(localIsoDate(new Date()));
    });
    return () => sub.remove();
  }, []);
  return date;
}

export function useTodayPlan(): TodayPlanState {
  const glance = usePlanGlance();
  const date = useLocalDate();
  const filter = usePoiFilter();
  const today = useMemo(() => todayPlan(glance, date), [glance, date]);
  const walk = today?.kind === 'walk' ? today.day : null;
  const rows = useMemo(() => (walk ? todayRows(glance.trail, walk) : []), [glance.trail, walk]);
  const pois = useMemo(() => (walk ? todayPois(glance.trail, walk) : []), [glance.trail, walk]);
  return useMemo(() => {
    return {
      today,
      rows,
      entries: walk ? todayEntries(rows, visiblePois(pois, filter), walk) : [],
      pois,
      date,
      trail: glance.trail,
      hasStartDate: glance.plan.startDate !== null,
      hasStops: glance.hasStops,
    };
  }, [today, walk, rows, pois, filter, date, glance]);
}
