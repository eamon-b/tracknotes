/**
 * The licence line under anything a hiker makes public: the comment composer
 * and the waypoint form when "Everyone" is chosen. The words come from
 * `@lib/contribution-licence`, so the phone and the web say the same thing.
 *
 * The whole line is the link to the terms, with "terms of service" inked as
 * one: a nested pressable <Text> is invisible to TalkBack, which reads the
 * outer <Text> as a single node, and this is the one control that leads to
 * the terms being agreed to.
 *
 * A failure to open the browser is spelled out with the URL, as Settings'
 * About section does, rather than a tap that does nothing.
 */

import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { openURL } from 'expo-linking';
import { TERMS_URL, contributionLicenceLine } from '@lib/contribution-licence';
import { useTheme } from '../../theme';
import { spacing, typography } from '../../tokens';

/** Shown when the OS refuses to open the terms (no browser, blocked scheme). */
export const TERMS_OPEN_FAILED_MESSAGE = `Couldn't open the terms of service. You can read them at ${TERMS_URL}`;

export function ContributionLicence({
  verb,
  what,
}: {
  verb: 'posting' | 'sharing';
  what: string;
}) {
  const { colors } = useTheme();
  const [failed, setFailed] = useState(false);
  const line = contributionLicenceLine(verb, what);

  const openTerms = useCallback(async () => {
    setFailed(false);
    try {
      await openURL(TERMS_URL);
    } catch {
      setFailed(true);
    }
  }, []);

  return (
    <View style={styles.wrap}>
      <Text
        onPress={() => void openTerms()}
        accessibilityRole="link"
        accessibilityHint="Opens the Tracknotes terms of service in your browser"
        style={[styles.line, { color: colors.textSecondary }]}
      >
        {line.before}
        <Text style={{ color: colors.accent }}>{line.link}</Text>
        {line.after}
      </Text>
      {failed ? (
        <Text style={[styles.line, { color: colors.danger }]} accessibilityRole="alert">
          {TERMS_OPEN_FAILED_MESSAGE}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.xs },
  line: { ...typography.caption },
});
