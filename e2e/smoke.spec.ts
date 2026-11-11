/**
 * Smoke tests: one per page family, each asserting the page did its main job
 * in a real browser. Keep this file small — the jsdom page suites in
 * `src/web/*.test.ts` own the detail; these catch what jsdom cannot (the
 * production bundle, real Leaflet and canvas, IndexedDB, page-to-page links).
 * `./fixtures` stubs the network and fails a test on any page/console error.
 */

import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';

/** Small curated trails with stable data: the viewer and the planner tests use them. */
const VIEWER_TRAIL = 'cape_to_cape';
const PLAN_TRAIL = 'larapinta';

/**
 * The route is drawn as SVG polylines (`M … L … L …`); a circle marker is arcs
 * with no `L`. Wait for a path with a few line segments — Leaflet simplifies
 * the line to the zoom, so even a long trail can be only a handful.
 */
async function expectRouteDrawn(page: Page): Promise<void> {
  const map = page.locator('#trail-map');
  await expect(map.locator('.leaflet-overlay-pane path').first()).toBeAttached();
  await expect
    .poll(() =>
      map
        .locator('.leaflet-overlay-pane path')
        .evaluateAll(paths => Math.max(0, ...paths.map(p => (p.getAttribute('d') ?? '').split('L').length - 1)))
    )
    .toBeGreaterThanOrEqual(2);
}

/** The elevation profile is a canvas: it has a size and some painted pixels. */
async function expectProfileDrawn(page: Page): Promise<void> {
  const canvas = page.locator('#elevation-canvas');
  await expect(canvas).toBeVisible();
  await expect
    .poll(() =>
      canvas.evaluate((el: HTMLCanvasElement) => {
        if (el.width === 0 || el.height === 0) return 0;
        const data = el.getContext('2d')!.getImageData(0, 0, el.width, el.height).data;
        let painted = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) painted++;
        return painted;
      })
    )
    .toBeGreaterThan(100);
}

test('the landing page lists every curated trail', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByRole('heading', { level: 1, name: 'Tracknotes' })).toBeVisible();

  const trails = await page.evaluate(async () => {
    const response = await fetch('data/generated/index.json');
    return (await response.json()) as { id: string; name: string }[];
  });
  expect(trails.length).toBeGreaterThan(0);

  const list = page.locator('#curated-section');
  for (const trail of trails) {
    await expect(list.locator(`a[href="./trails/${encodeURIComponent(trail.id)}/"]`)).toContainText(trail.name);
  }
});

test('a trail page draws the route on the map and the elevation profile', async ({ page }) => {
  await page.goto(`trails/${VIEWER_TRAIL}/`);
  await expect(page.locator('#distance')).not.toHaveText('--');
  await expectRouteDrawn(page);
  await expectProfileDrawn(page);
  // The datasheet filled in too.
  await expect(page.locator('#waypoints-container tbody tr').first()).toBeVisible();
});

test('the plan page suggests days and shows them as day cards', async ({ page }) => {
  await page.goto(`trails/${PLAN_TRAIL}/plan.html`);
  // `#save-status` reads "Saved" in the markup, so the proof of a save is the
  // stored document: no stops before, the plan's stops after.
  const storedStops = () =>
    page.evaluate(trailId => {
      const raw = localStorage.getItem(`trail-plan-doc-${trailId}`);
      return raw ? ((JSON.parse(raw) as { stops?: unknown[] }).stops?.length ?? 0) : 0;
    }, PLAN_TRAIL);
  expect(await storedStops()).toBe(0);
  await page.getByRole('button', { name: 'Suggest plans' }).click();
  await page.getByRole('button', { name: 'Use this plan' }).first().click();

  const firstDay = page.locator('#days-list .day-card[data-day-index="0"]');
  await expect(firstDay).toContainText('Day 1');
  await expect(firstDay).toContainText(/\d+(\.\d)? km/);
  await expect.poll(storedStops).toBeGreaterThan(0);
  await expect(page.locator('#save-status')).toHaveText('Saved');
});

test('a GPX imported on the upload page opens as a trail page', async ({ page }) => {
  await page.goto('upload.html');
  await page.locator('#file-input').setInputFiles('tests/fixtures/gpx/terminus-trail.gpx');

  await expect(page.getByLabel('Trail name')).toHaveValue('Terminus Test Trail');
  await page.getByRole('button', { name: 'Save trail' }).click();
  await page.getByRole('link', { name: 'Open trail page' }).click();

  await expect(page).toHaveURL(/my-trail\.html\?id=u_/);
  await expect(page.getByRole('heading', { level: 1, name: 'Terminus Test Trail' })).toBeVisible();
  await expect(page.locator('#distance')).toHaveText('12.6');
  await expectRouteDrawn(page);
  await expect(page.getByRole('cell', { name: 'Campsite One' })).toBeVisible();
});
