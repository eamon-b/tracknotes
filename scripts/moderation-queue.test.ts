import { describe, expect, it } from 'vitest';
import type { ModeratedRow } from '../src/lib/moderation-attention';
import { queueMarkdown, summarizeQueue } from './moderation-queue';

const row = (over: Partial<ModeratedRow> = {}): ModeratedRow => ({
  deletedBy: null,
  restoredAt: null,
  reportCount: 1,
  review: null,
  ...over,
});
const review = (verdict: 'remove' | 'needs_human' | 'keep') => ({ verdict }) as ModeratedRow['review'];

describe('summarizeQueue', () => {
  it('counts the rows the moderation page highlights, and the hidden ones among them', () => {
    const summary = summarizeQueue(
      [
        row({ deletedBy: 'reports' }),
        row({ review: review('needs_human') }),
        row({ review: review('keep') }),
        row({ review: review('remove'), restoredAt: '2026-11-01T00:00:00Z' }),
        row({ deletedBy: 'admin' }),
      ],
      [row({ deletedBy: 'reports' }), row()]
    );
    expect(summary).toEqual({ comments: { waiting: 2, hidden: 1 }, waypoints: { waiting: 1, hidden: 1 }, total: 3 });
  });
});

describe('queueMarkdown', () => {
  it('gives counts and the page, never post content', () => {
    const text = queueMarkdown({ comments: { waiting: 2, hidden: 1 }, waypoints: { waiting: 0, hidden: 0 }, total: 2 });
    expect(text).toContain('2 reported or flagged post(s)');
    expect(text).toContain('Comments: 2 waiting (1 hidden by reports');
    expect(text).toContain('admin-moderation.html');
  });

  it('says so when nothing waits', () => {
    expect(
      queueMarkdown({ comments: { waiting: 0, hidden: 0 }, waypoints: { waiting: 0, hidden: 0 }, total: 0 })
    ).toMatch(/^Nothing is waiting/);
  });
});
