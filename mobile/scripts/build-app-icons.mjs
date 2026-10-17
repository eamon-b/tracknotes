/* global console */
/**
 * Generates the Tracknotes mark — the app icon, Android adaptive layers,
 * splash image and favicons — from one piece of SVG artwork defined below.
 *
 * The mark: a footpath, dashed the way topo maps draw one, crossing real
 * contour lines below a summit, on the app's forest green (`#1B4332`, the
 * adaptive-icon background colour in app.json). The contours are Mt Sonder
 * (Rwetyepme) on the Larapinta Trail, traced from Copernicus GLO-30 into
 * `data/mark-contours.json` by the root `npm run trace:mark-contours`; this
 * script only draws them. The path passes the summit spot rather than ending
 * on it (a line ending on a dot reads as a pin), and the contours break where
 * it crosses them, as on a printed map.
 *
 * One drawing at four densities: as the mark shrinks it drops contour levels
 * and thickens its strokes, never redraws. At 32 px and under the dashes turn
 * to noise, so the small density draws the path solid.
 *
 * Outputs
 *   mobile/assets/images/icon.png                    1024, full bleed (iOS masks it)
 *   mobile/assets/images/android-icon-background.png 1024, the green
 *   mobile/assets/images/android-icon-foreground.png 1024, contours + path + summit on
 *                                                    transparent, scaled into the
 *                                                    visible centre of the layer
 *   mobile/assets/images/android-icon-monochrome.png 1024, white, contours at 50% alpha
 *                                                    (Android 13 themed icons)
 *   mobile/assets/images/splash-icon.png             1024, a disc on transparent: Android 12+
 *                                                    draws the splash icon in a circle
 *   mobile/assets/images/favicon.png                 48, Expo web
 *   public/favicon.svg, public/favicon-32.png, public/apple-touch-icon.png   the website
 *
 * Rasteriser: @resvg/resvg-js, found the same way as build-map-icons.mjs:
 *
 *   npx -y -p @resvg/resvg-js node scripts/build-app-icons.mjs
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const IMAGES = join(HERE, '..', 'assets', 'images');
const PUBLIC = join(HERE, '..', '..', 'public');

const GREEN = '#1B4332';
const GREEN_DEEP = '#143628';
const CONTOUR = '#2D6A4F';
const CONTOUR_LIGHT = '#40916C';
const TRAIL = '#F1E9D2';
const SUMMIT = '#F4A261';

const TERRAIN = JSON.parse(readFileSync(join(HERE, 'data', 'mark-contours.json'), 'utf8'));
/** The summit on the 1024 canvas (where the tracer put it). */
const [SX, SY] = TERRAIN.summit;
/** Contour levels, highest first; each a list of closed rings in canvas units. */
const LEVELS = TERRAIN.levels;

function area(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a / 2);
}

function inside(ring, [x, y]) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

const ringPath = (ring) => `M${ring.map(([x, y]) => `${x} ${y}`).join('L')}Z`;

/**
 * The path as walked over the terrain: across the open ground at lower left,
 * up the south-west flank, along below the summit ridge, off the right edge.
 * The guide is resampled with a slight low-frequency wobble — a walked line,
 * not a ruled one, which is what stops it reading as a road or a bolt.
 */
const TRAIL_GUIDE = [
  [330, 1100], [360, 900], [440, 770], [400, 660], [480, 570],
  [560, 530], [660, 535], [760, 560], [860, 560], [1120, 590],
];
const WOBBLE = 8;
const WOBBLE_PHASE = 6;

function trailPath() {
  const pts = [];
  let s = 0;
  for (let i = 0; i < TRAIL_GUIDE.length - 1; i++) {
    const [a, b] = [TRAIL_GUIDE[i], TRAIL_GUIDE[i + 1]];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(2, Math.round(len / 34));
    const nx = -(b[1] - a[1]) / len;
    const ny = (b[0] - a[0]) / len;
    for (let k = 0; k < steps; k++) {
      const f = k / steps;
      s += 1;
      const w = WOBBLE * (Math.sin(s * 0.9 + WOBBLE_PHASE) * 0.6 + Math.sin(s * 0.37 + WOBBLE_PHASE * 2) * 0.4);
      pts.push([a[0] + (b[0] - a[0]) * f + nx * w, a[1] + (b[1] - a[1]) * f + ny * w]);
    }
  }
  pts.push(TRAIL_GUIDE[TRAIL_GUIDE.length - 1]);
  // Catmull-Rom through the points → cubic Béziers.
  const at = (i) => pts[Math.max(0, Math.min(pts.length - 1, i))];
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}
const TRAIL_D = trailPath();

/**
 * The densities. `every` keeps every nth contour level from the top, `minArea`
 * drops rings too small to read, `gap` is the clearance the contours leave
 * either side of the path. Units are on the 1024 canvas.
 */
const FULL = { every: 1, ringWidth: 16, minArea: 2500, trailWidth: 30, dash: [26, 58], dot: 24, gap: 20 };
const MID = { every: 2, ringWidth: 24, minArea: 9000, trailWidth: 45, dash: [42, 93], dot: 31, gap: 26 };
const SMALL = { every: 3, ringWidth: 48, minArea: 40000, trailWidth: 70, dash: null, dot: 64, gap: 30 };
const MONO = {
  every: 2, ringWidth: 26, minArea: 6000, trailWidth: 42, dash: [36, 80], dot: 34, gap: 26,
  ink: '#FFFFFF', ringOpacity: 0.5,
};

let maskCount = 0;
function mark({ every, ringWidth, minArea, trailWidth, dash, dot, gap, ink, ringOpacity = 1 }) {
  const id = `trail-gap-${maskCount++}`;
  const rings = LEVELS.filter((_, k) => k % every === 0)
    .flatMap((level, k) =>
      level.rings
        .filter((ring) => area(ring) > minArea)
        .map((ring) => {
          // Only the summit's own top contour is lifted, not a neighbouring top's.
          const color = ink ?? (k === 0 && inside(ring, [SX, SY]) ? CONTOUR_LIGHT : CONTOUR);
          return `<path d="${ringPath(ring)}" fill="none" stroke="${color}" stroke-width="${ringWidth}" stroke-linejoin="round"/>`;
        })
    )
    .join('');
  const dashAttr = dash ? ` stroke-dasharray="${dash[0]} ${dash[1]}"` : '';
  return (
    // Contours break where the path crosses them, as on a printed map.
    `<defs><mask id="${id}" maskUnits="userSpaceOnUse" x="-200" y="-200" width="1424" height="1424">` +
    `<rect x="-200" y="-200" width="1424" height="1424" fill="#fff"/>` +
    `<path d="${TRAIL_D}" fill="none" stroke="#000" stroke-width="${trailWidth + gap * 2}" stroke-linecap="round" stroke-linejoin="round"/>` +
    `</mask></defs>` +
    `<g mask="url(#${id})" opacity="${ringOpacity}">${rings}</g>` +
    `<path d="${TRAIL_D}" fill="none" stroke="${ink ?? TRAIL}" stroke-width="${trailWidth}" stroke-linecap="round" stroke-linejoin="round"${dashAttr}/>` +
    `<circle cx="${SX}" cy="${SY}" r="${dot}" fill="${ink ?? SUMMIT}"/>`
  );
}

const BACKGROUND = `
  <defs><radialGradient id="g" cx="0.56" cy="0.38" r="0.8">
    <stop offset="0" stop-color="${GREEN}"/><stop offset="1" stop-color="${GREEN_DEEP}"/>
  </radialGradient></defs>
  <rect width="1024" height="1024" fill="url(#g)"/>`;

function svg(body, { size = 1024 } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024">${body}</svg>`;
}

/**
 * Scaled about the canvas centre. Android shows only the centre two-thirds of
 * an adaptive layer (inside whatever mask the launcher picks), so the layers
 * draw the mark at 0.9: the summit and the climb stay well inside it, and the
 * path still runs off the visible edge.
 */
const scaled = (body, k) => `<g transform="translate(512 512) scale(${k}) translate(-512 -512)">${body}</g>`;
const clipped = (body, shape, id) =>
  `<defs><clipPath id="${id}">${shape}</clipPath></defs><g clip-path="url(#${id})">${body}</g>`;
const TILE = '<rect width="1024" height="1024" rx="230"/>';
const DISC = '<circle cx="512" cy="512" r="512"/>';

const FULL_ART = `${BACKGROUND}${mark(FULL)}`;
const SMALL_TILE = clipped(`${BACKGROUND}${mark(SMALL)}`, TILE, 'tile-small');

const OUTPUTS = [
  [join(IMAGES, 'icon.png'), svg(FULL_ART), 1024],
  // Contours ride on the foreground with the path so the two stay aligned
  // whatever the launcher's parallax does; the background is the green alone.
  [join(IMAGES, 'android-icon-background.png'), svg(BACKGROUND), 1024],
  [join(IMAGES, 'android-icon-foreground.png'), svg(scaled(mark(FULL), 0.9)), 1024],
  [join(IMAGES, 'android-icon-monochrome.png'), svg(scaled(mark(MONO), 0.9)), 1024],
  [join(IMAGES, 'splash-icon.png'), svg(clipped(FULL_ART, DISC, 'disc')), 1024],
  [join(IMAGES, 'favicon.png'), svg(clipped(`${BACKGROUND}${mark(MID)}`, TILE, 'tile-mid')), 48],
  [join(PUBLIC, 'favicon-32.png'), svg(SMALL_TILE), 32],
  [join(PUBLIC, 'apple-touch-icon.png'), svg(FULL_ART), 180],
];

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
    '@resvg/resvg-js is not available. Re-run this script as:\n' +
      '  npx -y -p @resvg/resvg-js node scripts/build-app-icons.mjs'
  );
}

const Resvg = loadResvg();
for (const [path, doc, size] of OUTPUTS) {
  const png = new Resvg(doc, { fitTo: { mode: 'width', value: size } }).render().asPng();
  writeFileSync(path, png);
  console.log(`wrote ${path}`);
}
// The SVG favicon is the small artwork itself: crisp at any size, one request.
writeFileSync(join(PUBLIC, 'favicon.svg'), `${svg(SMALL_TILE, { size: 32 })}\n`);
console.log(`wrote ${join(PUBLIC, 'favicon.svg')}`);
