/**
 * The comments API's D1 migrations are numbered by hand, so two branches that
 * each add "the next one" both pass alone and collide on main. That happened
 * with 0010: wrangler applies by file name, so both ran, but a test that found
 * its migration by number picked the other file and main went red.
 *
 * This fails in the pull request that is rebased onto the other one, which is
 * where the number can still be changed: once a migration has been applied to
 * production it can never be renamed (wrangler would run it again as new).
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const MIGRATIONS = path.resolve(__dirname, '../workers/comments-api/migrations');

/** Applied to production under these names before the check existed. */
const SHARED_NUMBERS: Record<string, string[]> = {
  '0010': ['0010_content_review.sql', '0010_observed_at_day.sql'],
};

describe('comments API migrations', () => {
  const files = fs.readdirSync(MIGRATIONS).sort();

  it('are all named NNNN_snake_case.sql', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter(file => !/^\d{4}_[a-z0-9_]+\.sql$/.test(file))).toEqual([]);
  });

  it('each have a number of their own', () => {
    const byNumber = new Map<string, string[]>();
    for (const file of files) {
      const number = file.slice(0, 4);
      byNumber.set(number, [...(byNumber.get(number) ?? []), file]);
    }
    const collisions = [...byNumber]
      .filter(([number, names]) => names.length > 1 && SHARED_NUMBERS[number]?.join() !== names.join())
      .map(([, names]) => names);
    // Renumber the migration that has not been applied to production yet
    expect(collisions).toEqual([]);
  });

  it('are numbered without a gap, so the next number is the last plus one', () => {
    const numbers = [...new Set(files.map(file => Number(file.slice(0, 4))))];
    expect(numbers).toEqual(numbers.map((_, index) => index + 1));
  });
});
