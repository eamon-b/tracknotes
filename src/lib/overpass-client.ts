/**
 * Direct Overpass API access: a `POIFetcher` that sends one corridor query,
 * retries the "come back later" answers, and spaces its requests.
 *
 * Ported from `gpx-tools/lib/overpass-client` alongside `./osm-poi` (see there
 * for why). Runtime-neutral: only global `fetch`, `AbortController` and
 * timers, so Node scripts, the browser and React Native all run it.
 */

import {
  buildOverpassQuery,
  isTransientOverpassError,
  normalizeOverpassElements,
  overpassPayloadError,
  type OverpassArea,
  type OverpassElement,
  type POI,
  type POIType,
} from './osm-poi';

/** Overpass etiquette asks clients to identify themselves. */
const DEFAULT_USER_AGENT = 'gpx-tools/2.0 (+https://github.com/eamon-b/gpx-tools)';

/** The main public instance, and the default when no endpoint is given. */
export const DEFAULT_OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';

/**
 * Ceiling on a server-supplied Retry-After: Overpass occasionally answers with
 * a delay measured in hours.
 */
const MAX_RETRY_AFTER_MS = 120_000;

export interface OverpassFetcherOptions {
  /** Overpass instance. Default the main public endpoint. */
  endpoint?: string;
  /** Injectable fetch, for tests or for a custom agent. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Minimum gap between request starts. Default 2000 ms. */
  minDelayMs?: number;
  /** Overpass `[timeout:]` in seconds. The HTTP abort fires 5 s later. Default 22. */
  timeoutSeconds?: number;
  /** Retries after a retryable failure. Default 2, exponential backoff, honours Retry-After. */
  maxRetries?: number;
  /** `User-Agent` sent with every request (a browser drops it). */
  userAgent?: string;
  /**
   * Called with the response body's length in characters once it has been
   * read — what the phone reports as data used. Optional.
   */
  onResponseBytes?: (bytes: number) => void;
}

/** How a caller obtains POIs for an area. */
export type POIFetcher = (area: OverpassArea, types: POIType[], signal?: AbortSignal) => Promise<POI[]>;

function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

/** Sleep that rejects with an AbortError as soon as `signal` fires. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!(ms > 0)) {
    return signal?.aborted ? Promise.reject(abortError()) : Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Parse a Retry-After header (delta-seconds or HTTP-date) into milliseconds,
 * clamped. Null — "use the caller's own backoff" — for anything unusable,
 * including zero or a past date.
 */
function parseRetryAfter(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const clamp = (ms: number): number | null => (ms > 0 ? Math.min(ms, MAX_RETRY_AFTER_MS) : null);
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return clamp(seconds * 1000);
  }
  const when = Date.parse(value);
  if (Number.isFinite(when)) {
    return clamp(when - Date.now());
  }
  return null;
}

/**
 * Create a POIFetcher that queries Overpass directly.
 *
 * Requests are serialised through an internal queue and spaced by
 * `minDelayMs`: Overpass allocates very few slots per source IP, so parallel
 * queries mostly earn 429s rather than finishing sooner.
 */
export function createOverpassFetcher(opts: OverpassFetcherOptions = {}): POIFetcher {
  const endpoint = opts.endpoint ?? DEFAULT_OVERPASS_ENDPOINT;
  const doFetch = opts.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const minDelayMs = opts.minDelayMs ?? 2000;
  const timeoutSeconds = opts.timeoutSeconds ?? 22;
  const maxRetries = opts.maxRetries ?? 2;
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
  // Overpass's full server-side budget plus slack for the transfer.
  const httpTimeoutMs = (timeoutSeconds + 5) * 1000;

  let queue: Promise<unknown> = Promise.resolve();
  let lastStart = -Infinity;

  const runOne = async (area: OverpassArea, types: POIType[], signal?: AbortSignal): Promise<POI[]> => {
    const query = buildOverpassQuery(area, types, { timeoutSeconds });
    let lastError: Error = new Error('Overpass request failed');

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (signal?.aborted) {
        throw abortError();
      }

      const wait = lastStart + minDelayMs - Date.now();
      if (wait > 0) {
        await delay(wait, signal);
      }
      lastStart = Date.now();

      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, httpTimeoutMs);
      const onOuterAbort = (): void => controller.abort();
      signal?.addEventListener('abort', onOuterAbort, { once: true });

      /** Set when the failure must not be retried. */
      let fatal: Error | null = null;
      let retryDelayMs = minDelayMs * Math.pow(2, attempt);

      try {
        const response = await doFetch(endpoint, {
          method: 'POST',
          body: `data=${encodeURIComponent(query)}`,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': userAgent,
          },
          signal: controller.signal,
        });

        if (response.ok) {
          // A 200 is not automatically a result: see `overpassPayloadError`.
          let payload: unknown = null;
          try {
            if (opts.onResponseBytes && typeof response.text === 'function') {
              const text = await response.text();
              opts.onResponseBytes(text.length);
              payload = JSON.parse(text);
            } else {
              payload = await response.json();
            }
          } catch {
            payload = null;
          }
          const payloadError = overpassPayloadError(payload);
          if (!payloadError) {
            const data = payload as { elements?: OverpassElement[] };
            return normalizeOverpassElements(data?.elements);
          }
          lastError = new Error(`Overpass request failed: ${payloadError}`);
          if (!isTransientOverpassError(payloadError)) {
            fatal = lastError;
          }
        } else {
          lastError = new Error(`Overpass request failed: ${response.status}`);
          // 429 (no free slot) and 5xx (incl. the 504 a query outrunning its
          // timeout gets) are the "come back later" answers.
          if (response.status === 429 || response.status >= 500) {
            retryDelayMs = parseRetryAfter(response.headers?.get?.('Retry-After')) ?? retryDelayMs;
          } else {
            fatal = lastError;
          }
        }
      } catch (error) {
        if (signal?.aborted) {
          throw abortError();
        }
        lastError = timedOut
          ? new Error(`Overpass request timed out after ${httpTimeoutMs / 1000}s`)
          : (error as Error);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onOuterAbort);
      }

      if (fatal) {
        throw fatal;
      }
      if (attempt >= maxRetries) {
        break;
      }
      await delay(retryDelayMs, signal);
    }

    throw lastError;
  };

  return (area, types, signal) => {
    const result = queue.then(() => runOne(area, types, signal));
    // Keep the chain alive whatever this call does.
    queue = result.catch(() => undefined);
    return result;
  };
}

/**
 * A POIFetcher over several Overpass instances: each query tries them in turn
 * until one answers, and the next query starts with whichever answered last.
 *
 * Mirrors come and go (see `docs/architecture/build-scripts.md`), and a phone
 * on a mountain has no one to re-run a script for it, so one refused query is
 * retried elsewhere rather than left as a hole. `onEndpoint` reports which
 * instance is being asked, for the progress line. Cancellation is never
 * retried.
 */
export function createFallbackFetcher(
  fetchers: readonly { endpoint: string; fetchPOIs: POIFetcher }[],
  onEndpoint?: (endpoint: string, index: number) => void
): POIFetcher {
  if (fetchers.length === 0) {
    throw new Error('createFallbackFetcher needs at least one endpoint');
  }
  let preferred = 0;
  return async (area, types, signal) => {
    let lastError: unknown = new Error('Overpass request failed');
    for (let k = 0; k < fetchers.length; k++) {
      const index = (preferred + k) % fetchers.length;
      const { endpoint, fetchPOIs } = fetchers[index];
      if (signal?.aborted) {
        throw abortError();
      }
      onEndpoint?.(endpoint, index);
      try {
        const pois = await fetchPOIs(area, types, signal);
        preferred = index;
        return pois;
      } catch (error) {
        if (signal?.aborted) {
          throw abortError();
        }
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };
}
