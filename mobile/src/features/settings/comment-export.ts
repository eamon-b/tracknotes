/**
 * The pure half of Settings' "Your comments" export: what the share sheet is
 * handed. Kept apart from the component so the shape can be tested without a
 * renderer or a clock.
 *
 * JSON rather than prose: the export is the hiker's copy of everything the
 * server holds for their comments (deleted and hidden ones included, with who
 * took them down), and a copy that loses fields is not a copy. No display
 * name: it is the hiker's own export, and names are left out of every export.
 */

import type { MyComment } from '@lib/comments-api-types';

/** Version of the file's own shape, bumped if a field is renamed or dropped. */
export const COMMENT_EXPORT_FORMAT = 1;

export interface CommentExport {
  title: string;
  message: string;
}

/** The share sheet's title and the JSON body, for comments fetched at `exportedAt`. */
export function composeCommentExport(comments: MyComment[], exportedAt: string): CommentExport {
  const file = {
    format: COMMENT_EXPORT_FORMAT,
    exportedAt,
    comments,
  };
  return {
    title: 'My Tracknotes comments',
    message: JSON.stringify(file, null, 2),
  };
}

/** One line under the button once the sheet has been offered. */
export function exportSummary(count: number): string {
  if (count === 0) return 'You haven’t posted any comments.';
  return count === 1 ? 'Exported 1 comment.' : `Exported ${count} comments.`;
}
