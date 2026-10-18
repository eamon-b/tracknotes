/**
 * One day of the plan, waypoint by waypoint — what a day card on the Plan
 * screen opens.
 *
 * The same list as the Today screen (`DayWaypointList`): from the stop slept
 * at to the night's stop, every waypoint between with the distance, climb and
 * descent from the row before, and among them the OpenStreetMap points of
 * interest the guide's POI filter shows. The route params (`dayRouteParams`)
 * carry the day as the card showed it and the Plan screen's section, and the
 * day is rebuilt from the plan over that section (`currentPlanDay`: by date,
 * else by number), so an edit made from a waypoint pushed over this screen,
 * or a data reload, shows here; the params are the fallback when the plan no
 * longer has the day. The rows are measured on the route the plan walks
 * (`use-plan-route`), as the Plan screen's are.
 *
 * Read-only, like Today: stops are made and changed on the Plan screen.
 */

import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { KM_EPSILON } from '@lib/plan-direction';
import { useTheme } from '../../../src/theme';
import { spacing, typography } from '../../../src/tokens';
import { useGuide } from '../../../src/features/guide/GuideContext';
import { usePlanGlance } from '../../../src/features/plan/use-plan-glance';
import { planDays } from '../../../src/features/plan/plan-glance';
import {
  currentPlanDay,
  dayFromRouteParams,
  sectionFromRouteParams,
} from '../../../src/features/plan/today-plan';
import { useDayEntries, useLocalDate } from '../../../src/features/plan/use-today-plan';
import { DayWaypointList } from '../../../src/features/plan/DayWaypointList';

export default function DayScreen() {
  const params = useLocalSearchParams<Record<string, string>>();
  const { trailId } = useGuide();
  const { colors } = useTheme();
  const { trail, plan, options } = usePlanGlance();
  const today = useLocalDate();
  // Params are strings re-made on every render; key the parse on their values.
  const paramsKey = JSON.stringify(params);
  const opened = useMemo(
    () => ({ day: dayFromRouteParams(params), section: sectionFromRouteParams(params) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [paramsKey],
  );
  const day = useMemo(
    () => opened.day && currentPlanDay(planDays(trail, plan, options, opened.section), opened.day),
    [trail, plan, options, opened],
  );
  const { entries, pois } = useDayEntries(trail, day);

  if (!day) {
    return (
      <View style={[styles.empty, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: 'Day' }} />
        <Text style={[styles.emptyBody, { color: colors.textSecondary }]}>
          This day could not be opened. Go back to the planner and tap it again.
        </Text>
      </View>
    );
  }

  const endLead =
    day.date === today
      ? 'Tonight'
      : day.endKm >= trail.track.totalDistance - KM_EPSILON
        ? 'Finish'
        : 'Overnight';
  return (
    <>
      <Stack.Screen options={{ title: `Day ${day.dayNumber}` }} />
      <DayWaypointList
        trailId={trailId}
        day={day}
        lead={day.date !== undefined ? `Day ${day.dayNumber} · ${day.date}` : `Day ${day.dayNumber}`}
        endLead={endLead}
        entries={entries}
        pois={pois}
      />
    </>
  );
}

const styles = StyleSheet.create({
  empty: { flex: 1, padding: spacing.xl, justifyContent: 'center' },
  emptyBody: { ...typography.body },
});
