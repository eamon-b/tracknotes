/**
 * The on-phone OpenStreetMap search for a GPX imported on the device.
 *
 * A bundled trail gets its POIs from the build (`scripts/fetch-pois.ts` →
 * `build-trails.ts` → `build-mobile-trails.ts`); a `.tracknotes.json` handoff
 * brings the web's. A GPX imported here had neither, so the hiker can ask the
 * phone to run the same search: the same corridor queries
 * (`@lib/trail-poi-search` `planTrailPoiSearch`, over `@lib/poi-enrichment`),
 * the same 2 km radius, and the build's passes (`finishTrailPois`: noise,
 * duplicates of the guide's own waypoints, city thinning, `slimPoi`), so the
 * result reads exactly like a bundled trail's. It is saved into the import's
 * JSON (`saveImportedTrailPois`) and so works offline from then on.
 *
 * Never started by the app: the screen (`app/guide/[trailId]/find-pois.tsx`)
 * shows the request count and a data estimate first, and runs this only when
 * asked.
 *
 * Network behaviour:
 * - Queries go one at a time, spaced by `MIN_DELAY_MS` (Overpass etiquette).
 * - Each query tries the public instances in
 *   `INTERACTIVE_OVERPASS_ENDPOINTS` in turn (`createFallbackFetcher`), so one
 *   mirror refusing does not leave a hole.
 * - A query that every instance refuses is reported as a failed area; what
 *   the others found is still saved, and `runPoiSearch({ only, previous })`
 *   retries just the failed areas and saves the union.
 * - Every query failing saves nothing and throws, so a failed search never
 *   replaces POIs a guide already has.
 * - Cancelling (the signal) throws an `AbortError` and saves nothing.
 *
 * The CPU-bound parts (planning a 100,000-point track, placing a few thousand
 * results on it, the passes) hand the thread back with `yieldToUi` between
 * slices so the progress line paints and Cancel stays tappable.
 */

import {
  INTERACTIVE_OVERPASS_ENDPOINTS,
  INTERACTIVE_TIMEOUT_SECONDS,
  finishTrailPois,
  planTrailPoiSearch,
  type FinishableTrail,
  type TrailPoiSearchPlan,
} from '@lib/trail-poi-search';
import { ALL_POI_TYPES, fetchCorridorGroups, type ChunkFailure } from '@lib/poi-enrichment';
import { createFallbackFetcher, createOverpassFetcher } from '@lib/overpass-client';
import { osmElementKey, type POI } from '@lib/osm-poi';
import type { TrailPOI } from '@lib/trail-types';

import { readImportedTrail, saveImportedTrailPois } from '../../services/imported-trail-store';
import type { TrailJson } from '../../services/trail-assets';
import { canSearchPois } from './can-search-pois';
import { yieldToUi } from './import-gpx';

/** Overpass etiquette: a slow trickle from one client, never parallel queries. */
const MIN_DELAY_MS = 2000;
/** One retry per instance before moving to the next: the next instance is the better retry. */
const MAX_RETRIES_PER_ENDPOINT = 1;
/** Overpass asks clients to identify themselves. */
const USER_AGENT = 'Tracknotes (+https://tracknotes.info)';

export { canSearchPois };

/** The trail as read from disk and the queries a search of it would send. */
export interface PoiSearchSetup {
  trailId: string;
  trail: TrailJson;
  plan: TrailPoiSearchPlan;
}

/**
 * Read the import from disk and plan its search. No request is made. Null when
 * the guide is not an import or its file is gone.
 */
export async function preparePoiSearch(trailId: string): Promise<PoiSearchSetup | null> {
  if (!canSearchPois(trailId)) return null;
  const trail = await readImportedTrail(trailId);
  if (!trail) return null;
  // Planning simplifies the whole track: give the spinner a frame first.
  await yieldToUi();
  return { trailId, trail, plan: planTrailPoiSearch(asSearchable(trail)) };
}

/**
 * An import's file is a `ProcessedTrail` written by `@lib/gpx-import`;
 * `TrailJson` is the app's looser read-side view of the same shape.
 */
function asSearchable(trail: TrailJson): FinishableTrail {
  return trail as unknown as FinishableTrail;
}

export type PoiSearchPhase = 'fetching' | 'processing' | 'saving';

export interface PoiSearchProgress {
  phase: PoiSearchPhase;
  /** 1-based query number within this run, while fetching. */
  current?: number;
  /** Queries in this run. */
  total?: number;
  /** Host of the instance being asked, while fetching. */
  host?: string;
  /** Response bytes received so far in this run (uncompressed). */
  bytes: number;
}

export interface PoiSearchRunOptions {
  signal?: AbortSignal;
  onProgress?: (progress: PoiSearchProgress) => void;
  /** Retry only these query groups (a previous run's `failures`). Default: all. */
  only?: readonly number[];
  /** Elements an earlier run of this search already fetched, kept in the union. */
  previous?: readonly POI[];
  /** Injected by tests. */
  fetchImpl?: typeof fetch;
  /** Injected by tests (and a short spacing keeps them fast). */
  endpoints?: readonly string[];
  minDelayMs?: number;
}

export interface PoiSearchRun {
  /** Every element fetched so far, this run and those it built on. */
  fetched: POI[];
  /** Query groups no instance answered, by index into the plan's groups. */
  failures: ChunkFailure[];
  /** What was saved to the guide. */
  pois: TrailPOI[];
  /** Response bytes received in this run. */
  bytes: number;
}

/** Every query of a run failed: nothing was saved. */
export class PoiSearchFailedError extends Error {
  constructor(
    message: string,
    readonly failures: ChunkFailure[],
  ) {
    super(message);
    this.name = 'PoiSearchFailedError';
  }
}

function hostOf(endpoint: string): string {
  const match = /^https?:\/\/([^/]+)/i.exec(endpoint);
  return match ? match[1] : endpoint;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Run (or continue) a search and save the result into the guide.
 *
 * Throws `AbortError` when cancelled and `PoiSearchFailedError` when no query
 * was answered — in both cases nothing on disk changed.
 */
export async function runPoiSearch(
  setup: PoiSearchSetup,
  options: PoiSearchRunOptions = {},
): Promise<PoiSearchRun> {
  const { signal, onProgress } = options;
  const endpoints = options.endpoints ?? INTERACTIVE_OVERPASS_ENDPOINTS;
  const groups = setup.plan.corridor.groups.length;
  const only = options.only ? [...options.only] : undefined;
  const asked = only ? only.length : groups;

  let bytes = 0;
  let host: string | undefined;
  let current = 0;
  const report = (phase: PoiSearchPhase): void =>
    onProgress?.({
      phase,
      current: phase === 'fetching' ? current : undefined,
      total: asked,
      host,
      bytes,
    });

  const fetchers = endpoints.map((endpoint) => ({
    endpoint,
    fetchPOIs: createOverpassFetcher({
      endpoint,
      fetch: options.fetchImpl,
      minDelayMs: options.minDelayMs ?? MIN_DELAY_MS,
      timeoutSeconds: INTERACTIVE_TIMEOUT_SECONDS,
      maxRetries: MAX_RETRIES_PER_ENDPOINT,
      userAgent: USER_AGENT,
      onResponseBytes: (n) => {
        bytes += n;
        report('fetching');
      },
    }),
  }));
  const fetchPOIs = createFallbackFetcher(fetchers, (endpoint) => {
    host = hostOf(endpoint);
    report('fetching');
  });

  if (asked === 0) {
    // Nothing to ask (a track with no usable points): saving `[]` would claim
    // a search that never happened.
    throw new PoiSearchFailedError('This route has no track points to search along.', []);
  }

  const result = await fetchCorridorGroups(setup.plan.corridor, {
    types: ALL_POI_TYPES,
    fetchPOIs,
    signal,
    only,
    onProgress: (p) => {
      current = p.current ?? current;
      report('fetching');
    },
  });

  if (result.failedChunks.length === asked) {
    const reasons = [...new Set(result.failedChunks.map((f) => f.error))];
    throw new PoiSearchFailedError(reasons.join('; '), result.failedChunks);
  }

  // The union, first answer wins — an earlier run's copy of an element is as
  // good as this run's.
  const unique = new Map<string, POI>();
  for (const poi of [...(options.previous ?? []), ...result.pois]) {
    const key = osmElementKey(poi);
    if (!unique.has(key)) unique.set(key, poi);
  }
  const fetched = [...unique.values()];

  report('processing');
  await yieldToUi();
  const pois = await finishTrailPois(setup.plan, fetched, asSearchable(setup.trail), {
    signal,
    pause: yieldToUi,
  });

  // Last chance to cancel: past this point the file is written.
  if (signal?.aborted) {
    const error = new Error('Search cancelled');
    error.name = 'AbortError';
    throw error;
  }
  report('saving');
  const saved = await saveImportedTrailPois(setup.trailId, pois);
  if (!saved) {
    throw new Error('This guide is no longer on the phone.');
  }

  return { fetched, failures: result.failedChunks, pois: saved.pois ?? pois, bytes };
}

/** Remove an import's POIs: back to "never searched". */
export async function removeSearchedPois(trailId: string): Promise<boolean> {
  return (await saveImportedTrailPois(trailId, null)) !== null;
}

export { isAbort as isPoiSearchCancelled };
