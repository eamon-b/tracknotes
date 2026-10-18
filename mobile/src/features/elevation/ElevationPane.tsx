/**
 * Full-height elevation pane for the guide shell.
 *
 * Owns the visible km window and elevation window (the profile is
 * controlled), surfaces the scrub readout in a fixed chip, offers buttons to
 * stretch or flatten the elevation axis, and shows a reset-zoom affordance
 * whenever the user has zoomed either axis. Fed entirely from `useGuide()`.
 *
 * The elevation axis is the hiker's, not fitted to the stretch on screen: it
 * opens on 0 m to just above the trail's high point and keeps that while the
 * km window pans and zooms, so a gentle rise still looks gentle. A vertical
 * pinch or the buttons change it.
 *
 * That km window doubles as this pane's focus window (see guide-focus): arriving
 * from the map zooms the profile to the section that was on screen, and leaving
 * hands the same range to whichever pane comes next.
 *
 * OSM points of interest ride along as extra markers on the same `waypoints`
 * prop, tagged `kind: 'poi'` so the profile draws them hollow and the tap lands
 * on their own detail screen. They are appended only once the window is narrow
 * enough for the rings to be readable (see POI_PROFILE_MAX_WINDOW_KM).
 *
 * Waypoints the hiker has ticked as resupply stops are marked in the planned
 * colour at the favourite size, at every zoom (nothing thins waypoint markers).
 *
 * The hiker's plan rides along too, as `stopKms`: one tick per day boundary, in
 * the active km space (`features/plan/plan-overlay`). Unlike the POI ticks they
 * are drawn at every zoom — there are at most a few dozen of them, and where
 * tomorrow ends is exactly the thing a whole-trail view is being consulted for.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useRouter } from 'expo-router';
import { formatDistance, formatElevation } from '@lib/format-distance';
import { useTheme } from '../../theme';
import { radii, spacing, typography } from '../../tokens';
import { useSettingsStore } from '../../state/settings-store';
import { useFavoritesStore } from '../../state/favorites-store';
import { usePlannedResupplyIds } from '../plan/use-planned-resupply';
import { selectPlan, usePlansStore } from '../../state/plans-store';
import { useGuide } from '../guide/GuideContext';
import { useGuidePaneFocus } from '../guide/GuideFocusContext';
import { useGuidePositionContext } from '../guide/GuidePositionContext';
import { isSameFocus } from '../guide/guide-focus';
import { orderedWaypoints } from '../guide/guide-trail';
import { useVisiblePois } from '../guide/use-visible-pois';
import { planDirectionOf } from '../plan/plan-stops';
import { plannedStopKms } from '../plan/plan-overlay';
import { plannableTrail } from '../plan/use-plan-route';
import { plannedRouteFor } from '@lib/plan-alternates';
import { useRoutesStore } from '../routes/routes-store';
import {
  routeHighlightRanges,
  routePointsToActive,
  type RouteTrackPoint,
} from '../routes/route-geometry';
import { ElevationProfile, type ProfileReadout, type ProfileWaypoint } from './ElevationProfile';
import {
  clampWindow,
  defaultEleWindow,
  eleBounds,
  mirrorWindow,
  scaleEleWindow,
  type EleWindow,
  type KmWindow,
  type ProfileMarkerKind,
} from './geometry';
import type { ProfilePoint } from './lod';
import { poiProfileMarkers, POI_PROFILE_MAX_WINDOW_KM } from './poi-profile';

const ZOOM_EPSILON_KM = 0.01;
const ZOOM_EPSILON_M = 0.5;
/** How much one tap of a vertical-scale button stretches or flattens the relief. */
const ELE_SCALE_STEP = 1.5;

export function ElevationPane() {
  const { colors } = useTheme();
  const { trail, baseTrail, trailId, direction } = useGuide();
  const { currentKm } = useGuidePositionContext();
  const units = useSettingsStore((s) => s.units);
  const favoriteIds = useFavoritesStore((s) => s.byTrail[trailId]);
  const favoriteSet = useMemo(() => new Set(favoriteIds ?? []), [favoriteIds]);
  // Null until a resupply plan exists; nothing is marked planned before then.
  const plannedIds = usePlannedResupplyIds(trailId, trail);
  const pois = useVisiblePois(trail);
  const router = useRouter();

  const totalKm = trail.track.totalDistance || 0;
  const points = trail.track.displayPoints as ProfilePoint[];

  const waypoints = useMemo<ProfileWaypoint[]>(
    () =>
      orderedWaypoints(trail).map((wp, i) => ({
        id: wp.id ?? `${wp.name}-${i}`,
        type: wp.type,
        totalDistance: wp.totalDistance,
        elevation: wp.elevation,
      })),
    [trail],
  );

  // POI ticks: elevation sampled off the track once per (visible POIs, track),
  // not per frame — the sampling is a binary search per POI.
  const poiMarkers = useMemo(() => poiProfileMarkers(pois, points), [pois, points]);

  // The plan's day boundaries as ticks. Stops are stored NOBO-absolute and this
  // trail is direction-applied, so the conversion goes through the same
  // `plan-overlay` module the map's stop rings use. A stop on an alternate the
  // plan takes is ticked along the main stretch that alternate replaces.
  const plan = usePlansStore(selectPlan(trailId));
  const plannedRoute = plannedRouteFor(plannableTrail(baseTrail), plan);
  const stopKms = useMemo(
    () => plannedStopKms(plan, planDirectionOf(direction), totalKm, plannedRoute),
    [plan, direction, totalKm, plannedRoute],
  );

  // Active custom route → shade its on-trail spans on the profile. Saved route
  // km are NOBO-absolute (route-geometry), the profile's are direction-applied.
  const activePoints = useRoutesStore((s) => s.activePointsByTrail[trailId]);
  const highlightRanges = useMemo(
    () =>
      activePoints && activePoints.length > 0
        ? routeHighlightRanges(
            routePointsToActive(activePoints, planDirectionOf(direction), totalKm),
            points as RouteTrackPoint[],
          )
        : undefined,
    [activePoints, points, direction, totalKm],
  );

  const [window, setWindow] = useState<KmWindow>({ startKm: 0, endKm: totalKm });
  const [readout, setReadout] = useState<ProfileReadout | null>(null);

  // Elevation axis: bounds come from the whole track, so they — and the
  // default window — move only when the track does.
  const bounds = useMemo(() => eleBounds(points), [points]);
  const [eleWindow, setEleWindow] = useState<EleWindow>(() => defaultEleWindow(bounds));
  // A different track (another trail, or new data) refits the elevation axis.
  // A direction flip keeps every elevation, so the hiker's scale survives it.
  const fittedBoundsRef = useRef(bounds);
  useEffect(() => {
    const fitted = fittedBoundsRef.current;
    if (fitted.floorM === bounds.floorM && fitted.ceilingM === bounds.ceilingM) return;
    fittedBoundsRef.current = bounds;
    setEleWindow(defaultEleWindow(bounds));
  }, [bounds]);

  // A different (or newly loaded) trail invalidates the km window — refit it to
  // the full new length rather than leaving the zoom parked off the end. A
  // direction flip keeps the trail but renumbers every km, so the window is
  // mirrored to stay on the same stretch of ground, and the readout (a km from
  // the old numbering) is cleared rather than left naming the mirrored spot.
  const fittedRef = useRef({ totalKm, direction });
  useEffect(() => {
    const fitted = fittedRef.current;
    if (fitted.totalKm === totalKm && fitted.direction === direction) return;
    fittedRef.current = { totalKm, direction };
    if (fitted.totalKm !== totalKm) {
      setWindow({ startKm: 0, endKm: totalKm });
    } else {
      setWindow((w) => mirrorWindow(w, totalKm));
    }
    setReadout(null);
  }, [totalKm, direction]);

  const isEleZoomed =
    Math.abs(eleWindow.minM - bounds.floorM) > ZOOM_EPSILON_M ||
    Math.abs(eleWindow.maxM - bounds.ceilingM) > ZOOM_EPSILON_M;
  const isZoomed =
    window.startKm > ZOOM_EPSILON_KM || window.endKm < totalKm - ZOOM_EPSILON_KM || isEleZoomed;

  const resetZoom = useCallback(() => {
    setWindow({ startKm: 0, endKm: totalKm });
    setEleWindow(defaultEleWindow(bounds));
  }, [totalKm, bounds]);

  const stretchElevation = useCallback(() => {
    setEleWindow((w) => scaleEleWindow(w, ELE_SCALE_STEP, bounds));
  }, [bounds]);

  const flattenElevation = useCallback(() => {
    setEleWindow((w) => scaleEleWindow(w, 1 / ELE_SCALE_STEP, bounds));
  }, [bounds]);

  // Hollow POI rings only where they can be told apart: on a whole-trail window
  // a few hundred of them bury the trace.
  const showPoiTicks =
    poiMarkers.length > 0 && window.endKm - window.startKm <= POI_PROFILE_MAX_WINDOW_KM;

  const profileWaypoints = useMemo(
    () => (showPoiTicks ? [...waypoints, ...poiMarkers] : waypoints),
    [waypoints, poiMarkers, showPoiTicks],
  );

  const onWaypointTap = useCallback(
    (id: string, kind: ProfileMarkerKind) => {
      if (kind === 'poi') {
        router.push({
          pathname: '/guide/[trailId]/poi/[poiKey]',
          params: { trailId, poiKey: id },
        });
        return;
      }
      router.push({
        pathname: '/guide/[trailId]/waypoint/[waypointId]',
        params: { trailId, waypointId: id },
      });
    },
    [router, trailId],
  );

  // --- Pane focus ----------------------------------------------------------
  // The profile's zoom window is already a focus window, so leaving hands it
  // over as-is; arriving zooms to the incoming section unless the profile is
  // effectively there already (which would fight a zoom the user just made).
  // `useGuidePaneFocus` re-reads these handlers on every render, so they can
  // close over `window` directly — no ref needed to keep them current.
  useGuidePaneFocus('elevation', {
    capture: () => window,
    apply: (focus) => {
      const next = clampWindow(focus.startKm, focus.endKm, totalKm);
      if (isSameFocus(window, next)) return;
      setWindow(next);
    },
  });

  if (points.length === 0) {
    return (
      <View style={[styles.empty, { backgroundColor: colors.surface }]}>
        <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>Elevation</Text>
        <Text style={[styles.emptyHint, { color: colors.textSecondary }]}>
          This trail has no elevation data.
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <View style={styles.topBar} pointerEvents="box-none">
        <View
          style={[
            styles.chip,
            { backgroundColor: colors.surfaceElevated, borderColor: colors.border },
          ]}
        >
          {readout ? (
            <Text style={[styles.chipText, { color: colors.textPrimary }]}>
              {formatDistance(readout.km, units)} · {formatElevation(readout.ele, units)}
            </Text>
          ) : (
            <Text style={[styles.chipHint, { color: colors.textSecondary }]}>
              Tap to read off · pinch to zoom (up/down for height) · drag to pan
            </Text>
          )}
        </View>

        <View style={styles.scaleButtons}>
          <Pressable
            onPress={stretchElevation}
            accessibilityRole="button"
            accessibilityLabel="Stretch elevation"
            hitSlop={4}
            style={({ pressed }) => [
              styles.iconButton,
              { backgroundColor: colors.surfaceElevated, borderColor: colors.border },
              pressed && styles.pressed,
            ]}
          >
            <MaterialCommunityIcons name="arrow-expand-vertical" size={18} color={colors.accent} />
          </Pressable>
          <Pressable
            onPress={flattenElevation}
            accessibilityRole="button"
            accessibilityLabel="Flatten elevation"
            hitSlop={4}
            style={({ pressed }) => [
              styles.iconButton,
              { backgroundColor: colors.surfaceElevated, borderColor: colors.border },
              pressed && styles.pressed,
            ]}
          >
            <MaterialCommunityIcons name="arrow-collapse-vertical" size={18} color={colors.accent} />
          </Pressable>
        </View>

        {isZoomed && (
          <Pressable
            onPress={resetZoom}
            accessibilityRole="button"
            accessibilityLabel="Reset zoom"
            style={({ pressed }) => [
              styles.resetButton,
              { backgroundColor: colors.surfaceElevated, borderColor: colors.border },
              pressed && styles.pressed,
            ]}
          >
            <Text style={[styles.resetText, { color: colors.accent }]}>Reset zoom</Text>
          </Pressable>
        )}
      </View>

      <View style={styles.profile}>
        <ElevationProfile
          points={points}
          totalKm={totalKm}
          waypoints={profileWaypoints}
          favoriteIds={favoriteSet}
          plannedIds={plannedIds ?? undefined}
          unit={units}
          currentKm={currentKm}
          window={window}
          onWindowChange={setWindow}
          eleWindow={eleWindow}
          eleBounds={bounds}
          onEleWindowChange={setEleWindow}
          highlightRanges={highlightRanges}
          stopKms={stopKms}
          onWaypointTap={onWaypointTap}
          onScrub={setReadout}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
  },
  chip: {
    flexShrink: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipText: {
    ...typography.dataSmall,
    fontVariant: ['tabular-nums'],
  },
  chipHint: {
    ...typography.caption,
  },
  scaleButtons: {
    flexDirection: 'row',
    gap: spacing.xs,
    marginLeft: 'auto',
  },
  iconButton: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  resetButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  resetText: {
    ...typography.titleSmall,
  },
  pressed: {
    opacity: 0.6,
  },
  profile: {
    flex: 1,
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.md,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    padding: spacing.xl,
  },
  emptyTitle: {
    ...typography.displaySmall,
  },
  emptyHint: {
    ...typography.bodySmall,
    textAlign: 'center',
  },
});
