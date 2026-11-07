/**
 * Which moderated rows (reported or reviewed comments and shared waypoints)
 * still need an admin. The moderation page (`src/web/admin-moderation.ts`)
 * highlights them, and the daily moderation check
 * (`scripts/moderation-queue.ts`) counts them, so both agree on what the
 * queue is.
 */

import type { ContentReview, DeletedBy } from './comments-api-types';

export interface ModeratedRow {
  deletedBy: DeletedBy | null;
  restoredAt: string | null;
  reportCount: number;
  review: ContentReview | null;
}

/**
 * Hidden provisionally, or live with a review that wants a human (or would
 * remove it, below the hide threshold): the row needs an admin. A restore or
 * Keep (`restoredAt`) settles the review.
 */
export function needsAttention(row: ModeratedRow): boolean {
  return (
    row.deletedBy === 'reports' ||
    (row.deletedBy === null &&
      row.restoredAt === null &&
      row.review?.verdict !== undefined &&
      row.review.verdict !== 'keep')
  );
}
