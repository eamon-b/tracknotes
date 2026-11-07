/**
 * The monthly dependency check (`npm run audit:deps`, run by the Dependency
 * audit workflow): `npm audit` over every package in the repo, as one report.
 *
 * It fails only on a high or critical advisory that `npm audit fix` can fix
 * without a breaking change (`fixAvailable: true`): that is a lockfile update
 * someone should make now. A high advisory whose only "fix" is a semver-major
 * change is listed but does not fail the run. Under `mobile/` that "fix" is
 * usually npm proposing an older Expo SDK (an advisory in `@expo/cli`), which
 * only the next SDK upgrade can resolve. Moderates and lows are counted.
 *
 * Usage: npx tsx scripts/dependency-audit.ts [--markdown]
 * Reads each package-lock.json only (`--package-lock-only`), so no install is needed.
 */

import { spawnSync } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every package with its own lockfile. */
export const AUDITED_PACKAGES = ['.', 'mobile', 'workers/comments-api', 'contours/worker'];

const SEVERE = new Set(['high', 'critical']);

interface AuditVulnerability {
  name: string;
  severity: string;
  isDirect: boolean;
  via: (string | { title?: string; url?: string })[];
  fixAvailable: boolean | { name: string; version: string; isSemVerMajor: boolean };
}

export interface AuditJson {
  vulnerabilities?: Record<string, AuditVulnerability>;
  metadata?: { vulnerabilities?: Record<string, number> };
}

export interface AuditFinding {
  name: string;
  severity: string;
  /** `npm audit fix` fixes it without a breaking change. */
  fixable: boolean;
  /** What npm proposes otherwise (`expo@52.0.49`), or null when nothing. */
  breakingFix: string | null;
  /** Advisory titles, or the packages it comes through. */
  via: string[];
}

/** The high and critical advisories in one `npm audit --json` result. */
export function severeFindings(audit: AuditJson): AuditFinding[] {
  return Object.values(audit.vulnerabilities ?? {})
    .filter(v => SEVERE.has(v.severity))
    .map(v => ({
      name: v.name,
      severity: v.severity,
      fixable: v.fixAvailable === true,
      breakingFix:
        typeof v.fixAvailable === 'object' && v.fixAvailable
          ? `${v.fixAvailable.name}@${v.fixAvailable.version}`
          : null,
      via: v.via.map(entry => (typeof entry === 'string' ? entry : (entry.title ?? entry.url ?? '?'))),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function audit(dir: string): AuditJson {
  const result = spawnSync('npm', ['audit', '--package-lock-only', '--json'], {
    cwd: path.join(ROOT, dir),
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  // npm audit exits 1 when it finds anything; the JSON is the answer either way
  try {
    return JSON.parse(result.stdout) as AuditJson;
  } catch {
    throw new Error(`npm audit in ${dir} gave no JSON: ${result.stderr.trim() || result.error?.message}`);
  }
}

function main(): void {
  let failed = false;
  const lines: string[] = ['## Dependency audit', ''];
  for (const dir of AUDITED_PACKAGES) {
    const result = audit(dir);
    const counts = result.metadata?.vulnerabilities ?? {};
    const summary = ['critical', 'high', 'moderate', 'low'].map(s => `${counts[s] ?? 0} ${s}`).join(', ');
    lines.push(`### \`${dir === '.' ? 'root' : dir}\`: ${summary}`);
    for (const f of severeFindings(result)) {
      const fix = f.fixable
        ? '**fixable now** (`npm audit fix`)'
        : f.breakingFix
          ? `no non-breaking fix (npm proposes ${f.breakingFix})`
          : 'no fix yet';
      lines.push(`- ${f.severity} \`${f.name}\`: ${fix}; via ${f.via.join(', ')}`);
      if (f.fixable) failed = true;
    }
    lines.push('');
  }
  lines.push(
    failed
      ? 'A high or critical advisory has a non-breaking fix: run `npm audit fix` in that package (under `mobile/`, `npx expo install --fix` for Expo packages) and open a PR.'
      : 'No high or critical advisory has a non-breaking fix.'
  );
  console.log(lines.join('\n'));
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
