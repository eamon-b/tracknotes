/**
 * About section for Settings — the in-app route to the privacy policy and the
 * terms of service.
 *
 * The store listings link the same URL, and app stores expect the policy to be
 * reachable from inside the app too, so this is the one place a hiker can read
 * what the app collects without leaving for a browser search. The policy is the
 * web app's copy (`public/privacy.html`, deployed to Vercel) rather than a
 * bundled duplicate: a bundled copy would need an app release to correct a
 * policy, and the store listing would drift from what the app shows.
 *
 * Opening leaves the app, so a failure (no browser, unhandled scheme) is
 * reported inline with the URL spelled out — a hiker with no browser can still
 * type it in — instead of silently doing nothing.
 *
 * Below it, the app-wide data credits (OpenStreetMap, base maps, contours,
 * climate). A trail's own source is credited on its map (tap the credit label).
 */

import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { openURL } from 'expo-linking';
import { PRIVACY_POLICY_URL, TERMS_URL } from '@lib/contribution-licence';
import { useTheme } from '../../theme';
import { radii, spacing, touchTarget, typography } from '../../tokens';
import { CreditList } from '../../credits/CreditList';
import { appCredits } from '../../credits/credits';

const APP_CREDITS = appCredits();

/**
 * Canonical privacy policy URL — the Vercel deploy of `public/privacy.html`,
 * defined beside the terms in `@lib/contribution-licence` so the deploy origin
 * is spelled out once. Keep it in sync with the App Store / Play Store
 * listings; store review flags a mismatch.
 */
export { PRIVACY_POLICY_URL };

/** Shown when the OS refuses to open the policy (no browser, blocked scheme). */
export const PRIVACY_OPEN_FAILED_MESSAGE = `Couldn't open the privacy policy. You can read it at ${PRIVACY_POLICY_URL}`;

/** Shown when the OS refuses to open the terms of service. */
export const TERMS_OPEN_FAILED_MESSAGE = `Couldn't open the terms of service. You can read them at ${TERMS_URL}`;

export function AboutSection() {
  const { colors } = useTheme();
  const [error, setError] = useState<string | null>(null);

  const open = useCallback(async (url: string, failedMessage: string) => {
    setError(null);
    try {
      await openURL(url);
    } catch {
      setError(failedMessage);
    }
  }, []);

  return (
    <View style={styles.section}>
      <Text style={[styles.label, { color: colors.textSecondary }]}>About</Text>

      <View
        style={[
          styles.panel,
          { backgroundColor: colors.surfaceElevated, borderColor: colors.border },
        ]}
      >
        <View style={styles.row}>
          <View style={styles.rowMain}>
            <Text style={[styles.rowLabel, { color: colors.textSecondary }]}>Privacy policy</Text>
            <Text style={[styles.hint, { color: colors.textSecondary }]}>
              What Tracknotes collects, where it’s stored, and how to delete it. Opens in your
              browser.
            </Text>
          </View>
          <Pressable
            onPress={() => void open(PRIVACY_POLICY_URL, PRIVACY_OPEN_FAILED_MESSAGE)}
            accessibilityRole="link"
            accessibilityLabel="Open privacy policy"
            accessibilityHint="Opens the Tracknotes privacy policy in your browser"
            hitSlop={spacing.sm}
            style={styles.action}
          >
            <Text style={[styles.actionLink, { color: colors.accent }]}>Read</Text>
          </Pressable>
        </View>

        <View style={styles.row}>
          <View style={styles.rowMain}>
            <Text style={[styles.rowLabel, { color: colors.textSecondary }]}>Terms of service</Text>
            <Text style={[styles.hint, { color: colors.textSecondary }]}>
              The terms for using Tracknotes and for what you post. Opens in your browser.
            </Text>
          </View>
          <Pressable
            onPress={() => void open(TERMS_URL, TERMS_OPEN_FAILED_MESSAGE)}
            accessibilityRole="link"
            accessibilityLabel="Open terms of service"
            accessibilityHint="Opens the Tracknotes terms of service in your browser"
            hitSlop={spacing.sm}
            style={styles.action}
          >
            <Text style={[styles.actionLink, { color: colors.accent }]}>Read</Text>
          </Pressable>
        </View>

        {error ? (
          <Text style={[styles.error, { color: colors.danger }]} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}
      </View>

      <View
        style={[
          styles.panel,
          { backgroundColor: colors.surfaceElevated, borderColor: colors.border },
        ]}
      >
        <Text style={[styles.rowLabel, { color: colors.textSecondary }]}>Data credits</Text>
        <CreditList lines={APP_CREDITS} />
        <Text style={[styles.hint, { color: colors.textSecondary }]}>
          Each trail’s own source is on its map: tap the credit in the bottom corner.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing.sm },
  label: { ...typography.titleLarge },
  panel: {
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  rowMain: { flex: 1, gap: spacing.xs },
  rowLabel: { ...typography.caption },
  hint: { ...typography.bodySmall },
  error: { ...typography.bodySmall },
  action: {
    minHeight: touchTarget.min,
    minWidth: touchTarget.min,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.sm,
  },
  actionLink: { ...typography.titleSmall },
});
