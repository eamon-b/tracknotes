/**
 * The export carries every field the server sent and nothing that names the
 * hiker.
 */

import type { MyComment } from '@lib/comments-api-types';
import { COMMENT_EXPORT_FORMAT, composeCommentExport, exportSummary } from '../comment-export';

const COMMENT: MyComment = {
  id: 'c1',
  trailId: 'heysen',
  waypointId: 'w_00000001',
  text: 'Tank full',
  waterStatus: 'flowing',
  observedAt: '2026-10-01T06:00:00Z',
  createdAt: '2026-10-01T07:00:00Z',
  updatedAt: '2026-10-01T07:00:00Z',
  photoUrls: ['https://photos.test/a.jpg'],
  deletedAt: null,
  deletedBy: null,
};

describe('composeCommentExport', () => {
  it('wraps the comments, unchanged, with the format and export time', () => {
    const { title, message } = composeCommentExport([COMMENT], '2026-10-31T00:00:00Z');
    expect(title).toBe('My Tracknotes comments');
    expect(JSON.parse(message)).toEqual({
      format: COMMENT_EXPORT_FORMAT,
      exportedAt: '2026-10-31T00:00:00Z',
      comments: [COMMENT],
    });
    expect(message).not.toContain('displayName');
  });
});

describe('exportSummary', () => {
  it('counts what was exported', () => {
    expect(exportSummary(0)).toBe('You haven’t posted any comments.');
    expect(exportSummary(1)).toBe('Exported 1 comment.');
    expect(exportSummary(12)).toBe('Exported 12 comments.');
  });
});
