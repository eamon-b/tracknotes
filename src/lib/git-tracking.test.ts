import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readdirSync } from 'fs';
import { join } from 'path';

/**
 * Regression test: ensures all TypeScript source files in src/ are tracked by git.
 *
 * A global gitignore rule (`lib/`) previously caused new files added to src/lib/
 * to be silently ignored, leading to Vercel build failures (TS2307: Cannot find module).
 * Local builds passed because the files existed on disk even though they weren't committed.
 */
describe('git tracking', () => {
  it('should not have any gitignored .ts files in src/lib/', () => {
    const libDir = join(__dirname);
    const tsFiles = readdirSync(libDir).filter(f => f.endsWith('.ts'));

    // One `git check-ignore` for every file rather than a process per file: a
    // hundred-odd spawns took seconds on a loaded machine (#251). It prints the
    // paths that ARE ignored (NUL-separated with -z) and exits 1 when none are.
    let output = '';
    try {
      output = execFileSync('git', ['check-ignore', '--stdin', '-z'], {
        cwd: libDir,
        input: tsFiles.join('\0'),
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch {
      // exit code 1 = nothing ignored, which is what we want
    }
    const ignored = output.split('\0').filter(Boolean);

    expect(
      ignored,
      `These src/lib/ files are gitignored and will be missing from Vercel builds: ${ignored.join(', ')}`
    ).toEqual([]);
  });
});
