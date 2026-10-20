/**
 * The guide three-pane shell: a segmented control switches Map | Elevation |
 * List, with a direction toggle beside it and a shared GPS "what's next" strip
 * above the panes. All three panes stay mounted; inactive panes are frozen with
 * `display: 'none'` and `pointerEvents="none"` so switching is instant and no
 * pane loses its scroll position or re-runs expensive work.
 *
 * A single `GuidePositionProvider` (hoisted to the guide navigator's `_layout`)
 * feeds the distance strip, the map puck, the elevation marker, the list
 * distances, and the waypoint detail screen from one GPS session in lockstep.
 *
 * The switch itself goes through `GuideFocusProvider`, which carries the section
 * you were looking at across the panes: leaving the map hands the elevation
 * profile the km range that was on screen, leaving the profile fits the map to
 * its zoom window, and the list scrolls to whichever pane you came from was
 * showing. See GuideFocusContext for the one-shot, one-direction rule.
 */

import React, { useCallback, useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useTheme } from '../../theme';
import { spacing } from '../../tokens';
import { useFavoritesStore } from '../../state/favorites-store';
import { refreshStopKms } from '@lib/plan-editor';
import type { PlanDocument } from '@lib/plan-types';
import { routeBreakStarts } from '@lib/route-breaks';
import { useRoutesStore } from '../routes/routes-store';
import type { RouteTrackPoint } from '../routes/route-geometry';
import { selectPlan, usePlansStore } from '../../state/plans-store';
import { useCommentSync } from '../../sync/connectivity';
import { ElevationPane } from '../elevation/ElevationPane';
import { MapPane } from '../map/MapPane';
import { DirectionToggle } from './DirectionToggle';
import { DistanceStrip } from './DistanceStrip';
import { SegmentedControl } from './SegmentedControl';
import { WaypointListPane } from './WaypointListPane';
import { useGuide } from './GuideContext';
import { GuideFocusProvider, useGuideFocus, type GuidePaneKey } from './GuideFocusContext';
import { takeMapTarget } from './map-target';

const OPTIONS = [
  { value: 'map' as const, label: 'Map' },
  { value: 'elevation' as const, label: 'Elevation' },
  { value: 'list' as const, label: 'List' },
];

export function GuideView() {
  return (
    <GuideFocusProvider>
      <GuidePanes />
    </GuideFocusProvider>
  );
}

function GuidePanes() {
  const { colors } = useTheme();
  const { trail, trailId, baseTrail, dataUpdatedAt } = useGuide();
  const { pane, switchPane, showOnMap } = useGuideFocus();

  // "Show on map" from the waypoint screen: it leaves the place here and
  // dismisses back to this screen, which picks it up as it regains focus.
  useFocusEffect(
    useCallback(() => {
      const target = takeMapTarget(trailId);
      if (target) showOnMap(target);
    }, [trailId, showOnMap]),
  );

  // Hydrate favorite hearts and the trail's plan (both local, every guide), and run
  // comment sync in the background (drain outbox + pull delta on open /
  // reconnect / foreground). The sync hook is called unconditionally and gates
  // itself on the server boundary, so an imported guide wires up no listeners
  // and issues no request — see `sync/connectivity`.
  useEffect(() => {
    void useFavoritesStore.getState().hydrate(trailId);
    // The plan feeds the map's stop rings and the profile's day ticks, so it
    // has to be in memory before either pane draws — not only once the Plan
    // screen has been opened.
    void usePlansStore.getState().hydrate(trailId);
  }, [trailId]);
  useCommentSync(trailId);

  // A data update can move a place a stop was saved at (a junction found over
  // OSM): move the stop with it, so its day ends where the walk in leaves the
  // route. A saved plan from another device or an older build is caught the
  // same way when it arrives. The edit is a no-op, and writes nothing, once
  // every stop sits at its place.
  // Not from data older than the plan was last saved against, though: that
  // would move the stops back and sync it over the newer device's correction.
  // The write is stamped with the data this guide shows.
  const plan = usePlansStore(selectPlan(trailId));
  useEffect(() => {
    const refresh = (p: PlanDocument) => refreshStopKms(p, baseTrail, { dataUpdatedAt });
    if (!plan || refresh(plan) === plan) return;
    void usePlansStore.getState().apply(trailId, refresh, { dataUpdatedAt });
  }, [plan, baseTrail, trailId, dataUpdatedAt]);

  // The same for custom routes: a redrawn track moves the km under every saved
  // route's snap points, so each is snapped again from its lat/lon. Against
  // the stored (NOBO) display track, the one their km are saved on; a no-op
  // once the routes were saved against this track.
  const baseDisplay = baseTrail.track.displayPoints;
  const baseBreaks = baseTrail.track.breaks;
  useEffect(() => {
    void useRoutesStore
      .getState()
      .resnap(
        trailId,
        baseDisplay as RouteTrackPoint[],
        routeBreakStarts(baseBreaks, 'displayPoints'),
      )
      .catch(() => {});
  }, [trailId, baseDisplay, baseBreaks]);

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <View style={styles.header}>
        <View style={styles.segmented}>
          <SegmentedControl<GuidePaneKey>
            options={OPTIONS}
            value={pane}
            onChange={switchPane}
          />
        </View>
        <DirectionToggle />
      </View>

      <DistanceStrip />

      <View style={styles.panes}>
        <FrozenPane active={pane === 'map'}>
          {/* Keyed on the trail: everything the map pane holds (a dismissed
              degradation banner, the style it resolved, a selected variant, an
              in-progress route) belongs to one trail and must not carry over. */}
          <MapPane key={trailId} />
        </FrozenPane>
        <FrozenPane active={pane === 'elevation'}>
          <ElevationPane />
        </FrozenPane>
        <FrozenPane active={pane === 'list'}>
          <WaypointListPane trail={trail} />
        </FrozenPane>
      </View>
    </View>
  );
}

/** Keeps children mounted; hides + disables them when inactive. */
function FrozenPane({ active, children }: { active: boolean; children: React.ReactNode }) {
  return (
    <View
      style={[StyleSheet.absoluteFill, !active && styles.hidden]}
      pointerEvents={active ? 'auto' : 'none'}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.lg,
    paddingBottom: spacing.sm,
  },
  segmented: {
    flex: 1,
  },
  panes: {
    flex: 1,
  },
  hidden: {
    display: 'none',
  },
});
