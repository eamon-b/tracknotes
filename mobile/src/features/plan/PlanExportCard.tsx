/**
 * "Export" on the Plan screen: share the plan as a GPX file (the route as
 * planned, its night stops and resupply stops) or as a calendar (one event per
 * walking and rest day). The calendar needs a start date and says so while the
 * plan has none. Cancelling the share sheet is not an error (expo-sharing does
 * not say whether the sheet was used or dismissed).
 */

import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme';
import { radii, spacing, touchTarget, typography } from '../../tokens';
import type { PlanExportKind } from './plan-export-share';
import { ICS_REEXPORT_NOTE } from '@lib/plan-export';

export const ICS_NEEDS_START_DATE = 'Set a start date in the plan settings to export a calendar.';
export const PLAN_EXPORT_FAILED = "Couldn't export the plan. Please try again.";

export function PlanExportCard({
  canExportCalendar,
  onExport,
}: {
  /** The plan has a start date (and a planned day), so a calendar can be written. */
  canExportCalendar: boolean;
  onExport: (kind: PlanExportKind) => Promise<void>;
}) {
  const { colors } = useTheme();
  const [busy, setBusy] = useState<PlanExportKind | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (kind: PlanExportKind) => {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try {
      await onExport(kind);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : PLAN_EXPORT_FAILED);
    } finally {
      setBusy(null);
    }
  };

  const action = (kind: PlanExportKind, label: string, disabled: boolean) => (
    <Pressable
      onPress={() => void run(kind)}
      disabled={disabled || busy !== null}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || busy !== null, busy: busy === kind }}
      hitSlop={spacing.xs}
      style={[styles.action, { borderColor: colors.border }, disabled && styles.disabled]}
    >
      {busy === kind ? (
        <ActivityIndicator color={colors.textPrimary} />
      ) : (
        <Text style={[styles.actionText, { color: colors.textPrimary }]}>{label}</Text>
      )}
    </Pressable>
  );

  return (
    <View
      style={[
        styles.panel,
        { backgroundColor: colors.surfaceElevated, borderColor: colors.border },
      ]}
    >
      <Text style={[styles.hint, { color: colors.textSecondary }]}>
        Send the plan to a GPS or mapping app, or put the days in your calendar.
      </Text>
      <View style={styles.row}>
        {action('gpx', 'Share GPX', false)}
        {action('ics', 'Share calendar (.ics)', !canExportCalendar)}
      </View>
      <Text style={[styles.hint, { color: colors.textSecondary }]}>
        {canExportCalendar ? ICS_REEXPORT_NOTE : ICS_NEEDS_START_DATE}
      </Text>
      {error ? (
        <Text style={[styles.hint, { color: colors.danger }]} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  hint: { ...typography.bodySmall },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  action: {
    minHeight: touchTarget.min,
    minWidth: touchTarget.min,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  disabled: { opacity: 0.5 },
  actionText: { ...typography.titleSmall },
});
