/**
 * The hiker's planning thresholds — when a water carry is a dry stretch, how
 * much food a day weighs, and when a resupply leg is a long carry. ± steppers,
 * like daily hours. Presentational: the screen owns the values (per trail, in
 * `plan-inputs-store`, beside pace and hours) and the calculators require them.
 *
 * Each value is stored in the calculators' unit (km, grams, days); the stepper
 * moves in the hiker's display unit, so a miles user steps a mile at a time and
 * sees "9.3 mi" for the initial 15 km rather than a rounded figure.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { convertDistance } from '@lib/format-distance';
import { PLAN_THRESHOLD_BOUNDS, type PlanThresholds } from '@lib/plan-types';
import { useTheme } from '../../theme';
import { radii, spacing, typography } from '../../tokens';
import type { Units } from '../../state/settings-store';
import { StepButton } from './PlanInputsCard';
import { G_PER_OZ, formatDryStretch, formatFoodPerDay } from './plan-format';

/** One stepper tap, in the stored unit, for the hiker's display unit. */
function steps(units: Units): Record<keyof PlanThresholds, number> {
  return {
    dryStretchKm: units === 'mi' ? 1 / convertDistance(1, 'mi') : 1,
    foodGramsPerDay: units === 'mi' ? 2 * G_PER_OZ : 50,
    longCarryDays: 1,
  };
}

export interface PlanThresholdsCardProps extends PlanThresholds {
  units: Units;
  /** The store clamps into range; this only says which figure moved and to what. */
  onChange: (key: keyof PlanThresholds, value: number) => void;
}

export function PlanThresholdsCard(props: PlanThresholdsCardProps) {
  const { colors } = useTheme();
  const step = steps(props.units);
  const days = props.longCarryDays;

  const row = (key: keyof PlanThresholds, label: string, value: string, noun: string) => {
    const current = props[key];
    const { min, max } = PLAN_THRESHOLD_BOUNDS[key];
    return (
      <View style={styles.row}>
        <Text style={[styles.rowLabel, { color: colors.textSecondary }]}>{label}</Text>
        <View style={styles.stepper}>
          <StepButton
            label="−"
            accessibilityLabel={`Less ${noun}`}
            disabled={current <= min}
            onPress={() => props.onChange(key, current - step[key])}
          />
          <Text style={[styles.value, { color: colors.textPrimary }]}>{value}</Text>
          <StepButton
            label="+"
            accessibilityLabel={`More ${noun}`}
            disabled={current >= max}
            onPress={() => props.onChange(key, current + step[key])}
          />
        </View>
      </View>
    );
  };

  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.heading, { color: colors.textPrimary }]}>Carries</Text>
      {row(
        'dryStretchKm',
        'Dry stretch from',
        formatDryStretch(props.dryStretchKm, props.units),
        'dry-stretch distance',
      )}
      {row(
        'foodGramsPerDay',
        'Food per day',
        formatFoodPerDay(props.foodGramsPerDay, props.units),
        'food per day',
      )}
      {row('longCarryDays', 'Long carry over', `${days} ${days === 1 ? 'day' : 'days'}`, 'long-carry days')}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.md,
  },
  heading: { ...typography.titleSmall },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
  rowLabel: { ...typography.bodySmall, flexShrink: 1 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  value: { ...typography.titleSmall, minWidth: 72, textAlign: 'center', fontVariant: ['tabular-nums'] },
});
