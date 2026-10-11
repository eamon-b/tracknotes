/**
 * Today — the day of the plan dated today, waypoint by waypoint.
 *
 * From the stop the hiker slept at to the one entered for tonight, every
 * waypoint between with how far it is from the row before, and the climb and
 * descent on the way, and among them the OpenStreetMap points of interest the
 * guide's POI filter shows (restaurants, konbini, shops, water taps, …), each
 * with its km from the start and how far off the trail it is. Chips under the
 * day's summary edit that filter — the same one the map's layers sheet edits.
 * The header button that opens it shows only when today
 * has a planned day (`TodayHeaderButton`); opened any other way, the screen
 * says why there is nothing to show. On a rest day it says where.
 *
 * Read-only: stops are made and changed on the Plan screen, the map and the
 * waypoint screen. The list itself is `DayWaypointList`, which the Day screen
 * (any day tapped on the Plan screen) shares.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTheme } from '../../../src/theme';
import { radii, spacing, touchTarget, typography } from '../../../src/tokens';
import { emptyMessage } from '../../../src/features/plan/today-plan';
import { useTodayPlan } from '../../../src/features/plan/use-today-plan';
import { DayWaypointList } from '../../../src/features/plan/DayWaypointList';

export default function TodayScreen() {
  const { trailId } = useLocalSearchParams<{ trailId: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const { today, entries, pois, date, hasStartDate, hasStops } = useTodayPlan();

  const openPlanner = () =>
    router.push({ pathname: '/guide/[trailId]/plan', params: { trailId } });

  if (!today || today.kind === 'rest') {
    return (
      <View style={[styles.empty, { backgroundColor: colors.background }]}>
        <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>
          {today ? 'Rest day' : 'Nothing planned for today'}
        </Text>
        <Text style={[styles.emptyBody, { color: colors.textSecondary }]}>
          {emptyMessage(today, date, hasStops, hasStartDate)}
        </Text>
        <Pressable
          onPress={openPlanner}
          accessibilityRole="button"
          accessibilityLabel="Open planner"
          style={({ pressed }) => [
            styles.button,
            { backgroundColor: colors.accent },
            pressed && styles.pressed,
          ]}
        >
          <Text style={[styles.buttonText, { color: colors.accentText }]}>Open planner</Text>
        </Pressable>
      </View>
    );
  }

  const { day } = today;
  return (
    <DayWaypointList
      trailId={trailId}
      day={day}
      lead={`Day ${day.dayNumber} · ${date}`}
      endLead="Tonight"
      entries={entries}
      pois={pois}
    />
  );
}

const styles = StyleSheet.create({
  empty: { flex: 1, padding: spacing.xl, gap: spacing.md, justifyContent: 'center' },
  emptyTitle: { ...typography.titleLarge },
  emptyBody: { ...typography.body },
  button: {
    minHeight: touchTarget.min,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { ...typography.titleSmall },
  pressed: { opacity: 0.6 },
});
