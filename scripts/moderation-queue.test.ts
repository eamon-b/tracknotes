import { describe, expect, it } from 'vitest';
import { parseCounts, queueMarkdown } from './moderation-queue';

const body = {
  comments: { waiting: 2, hidden: 1 },
  waypoints: { waiting: 1, hidden: 0 },
  total: 3,
};

describe('parseCounts', () => {
  it('takes the counts route answer as it is', () => {
    expect(parseCounts(body)).toEqual(body);
  });

  it('refuses a body that is not counts, without quoting it', () => {
    for (const bad of [
      null,
      'secret text',
      { ...body, total: 4 },
      { ...body, comments: { waiting: -1, hidden: 0 } },
      { ...body, waypoints: { waiting: 1, hidden: 2 } },
      { ...body, comments: { waiting: '2', hidden: 1 } },
      { comments: body.comments, total: 2 },
    ]) {
      expect(() => parseCounts(bad)).toThrow(/^GET \/v1\/admin\/moderation\/counts answered an unexpected body$/);
    }
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
