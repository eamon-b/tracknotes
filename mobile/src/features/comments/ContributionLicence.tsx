/**
 * The licence line under anything a hiker makes public: the comment composer
 * and the waypoint form when "Everyone" is chosen. The words come from
 * `@lib/contribution-licence`, so the phone and the web say the same thing;
 * "terms of service" opens the published terms in the browser.
 *
 * A failure to open the browser is spelled out with the URL, as Settings'
 * About section does, rather than a tap that does nothing.
 */

import { useCallback, useState } from 'react';
import { Linking, StyleSheet, Text } from 'react-native';
import { TERMS_URL, contributionLicenceLine } from '@lib/contribution-licence';
import { useTheme } from '../../theme';
import { typography } from '../../tokens';

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
      await Linking.openURL(TERMS_URL);
    } catch {
      setFailed(true);
    }
  }, []);

  return (
    <Text style={[styles.line, { color: colors.textSecondary }]}>
      {line.before}
      <Text
        onPress={() => void openTerms()}
        accessibilityRole="link"
        accessibilityLabel="Open terms of service"
        style={{ color: colors.accent }}
      >
        {line.link}
      </Text>
      {line.after}
      {failed ? ` Couldn’t open them; they are at ${TERMS_URL}` : null}
    </Text>
  );
}

const styles = StyleSheet.create({
  line: { ...typography.caption },
});
