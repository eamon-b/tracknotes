/**
 * The licence and privacy lines under anything a hiker makes public: the
 * comment composer, the waypoint form when "Everyone" is chosen, and the
 * route-share form. The words come from `@lib/contribution-licence`, so the
 * phone and the web say the same thing.
 *
 * Each line is one link — the first to the terms, with "terms of service"
 * inked, the second to the privacy policy (the notice at collection) — rather
 * than two links nested in one line: a nested pressable <Text> is invisible to
 * TalkBack, which reads the outer <Text> as a single node.
 *
 * A failure to open the browser is spelled out with the URL, as Settings'
 * About section does, rather than a tap that does nothing.
 */

import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { openURL } from 'expo-linking';
import {
  PRIVACY_POLICY_URL,
  TERMS_URL,
  contributionLicenceLine,
  contributionPrivacyLine,
} from '@lib/contribution-licence';
import { useTheme } from '../../theme';
import { spacing, typography } from '../../tokens';

/** Shown when the OS refuses to open the terms (no browser, blocked scheme). */
export const TERMS_OPEN_FAILED_MESSAGE = `Couldn't open the terms of service. You can read them at ${TERMS_URL}`;

/** Shown when the OS refuses to open the privacy policy. */
export const PRIVACY_OPEN_FAILED_MESSAGE = `Couldn't open the privacy policy. You can read it at ${PRIVACY_POLICY_URL}`;

export function ContributionLicence({ verb, what }: { verb: 'posting' | 'sharing'; what: string }) {
  const { colors } = useTheme();
  const [failed, setFailed] = useState<string | null>(null);
  const line = contributionLicenceLine(verb, what);
  const privacy = contributionPrivacyLine();

  const open = useCallback(async (url: string, failedMessage: string) => {
    setFailed(null);
    try {
      await openURL(url);
    } catch {
      setFailed(failedMessage);
    }
  }, []);

  return (
    <View style={styles.wrap}>
      <Text
        onPress={() => void open(TERMS_URL, TERMS_OPEN_FAILED_MESSAGE)}
        accessibilityRole="link"
        accessibilityHint="Opens the Tracknotes terms of service in your browser"
        style={[styles.line, { color: colors.textSecondary }]}
      >
        {line.before}
        <Text style={{ color: colors.accent }}>{line.link}</Text>
        {line.after}
      </Text>
      <Text
        onPress={() => void open(PRIVACY_POLICY_URL, PRIVACY_OPEN_FAILED_MESSAGE)}
        accessibilityRole="link"
        accessibilityHint="Opens the Tracknotes privacy policy in your browser"
        style={[styles.line, { color: colors.textSecondary }]}
      >
        {privacy.before}
        <Text style={{ color: colors.accent }}>{privacy.link}</Text>
        {privacy.after}
      </Text>
      {failed ? (
        <Text style={[styles.line, { color: colors.danger }]} accessibilityRole="alert">
          {failed}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.xs },
  line: { ...typography.caption },
});
