/**
 * The comments API's D1 migrations are numbered by hand, so two branches that
 * each add "the next one" both pass alone and collide on main. That happened
 * with 0010: wrangler applies by file name, so both ran, but a test that found
 * its migration by number picked the other file and main went red.
 *
 * Two places run this check:
 * - `scripts/worker-migrations.test.ts` (the root suite), which fails in the
 *   pull request that is rebased onto the other one, where the number can still
 *   be changed;
 * - *Deploy comments API*, before it applies any migration, so a collision that
 *   reached `main` anyway (a pull request whose CI ran before the other merged)
 *   stops the deploy rather than reaching production. Once a migration has been
 *   applied there it can never be renamed (wrangler would run it again as new).
 *
 * Usage: node scripts/check-worker-migrations.ts [migrations dir]
 * Runs on Node's own type stripping (Node 22.18+), with no `npm ci`: it imports
 * only Node built-ins.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../workers/comments-api/migrations'
);

/** Applied to production under these names before the check existed. */
export const SHARED_NUMBERS: Readonly<Record<string, readonly string[]>> = {
  '0010': ['0010_content_review.sql', '0010_observed_at_day.sql'],
};

/** What is wrong with these migration file names (empty when nothing is). */
export function migrationProblems(names: readonly string[]): string[] {
  const files = [...names].sort();
  const problems: string[] = [];
  if (files.length === 0) problems.push('no migrations found');

  const misnamed = files.filter(file => !/^\d{4}_[a-z0-9_]+\.sql$/.test(file));
  for (const file of misnamed) problems.push(`${file} is not named NNNN_snake_case.sql`);

  const byNumber = new Map<string, string[]>();
  for (const file of files) {
    if (misnamed.includes(file)) continue;
    const number = file.slice(0, 4);
    byNumber.set(number, [...(byNumber.get(number) ?? []), file]);
  }
  for (const [number, group] of byNumber) {
    if (group.length > 1 && SHARED_NUMBERS[number]?.join() !== group.join()) {
      problems.push(`${group.join(', ')} share the number ${number}: renumber the one not yet applied to production`);
    }
  }

  // Only the first gap: every number after it is off by the same amount
  const numbers = [...byNumber.keys()].map(Number);
  const gap = numbers.findIndex((number, index) => number !== index + 1);
  if (gap >= 0) problems.push(`migration ${String(gap + 1).padStart(4, '0')} is missing (numbers run without a gap)`);
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(process.argv[2] ?? MIGRATIONS_DIR);
  const problems = migrationProblems(fs.readdirSync(dir).filter(file => !file.startsWith('.')));
  for (const problem of problems) console.log(`::error::${problem}`);
  if (problems.length > 0) process.exit(1);
  console.log(`${dir}: migration numbers are unique and without a gap.`);
}
