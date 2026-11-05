/**
 * The planner's filter box: one line of text narrowing a list of places by
 * name (`@lib/name-filter`, case- and accent-insensitive, as on the web).
 * Used over the Stops list and the resupply screen's groups. It only narrows
 * what is shown; nothing ticked or chosen changes.
 */

import React from 'react';
import { StyleSheet, TextInput } from 'react-native';
import { useTheme } from '../../theme';
import { radii, spacing, touchTarget, typography } from '../../tokens';

export function PlanFilterInput({
  value,
  onChange,
  placeholder,
  accessibilityLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  accessibilityLabel: string;
}) {
  const { colors } = useTheme();
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      placeholder={placeholder}
      placeholderTextColor={colors.textSecondary}
      accessibilityLabel={accessibilityLabel}
      autoCorrect={false}
      autoCapitalize="none"
      clearButtonMode="while-editing"
      returnKeyType="search"
      style={[
        styles.input,
        {
          color: colors.textPrimary,
          backgroundColor: colors.background,
          borderColor: colors.border,
        },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  input: {
    ...typography.bodySmall,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: touchTarget.min,
  },
});
