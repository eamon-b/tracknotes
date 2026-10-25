/**
 * The Plan screen's way into the resupply planner: one labelled row near the
 * top, carrying the plan's resupply in one line ("5 stops · longest 7 days").
 * It replaced a Resupply section near the foot of the screen whose "Choose
 * stops" link nobody found.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme';
import { radii, spacing, typography } from '../../tokens';

export interface ResupplyEntryRowProps {
  /** `resupply-planner` `resupplyEntryText`. */
  summary: string;
  onPress: () => void;
}

export function ResupplyEntryRow({ summary, onPress }: ResupplyEntryRowProps) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Resupply"
      accessibilityHint={summary}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: colors.surface, borderColor: colors.border },
        pressed && styles.pressed,
      ]}
    >
      <View style={styles.body}>
        <Text style={[styles.title, { color: colors.textPrimary }]}>Resupply</Text>
        <Text style={[styles.summary, { color: colors.textSecondary }]} numberOfLines={2}>
          {summary}
        </Text>
      </View>
      <Text style={[styles.open, { color: colors.accent }]}>Plan ›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.lg,
    padding: spacing.md,
  },
  body: { flex: 1, gap: 2 },
  title: { ...typography.titleSmall },
  summary: { ...typography.caption, fontVariant: ['tabular-nums'] },
  open: { ...typography.bodySmall, fontWeight: '700' },
  pressed: { opacity: 0.6 },
});
