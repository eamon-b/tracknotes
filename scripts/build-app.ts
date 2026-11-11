/**
 * `npm run build:app`: a production build of the web pages into `dist-app/`,
 * for the Playwright smoke suite (`npm run test:e2e`) and anyone who wants to
 * look at the built site without touching `dist/`.
 *
 * It differs from `npm run build` (Vercel's build) in two ways:
 *
 * - Vite's `publicDir` copy is off. Locally `public/data/tiles/` holds tens of
 *   GB of map tiles (gitignored, absent on CI and Vercel), which `vite build`
 *   would copy into the output. This copies the rest of `public/` itself —
 *   icons, legal pages, the GPX schema and `data/generated/` (the trail JSON
 *   the pages fetch) — and leaves the tile packs out.
 * - It builds no trail data and runs no `tsc`. Run
 *   `npm run sync:te-araroa && npm run build:trails` first; it stops with that
 *   instruction when the generated pages or JSON are missing.
 */

import { cpSync, existsSync, readFileSync, rmSync } from 'fs';
import { relative, resolve, sep } from 'path';
import { build } from 'vite';

const ROOT = resolve(import.meta.dirname, '..');
const PUBLIC_DIR = resolve(ROOT, 'public');
const OUT_DIR = resolve(ROOT, 'dist-app');

/** Paths under `public/` never copied: the map tile packs (gitignored, huge locally). */
const EXCLUDED = ['data/tiles'];

function fail(message: string): never {
  console.error(`build:app: ${message}`);
  console.error('Build the trail data first: npm run sync:te-araroa && npm run build:trails');
  process.exit(1);
}

function checkTrailData(): void {
  const indexPath = resolve(PUBLIC_DIR, 'data/generated/index.json');
  if (!existsSync(indexPath)) fail('public/data/generated/index.json is missing.');
  const trails = JSON.parse(readFileSync(indexPath, 'utf-8')) as { id: string }[];
  if (!Array.isArray(trails) || trails.length === 0) fail('public/data/generated/index.json lists no trails.');
  const missing = trails.filter(t => !existsSync(resolve(ROOT, 'src/web/trails', t.id, 'index.html'))).map(t => t.id);
  if (missing.length > 0) fail(`no generated trail page for ${missing.join(', ')} (src/web/trails/<id>/index.html).`);
  console.log(`build:app: ${trails.length} trails in public/data/generated/index.json`);
}

function copyPublic(): void {
  const excluded = EXCLUDED.map(p => resolve(PUBLIC_DIR, p));
  cpSync(PUBLIC_DIR, OUT_DIR, {
    recursive: true,
    filter: src => !excluded.some(ex => src === ex || src.startsWith(ex + sep)),
  });
  console.log(`build:app: copied public/ (except ${EXCLUDED.join(', ')}) to ${relative(ROOT, OUT_DIR)}/`);
}

checkTrailData();
rmSync(OUT_DIR, { recursive: true, force: true });
await build({
  configFile: resolve(ROOT, 'vite.config.ts'),
  publicDir: false,
  build: { outDir: OUT_DIR, emptyOutDir: true },
});
copyPublic();
