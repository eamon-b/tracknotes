/**
 * A list of data credits (`map-credits.ts`): a label, the credit itself, and
 * its link when it has one. Shared by the map's credits sheet and Settings →
 * About, so the two never word a licence differently.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { openURL } from 'expo-linking';
import { useTheme } from '../../theme';
import { spacing, typography } from '../../tokens';
import type { CreditLine } from './map-credits';

export function CreditList({ lines }: { lines: readonly CreditLine[] }) {
  const { colors } = useTheme();
  return (
    <View style={styles.list}>
      {lines.map((line) => (
        <View key={`${line.label}:${line.text}`} style={styles.line}>
          <Text style={[styles.label, { color: colors.textSecondary }]}>{line.label}</Text>
          <Text style={[styles.text, { color: colors.textPrimary }]}>
            {line.text}
            {line.url ? (
              <>
                {' '}
                <Text
                  style={{ color: colors.accent }}
                  accessibilityRole="link"
                  // A failed open (no browser) leaves the URL on screen to type in.
                  onPress={() => void openURL(line.url!).catch(() => undefined)}
                >
                  {line.linkText ?? line.url}
                </Text>
              </>
            ) : null}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing.md },
  line: { gap: spacing.xs },
  label: { ...typography.caption },
  text: { ...typography.bodySmall },
});
