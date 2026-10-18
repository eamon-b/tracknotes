/**
 * Water carries — the longest dry stretches in the section, from the shared
 * `analyzeWaterCarryForSection` (top ~5 gaps, biggest first). Carries at/over
 * the hiker's dry-stretch threshold (`isDryStretch`) are flagged.
 * Safety-critical for Australian trails, so the flag is loud.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { formatDistance } from '@lib/format-distance';
import { useTheme } from '../../theme';
import { radii, spacing, typography } from '../../tokens';
import type { Units } from '../../state/settings-store';
import { dryStretchBadge } from './plan-format';
import type { WaterGap } from '@lib/plan-types';

export function WaterCarryCard({
  carries,
  hasData,
  dryStretchKm,
  units,
}: {
  carries: WaterGap[];
  hasData: boolean;
  /** The threshold the carries were flagged against, named in the badge. */
  dryStretchKm: number;
  units: Units;
}) {
  const { colors } = useTheme();

  if (!hasData || carries.length === 0) {
    return (
      <Text style={[styles.empty, { color: colors.textSecondary }]}>
        No mapped water sources in this section.
      </Text>
    );
  }

  return (
    <View style={styles.list}>
      {carries.map((gap, i) => (
        <View
          key={`${gap.fromKm}-${gap.toKm}-${i}`}
          style={[
            styles.card,
            {
              backgroundColor: colors.surface,
              borderColor: gap.isDryStretch ? colors.danger : colors.border,
            },
          ]}
        >
          <View style={styles.head}>
            <Text style={[styles.route, { color: colors.textPrimary }]} numberOfLines={1}>
              {gap.fromName} → {gap.toName}
            </Text>
            {gap.isDryStretch && (
              <View style={[styles.badge, { backgroundColor: colors.danger }]}>
                <Text style={[styles.badgeText, { color: colors.dangerText }]}>{dryStretchBadge(dryStretchKm, units)}</Text>
              </View>
            )}
          </View>
          <Text style={[styles.stats, { color: colors.textSecondary }]}>
            {formatDistance(gap.distanceKm, units)} carry{offRouteText(gap, units)}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** " (incl. 2.3 km off route to water)" — the walk to and from sources off the route. */
function offRouteText(gap: WaterGap, units: Parameters<typeof formatDistance>[1]): string {
  const km = (gap.fromOffTrailKm ?? 0) + (gap.toOffTrailKm ?? 0);
  return km > 0 ? ` (incl. ${formatDistance(km, units)} off route to water)` : '';
}

const styles = StyleSheet.create({
  list: { gap: spacing.md },
  empty: { ...typography.bodySmall, paddingVertical: spacing.md },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  route: { ...typography.titleSmall, flexShrink: 1 },
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radii.full,
  },
  badgeText: { ...typography.caption, fontWeight: '700' },
  stats: { ...typography.bodySmall, fontVariant: ['tabular-nums'] },
});
