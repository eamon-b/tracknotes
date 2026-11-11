/**
 * Does this tree build the same trail data as a baseline?
 *
 * The rule (CLAUDE.md, "One ingestion pipeline"): a change to
 * `src/lib/trail-ingest.ts`, `gpx-parser.ts` or `track-simplify.ts` must leave
 * `public/data/generated/*.json` byte-identical unless the change is meant to
 * move it. That directory is gitignored, so git never shows the drift; this
 * script builds both sides and compares them.
 *
 *   npm run check:data-unchanged -- --baseline               # build origin/main into a snapshot
 *   npm run check:data-unchanged -- --baseline --ref HEAD~1  # …or any other ref
 *   npm run check:data-unchanged -- --baseline --current     # …or this tree, before you edit it
 *   npm run check:data-unchanged                             # rebuild this tree, compare with the snapshot
 *   npm run check:data-unchanged -- --no-build               # compare the outputs already on disk
 *
 * A ref is built in a temporary `git worktree` (this tree is untouched); it
 * borrows this checkout's node_modules when its package-lock.json is the same,
 * and runs `npm ci` otherwise. `--current` and the comparison build in place —
 * the same three commands as CI's trail-data job, which rewrite the committed
 * `mobile/assets/trails/` and `data/waypoint-ids.json` exactly as a manual
 * rebuild would.
 *
 * Compared: every file in `public/data/generated/`, `mobile/assets/trails/` and
 * the generated `src/web/trails/<id>/` pages, and `data/waypoint-ids.json`.
 * Ignored: only the clock fields listed in `lib/data-diff.ts`. Exit 0 when
 * nothing else differs, 1 when something does, 2 when a build or git fails.
 *
 * Snapshots live in the system temp directory, one per checkout
 * (`--snapshot <dir>` to choose another).
 */

import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { diffSnapshots, formatReport } from './lib/data-diff.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Where each part of a snapshot comes from, relative to a checkout. */
const SOURCES: Array<{ prefix: string; dir: string; recurse: boolean }> = [
  { prefix: 'generated', dir: 'public/data/generated', recurse: false },
  { prefix: 'mobile', dir: 'mobile/assets/trails', recurse: false },
  // One directory per trail; the templates and modules beside them are source.
  { prefix: 'pages', dir: 'src/web/trails', recurse: true },
];
const REGISTRY = { name: 'waypoint-ids.json', file: 'data/waypoint-ids.json' };
const META_FILE = '.snapshot.json';

const BUILD_STEPS = ['sync:te-araroa', 'build:trails', 'build:mobile-trails'];

interface Options {
  baseline: boolean;
  ref: string;
  current: boolean;
  build: boolean;
  snapshotDir: string;
}

interface SnapshotMeta {
  source: string;
  commit?: string;
  builtAt: string;
}

export class CheckError extends Error {}

const USAGE =
  'Usage: npm run check:data-unchanged -- [--baseline [--ref <ref> | --current]] [--no-build] [--snapshot <dir>]';

/** Throws a `CheckError` naming the bad argument. */
export function parseArgs(argv: string[], projectRoot = PROJECT_ROOT): Options {
  const options: Options = {
    baseline: false,
    ref: 'origin/main',
    current: false,
    build: true,
    snapshotDir: defaultSnapshotDir(projectRoot),
  };
  let refGiven = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--baseline') options.baseline = true;
    else if (arg === '--current') options.current = true;
    else if (arg === '--no-build') options.build = false;
    else if (arg === '--ref' || arg === '--snapshot') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new CheckError(`${arg} needs a value`);
      if (arg === '--ref') {
        options.ref = value;
        refGiven = true;
      } else options.snapshotDir = path.resolve(value);
    } else throw new CheckError(`unknown argument ${arg}`);
  }
  if ((refGiven || options.current) && !options.baseline)
    throw new CheckError('--ref and --current go with --baseline');
  if (refGiven && options.current) throw new CheckError('--ref and --current are alternatives');
  return options;
}

/** One snapshot directory per checkout, so worktrees do not overwrite each other's. */
export function defaultSnapshotDir(projectRoot: string): string {
  const tag = createHash('sha1').update(projectRoot).digest('hex').slice(0, 8);
  return path.join(os.tmpdir(), `tracknotes-data-baseline-${tag}`);
}

function git(args: string[], cwd = PROJECT_ROOT): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new CheckError(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

/** Run one npm script in `cwd`, its output to `log`; on failure show the log's tail. */
function npm(args: string[], cwd: string, log: string): void {
  const fd = fs.openSync(log, 'a');
  try {
    fs.writeSync(fd, `\n$ npm ${args.join(' ')}\n`);
    const result = spawnSync('npm', args, { cwd, stdio: ['ignore', fd, fd] });
    if (result.status !== 0) {
      const tail = fs.readFileSync(log, 'utf-8').trimEnd().split('\n').slice(-25).join('\n');
      throw new CheckError(`npm ${args.join(' ')} failed in ${cwd} (exit ${result.status}). Log: ${log}\n${tail}`);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function buildTrailData(cwd: string, log: string): void {
  for (const step of BUILD_STEPS) {
    console.log(`  npm run ${step}`);
    npm(['run', step], cwd, log);
  }
}

/** Every compared output file under `root`, keyed by its snapshot path. */
export function collectOutputs(root: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const { prefix, dir, recurse } of SOURCES) {
    const base = path.join(root, dir);
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (recurse) {
        if (!entry.isDirectory()) continue;
        for (const page of fs.readdirSync(path.join(base, entry.name), { withFileTypes: true })) {
          if (page.isFile()) {
            files.set(
              `${prefix}/${entry.name}/${page.name}`,
              fs.readFileSync(path.join(base, entry.name, page.name), 'utf-8')
            );
          }
        }
      } else if (entry.isFile()) {
        files.set(`${prefix}/${entry.name}`, fs.readFileSync(path.join(base, entry.name), 'utf-8'));
      }
    }
  }
  const registry = path.join(root, REGISTRY.file);
  if (fs.existsSync(registry)) files.set(REGISTRY.name, fs.readFileSync(registry, 'utf-8'));
  return files;
}

function writeSnapshot(dir: string, files: Map<string, string>, meta: SnapshotMeta): void {
  if (fs.existsSync(dir)) {
    // Only ever replace a directory this script made.
    if (fs.readdirSync(dir).length > 0 && !fs.existsSync(path.join(dir, META_FILE))) {
      throw new CheckError(`${dir} exists and is not a snapshot; choose another --snapshot`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  for (const [name, text] of files) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  fs.writeFileSync(path.join(dir, META_FILE), JSON.stringify(meta, null, 2));
}

function readSnapshot(dir: string): { files: Map<string, string>; meta: SnapshotMeta } {
  const metaPath = path.join(dir, META_FILE);
  if (!fs.existsSync(metaPath)) {
    throw new CheckError(`No baseline snapshot in ${dir}. Make one first: npm run check:data-unchanged -- --baseline`);
  }
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as SnapshotMeta;
  const files = new Map<string, string>();
  const walk = (sub: string) => {
    for (const entry of fs.readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const name = sub ? `${sub}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(name);
      else if (name !== META_FILE) files.set(name, fs.readFileSync(path.join(dir, name), 'utf-8'));
    }
  };
  walk('');
  return { files, meta };
}

/** Build `ref` in a temporary worktree and return its outputs. */
function buildRef(ref: string, log: string): { files: Map<string, string>; commit: string } {
  const commit = git(['rev-parse', '--verify', `${ref}^{commit}`]);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tracknotes-data-ref-'));
  const tree = path.join(scratch, 'tree');
  console.log(`Building ${ref} (${commit.slice(0, 12)}) in ${tree}`);
  git(['worktree', 'add', '--detach', tree, commit]);
  try {
    const lockHere = fs.readFileSync(path.join(PROJECT_ROOT, 'package-lock.json'), 'utf-8');
    const lockThere = fs.readFileSync(path.join(tree, 'package-lock.json'), 'utf-8');
    if (lockHere === lockThere && fs.existsSync(path.join(PROJECT_ROOT, 'node_modules'))) {
      fs.symlinkSync(path.join(PROJECT_ROOT, 'node_modules'), path.join(tree, 'node_modules'), 'dir');
    } else {
      console.log(`  npm ci (${ref} pins other packages than this tree)`);
      npm(['ci', '--no-audit', '--no-fund'], tree, log);
    }
    buildTrailData(tree, log);
    return { files: collectOutputs(tree), commit };
  } finally {
    try {
      git(['worktree', 'remove', '--force', tree]);
    } catch (error) {
      console.warn(`  could not remove the worktree: ${(error as Error).message}`);
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function main(): void {
  let options: Options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    throw new CheckError(`${(error as Error).message}\n${USAGE}`);
  }
  const log = path.join(os.tmpdir(), `tracknotes-check-data-${process.pid}.log`);

  if (options.baseline) {
    let files: Map<string, string>;
    let meta: SnapshotMeta;
    if (options.current) {
      console.log('Building this tree for the baseline');
      buildTrailData(PROJECT_ROOT, log);
      files = collectOutputs(PROJECT_ROOT);
      meta = { source: 'this tree', commit: git(['rev-parse', 'HEAD']), builtAt: new Date().toISOString() };
    } else {
      const built = buildRef(options.ref, log);
      files = built.files;
      meta = { source: options.ref, commit: built.commit, builtAt: new Date().toISOString() };
    }
    writeSnapshot(options.snapshotDir, files, meta);
    console.log(`\nBaseline (${files.size} files) saved to ${options.snapshotDir}`);
    console.log('Now make your change and run: npm run check:data-unchanged');
    return;
  }

  const baseline = readSnapshot(options.snapshotDir);
  if (options.build) {
    console.log('Building this tree');
    buildTrailData(PROJECT_ROOT, log);
  }
  const diffs = diffSnapshots(baseline.files, collectOutputs(PROJECT_ROOT));
  const against = `${baseline.meta.source}${baseline.meta.commit ? ` @ ${baseline.meta.commit.slice(0, 12)}` : ''}`;
  if (diffs.length === 0) {
    console.log(`\nTrail data unchanged against ${against} (built ${baseline.meta.builtAt}).`);
    return;
  }
  console.error(`\n${diffs.length} file(s) differ from ${against} (built ${baseline.meta.builtAt}):\n`);
  console.error(formatReport(diffs));
  if (diffs.some(diff => diff.path === REGISTRY.name)) {
    console.error(
      `\n${REGISTRY.file} changed: waypoint ids were minted or retired. That orphans server-side comments ` +
        'unless the change is meant (see CLAUDE.md, "Waypoint ids are stable").'
    );
  }
  console.error(
    '\nIf the change is meant to move the data, say so in the PR and commit the rebuilt mobile/assets/trails/ ' +
      `and ${REGISTRY.file}.`
  );
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    // Exit 2, not 1: the data was not compared, which is not "it differs".
    if (!(error instanceof CheckError)) console.error(error);
    else console.error(`check:data-unchanged: ${error.message}`);
    process.exit(2);
  }
}
