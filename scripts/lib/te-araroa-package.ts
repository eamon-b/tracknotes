/**
 * Where Te Araroa's GPX comes from, and whether the copy a build would read is
 * the one the lockfile pins.
 *
 * `sync-te-araroa.ts` copies `te-araroa-sobo.gpx` out of the `te-araroa-data`
 * package into `data/trails/te_araroa/`, where it is gitignored. Three ways that
 * went wrong without a word:
 *
 * - The package missing from this checkout's `node_modules`. Node's resolution
 *   walks up the directory tree, and a worktree under `.claude/worktrees/` sits
 *   inside the main checkout, so `require.resolve` found the main checkout's
 *   copy — another commit — and the sync copied it and exited 0.
 * - The package installed at another commit than `package-lock.json` pins (a
 *   pull without `npm ci`).
 * - The synced GPX outliving the package it came from: a gitignored file
 *   survives `npm ci`, so `build:trails` read last month's route.
 *
 * Each problem names the command that fixes it. Node built-ins only.
 */

import * as fs from 'fs';
import * as path from 'path';

export const TE_ARAROA_PACKAGE = 'te-araroa-data';
/** The trail directory under `data/trails/` that is built from the package. */
export const TE_ARAROA_TRAIL_DIR = 'te_araroa';
/** The one file we take. Its name is stable across upstream seasons. */
export const TE_ARAROA_ROUTE_FILE = 'te-araroa-sobo.gpx';

const LOCK_KEY = `node_modules/${TE_ARAROA_PACKAGE}`;

/** The package's directory in this checkout's own `node_modules` (never a parent's). */
export function teAraroaPackageDir(projectRoot: string): string {
  return path.join(projectRoot, 'node_modules', TE_ARAROA_PACKAGE);
}

/** The route file inside the installed package. */
export function packagedRoutePath(projectRoot: string): string {
  return path.join(teAraroaPackageDir(projectRoot), 'out', TE_ARAROA_ROUTE_FILE);
}

/** The synced copy `build:trails` reads. */
export function syncedRoutePath(projectRoot: string): string {
  return path.join(projectRoot, 'data', 'trails', TE_ARAROA_TRAIL_DIR, TE_ARAROA_ROUTE_FILE);
}

function lockedResolved(lockPath: string): string | undefined {
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as {
      packages?: Record<string, { resolved?: string }>;
    };
    return lock.packages?.[LOCK_KEY]?.resolved;
  } catch {
    return undefined;
  }
}

function shortCommit(resolved: string): string {
  const hash = resolved.lastIndexOf('#');
  return hash >= 0 ? resolved.slice(hash + 1, hash + 8) : resolved;
}

/**
 * Why the installed package cannot be synced from, or `null` when it can: it
 * must be in this checkout's `node_modules`, carry the route file, and — when
 * npm's install record names a git commit — be the commit the lockfile pins.
 */
export function packageProblem(projectRoot: string): string | null {
  const packageDir = teAraroaPackageDir(projectRoot);
  if (!fs.existsSync(path.join(packageDir, 'package.json'))) {
    return (
      `${TE_ARAROA_PACKAGE} is not installed in this checkout (${path.relative(projectRoot, packageDir)} is missing). ` +
      'Run `npm ci`.'
    );
  }
  const wanted = lockedResolved(path.join(projectRoot, 'package-lock.json'));
  const installed = lockedResolved(path.join(projectRoot, 'node_modules', '.package-lock.json'));
  // Only two git commits are compared: an `npm install ../te-araroa-data` made
  // to try an upstream change records a path, and is left alone on purpose.
  if (wanted?.startsWith('git+') && installed?.startsWith('git+') && wanted !== installed) {
    return (
      `${TE_ARAROA_PACKAGE} is installed from ${shortCommit(installed)} but package-lock.json pins ` +
      `${shortCommit(wanted)}. Run \`npm ci\`.`
    );
  }
  if (!fs.existsSync(packagedRoutePath(projectRoot))) {
    return (
      `${TE_ARAROA_PACKAGE} is installed but has no out/${TE_ARAROA_ROUTE_FILE}. ` +
      'The package commits its build outputs; reinstall it with `npm ci`.'
    );
  }
  return null;
}

/**
 * Why the synced GPX is not what a build should read, or `null` when it is a
 * byte-for-byte copy of the installed package's route.
 */
export function syncedRouteProblem(projectRoot: string): string | null {
  const fromPackage = packageProblem(projectRoot);
  if (fromPackage) return fromPackage;
  const synced = syncedRoutePath(projectRoot);
  const relative = path.relative(projectRoot, synced);
  if (!fs.existsSync(synced)) {
    return `${relative} is missing. Run \`npm run sync:te-araroa\`.`;
  }
  if (!fs.readFileSync(synced).equals(fs.readFileSync(packagedRoutePath(projectRoot)))) {
    return (
      `${relative} differs from the installed ${TE_ARAROA_PACKAGE} (a sync from another install). ` +
      'Run `npm run sync:te-araroa`.'
    );
  }
  return null;
}
