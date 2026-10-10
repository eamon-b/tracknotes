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
 * waypoint screen.
 */

import React from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { formatDistance, formatElevation } from '@lib/format-distance';
import {
  OSM_ATTRIBUTION,
  poiCategoryLabel,
  poiDisplayName,
  poiRouteKey,
} from '@lib/poi-display';
import { waypointTypeLabel } from '@lib/waypoint-taxonomy';
import { useTheme } from '../../../src/theme';
import { radii, spacing, touchTarget, typography } from '../../../src/tokens';
import { useSettingsStore, type Units } from '../../../src/state/settings-store';
import { formatHours } from '../../../src/features/plan/plan-format';
import { emptyMessage, type TodayEntry, type TodayRow } from '../../../src/features/plan/today-plan';
import { useTodayPlan } from '../../../src/features/plan/use-today-plan';
import { PoiFilterChips } from '../../../src/features/plan/PoiFilterChips';
import { poiColor } from '../../../src/features/elevation/waypoint-category';
import { OffTrailBadge, offTrailA11y } from '../../../src/features/guide/OffTrailBadge';

export default function TodayScreen() {
  const { trailId } = useLocalSearchParams<{ trailId: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const units = useSettingsStore((s) => s.units);
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
  const hasPoiRows = entries.some((entry) => entry.kind === 'poi');
  return (
    <FlatList<TodayEntry>
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={styles.list}
      data={entries}
      keyExtractor={(entry) => entry.key}
      ListHeaderComponent={
        <View style={styles.header}>
          <View
            style={[styles.summary, { backgroundColor: colors.surface, borderColor: colors.border }]}
            accessible
            accessibilityLabel={`Day ${day.dayNumber}, ${day.startName} to ${day.endName}, ${formatDistance(day.distanceKm, units)}`}
          >
            <Text style={[styles.summaryLead, { color: colors.textSecondary }]}>
              {`Day ${day.dayNumber} · ${date}`}
            </Text>
            <Text style={[styles.summaryRoute, { color: colors.textPrimary }]}>
              {`${day.startName} → ${day.endName}`}
            </Text>
            <Text style={[styles.summaryStats, { color: colors.textSecondary }]}>
              {`${formatDistance(day.distanceKm, units)} · ↑ ${formatElevation(day.ascentM, units)} · ↓ ${formatElevation(day.descentM, units)} · ${formatHours(day.estimatedHours)}`}
            </Text>
          </View>
          <PoiFilterChips pois={pois} />
        </View>
      }
      ListFooterComponent={
        // The credit rides with the rows: OSM is owed a mention only when its
        // data is on screen.
        hasPoiRows ? (
          <Text style={[styles.footer, { color: colors.textSecondary }]}>
            {`Rows marked OSM are OpenStreetMap points of interest, not checked trail data · ${OSM_ATTRIBUTION}`}
          </Text>
        ) : null
      }
      renderItem={({ item }) =>
        item.kind === 'poi' ? (
          <TodayPoiRowView
            entry={item}
            units={units}
            onPress={() =>
              router.push({
                pathname: '/guide/[trailId]/poi/[poiKey]',
                params: { trailId, poiKey: poiRouteKey(item.poi) },
              })
            }
          />
        ) : (
          <TodayRowView
            row={item.row}
            units={units}
            onPress={
              // A taken alternate's places open too: the waypoint screen finds
              // them on the alternate (`findGuideWaypoint`).
              item.row.waypoint?.id
                ? () =>
                    router.push({
                      pathname: '/guide/[trailId]/waypoint/[waypointId]',
                      params: { trailId, waypointId: item.row.waypoint!.id! },
                    })
                : undefined
            }
          />
        )
      }
    />
  );
}

/**
 * An OSM point of interest on today's way: lighter than a waypoint row (no
 * border, no leg — a POI never splits a waypoint's leg), with the "OSM" pill
 * and category colour the guide's list uses, its km from the start, and how far
 * off the trail it is when that is a walk. Opening hours, when OSM has them,
 * because "is the café open when I get there?" is the question.
 */
function TodayPoiRowView({
  entry,
  units,
  onPress,
}: {
  entry: Extract<TodayEntry, { kind: 'poi' }>;
  units: Units;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  const { poi } = entry;
  const name = poiDisplayName(poi);
  const hours = poi.tags?.opening_hours;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${name}, OpenStreetMap ${poiCategoryLabel(poi.category)}, ${formatDistance(entry.fromStartKm, units)} from start${offTrailA11y(poi.distanceFromTrail * 1000, units)}`}
      style={({ pressed }) => [styles.poiRow, pressed && styles.pressed]}
    >
      <View style={styles.rowMain}>
        <View style={styles.poiType}>
          <View style={[styles.osmPill, { borderColor: colors.textSecondary }]}>
            <Text style={[styles.osmPillText, { color: colors.textSecondary }]}>OSM</Text>
          </View>
          <Text
            style={[styles.rowLead, { color: poiColor(poi.category, colors) }]}
            numberOfLines={1}
          >
            {poiCategoryLabel(poi.category)}
          </Text>
        </View>
        <Text style={[styles.rowName, { color: colors.textPrimary }]} numberOfLines={2}>
          {name}
        </Text>
        {hours !== undefined && hours !== '' && (
          <Text style={[styles.rowLeg, { color: colors.textSecondary }]} numberOfLines={2}>
            {hours}
          </Text>
        )}
      </View>
      <View style={styles.rowSide}>
        <Text style={[styles.rowKm, { color: colors.textPrimary }]}>
          {formatDistance(entry.fromStartKm, units)}
        </Text>
        <OffTrailBadge metres={poi.distanceFromTrail * 1000} units={units} />
      </View>
    </Pressable>
  );
}

function TodayRowView({
  row,
  units,
  onPress,
}: {
  row: TodayRow;
  units: Units;
  onPress?: () => void;
}) {
  const { colors } = useTheme();
  const isEnd = row.role !== 'via';
  const lead =
    row.role === 'start' ? 'Start' : row.role === 'end' ? 'Tonight' : waypointTypeLabel(row.type);
  const leg =
    row.role === 'start'
      ? ''
      : `${formatDistance(row.legKm, units)} · ↑ ${formatElevation(row.legAscentM, units)} · ↓ ${formatElevation(row.legDescentM, units)}`;
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={`${row.name}, ${formatDistance(row.fromStartKm, units)} from start${leg ? `, leg ${leg}` : ''}${offTrailA11y(row.offTrailM, units)}`}
      style={({ pressed }) => [
        styles.row,
        {
          backgroundColor: colors.surface,
          borderColor: isEnd ? colors.waypointCamp : colors.border,
        },
        pressed && styles.pressed,
      ]}
    >
      <View style={styles.rowMain}>
        <Text style={[styles.rowLead, { color: isEnd ? colors.waypointCamp : colors.textSecondary }]}>
          {lead}
        </Text>
        <Text style={[styles.rowName, { color: colors.textPrimary }]} numberOfLines={2}>
          {row.name}
        </Text>
        {leg !== '' && (
          <Text style={[styles.rowLeg, { color: colors.textSecondary }]}>{leg}</Text>
        )}
      </View>
      <View style={styles.rowSide}>
        <Text style={[styles.rowKm, { color: colors.textPrimary }]}>
          {formatDistance(row.fromStartKm, units)}
        </Text>
        <Text style={[styles.rowClimb, { color: colors.textSecondary }]}>
          {`↑ ${formatElevation(row.totalAscentM, units)} ↓ ${formatElevation(row.totalDescentM, units)}`}
        </Text>
        <OffTrailBadge metres={row.offTrailM} units={units} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  list: { padding: spacing.lg, gap: spacing.sm },
  header: { gap: spacing.sm, marginBottom: spacing.sm },
  summary: {
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  summaryLead: { ...typography.caption, fontVariant: ['tabular-nums'] },
  summaryRoute: { ...typography.titleSmall },
  summaryStats: { ...typography.bodySmall, fontVariant: ['tabular-nums'] },
  row: {
    flexDirection: 'row',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.md,
    minHeight: touchTarget.min,
  },
  rowMain: { flex: 1, gap: 2 },
  poiRow: {
    flexDirection: 'row',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    gap: spacing.md,
    minHeight: touchTarget.min,
  },
  poiType: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  osmPill: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.full,
    paddingHorizontal: spacing.xs,
  },
  osmPillText: { ...typography.caption, fontWeight: '600' },
  footer: { ...typography.caption, marginTop: spacing.sm },
  rowLead: { ...typography.caption, fontWeight: '700' },
  rowName: { ...typography.bodySmall },
  rowLeg: { ...typography.caption, fontVariant: ['tabular-nums'] },
  rowSide: { alignItems: 'flex-end', justifyContent: 'center', gap: 2 },
  rowKm: { ...typography.bodySmall, fontWeight: '700', fontVariant: ['tabular-nums'] },
  rowClimb: { ...typography.caption, fontVariant: ['tabular-nums'] },
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
