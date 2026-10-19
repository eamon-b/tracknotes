/**
 * The comments block of a place: a newest-first feed (server rows + optimistic
 * local rows with "waiting to send" / "failed" affordances), "show earlier",
 * Report on other people's synced rows, Delete/Retry on the hiker's own, the
 * full-screen photo viewer, and the composer (`Composer` — water-flow chips,
 * photo attach, and the first-post display-name prompt).
 *
 * One component for every kind of place that takes comments — a curated
 * waypoint, a hiker's shared one, an OpenStreetMap POI (`@lib/poi-display`
 * `poiCommentId`) — so they cannot drift. The caller decides the id the
 * comments are filed under; null switches the feed off and says why.
 *
 * The feed reads straight from SQLite (so it renders instantly and offline);
 * mount kicks a background pull and re-reads when it lands. Since the cache
 * already holds every comment for the trail, paging is a widening LIMIT over
 * that cache rather than a network page fetch.
 *
 * None of that channel exists for a user-imported guide (`services/server-trails`):
 * its ids are local-only, so the block collapses to a one-line note and no
 * SQLite read or request is issued for it.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import type { WaterStatus } from '@lib/comments-api-types';
import { commentTargetFitsTrail, commentTargetKind } from '@lib/comment-targets';
import { isCommunityRouteId } from '@lib/community-types';
import { useTheme } from '../../theme';
import { radii, spacing, typography } from '../../tokens';
import { relativeDate, waterStatusMeta } from '../guide/waypoint-detail';
import { isServerKnown } from '../../services/server-trails';
import { getDatabase } from '../../db/database';
import * as commentsRepo from '../../db/comments-repo';
import type { CommentWithSyncState } from '../../db/comments-repo';
import { isApiConfigured } from '../../api/client';
import { useIdentityStore } from '../../state/identity-store';
import {
  deleteOwnComment,
  pullTrail,
  retryOutbox,
  submitComment,
  submitReport,
} from '../../sync/comment-sync';
import { onSyncChange } from '../../sync/sync-events';
import { Composer } from './Composer';
import { ReportDialog } from './ReportDialog';
import { confirmDeleteComment, retryComment } from './comment-actions';

/** Comments revealed per "show earlier" tap (and in the initial window). */
const COMMENT_PAGE_SIZE = 20;

/**
 * Whether the server files comments under this id on this trail. A community
 * route takes them only on its own `uw_` waypoints, shared hiker waypoints
 * and OSM places (`@lib/comment-targets`, the worker's rule): a route whose
 * file carries some other id for a place would have every comment refused.
 */
function takesComments(trailId: string, waypointId: string | null): waypointId is string {
  if (waypointId === null) return false;
  if (!isCommunityRouteId(trailId)) return true;
  const kind = commentTargetKind(waypointId);
  return kind !== null && commentTargetFitsTrail(kind, 'community');
}

export function CommentsSection({
  trailId,
  waypointId,
  waypointType,
  unavailableText = 'Comments aren’t supported for this waypoint.',
}: {
  trailId: string;
  /** The id the comments are filed under, or null when this place has none. */
  waypointId: string | null;
  /** Decides whether the composer offers the water-flow chips. */
  waypointType: string;
  /** What to say instead of a feed when `waypointId` is null. */
  unavailableText?: string;
}) {
  const { colors } = useTheme();
  const serverKnown = isServerKnown(trailId);
  // Null switches the feed off: no SQLite read and no composer.
  const commentWaypointId = serverKnown && takesComments(trailId, waypointId) ? waypointId : null;
  const identityStatus = useIdentityStore((s) => s.status);
  const session = useIdentityStore((s) => s.session);

  const [comments, setComments] = useState<CommentWithSyncState[] | null>(null);
  const [viewerUri, setViewerUri] = useState<string | null>(null);
  // Feed paging is over the LOCAL cache (trail sync pulls the whole set), so
  // "show earlier" just widens the query window — no network round trip.
  const [visibleCount, setVisibleCount] = useState(COMMENT_PAGE_SIZE);
  const [totalComments, setTotalComments] = useState(0);
  const [reloadToken, setReloadToken] = useState(0);
  const [reportTarget, setReportTarget] = useState<CommentWithSyncState | null>(null);
  // Ephemeral per-session "Reported" acknowledgement; the report itself is
  // durable in the outbox and idempotent server-side, so nothing is persisted.
  const [reportedIds, setReportedIds] = useState<string[]>([]);
  // The clock the feed's relative dates ("3 h ago") are measured against,
  // stamped when the rows are read. Reading `Date.now()` during render would
  // make a row's output depend on when React happened to re-render it; one
  // clock per read also keeps every row in the feed on the same reference.
  const [feedNowMs, setFeedNowMs] = useState(0);
  // The last cache read failed (SQLite unavailable): say so and offer a retry
  // instead of a spinner that never stops.
  const [feedError, setFeedError] = useState(false);

  // The cache read is separated from the state write so the effects below can
  // do the write in a promise callback — setState in an effect *body* cascades
  // renders — and so one re-read lands as a single render rather than several.
  const readFeed = useCallback(async () => {
    // No comments channel: nothing to read, and the render branches to a note
    // before it looks at any of the feed state, which is still at its initial value.
    if (!commentWaypointId) return null;
    const db = await getDatabase();
    return {
      rows: await commentsRepo.listByWaypoint(db, trailId, commentWaypointId, {
        limit: visibleCount,
      }),
      total: await commentsRepo.countByWaypoint(db, trailId, commentWaypointId),
      nowMs: Date.now(),
    };
  }, [trailId, commentWaypointId, visibleCount]);

  /**
   * Re-read the cached feed and show it. Returns once the rows are on screen,
   * or once a failed read has been recorded in `feedError` — it never rejects.
   */
  const load = useCallback(
    () =>
      readFeed().then(
        (feed) => {
          setFeedError(false);
          if (!feed) return;
          setComments(feed.rows);
          setTotalComments(feed.total);
          setFeedNowMs(feed.nowMs);
        },
        () => setFeedError(true),
      ),
    [readFeed],
  );

  useEffect(() => {
    void useIdentityStore.getState().hydrate();
  }, []);

  // Read the cache on mount, whenever the paging window widens, and whenever a
  // background pull lands (`reloadToken`).
  useEffect(() => {
    void load();
  }, [load, reloadToken]);

  // The background pull is keyed on the trail alone, so widening the paging
  // window re-queries SQLite without re-hitting the network.
  useEffect(() => {
    if (!serverKnown) return;
    let active = true;
    void (async () => {
      try {
        const res = await pullTrail(trailId);
        if (active && res.outcome === 'pulled') setReloadToken((t) => t + 1);
      } catch {
        // Offline-first: the cached feed stands; the next pull tries again.
      }
    })();
    return () => {
      active = false;
    };
  }, [serverKnown, trailId]);

  // A background drain/pull that changes rows (e.g. flips this comment
  // local→server) emits here; re-read so the mounted feed reflects it without
  // waiting for a refocus. Feeds are small, so re-query on any event for this
  // trail (or an unscoped one).
  useEffect(() => {
    return onSyncChange((change) => {
      if (change.trailId == null || change.trailId === trailId) void load();
    });
  }, [load, trailId]);

  const remaining = Math.max(totalComments - (comments?.length ?? 0), 0);

  return (
    <>
      <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>Comments</Text>

      {!serverKnown ? (
        <EmptyNote text="Comments aren’t available for imported trails." />
      ) : !isApiConfigured() ? (
        <EmptyNote text="Comments are unavailable — no server is configured for this build." />
      ) : !commentWaypointId ? (
        <EmptyNote text={unavailableText} />
      ) : comments === null && feedError ? (
        <Pressable
          onPress={() => void load()}
          accessibilityRole="button"
          accessibilityLabel="Couldn’t load comments. Try again"
        >
          <EmptyNote text="Couldn’t load comments. Tap to try again." />
        </Pressable>
      ) : comments === null ? (
        <ActivityIndicator style={styles.loader} color={colors.accent} />
      ) : comments.length === 0 ? (
        <EmptyNote text="No comments yet. Be the first to leave a note." />
      ) : (
        comments.map((c) => {
          const isMine = !!session && c.authorId === session.userId;
          return (
            <CommentItem
              key={c.id}
              comment={c}
              nowMs={feedNowMs}
              isMine={isMine}
              // Only a synced comment by someone else can be reported — a
              // local row isn't on the server to moderate yet.
              canReport={!isMine && c.source === 'server'}
              reported={reportedIds.includes(c.id)}
              onReport={() => setReportTarget(c)}
              onOpenPhoto={setViewerUri}
              onDelete={() =>
                confirmDeleteComment(async () => {
                  await deleteOwnComment({ id: c.id, source: c.source });
                  await load();
                })
              }
              onRetry={() => {
                void retryComment(async () => {
                  await retryOutbox();
                  await load();
                });
              }}
            />
          );
        })
      )}

      {remaining > 0 && (
        <Pressable
          onPress={() => setVisibleCount((count) => count + COMMENT_PAGE_SIZE)}
          accessibilityRole="button"
          accessibilityLabel={`Show earlier comments, ${remaining} remaining`}
          hitSlop={spacing.xs}
          style={styles.showEarlier}
        >
          <Text style={[styles.actionLink, { color: colors.accent }]}>
            {`Show earlier comments (${remaining} remaining)`}
          </Text>
        </Pressable>
      )}

      {isApiConfigured() && commentWaypointId && (
        <Composer
          waypointType={waypointType}
          registered={identityStatus === 'registered'}
          onSubmit={async ({ text, waterStatus, photo, displayName }) => {
            let activeSession = session;
            if (!activeSession) {
              if (!displayName) return; // guarded by the composer prompt
              activeSession = await useIdentityStore.getState().register(displayName);
            }
            await submitComment(
              { trailId, waypointId: commentWaypointId, text, waterStatus, photo, session: activeSession },
            );
            // Keep the whole window visible: the new row is the newest, so
            // widen by one rather than pushing the oldest out of the page.
            setVisibleCount((count) => count + 1);
            await load();
          }}
        />
      )}

      {reportTarget && commentWaypointId && (
        <ReportDialog
          commentId={reportTarget.id}
          registered={identityStatus === 'registered'}
          onCancel={() => setReportTarget(null)}
          onSubmit={async ({ reason, detail, displayName }) => {
            let activeSession = session;
            if (!activeSession) {
              // Reports are authenticated, so a first-time reporter registers
              // here exactly as a first-time poster does in the composer.
              if (!displayName) return; // guarded by the dialog's name step
              activeSession = await useIdentityStore.getState().register(displayName);
            }
            await submitReport({
              commentId: reportTarget.id,
              trailId,
              waypointId: commentWaypointId,
              reason,
              detail,
              session: activeSession,
            });
            setReportedIds((ids) => [...ids, reportTarget.id]);
            setReportTarget(null);
          }}
        />
      )}

      <PhotoViewer uri={viewerUri} onClose={() => setViewerUri(null)} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Full-screen photo viewer
// ---------------------------------------------------------------------------

function PhotoViewer({ uri, onClose }: { uri: string | null; onClose: () => void }) {
  const { colors } = useTheme();
  return (
    <Modal
      visible={uri !== null}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable
        style={[styles.viewerBackdrop, { backgroundColor: colors.scrim }]}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close photo"
      >
        {uri ? (
          <Image
            source={{ uri }}
            style={styles.viewerImage}
            contentFit="contain"
            cachePolicy="disk"
            accessibilityIgnoresInvertColors
          />
        ) : null}
      </Pressable>
    </Modal>
  );
}

function EmptyNote({ text }: { text: string }) {
  const { colors } = useTheme();
  return <Text style={[styles.emptyNote, { color: colors.textSecondary }]}>{text}</Text>;
}

// ---------------------------------------------------------------------------
// Comment row
// ---------------------------------------------------------------------------

function WaterBadge({ status }: { status: WaterStatus }) {
  const { colors } = useTheme();
  const meta = waterStatusMeta(status);
  const color = colors[meta.colorToken];
  return (
    <View style={[styles.waterBadge, { borderColor: color }]}>
      <Text style={[styles.waterBadgeText, { color }]}>{meta.label}</Text>
    </View>
  );
}

function PhotoThumbnails({
  urls,
  onOpen,
}: {
  urls: string[];
  onOpen: (uri: string) => void;
}) {
  const { colors } = useTheme();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.thumbRow}
    >
      {urls.map((uri, i) => (
        <Pressable
          key={`${uri}-${i}`}
          onPress={() => onOpen(uri)}
          accessibilityRole="imagebutton"
          accessibilityLabel={`Open photo ${i + 1}`}
          style={({ pressed }) => pressed && styles.pressed}
        >
          <Image
            source={{ uri }}
            style={[styles.thumb, { backgroundColor: colors.surface }]}
            contentFit="cover"
            cachePolicy="disk"
            transition={120}
            accessibilityIgnoresInvertColors
          />
        </Pressable>
      ))}
    </ScrollView>
  );
}

function CommentItem({
  comment,
  nowMs,
  isMine,
  canReport,
  reported,
  onReport,
  onOpenPhoto,
  onDelete,
  onRetry,
}: {
  comment: CommentWithSyncState;
  /** Reference clock for the relative date — stamped when the feed was read. */
  nowMs: number;
  isMine: boolean;
  canReport: boolean;
  reported: boolean;
  onReport: () => void;
  onOpenPhoto: (uri: string) => void;
  /** Asks for confirmation itself; errors are surfaced, never thrown. */
  onDelete: () => void;
  onRetry: () => void;
}) {
  const { colors } = useTheme();
  const pending = comment.outboxStatus === 'pending' || comment.outboxStatus === 'sending';
  const failed = comment.outboxStatus === 'failed';
  const photoFailed = comment.photoUploadStatus === 'failed';
  const photoPending =
    comment.photoUploadStatus === 'pending' || comment.photoUploadStatus === 'sending';

  return (
    <View style={[styles.comment, { borderColor: colors.border }]}>
      <View style={styles.commentHead}>
        <Text style={[styles.author, { color: colors.textPrimary }]} numberOfLines={1}>
          {comment.authorName ?? 'Anonymous'}
        </Text>
        <Text style={[styles.date, { color: colors.textSecondary }]}>
          {relativeDate(comment.createdAt, nowMs)}
        </Text>
      </View>

      {comment.waterStatus && (
        <View style={styles.badgeRow}>
          <WaterBadge status={comment.waterStatus} />
        </View>
      )}

      {comment.body ? (
        <Text style={[styles.body, { color: colors.textPrimary }]}>{comment.body}</Text>
      ) : null}

      {comment.photoUrls.length > 0 && (
        <PhotoThumbnails urls={comment.photoUrls} onOpen={onOpenPhoto} />
      )}

      {(photoPending || photoFailed) && (
        <Text
          style={[styles.statusText, { color: photoFailed ? colors.danger : colors.textSecondary }]}
        >
          {photoFailed ? 'Photo failed to upload' : 'Uploading photo…'}
        </Text>
      )}

      {(pending || failed) && (
        <View style={styles.statusRow}>
          <Text
            style={[styles.statusText, { color: failed ? colors.danger : colors.textSecondary }]}
          >
            {failed ? 'Failed to send' : 'Waiting to send…'}
          </Text>
          {failed && (
            <Pressable onPress={onRetry} accessibilityRole="button" hitSlop={spacing.xs}>
              <Text style={[styles.actionLink, { color: colors.accent }]}>Retry</Text>
            </Pressable>
          )}
        </View>
      )}

      {(isMine || canReport) && (
        <View style={styles.rowActions}>
          {isMine && (
            <Pressable
              onPress={onDelete}
              accessibilityRole="button"
              accessibilityLabel="Delete comment"
              hitSlop={spacing.xs}
            >
              <Text style={[styles.actionLink, { color: colors.danger }]}>Delete</Text>
            </Pressable>
          )}
          {canReport &&
            (reported ? (
              <Text style={[styles.statusText, { color: colors.textSecondary }]}>Reported</Text>
            ) : (
              <Pressable
                onPress={onReport}
                accessibilityRole="button"
                accessibilityLabel="Report comment"
                hitSlop={spacing.xs}
              >
                <Text style={[styles.actionLink, { color: colors.textSecondary }]}>Report</Text>
              </Pressable>
            ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  sectionTitle: { ...typography.titleLarge },
  emptyNote: { ...typography.bodySmall, paddingVertical: spacing.md },
  loader: { paddingVertical: spacing.lg },
  pressed: { opacity: 0.6 },

  comment: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  commentHead: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm },
  author: { ...typography.titleSmall, flexShrink: 1 },
  date: { ...typography.caption },
  badgeRow: { flexDirection: 'row' },
  body: { ...typography.body },
  waterBadge: {
    alignSelf: 'flex-start',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  waterBadgeText: { ...typography.caption, fontWeight: '600' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  statusText: { ...typography.caption },
  actionLink: { ...typography.titleSmall },
  rowActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    alignSelf: 'flex-start',
    paddingTop: spacing.xs,
  },
  showEarlier: { alignSelf: 'flex-start', paddingVertical: spacing.sm },

  thumbRow: { flexDirection: 'row', gap: spacing.sm, paddingVertical: spacing.xs },
  thumb: { width: 76, height: 76, borderRadius: radii.md },

  viewerBackdrop: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  viewerImage: { width: '100%', height: '100%' },
});
