/**
 * Smooth the contour lines of published offline tile packs, without
 * rebuilding them (see scripts/lib/contour-pack-smoothing.ts for why).
 *
 * For each trail: fetch its live manifest, download contours.mbtiles from its
 * content-addressed key (size and md5 checked), smooth it in place, validate it
 * as the build does, and write a new manifest beside it with the contours
 * entry, totalSize and version updated. base.mbtiles is not touched or
 * downloaded: the manifest keeps its entry as published, and upload-tiles.sh
 * skips a listed file that is absent locally when the bucket already holds it
 * at that key.
 *
 * Output goes to public/data/tiles/<id>/, where `npm run upload:tiles <id>`
 * publishes it (new contours object first, manifest last). Phones see the
 * new manifest version on the trail's Offline maps screen and re-download
 * only the contours file.
 *
 * A pack whose live copy is already smoothed is skipped.
 *
 * Usage:
 *   npm run smooth:packs -- larapinta heysen
 *   npm run smooth:packs -- --all
 *   npm run smooth:packs -- --all --dry-run   # measure only; nothing written to public/
 */

import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { ReadableStream as WebReadableStream } from 'stream/web';
import type { TileManifest } from '../src/lib/types.js';
import {
  PROJECT_ROOT,
  CONTOUR_ZOOM_EXPECTATION,
  contentAddressedKey,
  ensureDir,
  fileDigests,
  fileMd5,
  fileSizeBytes,
  formatBytes,
  validateMbtilesArtifact,
} from './tile-pipeline.js';
import { packSmoothingVersion, smoothContourMbtiles } from './lib/contour-pack-smoothing.js';

const TILE_BASE_URL = (process.env.TILE_BASE_URL || 'https://data.contour-map-tiles.net').replace(/\/$/, '');
const TILES_DIR = path.join(PROJECT_ROOT, 'public/data/tiles');
const CONTOURS = 'contours.mbtiles';

interface Args {
  ids: string[];
  all: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { ids: [], all: false, dryRun: false };
  for (const arg of argv) {
    if (arg === '--all') args.all = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}`);
    else args.ids.push(arg);
  }
  if (!args.all && args.ids.length === 0) {
    throw new Error('Name trail ids, or pass --all (see the usage at the top of this script).');
  }
  return args;
}

/** Every trail the app bundles — the same list check:tile-packs requires packs for. */
function bundledTrailIds(): string[] {
  const index = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'mobile/assets/trails/index.json'), 'utf8')) as {
    id: string;
  }[];
  return index.map((t) => t.id);
}

async function fetchManifest(id: string): Promise<TileManifest> {
  // A query string the edge has never seen: `cache: 'no-store'` only skips
  // the local cache, and the edge holds manifest.json for days past its
  // max-age (why upload-tiles.sh purges it). Smoothing a stale manifest's
  // contours would republish a pack that was already replaced.
  const res = await fetch(`${TILE_BASE_URL}/${id}/manifest.json?fresh=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${id}: manifest HTTP ${res.status}`);
  return (await res.json()) as TileManifest;
}

async function download(url: string, dest: string, size: number, md5: string | undefined): Promise<void> {
  const part = `${dest}.part`;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body as WebReadableStream), fs.createWriteStream(part));
      const got = fileSizeBytes(part);
      if (got !== size) throw new Error(`size ${got}, manifest says ${size}`);
      if (md5 && fileMd5(part) !== md5) throw new Error('md5 does not match the manifest');
      fs.renameSync(part, dest);
      return;
    } catch (error) {
      fs.rmSync(part, { force: true });
      if (attempt >= 4) throw new Error(`${url}: ${(error as Error).message}`);
      console.warn(`    retrying download (${(error as Error).message})`);
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    }
  }
}

/** Today's date, or today's date with a suffix when the live manifest already has it. */
function nextVersion(current: string): string {
  const today = new Date().toISOString().split('T')[0];
  if (current !== today && !current.startsWith(`${today}.`)) return today;
  const n = current === today ? 1 : Number(current.slice(today.length + 1)) || 1;
  return `${today}.${n + 1}`;
}

async function smoothPack(id: string, dryRun: boolean): Promise<string> {
  const manifest = await fetchManifest(id);
  const entry = manifest.files.find((f) => f.name === CONTOURS);
  if (!entry) return `${id}: no ${CONTOURS} in the live manifest, skipped`;

  const outDir = dryRun ? path.join(PROJECT_ROOT, 'data/tiles/smoothing-dry-run', id) : path.join(TILES_DIR, id);
  ensureDir(outDir);
  const file = path.join(outDir, CONTOURS);

  // Never write over a pack built here and not yet published: its manifest is
  // not the live one, and replacing it with a smoothed copy of the live pack
  // would silently throw the build away.
  const localManifestPath = path.join(outDir, 'manifest.json');
  if (!dryRun && fs.existsSync(localManifestPath)) {
    const local = JSON.parse(fs.readFileSync(localManifestPath, 'utf8')) as TileManifest;
    if (local.version !== manifest.version) {
      throw new Error(
        `${id}: ${localManifestPath} is version ${local.version} but the live pack is ${manifest.version}. ` +
          `Publish or remove the local build first (upload:tiles ${id}), then re-run.`
      );
    }
  }

  // Reuse an earlier download of the same live file.
  const reusable = fs.existsSync(file) && fileSizeBytes(file) === entry.size && (!entry.md5 || fileMd5(file) === entry.md5);
  if (!reusable) {
    console.log(`  ${id}: downloading ${CONTOURS} (${formatBytes(entry.size)})`);
    await download(`${TILE_BASE_URL}/${id}/${entry.key ?? entry.name}`, file, entry.size, entry.md5);
  }

  const smoothedAlready = packSmoothingVersion(file);
  if (smoothedAlready) {
    fs.rmSync(file);
    return `${id}: live pack is already smoothed (${smoothedAlready}), skipped`;
  }

  const started = Date.now();
  const result = smoothContourMbtiles(file);
  validateMbtilesArtifact(file, CONTOUR_ZOOM_EXPECTATION);

  const size = fileSizeBytes(file);
  const { sha256, md5 } = fileDigests(file);
  const files = manifest.files.map((f) =>
    f.name === CONTOURS ? { name: CONTOURS, size, sha256, md5, key: contentAddressedKey(CONTOURS, sha256) } : f
  );
  const next: TileManifest = {
    ...manifest,
    version: nextVersion(manifest.version),
    files,
    totalSize: files.reduce((sum, f) => sum + f.size, 0),
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(next, null, 2));

  const growth = ((size / entry.size - 1) * 100).toFixed(0);
  return (
    `${id}: ${formatBytes(entry.size)} → ${formatBytes(size)} (+${growth}%), ` +
    `${result.tiles} tiles in ${((Date.now() - started) / 1000).toFixed(1)}s, version ${next.version}`
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ids = args.all ? bundledTrailIds() : args.ids;
  const lines: string[] = [];
  let failed = 0;
  for (const id of ids) {
    try {
      const line = await smoothPack(id, args.dryRun);
      console.log(`  ✓ ${line}`);
      lines.push(line);
    } catch (error) {
      failed++;
      const line = `${id}: FAILED — ${(error as Error).message}`;
      console.error(`  ✗ ${line}`);
      lines.push(line);
    }
  }
  console.log(`\n${lines.join('\n')}`);
  if (!args.dryRun && failed < ids.length) {
    console.log(`\nPublish with: npm run upload:tiles -- <id>  (outputs are in ${path.relative(PROJECT_ROOT, TILES_DIR)}/<id>/)`);
  }
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
