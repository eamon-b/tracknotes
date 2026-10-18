/**
 * A list of data credits (`credits.ts`): a label, the credit itself, and its
 * link when it has one. Shared by the map's credits sheet and Settings →
 * About, so the two never word a licence differently.
 *
 * A link shows its `linkText`, not its address, so a failed open (no browser,
 * blocked scheme) is reported inline with the URL spelled out — the hiker can
 * still type it in — as AboutSection does for the privacy policy.
 */

import React, { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { openURL } from 'expo-linking';
import { useTheme } from '../theme';
import { spacing, typography } from '../tokens';
import type { CreditLine } from './credits';

export function creditOpenFailedMessage(url: string): string {
  return `Couldn't open the link. You can find it at ${url}`;
}

export function CreditList({ lines }: { lines: readonly CreditLine[] }) {
  const { colors } = useTheme();
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  const open = useCallback(async (url: string) => {
    setFailedUrl(null);
    try {
      await openURL(url);
    } catch {
      setFailedUrl(url);
    }
  }, []);

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
                  accessibilityHint="Opens in your browser"
                  onPress={() => void open(line.url!)}
                >
                  {line.linkText ?? line.url}
                </Text>
              </>
            ) : null}
          </Text>
          {failedUrl !== null && failedUrl === line.url ? (
            <Text
              selectable
              style={[styles.text, { color: colors.danger }]}
              accessibilityRole="alert"
            >
              {creditOpenFailedMessage(failedUrl)}
            </Text>
          ) : null}
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
