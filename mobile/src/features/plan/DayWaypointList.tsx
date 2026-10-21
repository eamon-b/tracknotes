/**
 * One planned day, waypoint by waypoint: a summary card, the guide's POI
 * filter chips, then every row from the stop slept at to the night's stop with
 * the OSM points of interest the filter shows among them (`today-plan.ts`
 * `todayEntries`). Each waypoint row opens its waypoint, each POI row its POI,
 * and a waypoint row's map-marker button shows the place on the guide's map,
 * with the walk in dotted when it is off the route.
 *
 * Shared by the Today screen (the day dated today) and the Day screen (any
 * day card tapped on the Plan screen), so the two read the same.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { formatDistance, formatElevation } from '@lib/format-distance';
import type { ComputedDay } from '@lib/plan-types';
import {
  OSM_ATTRIBUTION,
  poiCategoryLabel,
  poiDisplayName,
  poiRouteKey,
} from '@lib/poi-display';
import type { TrailPOI } from '@lib/trail-types';
import { waypointTypeLabel } from '@lib/waypoint-taxonomy';
import { useTheme } from '../../theme';
import { radii, spacing, touchTarget, typography } from '../../tokens';
import { useSettingsStore, type Units } from '../../state/settings-store';
import { poiColor } from '../elevation/waypoint-category';
import { OffTrailBadge, offTrailA11y } from '../guide/OffTrailBadge';
import { mapPointOf } from '../guide/map-target';
import { ShowOnMapIconButton, useShowOnMap } from '../guide/ShowOnMap';
import { ScreenFlatList } from '../../navigation/ScreenScrollView';
import { formatHours } from './plan-format';
import type { TodayEntry, TodayRow } from './today-plan';
import { PoiFilterChips } from './PoiFilterChips';

export function DayWaypointList({
  trailId,
  day,
  lead,
  endLead,
  entries,
  pois,
}: {
  trailId: string;
  day: ComputedDay;
  /** The summary card's first line, e.g. "Day 2 · 2026-10-11". */
  lead: string;
  /** The label on the night's stop: "Tonight" on the Today screen. */
  endLead: string;
  /** The rows with the POIs the filter shows among them (`todayEntries`). */
  entries: TodayEntry[];
  /** Every POI along the day, unfiltered — what the filter chips count. */
  pois: TrailPOI[];
}) {
  const router = useRouter();
  const { colors } = useTheme();
  const units = useSettingsStore((s) => s.units);
  const showOnMap = useShowOnMap(trailId);
  const hasPoiRows = entries.some((entry) => entry.kind === 'poi');
  return (
    <ScreenFlatList<TodayEntry>
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
            <Text style={[styles.summaryLead, { color: colors.textSecondary }]}>{lead}</Text>
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
        ) : undefined
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
            endLead={endLead}
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
            onShowOnMap={
              item.row.waypoint ? () => showOnMap(mapPointOf(item.row.waypoint!)) : undefined
            }
          />
        )
      }
    />
  );
}

/**
 * An OSM point of interest on the day's way: lighter than a waypoint row (no
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
  endLead,
  onPress,
  onShowOnMap,
}: {
  row: TodayRow;
  units: Units;
  endLead: string;
  onPress?: () => void;
  onShowOnMap?: () => void;
}) {
  const { colors } = useTheme();
  const isEnd = row.role !== 'via';
  const lead =
    row.role === 'start' ? 'Start' : row.role === 'end' ? endLead : waypointTypeLabel(row.type);
  const leg =
    row.role === 'start'
      ? ''
      : `${formatDistance(row.legKm, units)} · ↑ ${formatElevation(row.legAscentM, units)} · ↓ ${formatElevation(row.legDescentM, units)}`;
  // The map button sits beside the row's pressable, not inside it: an
  // accessible parent would hide it from a screen reader.
  return (
    <View
      style={[
        styles.row,
        {
          backgroundColor: colors.surface,
          borderColor: isEnd ? colors.waypointCamp : colors.border,
        },
      ]}
    >
      <Pressable
        onPress={onPress}
        disabled={!onPress}
        accessibilityRole={onPress ? 'button' : undefined}
        accessibilityLabel={`${row.name}, ${formatDistance(row.fromStartKm, units)} from start${leg ? `, leg ${leg}` : ''}${offTrailA11y(row.offTrailM, units)}`}
        style={({ pressed }) => [styles.rowPress, pressed && styles.pressed]}
      >
        <View style={styles.rowMain}>
          <Text
            style={[styles.rowLead, { color: isEnd ? colors.waypointCamp : colors.textSecondary }]}
          >
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
      {onShowOnMap && <ShowOnMapIconButton name={row.name} onPress={onShowOnMap} />}
    </View>
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
  rowPress: { flex: 1, flexDirection: 'row', gap: spacing.md },
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
  pressed: { opacity: 0.6 },
});
