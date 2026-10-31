/**
 * "Your comments" in Settings: download a copy of every comment this account
 * posted (`GET /v1/me/comments`), handed to the OS share sheet as JSON so the
 * hiker can save it to Files, mail it to themselves, or keep it in a note.
 *
 * Only shown to a `registered` device, like the other account sections: an
 * anonymous install has posted nothing. The export needs the network; a
 * failure says so inline. Cancelling the sheet is not an error.
 */

import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Share, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme';
import { radii, spacing, touchTarget, typography } from '../../tokens';
import { isApiConfigured } from '../../api/client';
import { apiErrorMessage } from '../../api/error-message';
import { fetchMyComments } from '../../api/my-comments';
import { useIdentityStore } from '../../state/identity-store';
import { composeCommentExport, exportSummary } from './comment-export';

/** Fallback copy when an export fails for a reason we can't be specific about. */
export const EXPORT_FAILED_MESSAGE = "Couldn't export your comments. Please try again.";

export function CommentExportSection() {
  const { colors } = useTheme();
  const status = useIdentityStore((s) => s.status);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  // Same async keystore read as the other account sections; idempotent.
  useEffect(() => {
    void useIdentityStore
      .getState()
      .hydrate()
      .catch(() => undefined);
  }, []);

  const exportComments = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSummary(null);
    try {
      const comments = await fetchMyComments();
      if (comments.length > 0) {
        const { title, message } = composeCommentExport(comments, new Date().toISOString());
        const result = await Share.share(
          { title, message },
          { subject: title, dialogTitle: title },
        );
        if (result.action === Share.dismissedAction) return;
      }
      setSummary(exportSummary(comments.length));
    } catch (err) {
      setError(apiErrorMessage(err, EXPORT_FAILED_MESSAGE));
    } finally {
      setBusy(false);
    }
  }, [busy]);

  if (status !== 'registered') return null;
  if (!isApiConfigured()) return null;

  return (
    <View style={styles.section}>
      <Text style={[styles.label, { color: colors.textSecondary }]}>Your comments</Text>

      <View
        style={[
          styles.panel,
          { backgroundColor: colors.surfaceElevated, borderColor: colors.border },
        ]}
      >
        <Text style={[styles.hint, { color: colors.textSecondary }]}>
          Download a copy of every comment and water report you’ve posted, including ones you’ve
          deleted, as a JSON file you can save or send.
        </Text>

        {error ? (
          <Text style={[styles.message, { color: colors.danger }]} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}
        {summary ? (
          <Text style={[styles.message, { color: colors.textSecondary }]}>{summary}</Text>
        ) : null}

        <Pressable
          onPress={() => void exportComments()}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Export my comments"
          accessibilityState={{ disabled: busy, busy }}
          hitSlop={spacing.xs}
          style={[styles.action, { borderColor: colors.border }, busy && styles.disabled]}
        >
          {busy ? (
            <ActivityIndicator color={colors.textPrimary} />
          ) : (
            <Text style={[styles.actionLink, { color: colors.textPrimary }]}>
              Export my comments
            </Text>
          )}
        </Pressable>
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
  hint: { ...typography.bodySmall },
  message: { ...typography.bodySmall },
  action: {
    alignSelf: 'flex-start',
    minHeight: touchTarget.min,
    minWidth: touchTarget.min,
    paddingHorizontal: spacing.lg,
    marginTop: spacing.xs,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  disabled: { opacity: 0.5 },
  actionLink: { ...typography.titleSmall },
});
