import { afterEach, describe, expect, it, vi } from 'vitest';
import { debounce, loadGeneratedTrail, niceAxisTicks } from './viewer-utils';

describe('niceAxisTicks', () => {
  it('steps on 1, 2 or 5 times a power of ten', () => {
    expect(niceAxisTicks(0, 100, 5)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceAxisTicks(0, 1000, 5)).toEqual([0, 200, 400, 600, 800, 1000]);
    expect(niceAxisTicks(130, 870, 5)).toEqual([200, 400, 600, 800]);
    expect(niceAxisTicks(0, 0.7, 5)).toEqual([0, 0.2, 0.4, 0.6]);
  });

  it('gives the one value for an empty range', () => {
    expect(niceAxisTicks(5, 5, 5)).toEqual([5]);
  });
});

describe('debounce', () => {
  afterEach(() => vi.useRealTimers());

  it('runs once, after the last call, with its arguments', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const run = debounce(fn as (...args: unknown[]) => void, 100);
    run(1);
    vi.advanceTimersByTime(50);
    run(2);
    vi.advanceTimersByTime(99);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(2);
  });
});

describe('loadGeneratedTrail', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('fetches the JSON relative to a trail page', async () => {
    window.history.replaceState({}, '', '/sub/trails/heysen/plan.html');
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ config: { id: 'heysen' } }) }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(loadGeneratedTrail('heysen')).resolves.toEqual({ config: { id: 'heysen' } });
    expect(fetchMock).toHaveBeenCalledWith(new URL('/sub/data/generated/heysen.json', window.location.href).href);
  });

  it('is null when the file is missing or the fetch fails', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }))
    );
    await expect(loadGeneratedTrail('nope')).resolves.toBeNull();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('offline');
      })
    );
    await expect(loadGeneratedTrail('nope')).resolves.toBeNull();
    quiet.mockRestore();
  });
});
