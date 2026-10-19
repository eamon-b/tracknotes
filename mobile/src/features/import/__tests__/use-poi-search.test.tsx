/**
 * The screen's state machine: nothing runs until asked, a result reloads the
 * guide, a partial result offers a retry built on what was fetched, and a
 * cancelled or failed retry leaves the saved result standing.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import * as Network from 'expo-network';
import { connectionKind, usePoiSearch, type UsePoiSearch } from '../use-poi-search';
import {
  PoiSearchFailedError,
  preparePoiSearch,
  runPoiSearch,
  type PoiSearchRun,
  type PoiSearchSetup,
} from '../poi-search';

jest.mock('expo-network', () => ({
  NetworkStateType: {
    NONE: 'NONE',
    UNKNOWN: 'UNKNOWN',
    CELLULAR: 'CELLULAR',
    WIFI: 'WIFI',
    ETHERNET: 'ETHERNET',
    OTHER: 'OTHER',
  },
  getNetworkStateAsync: jest.fn(async () => ({ type: 'CELLULAR', isConnected: true })),
  addNetworkStateListener: jest.fn(() => ({ remove: jest.fn() })),
}));

jest.mock('../poi-search', () => {
  class MockPoiSearchFailedError extends Error {
    mockFailures: unknown[];
    constructor(message: string, mockList: unknown[]) {
      super(message);
      this.mockFailures = mockList;
    }
    get failures(): unknown[] {
      return this.mockFailures;
    }
  }
  return {
    PoiSearchFailedError: MockPoiSearchFailedError,
    isPoiSearchCancelled: (e: unknown) => e instanceof Error && e.name === 'AbortError',
    preparePoiSearch: jest.fn(),
    runPoiSearch: jest.fn(),
    removeSearchedPois: jest.fn(async () => true),
  };
});

const SETUP = { trailId: 'u_x', trail: {}, plan: { estimate: { queries: 2 } } } as unknown as PoiSearchSetup;

function runResult(over: Partial<PoiSearchRun> = {}): PoiSearchRun {
  return { fetched: [], failures: [], pois: [], bytes: 10, ...over };
}

let tree: ReactTestRenderer | null = null;
const onSaved = jest.fn();

/** Let the mocked promises settle inside act(). */
async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  (preparePoiSearch as jest.Mock).mockResolvedValue(SETUP);
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
});

describe('connectionKind', () => {
  it('names the connection the download would use', () => {
    expect(connectionKind(null)).toBe('unknown');
    expect(connectionKind({ type: Network.NetworkStateType.WIFI, isConnected: true })).toBe('wifi');
    expect(connectionKind({ type: Network.NetworkStateType.CELLULAR, isConnected: true })).toBe('cellular');
    expect(connectionKind({ type: Network.NetworkStateType.WIFI, isConnected: false })).toBe('offline');
  });
});

describe('usePoiSearch', () => {
  let hook!: UsePoiSearch;
  function Probe() {
    hook = usePoiSearch('u_x', onSaved);
    return null;
  }

  async function mount() {
    await act(async () => {
      tree = TestRenderer.create(<Probe />);
    });
  }

  it('plans on open and runs nothing until asked', async () => {
    await mount();
    await flush();
    expect(hook.state.kind).toBe('ready');
    expect(hook.connection).toBe('cellular');
    expect(runPoiSearch).not.toHaveBeenCalled();
  });

  it('runs on start, then reloads the guide', async () => {
    (runPoiSearch as jest.Mock).mockResolvedValue(runResult());
    await mount();
    await flush();
    act(() => hook.start());
    await flush();
    expect(hook.state.kind).toBe('done');
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('retries only the missed areas, on top of what was fetched', async () => {
    const partial = runResult({
      failures: [{ chunkIndex: 1, error: 'Overpass request failed: 504' }],
      fetched: [{ id: 1, type: 'node', lat: 0, lon: 0, tags: {} }],
    });
    (runPoiSearch as jest.Mock).mockResolvedValueOnce(partial).mockResolvedValueOnce(runResult());
    await mount();
    await flush();
    act(() => hook.start());
    await flush();
    act(() => hook.retryMissed());
    await flush();
    expect((runPoiSearch as jest.Mock).mock.calls[1][1]).toMatchObject({
      only: [1],
      previous: partial.fetched,
    });
    expect(hook.state.kind).toBe('done');
  });

  it('keeps the saved result when a retry fails again', async () => {
    const partial = runResult({ failures: [{ chunkIndex: 0, error: 'x' }] });
    (runPoiSearch as jest.Mock)
      .mockResolvedValueOnce(partial)
      .mockRejectedValueOnce(new PoiSearchFailedError('Overpass request failed: 504', [{}] as never));
    await mount();
    await flush();
    act(() => hook.start());
    await flush();
    act(() => hook.retryMissed());
    await flush();
    expect(hook.state).toMatchObject({ kind: 'done', run: partial });
    expect(hook.state.kind === 'done' && hook.state.retryError).toMatch(/No OpenStreetMap server answered/);
  });

  it('reports a failure, and a cancel, without saving', async () => {
    (runPoiSearch as jest.Mock).mockRejectedValueOnce(new Error('Network request failed'));
    await mount();
    await flush();
    act(() => hook.start());
    await flush();
    expect(hook.state).toMatchObject({ kind: 'failed', message: 'Network request failed' });

    (runPoiSearch as jest.Mock).mockImplementationOnce(
      (_setup: unknown, opts: { signal: AbortSignal }) =>
        new Promise((_, reject) =>
          opts.signal.addEventListener('abort', () => {
            const e = new Error('Aborted');
            e.name = 'AbortError';
            reject(e);
          }),
        ),
    );
    act(() => hook.start());
    expect(hook.state.kind).toBe('running');
    act(() => hook.cancel());
    await flush();
    expect(hook.state.kind).toBe('cancelled');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('cancels a running search when the screen closes', async () => {
    let signal: AbortSignal | undefined;
    (runPoiSearch as jest.Mock).mockImplementationOnce(
      (_setup: unknown, opts: { signal: AbortSignal }) => {
        signal = opts.signal;
        return new Promise(() => {});
      },
    );
    await mount();
    await flush();
    act(() => hook.start());
    act(() => tree?.unmount());
    tree = null;
    expect(signal?.aborted).toBe(true);
  });

  it('is unavailable for a guide that cannot be searched', async () => {
    (preparePoiSearch as jest.Mock).mockResolvedValue(null);
    await mount();
    await flush();
    expect(hook.state.kind).toBe('unavailable');
  });
});
