/**
 * A list of data credits (`credits.ts`): a label, the credit itself, and its
 * link when it has one. Shared by the map's credits sheet and Settings →
 * About, so the two never word a licence differently.
 *
 * A link shows its `linkText`, not its address, so a failed open (no browser,
 * blocked scheme) is reported inline with the URL spelled out — the hiker can
 * still type it in — as AboutSection does for the privacy policy.
 *
 * Each link is its own `Pressable` under the credit rather than a `<Text>`
 * nested in it: TalkBack reads a parent `Text` as one node and ignores a nested
 * link's role, so a nested link could not be reached with a screen reader.
 */

import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { openURL } from 'expo-linking';
import { useTheme } from '../theme';
import { spacing, touchTarget, typography } from '../tokens';
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
          <Text style={[styles.text, { color: colors.textPrimary }]}>{line.text}</Text>
          {line.url ? (
            <Pressable
              onPress={() => void open(line.url!)}
              accessibilityRole="link"
              accessibilityLabel={line.linkText ?? line.url}
              accessibilityHint="Opens in your browser"
              hitSlop={{ top: spacing.sm, bottom: spacing.sm }}
              style={({ pressed }) => [styles.link, pressed && styles.pressed]}
            >
              <Text style={[styles.text, { color: colors.accent }]}>
                {line.linkText ?? line.url}
              </Text>
            </Pressable>
          ) : null}
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
  link: {
    alignSelf: 'flex-start',
    minHeight: touchTarget.min - 2 * spacing.sm,
    justifyContent: 'center',
  },
  pressed: { opacity: 0.6 },
});
