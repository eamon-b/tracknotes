/**
 * Which R2 archive each `{source}` path segment serves. Kept free of runtime
 * dependencies (no pmtiles, no Workers globals) so the root test suite can
 * import the real mapping rather than a copy of it.
 *
 * The same Worker code is deployed twice (`wrangler.toml`): as the public
 * contour dataset, which runs on the defaults here, and as the app's own tile
 * Worker, whose `[env.app]` vars replace them. See `resolveSourceConfig`.
 */

/**
 * The dataset's tilesets, keyed by the `{source}` path segment. Adding one is
 * an entry here plus uploading the archive to R2 — nothing else in the Worker
 * is per-source.
 *
 * `contours` served the Australia archive until it was retired (#228); it is
 * now an alias of `world`, kept because shipped app builds request it for
 * Australian trails. contours/australia.pmtiles stays in R2 as a frozen
 * download but is no longer served here.
 */
export const SOURCES: Readonly<Record<string, string>> = {
  contours: 'contours/world.pmtiles',
  world: 'contours/world.pmtiles',
};

/** The dataset source whose health decides the top-level `ok` of /health. */
export const DEFAULT_SOURCE = 'world';

/** What one deployment serves. */
export interface SourceConfig {
  sources: Readonly<Record<string, string>>;
  /** The source whose health decides the top-level `ok` of /health. */
  defaultSource: string;
}

/** The wrangler vars that replace the dataset's defaults for a deployment. */
export interface SourceVars {
  SOURCES?: unknown;
  DEFAULT_SOURCE?: unknown;
}

const hasOwn = (record: object, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);

function isSourceMap(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const archiveKeys = Object.values(value);
  return archiveKeys.length > 0 && archiveKeys.every((key) => typeof key === 'string' && key.length > 0);
}

/**
 * The sources this deployment serves: the dataset's when neither var is set,
 * else exactly what the vars say. They come as a pair, because a default left
 * over from the dataset would not name a source of another deployment.
 *
 * A bad config throws rather than falling back: the dataset's sources are the
 * wrong archives for any deployment that set its own, so a typo must show as an
 * error, not as a Worker quietly serving something else.
 */
export function resolveSourceConfig(vars: SourceVars): SourceConfig {
  const { SOURCES: sources, DEFAULT_SOURCE: defaultSource } = vars;
  if (sources === undefined && defaultSource === undefined) {
    return { sources: SOURCES, defaultSource: DEFAULT_SOURCE };
  }
  if (!isSourceMap(sources)) {
    throw new Error('SOURCES must be a non-empty table of source name to R2 key');
  }
  if (typeof defaultSource !== 'string' || !hasOwn(sources, defaultSource)) {
    throw new Error(`DEFAULT_SOURCE must name one of SOURCES (got ${JSON.stringify(defaultSource)})`);
  }
  return { sources, defaultSource };
}

/** Own keys only, so `constructor`, `__proto__` and the like are never sources. */
export function isKnownSource(config: SourceConfig, source: string): boolean {
  return hasOwn(config.sources, source);
}

/** The R2 key a source serves, or null for an unknown source (→ 404). */
export function archiveKeyForSource(config: SourceConfig, source: string): string | null {
  return isKnownSource(config, source) ? config.sources[source] : null;
}

/**
 * The /health answer from each source's health. The top level describes the
 * deployment's default source alone, status included, so a source whose archive
 * is not uploaded yet shows as ok:false under `sources` without failing the
 * check, and no deployment's answer depends on a source it does not serve.
 */
export function healthSummary<T extends { ok: boolean }>(
  config: SourceConfig,
  sources: Record<string, T>
): { status: 200 | 503; body: T & { sources: Record<string, T> } } {
  const primary = sources[config.defaultSource];
  return { status: primary.ok ? 200 : 503, body: { ...primary, sources } };
}
