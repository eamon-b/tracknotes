/** Types for http-mbtiles.mjs (plain JavaScript so e2e-tile-check.mjs runs without a build). */

/** Bytes [start, end] inclusive of the file. */
export type RangeReader = (start: number, end: number) => Promise<Uint8Array>;

export type RecordValue = null | number | string | Uint8Array;

export const ATTEMPT_TIMEOUT_MS: number;
export const MAX_RETRY_AFTER_MS: number;

export interface RetryOptions {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** The clock `deadline` is read on. */
  now?: () => number;
  /** Per attempt, headers and body; 0 for none. */
  attemptTimeoutMs?: number;
  /** A `now()` after which no retry starts, nor a wait that would end past it. */
  deadline?: number;
}

export function isTransientFetchError(error: unknown): boolean;
export function fetchWithRetries<T>(
  url: string,
  options: RetryOptions & { headers?: Record<string, string>; describe?: string; retryIgnoredRange?: boolean },
  read: (res: Response, attempts: number) => Promise<T>
): Promise<T>;
export function httpRangeReader(
  url: string,
  fetchFn?: typeof fetch,
  sleep?: (ms: number) => Promise<void>,
  options?: Omit<RetryOptions, 'fetchFn' | 'sleep'>
): RangeReader;
export function readPrefix(res: Response, n: number): Promise<Uint8Array>;
export function parseRecord(payload: Uint8Array): RecordValue[];
export function tableColumns(sql: string): Array<{ name: string; rowidAlias: boolean }>;
export function indexColumns(sql: string): string[];
export function readZoomTiles(
  read: RangeReader,
  zoom: number
): Promise<Array<{ x: number; y: number; data: Uint8Array }>>;
