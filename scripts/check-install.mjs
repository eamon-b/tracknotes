#!/usr/bin/env node
/**
 * Is every package installed at the version its lockfile pins?
 *
 * A checkout that pulls a dependency change without reinstalling still runs,
 * and fails in ways that read as code bugs: `prettier: command not found`,
 * "Cannot find module 'fflate'", a type that does not exist in the older SDK.
 * CI installs from the lockfile every run and never sees it. `npm run check`
 * runs this first, so a stale install is named before any suite runs.
 *
 * Compares each package-lock.json with node_modules/.package-lock.json, the
 * record npm keeps of what it installed. Node built-ins only: it has to run
 * when the install it is checking is broken.
 *
 *   node scripts/check-install.mjs            # all four packages
 *   node scripts/check-install.mjs mobile     # only the ones named
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Every directory with its own lockfile, relative to the repo root. */
export const PACKAGE_DIRS = ['.', 'mobile', 'workers/comments-api', 'contours/worker'];

/**
 * The packages `lock` pins that `installed` lacks or holds at another version.
 * Both are the `packages` map of a lockfile, keyed by `node_modules/...` path.
 *
 * Optional packages are skipped: they are the per-platform binaries (esbuild,
 * workerd, sharp), of which npm installs only the one for this machine.
 *
 * @param {Record<string, { version?: string, resolved?: string, optional?: boolean, link?: boolean }>} lock
 * @param {Record<string, { version?: string, resolved?: string }>} installed
 * @returns {string[]} one line per package, empty when the install matches
 */
export function installDrift(lock, installed) {
  const drift = [];
  for (const [key, want] of Object.entries(lock)) {
    if (key === '' || want.optional || want.link) continue;
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const have = installed[key];
    if (!have) {
      drift.push(`${name}: not installed (lockfile has ${want.version})`);
    } else if (have.version !== want.version) {
      drift.push(`${name}: ${have.version} installed, lockfile has ${want.version}`);
    } else if (isGitUrl(want.resolved) && isGitUrl(have.resolved) && have.resolved !== want.resolved) {
      // A git dependency (te-araroa-data, gpx-tools) keeps its version across commits
      drift.push(`${name}: installed from ${commitOf(have.resolved)}, lockfile has ${commitOf(want.resolved)}`);
    }
  }
  return drift;
}

function isGitUrl(resolved) {
  return typeof resolved === 'string' && resolved.startsWith('git+');
}

function commitOf(resolved) {
  return resolved.slice(resolved.lastIndexOf('#') + 1, resolved.lastIndexOf('#') + 8);
}

/**
 * @param {string} root the repo root
 * @param {string} dir one of PACKAGE_DIRS
 * @returns {string[]} what is wrong with the install in `dir`, empty when nothing is
 */
export function checkPackageDir(root, dir) {
  const lockPath = join(root, dir, 'package-lock.json');
  const installedPath = join(root, dir, 'node_modules', '.package-lock.json');
  if (!existsSync(lockPath)) return [`no package-lock.json in ${dir}`];
  if (!existsSync(installedPath)) return ['nothing installed'];
  const lock = JSON.parse(readFileSync(lockPath, 'utf-8')).packages ?? {};
  const installed = JSON.parse(readFileSync(installedPath, 'utf-8')).packages ?? {};
  return installDrift(lock, installed);
}

const SHOWN = 5;

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const dirs = process.argv.length > 2 ? process.argv.slice(2) : PACKAGE_DIRS;
  let stale = 0;
  for (const dir of dirs) {
    const problems = checkPackageDir(root, dir);
    if (problems.length === 0) continue;
    stale++;
    const label = dir === '.' ? 'the repo root' : dir;
    console.error(`\nThe install in ${label} does not match its package-lock.json:`);
    for (const problem of problems.slice(0, SHOWN)) console.error(`  ${problem}`);
    if (problems.length > SHOWN) console.error(`  … and ${problems.length - SHOWN} more`);
    console.error(`Run: ${dir === '.' ? 'npm ci' : `npm ci --prefix ${dir}`}`);
  }
  if (stale > 0) {
    console.error('\nA suite run against a stale install fails for reasons that are not in the code.');
    process.exit(1);
  }
  console.log(`Installed packages match the lockfile in ${dirs.length} package${dirs.length === 1 ? '' : 's'}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
