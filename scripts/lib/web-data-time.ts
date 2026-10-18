/**
 * The data time the web build stamps on each trail (`ProcessedTrail.dataUpdatedAt`),
 * which the plan page writes on every plan it saves (`PlanDocument.dataUpdatedAt`).
 * Kept apart from `build-trails.ts`, which runs on import, so it can be tested.
 */

import * as fs from 'fs';
import type { ProcessedTrail } from '../../src/lib/trail-types.js';
import { digestTrailFile } from './trail-data-catalog.js';
import { mobileTrailFile, type TrailJson as MobileTrailJson } from '../build-mobile-trails.js';

/** A trail's entry in the app's committed trail index: its file's md5 and data time. */
export interface AppIndexEntry {
  md5: string;
  updatedAt: string;
}

/** The app's committed trail index (`mobile/assets/trails/index.json`), by id. Empty when it is unreadable. */
export function readAppIndex(indexPath: string): Map<string, AppIndexEntry> {
  const entries = new Map<string, AppIndexEntry>();
  try {
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as unknown;
    if (!Array.isArray(index)) return entries;
    for (const entry of index as Array<{ id?: unknown; md5?: unknown; updatedAt?: unknown }>) {
      if (typeof entry?.id === 'string' && typeof entry.md5 === 'string' && typeof entry.updatedAt === 'string') {
        entries.set(entry.id, { md5: entry.md5, updatedAt: entry.updatedAt });
      }
    }
  } catch {
    // No app index (a checkout without mobile/): every trail is stamped with the build time.
  }
  return entries;
}

/**
 * The data time to stamp plans made on this trail's page with
 * (`ProcessedTrail.dataUpdatedAt`, `PlanDocument.dataUpdatedAt`) — the clock
 * the page and the phone compare to tell whose data is newer.
 *
 * When the app's committed file for the trail is exactly what this build's
 * data makes, the page's data *is* that copy, so it takes the index's
 * `updatedAt`. Otherwise the page has data no app copy has yet (a waypoint
 * moved, a `te-araroa-data` bump, without `build:mobile-trails`), and taking
 * the old copy's time would make different data look equally current — a
 * phone on the old copy would move the stops back. It takes the build time
 * instead: later than the copy it differs from, and earlier than the
 * `updatedAt` the app's next build of this data will get.
 */
export function webDataTime(processed: ProcessedTrail, app: AppIndexEntry | undefined, buildTime: string): string {
  if (!app) return buildTime;
  // The app build reads this JSON back from disk, so it is hashed the same way.
  const asWritten = JSON.parse(JSON.stringify(processed)) as MobileTrailJson;
  const { md5 } = digestTrailFile(mobileTrailFile(processed.config.id, asWritten).json);
  return md5 === app.md5 ? app.updatedAt : buildTime;
}
