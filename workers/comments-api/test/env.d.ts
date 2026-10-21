/// <reference path="../node_modules/@cloudflare/vitest-plugin/types/cloudflare-test.d.ts" />

import type { D1Migration } from '@cloudflare/vitest-plugin';

// Augment the worker's environment with the bindings our tests rely on: the D1
// database (from wrangler.toml) and the test-only migrations array injected by
// vitest.config.ts.
declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      PHOTOS: R2Bucket;
      PHOTOS_PUBLIC_BASE: string;
      SITE_BASE: string;
      ANTHROPIC_API_KEY?: string;
      OVERPASS_ENDPOINTS?: string;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
