/**
 * Generates the guide map's waypoint marker glyphs.
 *
 * The map must work fully offline, so marker iconography cannot come from a
 * remote sprite sheet, an icon font, or emoji (the bundled glyph pbfs only
 * cover Latin + punctuation + a few maths/arrow blocks — no pictographs). The
 * icons are therefore committed PNG assets registered with MapLibre's <Images>.
 *
 * Each glyph is authored as a small SVG in `src/lib/map-glyphs.ts` (the web
 * inlines the same shapes) and rasterised here to
 * `assets/map-icons/<name>.png` at 96x96 (declared scale 1, drawn at ~0.175
 * icon-size, so a 3x screen still samples down rather than up).
 *
 * The glyph is a single ink silhouette on a transparent background: the white
 * badge and the category-coloured ring underneath are drawn by GuideMap's
 * CircleLayer, which is what keeps the category colour theme-resolved instead
 * of baked into a bitmap.
 *
 * Rasteriser: ImageMagick with the librsvg delegate
 * (`magick -list format | grep SVG`) when `magick` is on PATH, otherwise
 * @resvg/resvg-js — a pure-Rust renderer with prebuilt binaries and no system
 * dependencies. It is deliberately NOT a devDependency (nothing else needs it,
 * and glyphs change about once a year), so on a box without ImageMagick run it
 * through npx, which leaves the package in the npx cache where `loadResvg`
 * below finds it:
 *
 *   npx -y -p @resvg/resvg-js node scripts/build-map-icons.mjs
 *
 * Named arguments regenerate a subset — the two rasterisers are not
 * byte-identical, so adding a glyph should not rewrite the other PNGs:
 *
 *   node scripts/build-map-icons.mjs      (or: npm run build:map-icons)
 *   node scripts/build-map-icons.mjs restaurant transport emergency
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'assets', 'map-icons');
const TMP_DIR = join(HERE, '..', '.map-icons-tmp');

/** Canvas edge in px. Glyphs are drawn inside a ~72px centred box. */
const SIZE = 96;
/** Glyph ink. Fixed map cartography (see GuideMap's LABEL_TEXT), not a theme token. */
const INK = '#1A1A1A';

/**
 * The glyph shapes (`currentColor`-inked SVG bodies), shared with the web's
 * markers. Loaded straight from the TypeScript source with Node's type
 * stripping (on by default from Node 22.18; on older Node run this script with
 * `--experimental-strip-types`). Edit the shapes there, not here.
 */
const { MAP_GLYPHS } = await import('../../src/lib/map-glyphs.ts');
const GLYPHS = Object.fromEntries(
  Object.entries(MAP_GLYPHS).map(([name, body]) => [name, body.replaceAll('currentColor', INK)])
);

function svgDocument(body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">${body}</svg>`;
}

/** True when ImageMagick is callable (the original, preferred path). */
function hasMagick() {
  return spawnSync('magick', ['-version'], { stdio: 'ignore' }).status === 0;
}

/**
 * `@resvg/resvg-js` from wherever it can be found: a local install first, then
 * the npx cache, which is where `npx -y -p @resvg/resvg-js node …` leaves it
 * (npx puts a package's *bin* on PATH, not its module on the resolution path,
 * so a plain `import` from this script does not see it).
 */
function loadResvg() {
  const require_ = createRequire(import.meta.url);
  const npxRoot = join(homedir(), '.npm', '_npx');
  const cacheDirs = existsSync(npxRoot)
    ? readdirSync(npxRoot).map((entry) => join(npxRoot, entry, 'node_modules'))
    : [];
  for (const paths of [undefined, cacheDirs]) {
    try {
      return require_(require_.resolve('@resvg/resvg-js', paths && { paths })).Resvg;
    } catch {
      // Try the next resolution root.
    }
  }
  throw new Error(
    'Neither ImageMagick nor @resvg/resvg-js is available. Install ImageMagick with ' +
      'the librsvg delegate, or re-run this script as:\n' +
      '  npx -y -p @resvg/resvg-js node scripts/build-map-icons.mjs'
  );
}

/** (name, svg) -> writes a 96x96 RGBA PNG on a transparent background. */
function createRasteriser() {
  if (hasMagick()) {
    mkdirSync(TMP_DIR, { recursive: true });
    return (name, svg, pngPath) => {
      const svgPath = join(TMP_DIR, `${name}.svg`);
      writeFileSync(svgPath, svg);
      execFileSync('magick', [
        '-background',
        'none',
        svgPath,
        '-resize',
        `${SIZE}x${SIZE}`,
        `png32:${pngPath}`,
      ]);
    };
  }
  const Resvg = loadResvg();
  return (_name, svg, pngPath) => {
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: SIZE } }).render().asPng();
    writeFileSync(pngPath, png);
  };
}

const only = new Set(process.argv.slice(2));
for (const name of only) {
  if (!(name in GLYPHS)) {
    throw new Error(`unknown glyph "${name}" (have: ${Object.keys(GLYPHS).join(', ')})`);
  }
}

mkdirSync(OUT_DIR, { recursive: true });
const rasterise = createRasteriser();

let written = 0;
for (const [name, body] of Object.entries(GLYPHS)) {
  if (only.size > 0 && !only.has(name)) continue;
  const pngPath = join(OUT_DIR, `${name}.png`);
  rasterise(name, svgDocument(body), pngPath);
  written += 1;
  console.log(`wrote ${pngPath}`);
}

rmSync(TMP_DIR, { recursive: true, force: true });
console.log(`${written} icons written to assets/map-icons/`);
