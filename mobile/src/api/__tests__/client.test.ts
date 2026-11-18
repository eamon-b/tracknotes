import {
  ApiError,
  DEFAULT_TIMEOUT_MS,
  NetworkError,
  UPLOAD_TIMEOUT_MS,
  apiRequest,
  apiRequestRaw,
} from '../client';

interface FakeResponseInit {
  status: number;
  body?: unknown;
  raw?: string;
}

function makeFetch(init: FakeResponseInit | (() => never)) {
  return jest.fn(async () => {
    if (typeof init === 'function') return init();
    const raw = init.raw ?? (init.body === undefined ? '' : JSON.stringify(init.body));
    return {
      ok: init.status >= 200 && init.status < 300,
      status: init.status,
      statusText: 'Status',
      text: async () => raw,
    };
  }) as unknown as typeof fetch;
}

const BASE = 'https://api.test';

describe('apiRequest', () => {
  it('parses a 2xx JSON body', async () => {
    const fetchImpl = makeFetch({ status: 200, body: { userId: 'u1' } });
    const out = await apiRequest<{ userId: string }>('/v1/me', { baseUrl: BASE, fetchImpl });
    expect(out).toEqual({ userId: 'u1' });
  });

  it('sends the bearer token and JSON body', async () => {
    const fetchImpl = makeFetch({ status: 200, body: {} });
    await apiRequest('/v1/comments/x', {
      baseUrl: BASE,
      fetchImpl,
      token: 'secret',
      method: 'PUT',
      body: { trailId: 'aawt' },
    });
    const [, init] = (fetchImpl as jest.Mock).mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer secret');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ trailId: 'aawt' });
  });

  it('maps a non-2xx error envelope to a typed ApiError', async () => {
    const fetchImpl = makeFetch({
      status: 400,
      body: { error: { code: 'invalid_text', message: 'too long' } },
    });
    expect.assertions(3);
    try {
      await apiRequest('/v1/comments/x', { baseUrl: BASE, fetchImpl, method: 'PUT', body: {} });
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(400);
      expect((e as ApiError).code).toBe('invalid_text');
    }
  });

  it('returns undefined for a 204', async () => {
    const fetchImpl = makeFetch({ status: 204 });
    const out = await apiRequest('/v1/comments/x', { baseUrl: BASE, fetchImpl, method: 'DELETE' });
    expect(out).toBeUndefined();
  });

  it('wraps a transport failure in NetworkError', async () => {
    const fetchImpl = makeFetch(() => {
      throw new Error('ECONNREFUSED');
    });
    await expect(apiRequest('/v1/me', { baseUrl: BASE, fetchImpl })).rejects.toBeInstanceOf(
      NetworkError,
    );
  });
});

describe('request timeout', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  /** A fetch that never answers (and ignores its signal, like a wedged socket). */
  const hangingFetch = () => jest.fn(() => new Promise<never>(() => {})) as unknown as typeof fetch;

  async function settle<T>(
    promise: Promise<T>,
    ms: number,
  ): Promise<{ value?: T; error?: unknown }> {
    const outcome = promise.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await jest.advanceTimersByTimeAsync(ms);
    return outcome;
  }

  it('fails a hung request as a NetworkError after the default timeout', async () => {
    const fetchImpl = hangingFetch();
    let settled = false;
    const pending = apiRequest('/v1/sync', { baseUrl: BASE, fetchImpl }).finally(() => {
      settled = true;
    });
    await jest.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    const { error } = await settle(pending, 1);
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as Error).message).toMatch(/timed out/);
    // The fetch was handed the abort signal, so a real fetch cancels the socket.
    const [, init] = (fetchImpl as jest.Mock).mock.calls[0];
    expect(init.signal.aborted).toBe(true);
  });

  it('covers a body that never finishes arriving', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: () => new Promise<string>(() => {}),
    })) as unknown as typeof fetch;
    const { error } = await settle(
      apiRequest('/v1/sync', { baseUrl: BASE, fetchImpl }),
      DEFAULT_TIMEOUT_MS,
    );
    expect(error).toBeInstanceOf(NetworkError);
  });

  it('honours a per-request timeoutMs', async () => {
    const { error } = await settle(
      apiRequest('/v1/sync', { baseUrl: BASE, fetchImpl: hangingFetch(), timeoutMs: 50 }),
      50,
    );
    expect(error).toBeInstanceOf(NetworkError);
  });

  it('gives photo uploads the longer upload timeout', async () => {
    let settled = false;
    const pending = apiRequestRaw('/v1/comments/c/photos', {
      baseUrl: BASE,
      fetchImpl: hangingFetch(),
      body: new Uint8Array([1]),
      contentType: 'image/jpeg',
    }).finally(() => {
      settled = true;
    });
    pending.catch(() => undefined);
    await jest.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS);
    expect(settled).toBe(false);
    const { error } = await settle(pending, UPLOAD_TIMEOUT_MS - DEFAULT_TIMEOUT_MS);
    expect(error).toBeInstanceOf(NetworkError);
  });

  it('applies no timeout when the caller passes its own signal', async () => {
    const controller = new AbortController();
    let settled = false;
    const pending = apiRequest('/v1/sync', {
      baseUrl: BASE,
      fetchImpl: hangingFetch(),
      signal: controller.signal,
    }).finally(() => {
      settled = true;
    });
    pending.catch(() => undefined);
    await jest.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS * 2);
    expect(settled).toBe(false);
    controller.abort();
    const { error } = await settle(pending, 0);
    expect(error).toBeInstanceOf(NetworkError);
  });

  it('clears its timer when the request answers', async () => {
    await apiRequest('/v1/me', { baseUrl: BASE, fetchImpl: makeFetch({ status: 204 }) });
    expect(jest.getTimerCount()).toBe(0);
  });
});
