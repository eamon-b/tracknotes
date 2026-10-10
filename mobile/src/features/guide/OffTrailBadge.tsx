/**
 * "1.2 km off trail" — the one way every list marks a place the route does
 * not reach: a town down a side road, a hut up a spur, an OSM café a few
 * hundred metres away. An outlined pill in the theme's `offTrail` colour, so
 * it reads apart from the km beside it (which is the turn-off's, not the
 * place's) and from the category, water and resupply colours.
 *
 * Renders nothing for a place on the trail (`isPlaceOffTrail`, 50 m), so a
 * caller can always pass the figure it has.
 */

import React from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { formatDistance, type DistanceUnit } from '@lib/format-distance';
import { useTheme } from '../../theme';
import { radii, spacing, typography } from '../../tokens';
import { formatShortDistance } from './waypoint-filters';
import { isPlaceOffTrail } from './waypoint-detail';

/** How far off the trail, in words: metres/feet under 1 km, else km/mi. */
export function offTrailDistance(metres: number, units: DistanceUnit): string {
  return metres < 1000 ? formatShortDistance(metres, units) : formatDistance(metres / 1000, units);
}

/** The badge's text: "350 m off trail", "1.2 km off trail". */
export function offTrailLabel(metres: number, units: DistanceUnit): string {
  return `${offTrailDistance(metres, units)} off trail`;
}

export function OffTrailBadge({
  metres,
  units,
  style,
}: {
  /** Metres from the trail line (a turn-off's own `offTrailKm` × 1000). */
  metres: number | null | undefined;
  units: DistanceUnit;
  /** Placement only (e.g. `alignSelf` in a column that stretches its children). */
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  if (metres == null || !isPlaceOffTrail(metres)) return null;
  const label = offTrailLabel(metres, units);
  return (
    <View
      accessible
      accessibilityLabel={label}
      style={[styles.pill, { borderColor: colors.offTrail }, style]}
    >
      <Text style={[styles.text, { color: colors.offTrail }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    borderWidth: 1,
    borderRadius: radii.full,
    paddingHorizontal: spacing.sm,
  },
  text: { ...typography.caption, fontWeight: '600', fontVariant: ['tabular-nums'] },
});
