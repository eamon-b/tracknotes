/**
 * Which OpenStreetMap points of interest to show, as a row of chips — the
 * planner's way into the guide's one POI filter.
 *
 * The map edits that filter from its layers sheet (`PoiLayersSheet`); the Today
 * screen and the Plan screen's day splits show the same POIs, so they edit the
 * same filter here rather than keeping one of their own: turning "Food & drink"
 * off in the planner and still seeing every café on the map would read as a
 * bug. The first chip is the master switch; then one chip per category with
 * something in `pois`, each with how many it controls. A category with nothing
 * here gets no chip — the layers sheet is where "Emergency · 0" is answered.
 */

import React, { useMemo } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { countPoisByCategory, POI_CATEGORIES, POI_CATEGORY_LABELS } from '@lib/poi-display';
import type { TrailPOI, TrailPOICategory } from '@lib/trail-types';
import { useTheme } from '../../theme';
import { radii, spacing, touchTarget, typography } from '../../tokens';
import { selectPoiFilter, useSettingsStore } from '../../state/settings-store';
import { poiColor } from '../elevation/waypoint-category';
import { WAYPOINT_ICON_IMAGES } from '../map/waypoint-icon-images';
import { poiIconName } from '../map/waypoint-icons';

export function PoiFilterChips({
  pois,
  label = 'OpenStreetMap places',
}: {
  /** The POIs the chips count — unfiltered, so a chip says what it would show. */
  pois: readonly TrailPOI[];
  /** The master chip's text. */
  label?: string;
}) {
  const filter = useSettingsStore(selectPoiFilter);
  const setPoiEnabled = useSettingsStore((s) => s.setPoiEnabled);
  const setPoiCategory = useSettingsStore((s) => s.setPoiCategory);
  const counts = useMemo(() => countPoisByCategory(pois), [pois]);
  const present = POI_CATEGORIES.filter((category) => counts[category] > 0);

  if (present.length === 0) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
      accessibilityLabel="Filter OpenStreetMap places"
    >
      <Chip
        on={filter.enabled}
        text={label}
        accessibilityLabel={`Show ${label}`}
        onPress={() => setPoiEnabled(!filter.enabled)}
      />
      {present.map((category) => (
        <Chip
          key={category}
          on={filter.enabled && filter.categories[category]}
          disabled={!filter.enabled}
          category={category}
          text={`${POI_CATEGORY_LABELS[category]} ${counts[category]}`}
          accessibilityLabel={`${POI_CATEGORY_LABELS[category]}, ${counts[category]}`}
          onPress={() => setPoiCategory(category, !filter.categories[category])}
        />
      ))}
      {/* Keeps the last chip clear of the screen edge when scrolled to the end. */}
      <View style={styles.tail} />
    </ScrollView>
  );
}

function Chip({
  on,
  disabled = false,
  category,
  text,
  accessibilityLabel,
  onPress,
}: {
  on: boolean;
  disabled?: boolean;
  category?: TrailPOICategory;
  text: string;
  accessibilityLabel: string;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  const tint = category ? poiColor(category, colors) : colors.accent;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked: on, disabled }}
      style={({ pressed }) => [
        styles.chip,
        {
          borderColor: on ? tint : colors.border,
          backgroundColor: on ? colors.surfaceElevated : colors.surface,
        },
        disabled && styles.disabled,
        pressed && styles.pressed,
      ]}
    >
      {category && (
        <Image
          source={WAYPOINT_ICON_IMAGES[poiIconName(category)]}
          style={[styles.glyph, { tintColor: colors.textPrimary }]}
          accessibilityIgnoresInvertColors
        />
      )}
      <Text
        style={[
          styles.text,
          { color: on ? colors.textPrimary : colors.textSecondary },
          !on && styles.off,
        ]}
      >
        {text}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { gap: spacing.sm, alignItems: 'center' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: touchTarget.min,
    paddingHorizontal: spacing.md,
    borderRadius: radii.full,
    borderWidth: 1.5,
  },
  glyph: { width: 14, height: 14, resizeMode: 'contain' },
  text: { ...typography.caption, fontWeight: '600', fontVariant: ['tabular-nums'] },
  off: { textDecorationLine: 'line-through' },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.6 },
  tail: { width: spacing.xs },
});
