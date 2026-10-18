/**
 * The plan as the guide map draws it: which markers to draw and ring, and
 * which lines are the route the plan walks (`plan-overlay`).
 *
 * With no alternate taken the markers are the main route's own array and no
 * line changes, so a map for a plan that never takes one renders as before.
 */

import { useMemo } from 'react';
import { plannedRouteFor } from '@lib/plan-alternates';
import { useGuide } from '../guide/GuideContext';
import { selectPlan, usePlansStore } from '../../state/plans-store';
import {
  plannedAlternateWaypoints,
  plannedRouteLines,
  plannedStopFeatureIds,
  type OverlayWaypoint,
  type PlannedRouteLines,
} from './plan-overlay';
import { planDirectionOf } from './plan-stops';
import { plannableTrail } from './use-plan-route';

export interface PlannedRouteMap<W> {
  /** The main route's markers, then the places on the alternates the plan takes. */
  waypoints: W[];
  /** Feature ids of the markers that are stops of the plan. */
  plannedStopIds: Set<string>;
  /** The taken alternates and the main route they bypass; null when none is taken. */
  lines: PlannedRouteLines | null;
}

export function usePlannedRouteMap<W extends Omit<OverlayWaypoint, 'alternate'>>(
  mainWaypoints: W[],
  alternates: readonly { name?: string; waypoints?: unknown[] }[] | undefined,
): PlannedRouteMap<W> {
  const { baseTrail, trail, trailId, direction } = useGuide();
  const plan = usePlansStore(selectPlan(trailId));
  const totalKm = trail.track.totalDistance;
  const planDirection = planDirectionOf(direction);
  // Built from the trail as stored, cached per trail and set of alternates.
  const route = plannedRouteFor(plannableTrail(baseTrail), plan);

  const lines = useMemo(
    () => plannedRouteLines(route, planDirection, totalKm),
    [route, planDirection, totalKm],
  );
  const waypoints = useMemo(() => {
    const onAlternates = plannedAlternateWaypoints(
      alternates as { name?: string; waypoints?: W[] }[] | undefined,
      lines,
      mainWaypoints,
    );
    return onAlternates.length === 0 ? mainWaypoints : [...mainWaypoints, ...onAlternates];
  }, [mainWaypoints, alternates, lines]);
  // Stops of the hiker's plan get a ring on their marker. The plan stores km
  // NOBO-absolute while this trail is direction-applied, so the conversion goes
  // through `plan-overlay` — the same module the elevation profile uses, so the
  // two panes can never disagree about which hut tonight is.
  const plannedStopIds = useMemo(
    () => plannedStopFeatureIds(plan, waypoints, planDirection, totalKm),
    [plan, waypoints, planDirection, totalKm],
  );
  return { waypoints, plannedStopIds, lines };
}
