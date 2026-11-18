/**
 * Small pure helpers shared by every web page and the trail, plan and resupply
 * viewers: the one `escapeHtml` they all use, query parameters, the site-root
 * and data URLs.
 *
 * Deliberately DOM-free so they can be unit-tested directly and used before the
 * document exists.
 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escape a value for interpolation into HTML.
 *
 * Every user-supplied string on these pages (trail names above all) goes
 * through here before it reaches `innerHTML`. Quotes are escaped too, so the
 * result is also safe inside a double- or single-quoted attribute value.
 *
 * `null`/`undefined` become the empty string rather than the literal text
 * "null", which is what you want for optional fields.
 */
export function escapeHtml(value: unknown): string {
  if (value == null) return '';
  return String(value).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

/**
 * Read one query-string parameter.
 *
 * @param search  A location search string, with or without the leading `?`.
 * @returns The decoded value, or null when the parameter is absent or empty.
 */
export function getQueryParam(search: string, name: string): string | null {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const value = params.get(name);
  return value === null || value === '' ? null : value;
}

/** Format a distance in km for display (one decimal place). */
export function formatKm(km: number): string {
  return Number.isFinite(km) ? km.toFixed(1) : '—';
}

/**
 * A page's relative path back to the site root. A trail's own pages live in
 * `trails/<id>/` (`index.html`, `plan.html`, `climate.html`); the import and
 * shared-plan pages sit at the top level beside `index.html`.
 */
export const SITE_ROOT = { topLevel: './', trailPage: '../../' } as const;

/**
 * The URL of one of the site's generated data files, for `fetch`.
 *
 * Relative to the page, as `index.html` fetches `./data/generated/index.json`:
 * Vite builds with `base: './'` so the site works from a sub-path
 * (`https://host/tracknotes/`), where an absolute `/data/…` misses it.
 *
 * @param file  Path under `data/generated/`, e.g. `heysen.json`.
 * @param siteRoot  The page's way back to the site root (`SITE_ROOT`).
 * @param baseUri  The page's base URL — `document.baseURI` in a page.
 */
export function generatedDataUrl(file: string, siteRoot: string, baseUri: string): string {
  return new URL(`${siteRoot}data/generated/${file}`, baseUri).href;
}

/**
 * The trail page's `?overpass=<url>` override, for trying another Overpass
 * instance while developing — or `undefined`. Here rather than in
 * `poi-enrich.ts`, which `my-trail.ts` loads lazily.
 *
 * Development builds only, and https only. In production a crafted link could
 * otherwise send the reader's route corridor (the whole shape of a trail they
 * imported, and that exists nowhere but their browser) to a host of the link
 * author's choosing the moment they press "Find points of interest".
 *
 * @param isDev  `import.meta.env.DEV` — a parameter so tests can say either.
 */
export function overpassEndpointOverride(search: string, isDev: boolean): string | undefined {
  if (!isDev) return undefined;
  const raw = getQueryParam(search, 'overpass');
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}
