/**
 * The resupply legs as the guide map draws them: the carries the resupply
 * screen lists, each cut out of the route as a line.
 *
 * Measured on the route as the plan walks it (`use-plan-route`: alternates
 * spliced in, direction applied), the trail the resupply screen hands
 * `computeResupplyLegs`, so a leg along a taken alternate is drawn along it
 * and the numbering matches that screen's. The selection is the screen's too:
 * the document's, the device-local one only while the document has none, and
 * every option while nothing is chosen. The whole trail, never the Plan
 * screen's section: the map shows the whole trail.
 *
 * The cutting (nearest points, route breaks) is `@lib/route-ranges`, shared
 * with the web plan page's Resupply tab.
 */

import { useMemo } from 'react';
import { rangeLines, type RangeLine } from '@lib/route-ranges';
import type { ResupplyOptionGroup } from '@lib/resupply-plan';
import type { TrackPoint } from '@lib/trail-types';
import type { TrailJson } from '../../services/trail-assets';
import { useGuide } from '../guide/GuideContext';
import { selectPlan, usePlansStore } from '../../state/plans-store';
import { computeResupplyPlan, PACE_KMH, type ResupplyPlanInputs } from './plan-adapters';
import { selectPrefs, usePlanInputsStore } from './plan-inputs-store';
import { usePlanRoute } from './use-plan-route';
import { resupplyGroupsFor } from './use-planned-resupply';

/**
 * Pure half of the hook: the legs' lines over the map's copy of the route
 * (`displayPoints`, its own break index). Empty for a trail with no resupply
 * options: its one leg is the whole trail, which says nothing on a map.
 */
export function resupplyLegLines(
  trail: TrailJson,
  inputs: ResupplyPlanInputs,
  groups: ResupplyOptionGroup[] = resupplyGroupsFor(trail),
): RangeLine<TrackPoint>[] {
  if (groups.length === 0) return [];
  const { legs } = computeResupplyPlan(trail, null, inputs, groups);
  return rangeLines(trail.track, legs, 'displayPoints');
}

export interface ResupplyLegLines {
  /** Whether the trail has anything to plan: the layers sheet offers the switch only then. */
  available: boolean;
  /** The lines to draw, or null while `enabled` is off (nothing is worked out then). */
  lines: RangeLine<TrackPoint>[] | null;
}

export function useResupplyLegLines(enabled: boolean): ResupplyLegLines {
  const { trailId } = useGuide();
  const plan = usePlansStore(selectPlan(trailId));
  const { trail } = usePlanRoute(plan);
  const prefs = usePlanInputsStore(selectPrefs(trailId));
  const stored = plan?.resupplyStops ?? prefs.resupplyStops;

  // Keyed on the trail alone, as the resupply screen's: grouping is not free.
  const groups = useMemo(() => resupplyGroupsFor(trail), [trail]);
  const lines = useMemo(
    () =>
      enabled
        ? resupplyLegLines(
            trail,
            {
              dailyHours: prefs.dailyHours,
              baseKmh: PACE_KMH[prefs.pace],
              longCarryDays: prefs.longCarryDays,
              foodGramsPerDay: prefs.foodGramsPerDay,
              resupplyStops: stored,
            },
            groups,
          )
        : null,
    [
      enabled,
      trail,
      groups,
      stored,
      prefs.dailyHours,
      prefs.pace,
      prefs.longCarryDays,
      prefs.foodGramsPerDay,
    ],
  );
  return { available: groups.length > 0, lines };
}
