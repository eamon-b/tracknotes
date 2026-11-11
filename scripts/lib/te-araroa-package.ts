/**
 * Where Te Araroa's GPX comes from, and whether the copy a build would read is
 * the one the lockfile pins.
 *
 * `sync-te-araroa.ts` copies the route named by `data/trails/te_araroa/trail.json`
 * `gpxFile` (`te-araroa-sobo.gpx`) out of the `te-araroa-data` package's `out/`
 * into `data/trails/te_araroa/`, where it is gitignored. Three ways that
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

const LOCK_KEY = `node_modules/${TE_ARAROA_PACKAGE}`;

/** The package's directory in this checkout's own `node_modules` (never a parent's). */
export function teAraroaPackageDir(projectRoot: string): string {
  return path.join(projectRoot, 'node_modules', TE_ARAROA_PACKAGE);
}

function trailConfigPath(projectRoot: string): string {
  return path.join(projectRoot, 'data', 'trails', TE_ARAROA_TRAIL_DIR, 'trail.json');
}

/**
 * The one file we take, as the committed `trail.json` names it (`gpxFile`), or
 * `undefined` when it names none. The package's `out/` uses the same name.
 */
export function teAraroaRouteFile(projectRoot: string): string | undefined {
  try {
    const config = JSON.parse(fs.readFileSync(trailConfigPath(projectRoot), 'utf-8')) as { gpxFile?: unknown };
    return typeof config.gpxFile === 'string' && config.gpxFile ? config.gpxFile : undefined;
  } catch {
    return undefined;
  }
}

/** The route file inside the installed package. */
export function packagedRoutePath(projectRoot: string, routeFile: string): string {
  return path.join(teAraroaPackageDir(projectRoot), 'out', routeFile);
}

/** The synced copy `build:trails` reads. */
export function syncedRoutePath(projectRoot: string, routeFile: string): string {
  return path.join(projectRoot, 'data', 'trails', TE_ARAROA_TRAIL_DIR, routeFile);
}

function noRouteFile(projectRoot: string): string {
  return `${path.relative(projectRoot, trailConfigPath(projectRoot))} names no gpxFile.`;
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
export function packageProblem(projectRoot: string, routeFile = teAraroaRouteFile(projectRoot)): string | null {
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
  if (!routeFile) return noRouteFile(projectRoot);
  if (!fs.existsSync(packagedRoutePath(projectRoot, routeFile))) {
    return (
      `${TE_ARAROA_PACKAGE} is installed but has no out/${routeFile}. ` +
      'The package commits its build outputs; reinstall it with `npm ci`.'
    );
  }
  return null;
}

/**
 * Why the synced GPX is not what a build should read, or `null` when it is a
 * byte-for-byte copy of the installed package's route.
 */
export function syncedRouteProblem(projectRoot: string, routeFile = teAraroaRouteFile(projectRoot)): string | null {
  const fromPackage = packageProblem(projectRoot, routeFile);
  if (fromPackage) return fromPackage;
  if (!routeFile) return noRouteFile(projectRoot);
  const synced = syncedRoutePath(projectRoot, routeFile);
  const relative = path.relative(projectRoot, synced);
  if (!fs.existsSync(synced)) {
    return `${relative} is missing. Run \`npm run sync:te-araroa\`.`;
  }
  if (!fs.readFileSync(synced).equals(fs.readFileSync(packagedRoutePath(projectRoot, routeFile)))) {
    return (
      `${relative} differs from the installed ${TE_ARAROA_PACKAGE} (a sync from another install). ` +
      'Run `npm run sync:te-araroa`.'
    );
  }
  return null;
}
