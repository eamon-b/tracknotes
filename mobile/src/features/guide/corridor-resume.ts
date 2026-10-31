/**
 * Whether building a corridor pack now picks up an interrupted build, and
 * what to tell the hiker when it would not.
 *
 * A build's `.part` files resume only for the corridor they were started for
 * (`corridor-pack`'s staging key: route fingerprint + width + source); any
 * other build discards them. The Offline maps screen offers "Resume" only when
 * this says so, and shows the warning otherwise.
 */

import type { CorridorProgressRecord } from '../../services/corridor-pack';

export interface CorridorResume {
  /** Building now keeps the interrupted tiles. */
  resumable: boolean;
  /** What building now throws away; null when nothing is lost. */
  warning: string | null;
}

/**
 * @param interrupted  an interrupted build left `.part` files
 * @param progress     the corridor they hold (`readCorridorProgress`); null when unknown
 * @param bufferKm     the width chosen now
 * @param sourceVersion the route's fingerprint now
 */
export function corridorResume(
  interrupted: boolean,
  progress: CorridorProgressRecord | null,
  bufferKm: number,
  sourceVersion: string,
): CorridorResume {
  if (!interrupted) return { resumable: false, warning: null };
  if (!progress) {
    return { resumable: false, warning: 'Starting now discards the interrupted download.' };
  }
  if (progress.sourceVersion !== sourceVersion) {
    return {
      resumable: false,
      warning: 'The route has changed since the interrupted download, so starting now discards it.',
    };
  }
  if (progress.bufferKm !== bufferKm) {
    return {
      resumable: false,
      warning:
        `Starting at ${bufferKm} km discards the interrupted download at ` +
        `${progress.bufferKm} km. Choose ${progress.bufferKm} km to resume it.`,
    };
  }
  return { resumable: true, warning: null };
}
