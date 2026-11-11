/**
 * Playwright smoke suite for the web pages (`npm run test:e2e`, specs in `e2e/`).
 *
 * By default it serves the `npm run build:app` output (`dist-app/`) with
 * `vite preview` and tests that. Set `BASE_URL` to test a deployed site
 * instead (no local server is started); when `VERCEL_AUTOMATION_BYPASS_SECRET`
 * is set too, requests to that site carry Vercel's protection-bypass headers,
 * which a Preview deployment behind Vercel Authentication needs (added in
 * `e2e/fixtures.ts`, so the secret never goes to another host).
 */

import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'path';

const PORT = 4319;
const deployedUrl = process.env.BASE_URL;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // No retries: a test that needs one is flaky, and should be fixed or cut.
  retries: 0,
  // Generous for a busy machine (the trail JSON is megabytes); a passing run is seconds.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    // Trailing slash: the pages are addressed relative to it (`trails/aawt/`).
    baseURL: (deployedUrl ?? `http://127.0.0.1:${PORT}`).replace(/\/?$/, '/'),
    // A trace records request headers, so none is kept while the Vercel bypass
    // secret is in use (CI uploads the results of a failed run).
    trace: process.env.VERCEL_AUTOMATION_BYPASS_SECRET ? 'off' : 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: deployedUrl
    ? undefined
    : {
        command: `npx vite preview --outDir ${JSON.stringify(resolve(import.meta.dirname, 'dist-app'))} --port ${PORT} --strictPort --host 127.0.0.1`,
        url: `http://127.0.0.1:${PORT}/`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
