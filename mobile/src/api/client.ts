/**
 * Thin typed fetch wrapper for the comments API.
 *
 * Two failure modes are kept distinct because the offline-first sync layer
 * treats them very differently:
 *   - `NetworkError` — the request never got an HTTP response (offline, DNS,
 *     reset). The outbox drain should STOP and retry later.
 *   - `ApiError` — the server answered with a non-2xx status. Carries the
 *     structured `{ status, code, message }` so callers can branch on 401
 *     (pause the queue) vs. 4xx validation (mark the item failed, keep it
 *     visible) vs. transient 5xx.
 *
 * The base URL is resolved from `EXPO_PUBLIC_API_BASE_URL`; when it is missing
 * (common in dev) the comments UI shows an "unconfigured" state and sync
 * no-ops, so callers should check `getBaseUrl()` before issuing requests rather
 * than relying on this module to guess.
 */

import type { ApiError as ApiErrorBody } from '@lib/comments-api-types';

/** A structured non-2xx response from the API. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /**
   * The decoded response body, when there was one.
   *
   * The error envelope itself is already unpacked into `code`/`message`; this
   * keeps the fields that ride ALONGSIDE it, which some 409s need to be
   * recoverable rather than merely reportable — `PUT /v1/plans/:id` answers
   * `plan_exists` with the `existingId` the client is meant to adopt, and
   * dropping it would strand the plan (see `api/plans.planExistsId`).
   */
  readonly body?: unknown;

  constructor(status: number, code: string, message: string, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/** A request that never received an HTTP response (offline / transport error). */
export class NetworkError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

/** Injectable fetch, structurally compatible with the global. */
export type FetchLike = typeof fetch;

export interface RequestConfig {
  /** Resolved API base URL, e.g. `http://localhost:8787`. No trailing slash. */
  baseUrl: string;
  /** Bearer token for authenticated endpoints. */
  token?: string;
  /** Test seam — defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /**
   * Abort signal. When given, the caller owns the request's lifetime and no
   * timeout is applied; when omitted, the request is aborted after
   * `timeoutMs` and fails as a `NetworkError`.
   */
  signal?: AbortSignal;
  /**
   * How long a request may take, body included, before it is aborted (only
   * when no `signal` is passed). Defaults to {@link DEFAULT_TIMEOUT_MS}; the
   * raw (photo upload) path defaults to {@link UPLOAD_TIMEOUT_MS}.
   */
  timeoutMs?: number;
  /**
   * Fetch cache mode. `'no-store'` for reads whose answer decides something
   * destructive or user-visible right now (the community list and its
   * per-route probes): RN's fetch adds a cache-busting query parameter for it,
   * so neither the OS HTTP cache nor an edge copy can answer with a stale body.
   */
  cache?: RequestCache;
}

export interface RequestOptions extends RequestConfig {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** JSON request body; serialized with `JSON.stringify`. */
  body?: unknown;
}

/**
 * Default request timeout. Without one, a request the network swallows (a
 * captive portal, a dead NAT mapping) never settles, and the single-flight
 * guards it runs under (`activeDrain`, `activePlansPull`, `activeSync`) stay
 * held until the app restarts.
 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Photo uploads carry megabytes over trail-side connections: give them longer. */
export const UPLOAD_TIMEOUT_MS = 120_000;

/** The configured API base URL, or `undefined` when unset. */
export function getBaseUrl(): string | undefined {
  const raw = process.env.EXPO_PUBLIC_API_BASE_URL;
  if (!raw) return undefined;
  return raw.replace(/\/+$/, '');
}

/** True when the API is configured and requests can be issued. */
export function isApiConfigured(): boolean {
  return getBaseUrl() !== undefined;
}

/** A `fetch`-shaped response, structurally what both the global and mocks return. */
type ResponseLike = {
  ok: boolean;
  status: number;
  statusText?: string;
  text: () => Promise<string>;
};

/**
 * Decode a response body as JSON, mapping non-2xx statuses to `ApiError`.
 * Shared by the JSON and raw-bytes request paths. Returns `undefined` for 204s.
 * `readBody` reads the text (under the request's timeout); its failure is
 * thrown as it comes, for the caller to map.
 */
async function decodeResponse<T>(
  response: ResponseLike,
  readBody: () => Promise<string>,
): Promise<T> {
  if (response.status === 204) {
    return undefined as T;
  }

  const raw = await readBody();
  let parsed: unknown;
  if (raw.length > 0) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A body that isn't JSON on an error status is still an error.
      if (!response.ok) {
        throw new ApiError(response.status, 'http_error', raw || response.statusText || '');
      }
      throw new ApiError(response.status, 'invalid_response', 'Response body was not valid JSON');
    }
  }

  if (!response.ok) {
    const errBody = parsed as ApiErrorBody | undefined;
    const code = errBody?.error?.code ?? 'http_error';
    const message = errBody?.error?.message ?? response.statusText ?? 'Request failed';
    throw new ApiError(response.status, code, message, parsed);
  }

  return parsed as T;
}

/**
 * `promise`, or a rejection as soon as `signal` aborts — whichever comes first.
 * The race makes the timeout hold even for a fetch (or a body read) that does
 * not itself honour the signal.
 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('Request aborted'));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort);
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Fetch `url` and decode the response, under the caller's `signal` or, when
 * there is none, a timeout of `timeoutMs` that covers the response body too.
 * A transport failure, an abort or the timeout is a `NetworkError` — the sync
 * layer's "stop and retry later" — and an HTTP error status an `ApiError`.
 *
 * An `AbortController` + `setTimeout` rather than `AbortSignal.timeout`, which
 * Hermes does not reliably provide.
 */
async function send<T>(
  path: string,
  url: string,
  fetchImpl: FetchLike | undefined,
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
  init: RequestInit,
): Promise<T> {
  const doFetch = fetchImpl ?? fetch;
  // The caller's own signal wins: it decides when the request is abandoned.
  const controller = callerSignal ? undefined : new AbortController();
  const signal = callerSignal ?? controller?.signal;
  let timedOut = false;
  const timer = controller
    ? setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs)
    : undefined;
  const failure = (cause: unknown) =>
    new NetworkError(
      timedOut
        ? `Request to ${path} timed out after ${timeoutMs} ms`
        : `Request to ${path} failed to reach the server`,
      cause,
    );

  try {
    let response: Response;
    try {
      response = await untilAborted(doFetch(url, { ...init, signal }), signal);
    } catch (cause) {
      throw failure(cause);
    }
    return await decodeResponse<T>(response, async () => {
      try {
        return await untilAborted(response.text(), signal);
      } catch (cause) {
        throw failure(cause);
      }
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Issue a request and decode JSON. Throws `NetworkError` on transport failure
 * or timeout and `ApiError` on any non-2xx response. Returns `undefined` for 204s.
 */
export async function apiRequest<T>(path: string, options: RequestOptions): Promise<T> {
  const { baseUrl, token, fetchImpl, signal, cache, timeoutMs, method = 'GET', body } = options;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  return send<T>(path, `${baseUrl}${path}`, fetchImpl, signal, timeoutMs ?? DEFAULT_TIMEOUT_MS, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    ...(cache ? { cache } : {}),
  });
}

export interface RawRequestOptions extends RequestConfig {
  method?: 'POST' | 'PUT';
  /** Raw request bytes sent verbatim as the body. */
  body: Uint8Array | ArrayBuffer;
  /** Value for the `Content-Type` header (e.g. `image/jpeg`). */
  contentType: string;
}

/**
 * Issue a request whose body is raw bytes (not JSON) under an explicit
 * `Content-Type`, decoding a JSON response. Used by the photo-upload endpoint,
 * which takes the image bytes directly. Same error contract as `apiRequest`,
 * with the longer {@link UPLOAD_TIMEOUT_MS} by default.
 */
export async function apiRequestRaw<T>(path: string, options: RawRequestOptions): Promise<T> {
  const {
    baseUrl,
    token,
    fetchImpl,
    signal,
    timeoutMs,
    method = 'POST',
    body,
    contentType,
  } = options;

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': contentType,
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  return send<T>(path, `${baseUrl}${path}`, fetchImpl, signal, timeoutMs ?? UPLOAD_TIMEOUT_MS, {
    method,
    headers,
    // RN's fetch accepts a typed-array/ArrayBuffer body; cast for the DOM types.
    body: body as unknown as BodyInit,
  });
}
