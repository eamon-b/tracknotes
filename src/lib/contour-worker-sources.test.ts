/**
 * The tile worker's source → R2 archive mapping, per deployment
 * (contours/worker/src/sources.ts), imported for real rather than copied.
 */

import { describe, it, expect } from 'vitest';
import {
  archiveKeyForSource,
  DEFAULT_SOURCE,
  healthSummary,
  isKnownSource,
  resolveSourceConfig,
  SOURCES,
} from '../../contours/worker/src/sources';
import { parseTilePath } from '../../contours/worker/src/tile-path';

const WORLD_KEY = 'contours/world.pmtiles';
const BASE_KEY = 'basemap/planet.pmtiles';

const dataset = resolveSourceConfig({});
/** What `[env.app]` in contours/worker/wrangler.toml sets. */
const app = resolveSourceConfig({ SOURCES: { base: BASE_KEY }, DEFAULT_SOURCE: 'base' });

describe('contour worker sources', () => {
  it('serves world from the world archive', () => {
    expect(archiveKeyForSource(dataset, 'world')).toBe(WORLD_KEY);
  });

  it('keeps contours as an alias of world for shipped app builds (#228)', () => {
    expect(archiveKeyForSource(dataset, 'contours')).toBe(WORLD_KEY);
    expect(archiveKeyForSource(dataset, 'contours')).toBe(archiveKeyForSource(dataset, 'world'));
  });

  it('leaves the app basemap to the app deployment (#269)', () => {
    expect(isKnownSource(dataset, 'base')).toBe(false);
    expect(Object.values(SOURCES)).not.toContain(BASE_KEY);
  });

  it('no longer serves the retired Australia archive', () => {
    expect(Object.values(SOURCES)).not.toContain('contours/australia.pmtiles');
  });

  it('reports /health from a source it serves', () => {
    expect(isKnownSource(dataset, DEFAULT_SOURCE)).toBe(true);
    expect(DEFAULT_SOURCE).toBe('world');
  });

  it('maps a parsed tile path to its archive', () => {
    const tile = parseTilePath('/contours/9/444/290.pbf');
    expect(tile).not.toBeNull();
    expect(archiveKeyForSource(dataset, tile!.source)).toBe(WORLD_KEY);
  });

  it('rejects unknown sources, including inherited object keys', () => {
    for (const source of ['australia', 'secret_data', 'constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(isKnownSource(dataset, source)).toBe(false);
      expect(archiveKeyForSource(dataset, source)).toBeNull();
      expect(isKnownSource(app, source)).toBe(false);
    }
  });
});

describe('a deployment with its own sources', () => {
  it('serves what its vars say and nothing of the dataset', () => {
    expect(archiveKeyForSource(app, 'base')).toBe(BASE_KEY);
    expect(isKnownSource(app, 'world')).toBe(false);
    expect(isKnownSource(app, 'contours')).toBe(false);
    expect(app.defaultSource).toBe('base');
  });

  it('refuses a bad config rather than falling back to the dataset', () => {
    const base = { base: BASE_KEY };
    for (const vars of [
      { SOURCES: base },
      { DEFAULT_SOURCE: 'base' },
      { SOURCES: base, DEFAULT_SOURCE: 'world' },
      { SOURCES: base, DEFAULT_SOURCE: 'constructor' },
      { SOURCES: {}, DEFAULT_SOURCE: 'base' },
      { SOURCES: { base: '' }, DEFAULT_SOURCE: 'base' },
      { SOURCES: { base: 1 }, DEFAULT_SOURCE: 'base' },
      { SOURCES: '{"base":"basemap/planet.pmtiles"}', DEFAULT_SOURCE: 'base' },
    ]) {
      expect(() => resolveSourceConfig(vars)).toThrow();
    }
  });
});

describe('/health', () => {
  const down = { ok: false, error: 'Archive not found' };
  const up = { ok: true };

  it("follows the app deployment's base alone, with no world to depend on", () => {
    expect(healthSummary(app, { base: up })).toEqual({ status: 200, body: { ok: true, sources: { base: up } } });
    expect(healthSummary(app, { base: down })).toEqual({ status: 503, body: { ...down, sources: { base: down } } });
  });

  it('follows world on the dataset, whatever the other sources say', () => {
    expect(healthSummary(dataset, { world: up, contours: down }).status).toBe(200);
    expect(healthSummary(dataset, { world: down, contours: up }).status).toBe(503);
  });
});
