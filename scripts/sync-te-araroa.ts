/**
 * Copy the published Te Araroa route out of the `te-araroa-data` package into
 * `data/trails/te_araroa/`.
 *
 * The route, its waypoints and the hand-researched resupply points are built in
 * https://github.com/eamon-b/te-araroa-data, which commits its outputs. Keeping
 * a hand-copied GPX here meant curating that work twice — the six places the
 * walking route stops and resumes, the resupply points positioned at the km you
 * leave the trail rather than at the town — and the two copies had already
 * drifted. So the build is a devDependency instead: `package-lock.json` records
 * the exact commit, and this script materialises it.
 *
 * The file it writes is gitignored. `npm run sync:te-araroa` is a build step,
 * not a commit; to take a newer build, `npm update te-araroa-data` and re-run.
 *
 * It copies the file `trail.json` names as `gpxFile` — the *stable* filename
 * (`te-araroa-sobo.gpx`, not `te-araroa-2026-27-sobo.gpx`) — so a season rollover upstream needs no change
 * here. SOBO is the direction `trail.json` declares as default; the trail page
 * reverses it for NOBO walkers.
 */

import * as fs from 'fs';
import * as path from 'path';
import { packageProblem, packagedRoutePath, teAraroaPackageDir, teAraroaRouteFile } from './lib/te-araroa-package.js';

const SCRIPTS_DIR = path.dirname(
  process.platform === 'win32'
    ? new URL(import.meta.url).pathname.slice(1).replace(/\//g, '\\')
    : new URL(import.meta.url).pathname
);
const PROJECT_ROOT = path.resolve(SCRIPTS_DIR, '..');
const TRAIL_DIR = path.join(PROJECT_ROOT, 'data/trails/te_araroa');

/** Read alongside the route, for the log line only — never copied. */
const META_FILE = 'te-araroa.meta.json';

interface TeAraroaMeta {
  season?: string;
  version?: string;
  generatedAt?: string;
  walkedLengthKm?: number;
  gapLengthKm?: number;
  walkedStretches?: number;
}

function main(): void {
  // This checkout's own install only, at the lockfile's commit: Node's
  // `require.resolve` would walk up into a parent checkout's node_modules
  // (a worktree under .claude/worktrees/ sits inside the main checkout) and
  // copy another commit's route without a word. See lib/te-araroa-package.ts.
  const routeFile = teAraroaRouteFile(PROJECT_ROOT);
  const problem = packageProblem(PROJECT_ROOT, routeFile);
  if (problem || !routeFile) {
    console.error(`sync:te-araroa: ${problem}`);
    process.exit(1);
  }
  const outDir = path.join(teAraroaPackageDir(PROJECT_ROOT), 'out');
  const source = packagedRoutePath(PROJECT_ROOT, routeFile);

  fs.mkdirSync(TRAIL_DIR, { recursive: true });
  const destination = path.join(TRAIL_DIR, routeFile);
  fs.copyFileSync(source, destination);

  const bytes = fs.statSync(destination).size;
  console.log(`Synced ${routeFile} → data/trails/te_araroa/ (${(bytes / 1024 / 1024).toFixed(1)} MB)`);

  // Say which build this is, so a stale node_modules is visible in the log
  // rather than only in the trail page's numbers.
  const metaPath = path.join(outDir, META_FILE);
  if (fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as TeAraroaMeta;
    console.log(`  Te Araroa ${meta.season ?? '?'} (${meta.version ?? '?'}), built ${meta.generatedAt ?? '?'}`);
    if (meta.walkedLengthKm !== undefined) {
      console.log(
        `  ${meta.walkedLengthKm.toFixed(1)} km walkable over ` +
          `${meta.walkedStretches ?? '?'} stretches, ` +
          `${(meta.gapLengthKm ?? 0).toFixed(1)} km of ferries and river crossings between them`
      );
    }
  }
}

main();
