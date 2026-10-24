/**
 * The stops a trail data update left without a place (`@lib/plan-stop-issues`),
 * above the Plan screen's days: one notice — how many need checking, and the
 * nights left out of the dates — then each stop with why, which day it ends or
 * that its nights are not counted, and a Remove button. Nothing is removed or
 * moved for the hiker; ticking a stop's own place in Stops moves it there.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme';
import { radii, spacing, typography } from '../../tokens';
import { STOP_ISSUES_HINT } from '@lib/plan-stop-issues';
import type { StopIssueRow } from './stop-issues';

export interface StopIssuesCardProps {
  /** `stopIssuesNotice`; the card renders nothing when null. */
  notice: string | null;
  rows: readonly StopIssueRow[];
  /** Absent on a plan the hiker cannot edit: no Remove buttons. */
  onRemove?: (row: StopIssueRow) => void;
}

export function StopIssuesCard({ notice, rows, onRemove }: StopIssuesCardProps) {
  const { colors } = useTheme();
  if (notice === null) return null;
  return (
    <View
      style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.warning }]}
      accessibilityRole="alert"
    >
      <Text style={[styles.notice, { color: colors.textPrimary }]}>{`⚠ ${notice}`}</Text>
      {rows.map((row) => (
        <View key={row.key} style={styles.row}>
          <View style={styles.text}>
            <Text style={[styles.name, { color: colors.textPrimary }]} numberOfLines={1}>
              {row.name}
            </Text>
            <Text style={[styles.reason, { color: colors.textSecondary }]}>
              {`${row.reason} · ${row.where}`}
            </Text>
          </View>
          {onRemove && (
            <Pressable
              onPress={() => onRemove(row)}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${row.name} from the plan`}
              hitSlop={spacing.sm}
              style={({ pressed }) => [
                styles.remove,
                { borderColor: colors.warning },
                pressed && styles.pressed,
              ]}
            >
              <Text style={[styles.removeText, { color: colors.textPrimary }]}>Remove</Text>
            </Pressable>
          )}
        </View>
      ))}
      {onRemove && (
        <Text style={[styles.hint, { color: colors.textSecondary }]}>{STOP_ISSUES_HINT}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  notice: { ...typography.bodySmall, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  text: { flex: 1, gap: 2 },
  name: { ...typography.bodySmall, fontWeight: '600' },
  reason: { ...typography.caption },
  remove: {
    borderWidth: 1,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  removeText: { ...typography.caption, fontWeight: '700' },
  pressed: { opacity: 0.6 },
  hint: { ...typography.caption },
});
