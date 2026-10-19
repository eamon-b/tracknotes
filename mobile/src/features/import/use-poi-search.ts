/**
 * State for the "Find places along this route" screen: plan → (asked) run →
 * done / partly done / failed / cancelled, with a retry of the missed areas.
 *
 * The search itself is `poi-search.ts`; this hook only sequences it, keeps the
 * elements a partial run fetched so a retry can build on them, and reads the
 * connection type so the screen can say whether the download would be on
 * mobile data. It never starts a search on its own.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import * as Network from 'expo-network';
import type { ChunkFailure } from '@lib/poi-enrichment';

import {
  PoiSearchFailedError,
  isPoiSearchCancelled,
  preparePoiSearch,
  removeSearchedPois,
  runPoiSearch,
  type PoiSearchProgress,
  type PoiSearchRun,
  type PoiSearchSetup,
} from './poi-search';

export type PoiSearchState =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; setup: PoiSearchSetup }
  | { kind: 'running'; setup: PoiSearchSetup; progress: PoiSearchProgress | null; retrying: boolean }
  | {
      kind: 'done';
      setup: PoiSearchSetup;
      run: PoiSearchRun;
      /** Set when a retry of the missed areas failed again; the earlier result still stands. */
      retryError?: string;
    }
  | { kind: 'failed'; setup: PoiSearchSetup; message: string }
  | { kind: 'cancelled'; setup: PoiSearchSetup }
  | { kind: 'removed'; setup: PoiSearchSetup };

/** What the screen says about the connection. `unknown` when the platform will not say. */
export type ConnectionKind = 'wifi' | 'cellular' | 'offline' | 'other' | 'unknown';

export function connectionKind(state: Network.NetworkState | null): ConnectionKind {
  if (!state) return 'unknown';
  if (state.isConnected === false || state.isInternetReachable === false) return 'offline';
  if (state.type === Network.NetworkStateType.WIFI || state.type === Network.NetworkStateType.ETHERNET) {
    return 'wifi';
  }
  if (state.type === Network.NetworkStateType.CELLULAR) return 'cellular';
  if (state.type === Network.NetworkStateType.NONE) return 'offline';
  return state.type === Network.NetworkStateType.UNKNOWN ? 'unknown' : 'other';
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Something went wrong.';
}

export interface UsePoiSearch {
  state: PoiSearchState;
  connection: ConnectionKind;
  start: () => void;
  retryMissed: () => void;
  cancel: () => void;
  remove: () => Promise<boolean>;
}

/**
 * `onSaved` runs after every write to the guide's file (a search, a retry or
 * a removal) — the guide re-reads its trail there.
 */
export function usePoiSearch(trailId: string, onSaved?: () => void): UsePoiSearch {
  const [state, setState] = useState<PoiSearchState>({ kind: 'loading' });
  const [connection, setConnection] = useState<ConnectionKind>('unknown');
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const onSavedRef = useRef(onSaved);
  useEffect(() => {
    onSavedRef.current = onSaved;
  }, [onSaved]);

  useEffect(() => {
    mounted.current = true;
    let live = true;
    preparePoiSearch(trailId)
      .then((setup) => {
        if (live) setState(setup ? { kind: 'ready', setup } : { kind: 'unavailable' });
      })
      .catch(() => {
        if (live) setState({ kind: 'unavailable' });
      });
    return () => {
      live = false;
      mounted.current = false;
      // Leaving the screen cancels: nothing is half-written, and nobody is
      // left watching a search they can no longer stop.
      controller.current?.abort();
    };
  }, [trailId]);

  useEffect(() => {
    let live = true;
    const read = () =>
      Network.getNetworkStateAsync()
        .then((s) => {
          if (live) setConnection(connectionKind(s));
        })
        .catch(() => {});
    void read();
    const subscription = Network.addNetworkStateListener((s) => {
      if (live) setConnection(connectionKind(s));
    });
    return () => {
      live = false;
      subscription?.remove();
    };
  }, []);

  const run = useCallback(
    (setup: PoiSearchSetup, previous: PoiSearchRun | null) => {
      if (controller.current) return;
      const ac = new AbortController();
      controller.current = ac;
      const retrying = previous !== null;
      setState({ kind: 'running', setup, progress: null, retrying });
      const only: number[] | undefined = previous?.failures.map((f: ChunkFailure) => f.chunkIndex);

      runPoiSearch(setup, {
        signal: ac.signal,
        only,
        previous: previous?.fetched,
        onProgress: (progress) => {
          if (mounted.current && !ac.signal.aborted) {
            setState({ kind: 'running', setup, progress, retrying });
          }
        },
      })
        .then((result) => {
          onSavedRef.current?.();
          if (mounted.current) setState({ kind: 'done', setup, run: result });
        })
        .catch((error: unknown) => {
          if (!mounted.current) return;
          if (ac.signal.aborted || isPoiSearchCancelled(error)) {
            // A cancelled retry leaves the earlier, saved result standing.
            setState(previous ? { kind: 'done', setup, run: previous } : { kind: 'cancelled', setup });
            return;
          }
          const message =
            error instanceof PoiSearchFailedError && error.failures.length > 0
              ? `No OpenStreetMap server answered (${error.message}).`
              : messageOf(error);
          setState(
            previous
              ? { kind: 'done', setup, run: previous, retryError: message }
              : { kind: 'failed', setup, message },
          );
        })
        .finally(() => {
          if (controller.current === ac) controller.current = null;
        });
    },
    [],
  );

  const start = useCallback(() => {
    if (state.kind === 'ready' || state.kind === 'failed' || state.kind === 'cancelled' || state.kind === 'removed' || state.kind === 'done') {
      run(state.setup, null);
    }
  }, [run, state]);

  const retryMissed = useCallback(() => {
    if (state.kind === 'done' && state.run.failures.length > 0) run(state.setup, state.run);
  }, [run, state]);

  const cancel = useCallback(() => {
    controller.current?.abort();
  }, []);

  const remove = useCallback(async () => {
    if (controller.current) return false;
    if (state.kind === 'loading' || state.kind === 'unavailable' || state.kind === 'running') return false;
    const setup = state.setup;
    const removed = await removeSearchedPois(trailId);
    if (removed) {
      onSavedRef.current?.();
      if (mounted.current) {
        setState({ kind: 'removed', setup });
      }
    }
    return removed;
  }, [state, trailId]);

  return { state, connection, start, retryMissed, cancel, remove };
}
