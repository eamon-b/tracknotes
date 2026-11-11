/**
 * The `test` every smoke spec imports. It wraps Playwright's `page` so that:
 *
 * - The network is deterministic. Requests to the site under test go through
 *   (with Vercel's bypass headers when `VERCEL_AUTOMATION_BYPASS_SECRET` is
 *   set). Leaflet, which the pages load from unpkg with an SRI hash, is served
 *   from `node_modules/leaflet` (the same 1.9.4 bytes, so the hash still
 *   matches). Map tiles get a blank PNG. Anything else — Overpass, elevation,
 *   climate — is aborted, except, against a deployed site, read-only (GET)
 *   calls to its comments API (a Preview build may set `VITE_API_BASE_URL`).
 *   The suite never writes to an API.
 * - The test fails on any uncaught page error or console error, apart from the
 *   browser's own "Failed to load resource" line for a request to another host
 *   that the stubbing above refused.
 */

import { test as base, expect, type Request, type Route } from '@playwright/test';
import { existsSync, readFileSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join } from 'path';

const require = createRequire(import.meta.url);
const LEAFLET_DIST = join(dirname(require.resolve('leaflet/package.json')), 'dist');

/** A 1×1 transparent PNG, the answer to every map tile request. */
const BLANK_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
);

const TILE_HOSTS = /(^|\.)(tile\.opentopomap\.org|tile\.openstreetmap\.org|openfreemap\.org)$/;

const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
const deployed = !!process.env.BASE_URL;

function leafletFile(url: URL): { body: Buffer; contentType: string } | null {
  const match = url.pathname.match(/^\/leaflet@1\.9\.4\/dist\/([\w./-]+)$/);
  if (!match || match[1].includes('..') || !existsSync(join(LEAFLET_DIST, match[1]))) return null;
  const contentType = match[1].endsWith('.css')
    ? 'text/css'
    : match[1].endsWith('.js')
      ? 'application/javascript'
      : 'image/png';
  return { body: readFileSync(join(LEAFLET_DIST, match[1])), contentType };
}

async function handleRequest(route: Route, request: Request, siteOrigin: string): Promise<void> {
  const url = new URL(request.url());
  if (url.origin === siteOrigin) {
    if (!bypassSecret) return route.continue();
    return route.continue({
      headers: {
        ...request.headers(),
        'x-vercel-protection-bypass': bypassSecret,
        'x-vercel-set-bypass-cookie': 'true',
      },
    });
  }
  if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue();
  if (url.hostname === 'unpkg.com') {
    const file = leafletFile(url);
    if (file) {
      // The pages load it with crossorigin (SRI), so the response needs CORS.
      return route.fulfill({
        status: 200,
        body: file.body,
        contentType: file.contentType,
        headers: { 'access-control-allow-origin': '*' },
      });
    }
  }
  if (TILE_HOSTS.test(url.hostname)) {
    return route.fulfill({ status: 200, body: BLANK_PNG, contentType: 'image/png' });
  }
  if (deployed && request.method() === 'GET' && /(^|\.)api\.[\w.-]+$/.test(url.hostname)) {
    return route.continue();
  }
  return route.abort('blockedbyclient');
}

export const test = base.extend({
  page: async ({ page, baseURL }, use) => {
    const siteOrigin = new URL(baseURL!).origin;
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(`page error: ${error.message}`));
    page.on('console', message => {
      if (message.type() !== 'error') return;
      const source = message.location().url;
      const refusedElsewhere =
        message.text().startsWith('Failed to load resource') && !!source && new URL(source).origin !== siteOrigin;
      if (!refusedElsewhere) errors.push(`console error: ${message.text()}${source ? ` (${source})` : ''}`);
    });
    await page.route('**/*', (route, request) => handleRequest(route, request, siteOrigin));
    await use(page);
    expect(errors, 'the page logged errors').toEqual([]);
  },
});

export { expect };
