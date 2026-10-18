/**
 * The hiker's planning thresholds — when a water carry is a dry stretch, how
 * much food a day weighs, and when a resupply leg is a long carry. ± steppers,
 * like daily hours. Presentational: the screen owns the values (per trail, in
 * `plan-inputs-store`, beside pace and hours) and the calculators require them.
 *
 * Each value is stored in the calculators' unit (km, grams, days); the stepper
 * moves on a grid in the hiker's display unit — whole km or miles, 20 g (the
 * web input's step) or whole ounces, whole days — snapping an off-grid value
 * (an initial 15 km read in miles, or a figure set in the other unit) onto it
 * first. The stored value is rounded to what the card can show (0.1 km, 1 g),
 * so the figure on screen and in the badge is the one the flags use.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { convertDistance } from '@lib/format-distance';
import { PLAN_THRESHOLD_BOUNDS, PLAN_THRESHOLD_STEPS, type PlanThresholds } from '@lib/plan-types';
import { useTheme } from '../../theme';
import { radii, spacing, typography } from '../../tokens';
import type { Units } from '../../state/settings-store';
import { StepButton } from './PlanInputsCard';
import { G_PER_OZ, formatDryStretch, formatFoodPerDay } from './plan-format';

/** How many stored units (km, g, days) one step of the hiker's display unit is. */
function stepSize(key: keyof PlanThresholds, units: Units): number {
  if (units === 'mi' && key === 'dryStretchKm') return 1 / convertDistance(1, 'mi');
  if (units === 'mi' && key === 'foodGramsPerDay') return G_PER_OZ;
  return PLAN_THRESHOLD_STEPS[key];
}

/** The stored precision: 0.1 km, whole grams, whole days. */
const STORED_DECIMALS: Record<keyof PlanThresholds, number> = {
  dryStretchKm: 1,
  foodGramsPerDay: 0,
  longCarryDays: 0,
};

/**
 * The value one step up (`direction` 1) or down (-1) from `current`, on the
 * display unit's grid: snap to the nearest grid point, step, convert back, and
 * round to the stored precision. Exported for tests.
 */
export function stepThreshold(
  key: keyof PlanThresholds,
  current: number,
  direction: 1 | -1,
  units: Units,
): number {
  const size = stepSize(key, units);
  const next = (Math.round(current / size) + direction) * size;
  const factor = 10 ** STORED_DECIMALS[key];
  return Math.round(next * factor) / factor;
}

export interface PlanThresholdsCardProps extends PlanThresholds {
  units: Units;
  /** The store clamps into range; this only says which figure moved and to what. */
  onChange: (key: keyof PlanThresholds, value: number) => void;
}

export function PlanThresholdsCard(props: PlanThresholdsCardProps) {
  const { colors } = useTheme();
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
            onPress={() => props.onChange(key, stepThreshold(key, current, -1, props.units))}
          />
          <Text style={[styles.value, { color: colors.textPrimary }]}>{value}</Text>
          <StepButton
            label="+"
            accessibilityLabel={`More ${noun}`}
            disabled={current >= max}
            onPress={() => props.onChange(key, stepThreshold(key, current, 1, props.units))}
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
