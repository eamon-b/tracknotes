import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import probeScript from '../../../scripts/probe-comments-api.sh?raw';
import { url } from './helpers';

/**
 * Every line of `PROBES` in scripts/probe-comments-api.sh, which the deploy
 * workflow runs against production after each deploy: a wrong expectation
 * there fails every deploy, so each one is checked against the worker here.
 */
function probes(): { want: number; path: string; why: string }[] {
  const block = /PROBES=\(\n([\s\S]*?)\n\)/.exec(probeScript)?.[1] ?? '';
  return [...block.matchAll(/^\s*"(\d{3}) (\S+) ([^"]*)"$/gm)].map((m) => ({
    want: Number(m[1]),
    path: m[2],
    why: m[3],
  }));
}

describe('scripts/probe-comments-api.sh', () => {
  it('lists the routes migrations 0003 and 0008 added', () => {
    const paths = probes().map((p) => p.path);
    expect(paths.length).toBeGreaterThanOrEqual(11);
    expect(paths).toContain('/v1/trails/heysen/descriptions');
    expect(paths).toContain('/v1/admin/reports');
    expect(paths.some((p) => /^\/v1\/admin\/users\/[^/]+\/ban$/.test(p))).toBe(true);
    expect(paths.some((p) => /^\/v1\/admin\/comments\/[^/]+\/restore$/.test(p))).toBe(true);
  });

  for (const { want, path, why } of probes()) {
    it(`GET ${path} answers ${want} (${why})`, async () => {
      const res = await SELF.fetch(url(path));
      expect(res.status).toBe(want);
      await res.arrayBuffer();
    });
  }

  it('answers 404, not 405, for a path no route has', async () => {
    const res = await SELF.fetch(url('/v1/admin/users/00000000-0000-4000-8000-000000000000/nope'));
    expect(res.status).toBe(404);
  });
});
