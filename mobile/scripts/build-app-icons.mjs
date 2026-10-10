/**
 * Generates the Tracknotes mark — the app icon, Android adaptive layers,
 * splash image and favicons — from one piece of SVG artwork defined below.
 *
 * The mark: a cream trail climbing through contour lines to a summit marker,
 * on the app's forest green (`#1B4332`, the adaptive-icon background colour in
 * app.json). Two versions of the contours are drawn: the full set for the app
 * icon, and a pared-down pair for the favicons, where finer lines turn to mush
 * at 16-32 px.
 *
 * Outputs
 *   mobile/assets/images/icon.png                    1024, full bleed (iOS masks it)
 *   mobile/assets/images/android-icon-background.png 1024, the green
 *   mobile/assets/images/android-icon-foreground.png 1024, contours + trail + summit on
 *                                                    transparent, the mark inside the
 *                                                    visible centre two-thirds
 *   mobile/assets/images/android-icon-monochrome.png 1024, white silhouette (Android 13 themed icons)
 *   mobile/assets/images/splash-icon.png             1024, rounded tile on transparent
 *                                                    (sits on the white and the #081C15 splash)
 *   mobile/assets/images/favicon.png                 48, Expo web
 *   public/favicon.svg, public/favicon-32.png, public/apple-touch-icon.png   the website
 *
 * Rasteriser: @resvg/resvg-js, found the same way as build-map-icons.mjs:
 *
 *   npx -y -p @resvg/resvg-js node scripts/build-app-icons.mjs
 */

import { existsSync, readdirSync, writeFileSync } from 'node:fs';
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

/** Summit (the contours' centre and the end of the trail) on a 1024 canvas. */
const CX = 636;
const CY = 350;

/**
 * A closed, gently irregular ring around the summit as a smooth path:
 * r(θ) wobbles by a few per cent so the lines read as terrain, not a target.
 */
function contour(radius, phase) {
  const n = 48;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const r = radius * (1 + 0.09 * Math.sin(2 * t + phase) + 0.05 * Math.sin(3 * t + phase * 1.7));
    // Squash vertically a little and lean the rings down-left, toward the trail.
    pts.push([CX + r * 1.08 * Math.cos(t) - radius * 0.12, CY + r * 0.86 * Math.sin(t) + radius * 0.1]);
  }
  // Closed Catmull-Rom → cubic Béziers.
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return `${d} Z`;
}

const CONTOURS_FULL = [
  [95, 0.4, CONTOUR_LIGHT],
  [190, 1.3, CONTOUR],
  [290, 2.1, CONTOUR],
  [400, 2.9, CONTOUR],
  [520, 3.6, CONTOUR],
]
  .map(([r, ph, c]) => `<path d="${contour(r, ph)}" fill="none" stroke="${c}" stroke-width="20"/>`)
  .join('');

const CONTOURS_SMALL = [
  [150, 1.0, CONTOUR_LIGHT],
  [330, 2.4, CONTOUR_LIGHT],
]
  .map(([r, ph, c]) => `<path d="${contour(r, ph)}" fill="none" stroke="${c}" stroke-width="44"/>`)
  .join('');

/**
 * The trail: up from the bottom left in switchbacks to the summit. Straight
 * legs with rounded corners, so it reads as a walked line, not a squiggle.
 */
const TRAIL_D = `M300 860 L530 720 L350 600 L570 480 L${CX} ${CY}`;
/** Centre of the trail-and-summit group, which the adaptive layers centre. */
const MARK_CX = 488;
const MARK_CY = 595;

function trail(width, color = TRAIL) {
  return `<path d="${TRAIL_D}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function summit(r, ring, fill = SUMMIT, ringColor = TRAIL) {
  return `<circle cx="${CX}" cy="${CY}" r="${r + ring}" fill="${ringColor}"/><circle cx="${CX}" cy="${CY}" r="${r}" fill="${fill}"/>`;
}

const BACKGROUND = `
  <defs><radialGradient id="g" cx="0.55" cy="0.4" r="0.85">
    <stop offset="0" stop-color="${GREEN}"/><stop offset="1" stop-color="${GREEN_DEEP}"/>
  </radialGradient></defs>
  <rect width="1024" height="1024" fill="url(#g)"/>`;

function svg(body, { size = 1024, view = '0 0 1024 1024' } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${view}">${body}</svg>`;
}


/**
 * The artwork with the mark centred and scaled. Android shows only the
 * centre two-thirds of an adaptive layer (inside whatever mask the launcher
 * picks), so the foreground's trail and summit must fit a ~340 px radius.
 */
function centred(body, k) {
  return `<g transform="translate(512 512) scale(${k}) translate(${-MARK_CX} ${-MARK_CY})">${body}</g>`;
}

const FULL = `${BACKGROUND}${centred(`${CONTOURS_FULL}${trail(64)}${summit(40, 16)}`, 1.05)}`;
const SMALL = `${BACKGROUND}${centred(`${CONTOURS_SMALL}${trail(100)}${summit(62, 26)}`, 1.1)}`;
const ROUNDED = (body, rx) =>
  `<defs><clipPath id="c"><rect width="1024" height="1024" rx="${rx}"/></clipPath></defs><g clip-path="url(#c)">${body}</g>`;

const OUTPUTS = [
  [join(IMAGES, 'icon.png'), svg(FULL), 1024],
  // Contours ride on the foreground with the trail so the two stay aligned
  // whatever the launcher's parallax does; the background is the green alone.
  [join(IMAGES, 'android-icon-background.png'), svg(BACKGROUND), 1024],
  [join(IMAGES, 'android-icon-foreground.png'), svg(centred(`${CONTOURS_FULL}${trail(64)}${summit(40, 16)}`, 0.85)), 1024],
  [join(IMAGES, 'android-icon-monochrome.png'), svg(centred(`${trail(76, '#FFFFFF')}${summit(58, 0, '#FFFFFF')}`, 0.85)), 1024],
  [join(IMAGES, 'splash-icon.png'), svg(ROUNDED(FULL, 230)), 1024],
  [join(IMAGES, 'favicon.png'), svg(ROUNDED(SMALL, 220)), 48],
  [join(PUBLIC, 'favicon-32.png'), svg(ROUNDED(SMALL, 220)), 32],
  [join(PUBLIC, 'apple-touch-icon.png'), svg(FULL), 180],
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
writeFileSync(join(PUBLIC, 'favicon.svg'), `${svg(ROUNDED(SMALL, 220), { size: 32 })}\n`);
console.log(`wrote ${join(PUBLIC, 'favicon.svg')}`);
