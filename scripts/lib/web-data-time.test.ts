/**
 * The web build's data time: the app index's `updatedAt` only while the app's
 * committed file is exactly this build's data, the build time otherwise — or a
 * page with newer data would look as current as a phone on the old copy, and
 * the two would move a plan's stops back and forth (PR 180 review).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { digestTrailFile } from './trail-data-catalog.js';
import { mobileTrailFile } from '../build-mobile-trails.js';
import { readAppIndex, webDataTime } from './web-data-time.js';
import type { ProcessedTrail } from '../../src/lib/trail-types.js';

const BUILD_TIME = '2026-10-18T05:00:00.000Z';
const APP_TIME = '2026-10-17T00:01:47.265Z';

function trail(campKm: number): ProcessedTrail {
  const points = [
    { lat: -34, lon: 138, ele: 100, dist: 0 },
    { lat: -34.05, lon: 138.05, ele: 150, dist: 5 },
    { lat: -34.1, lon: 138.1, ele: 120, dist: 10 },
  ];
  return {
    config: { id: 'fixture', name: 'Fixture' },
    track: { points, displayPoints: points, totalDistance: 10, totalAscent: 50, totalDescent: 30 },
    waypoints: [{ id: 'w_camp', name: 'Camp', type: 'campsite', lat: -34.05, lon: 138.05, totalDistance: campKm }],
    offTrailWaypoints: [],
    alternates: [],
    sideTrips: [],
    climate: null,
    climateLocations: null,
    direction: null,
  } as unknown as ProcessedTrail;
}

/** The md5 `build-mobile-trails.ts` would record for this trail. */
const appMd5 = (t: ProcessedTrail): string =>
  digestTrailFile(mobileTrailFile('fixture', JSON.parse(JSON.stringify(t))).json).md5;

describe('webDataTime', () => {
  it("takes the app copy's time when the app copy is this build's data", () => {
    const built = trail(5);
    expect(webDataTime(built, { md5: appMd5(trail(5)), updatedAt: APP_TIME }, BUILD_TIME)).toBe(APP_TIME);
  });

  it('takes the build time when the data has moved past the app copy', () => {
    // The camp moved since the app's files were built.
    expect(webDataTime(trail(6), { md5: appMd5(trail(5)), updatedAt: APP_TIME }, BUILD_TIME)).toBe(BUILD_TIME);
  });

  it('takes the build time for a trail the app does not carry', () => {
    expect(webDataTime(trail(5), undefined, BUILD_TIME)).toBe(BUILD_TIME);
  });

  it('ignores a data time already on the trail (the app file never carries it)', () => {
    const stamped = { ...trail(5), dataUpdatedAt: '2020-01-01T00:00:00.000Z' };
    expect(webDataTime(stamped, { md5: appMd5(trail(5)), updatedAt: APP_TIME }, BUILD_TIME)).toBe(APP_TIME);
  });
});

describe('readAppIndex', () => {
  it('reads each entry with an md5 and a time, and is empty for a missing file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-index-'));
    const file = path.join(dir, 'index.json');
    fs.writeFileSync(
      file,
      JSON.stringify([
        { id: 'a', md5: 'x'.repeat(32), updatedAt: APP_TIME },
        { id: 'b', updatedAt: APP_TIME },
      ])
    );
    expect([...readAppIndex(file)]).toEqual([['a', { md5: 'x'.repeat(32), updatedAt: APP_TIME }]]);
    expect(readAppIndex(path.join(dir, 'missing.json')).size).toBe(0);
  });
});
