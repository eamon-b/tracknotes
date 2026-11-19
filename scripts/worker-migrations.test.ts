/**
 * The comments API's migration numbers: why they are checked, and where else
 * the check runs (the production deploy), is in `check-worker-migrations.ts`.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import { MIGRATIONS_DIR, migrationProblems } from './check-worker-migrations.ts';

describe('comments API migrations', () => {
  it('are named NNNN_snake_case.sql, each with a number of its own, without a gap', () => {
    // Renumber the migration that has not been applied to production yet
    expect(migrationProblems(fs.readdirSync(MIGRATIONS_DIR))).toEqual([]);
  });
});

describe('migrationProblems', () => {
  const applied = ['0001_init.sql', '0002_b.sql', '0010_content_review.sql', '0010_observed_at_day.sql'];

  it('accepts the numbers shared before the check existed', () => {
    const names = [
      '0001_a.sql',
      '0002_b.sql',
      '0003_c.sql',
      '0004_d.sql',
      '0005_e.sql',
      '0006_f.sql',
      '0007_g.sql',
      '0008_h.sql',
      '0009_i.sql',
      ...applied.slice(2),
      '0011_j.sql',
    ];
    expect(migrationProblems(names)).toEqual([]);
  });

  it('refuses two migrations that each took the next number', () => {
    expect(migrationProblems(['0001_init.sql', '0002_a.sql', '0002_b.sql'])).toEqual([
      '0002_a.sql, 0002_b.sql share the number 0002: renumber the one not yet applied to production',
    ]);
  });

  it('refuses a third file on a shared number', () => {
    expect(migrationProblems(applied).some(p => p.includes('share the number 0010'))).toBe(false);
    expect(migrationProblems([...applied, '0010_late.sql']).some(p => p.includes('share the number 0010'))).toBe(true);
  });

  it('names the first gap only', () => {
    expect(migrationProblems(['0001_a.sql', '0003_c.sql', '0004_d.sql'])).toEqual([
      'migration 0002 is missing (numbers run without a gap)',
    ]);
  });

  it('refuses a misnamed file, and an empty directory', () => {
    expect(migrationProblems(['0001_a.sql', '0002-B.sql'])).toEqual(['0002-B.sql is not named NNNN_snake_case.sql']);
    expect(migrationProblems([])).toEqual(['no migrations found']);
  });
});
