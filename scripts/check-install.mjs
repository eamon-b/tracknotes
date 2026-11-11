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
 * record npm keeps of what it installed, and with the package.json in each
 * package's folder, since that record survives a folder deleted by hand or a
 * half-finished install. Node built-ins only: it has to run when the install
 * it is checking is broken.
 *
 *   node scripts/check-install.mjs            # all four packages
 *   node scripts/check-install.mjs mobile     # only the ones named
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Every directory with its own lockfile, relative to the repo root. */
export const PACKAGE_DIRS = ['.', 'mobile', 'workers/comments-api', 'contours/worker'];

/**
 * This machine, in the terms a lockfile's `os`, `cpu` and `libc` fields use.
 *
 * @returns {{ os: string, cpu: string, libc?: string }}
 */
export function currentPlatform() {
  /** @type {{ os: string, cpu: string, libc?: string }} */
  const platform = { os: process.platform, cpu: process.arch };
  if (process.platform === 'linux') {
    // npm tells glibc from musl the same way
    const header = /** @type {any} */ (process.report?.getReport())?.header;
    platform.libc = header?.glibcVersionRuntime ? 'glibc' : 'musl';
  }
  return platform;
}

/**
 * Does `value` satisfy a lockfile constraint list such as `["linux"]` or `["!win32"]`?
 * An absent list allows everything, as it does for npm.
 *
 * @param {string[] | undefined} list
 * @param {string | undefined} value
 */
function allows(list, value) {
  if (!list || list.length === 0) return true;
  if (value === undefined) return false;
  if (list.includes(`!${value}`)) return false;
  const positives = list.filter(entry => !entry.startsWith('!'));
  return positives.length === 0 || positives.includes(value);
}

/**
 * Should this machine have the package at `want` installed?
 *
 * A required package always. An optional one only when it names the platforms
 * it is for (`os`, `cpu`, `libc`) and this machine is one of them: that is this
 * machine's own esbuild, rollup, workerd or sharp binary, and npm installs it
 * every time. An optional package that names no platform is a dependency of
 * some platform's binary, or one whose install is allowed to fail, so it is
 * left out either way.
 *
 * @param {{ optional?: boolean, link?: boolean, os?: string[], cpu?: string[], libc?: string[] }} want
 * @param {{ os: string, cpu: string, libc?: string }} platform
 */
export function isExpected(want, platform) {
  if (want.link) return false;
  if (!want.optional) return true;
  if (!want.os && !want.cpu && !want.libc) return false;
  return allows(want.os, platform.os) && allows(want.cpu, platform.cpu) && allows(want.libc, platform.libc);
}

/**
 * The packages `lock` pins that `installed` lacks or holds at another version.
 * Both are the `packages` map of a lockfile, keyed by `node_modules/...` path.
 *
 * Optional packages for another platform are skipped (`isExpected`).
 * With `folderVersion`, a package the record says is installed is also looked
 * for on disk: it returns the version in that package's own package.json, or
 * undefined when the folder or its package.json is missing.
 *
 * @param {Record<string, { version?: string, resolved?: string, optional?: boolean, link?: boolean, os?: string[], cpu?: string[], libc?: string[] }>} lock
 * @param {Record<string, { version?: string, resolved?: string }>} installed
 * @param {{ platform?: { os: string, cpu: string, libc?: string }, folderVersion?: (key: string) => string | undefined }} [options]
 * @returns {string[]} one line per package, empty when the install matches
 */
export function installDrift(lock, installed, { platform = currentPlatform(), folderVersion } = {}) {
  const drift = [];
  for (const [key, want] of Object.entries(lock)) {
    if (key === '' || !isExpected(want, platform)) continue;
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const have = installed[key];
    if (!have) {
      drift.push(`${name}: not installed (lockfile has ${want.version})`);
    } else if (have.version !== want.version) {
      drift.push(`${name}: ${have.version} installed, lockfile has ${want.version}`);
    } else if (isGitUrl(want.resolved) && isGitUrl(have.resolved) && have.resolved !== want.resolved) {
      // A git dependency (te-araroa-data, gpx-tools) keeps its version across commits
      drift.push(`${name}: installed from ${commitOf(have.resolved)}, lockfile has ${commitOf(want.resolved)}`);
    } else if (folderVersion) {
      const onDisk = folderVersion(key);
      if (onDisk === undefined) {
        drift.push(`${name}: its folder (${key}) is missing, lockfile has ${want.version}`);
      } else if (onDisk !== want.version) {
        drift.push(`${name}: ${onDisk} in ${key}/package.json, lockfile has ${want.version}`);
      }
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
  const folderVersion = key => {
    const manifest = join(root, dir, key, 'package.json');
    if (!existsSync(manifest)) return undefined;
    try {
      return JSON.parse(readFileSync(manifest, 'utf-8')).version;
    } catch {
      return undefined;
    }
  };
  return installDrift(lock, installed, { folderVersion });
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

/**
 * Is `argv1` (process.argv[1]) this module, however it was reached?
 * Node resolves symlinks before it loads a script but leaves argv[1] as typed,
 * so a run through a symlinked checkout or node_modules/.bin compares unequal
 * by URL and would exit 0 having checked nothing.
 *
 * @param {string | undefined} argv1
 * @param {string} modulePath fileURLToPath(import.meta.url)
 */
export function isRunAsScript(argv1, modulePath) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(modulePath);
  } catch {
    return false;
  }
}

if (isRunAsScript(process.argv[1], fileURLToPath(import.meta.url))) main();
