/**
 * The plan half of a `.tracknotes.json` import: a plan carried from the web
 * lands in the phone's plan store as this device's own copy, and the
 * "is there one already?" check reads SQLite, not just a cold cache.
 *
 * The plans store and repo run for real against an in-memory database.
 */

import { serializeTrailHandoff } from '@lib/trail-handoff';
import type { PlanDocument } from '@lib/plan-types';
import type { ProcessedTrail } from '@lib/trail-types';
import { createMigratedTestDb } from '../../../db/__tests__/test-helpers';
import { getDatabase } from '../../../db/database';
import * as plansRepo from '../../../db/plans-repo';
import type { SqlDatabase } from '../../../db/sql-database';
import { usePlansStore } from '../../../state/plans-store';
import { importGpxFromUri } from '../import-gpx';
import { existingPlanFor, saveImportedPlan } from '../import-plan';

const mockFiles: Record<string, string> = {};

jest.mock('expo-file-system', () => ({
  File: jest.fn().mockImplementation((uri: string) => ({
    uri,
    get size() {
      return mockFiles[uri]?.length ?? 0;
    },
    text: jest.fn(async () => mockFiles[uri]),
  })),
}));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('../../../db/database', () => ({ getDatabase: jest.fn() }));
jest.mock('../../../services/imported-trail-store', () => ({
  saveImportedTrail: jest.fn(async () => undefined),
}));
jest.mock('../../../services/trail-data-updates', () => ({
  trailDataUpdatedAt: jest.fn(() => null),
}));
jest.mock('../../../api/uuid', () => {
  let n = 0;
  return { uuidv4: () => `uuid-${++n}` };
});

const mockGetDatabase = getDatabase as jest.Mock;

const TRAIL_ID = 'u_abc123';

const points = [
  { lat: -33.8688, lon: 151.2093, ele: 10, dist: 0 },
  { lat: -33.875, lon: 151.215, ele: 40, dist: 0.85 },
];

const trail: ProcessedTrail = {
  config: {
    id: TRAIL_ID,
    name: 'Weekend Loop',
    shortName: 'Weekend Loop',
    region: 'Imported',
    lengthKm: 0.85,
    gpxFile: '',
    source: 'imported',
  },
  track: { points, displayPoints: points, totalDistance: 0.85, totalAscent: 30, totalDescent: 0 },
  waypoints: [],
  offTrailWaypoints: [],
  alternates: [],
  sideTrips: [],
  climate: null,
  climateLocations: null,
  direction: null,
};

const webPlan: PlanDocument = {
  id: 'web-plan-id',
  trailId: TRAIL_ID,
  name: 'Easter trip',
  direction: 'SOBO',
  startDate: '2026-04-03',
  stops: [{ km: 0.5, name: 'Camp', nights: 2, note: 'Water tank' }],
  updatedAt: '2026-03-01T10:00:00.000Z',
  version: 1,
};

let db: SqlDatabase;

beforeEach(async () => {
  db = (await createMigratedTestDb()) as unknown as SqlDatabase;
  mockGetDatabase.mockResolvedValue(db);
  usePlansStore.setState({ byTrail: {}, lastError: {} });
});

describe('importGpxFromUri — a handoff with a plan', () => {
  it('returns the plan, re-keyed to the trail, beside it', async () => {
    mockFiles['file:///cache/a.tracknotes.json'] = serializeTrailHandoff(trail, {
      plan: { ...webPlan, trailId: 'u_somewhereelse' },
    });
    const imported = await importGpxFromUri('file:///cache/a.tracknotes.json', {
      fileName: 'a.tracknotes.json',
    });
    expect(imported.plan).toEqual({ ...webPlan, trailId: imported.trail.config.id });
    expect(imported.report.warnings).toEqual([]);
  });

  it('has no plan for a trail-only file', async () => {
    mockFiles['file:///cache/b.tracknotes.json'] = serializeTrailHandoff(trail);
    const imported = await importGpxFromUri('file:///cache/b.tracknotes.json', {
      fileName: 'b.tracknotes.json',
    });
    expect(imported.plan).toBeUndefined();
  });

  it('imports the trail and warns when the plan is unusable', async () => {
    const file = JSON.parse(serializeTrailHandoff(trail, { plan: webPlan })) as Record<
      string,
      unknown
    >;
    file.plan = { ...webPlan, stops: [{ km: 'far', name: 'Camp', nights: 1 }] };
    mockFiles['file:///cache/c.tracknotes.json'] = JSON.stringify(file);
    const imported = await importGpxFromUri('file:///cache/c.tracknotes.json', {
      fileName: 'c.tracknotes.json',
    });
    expect(imported.plan).toBeUndefined();
    expect(imported.trail.config.id).toBe(TRAIL_ID);
    expect(imported.report.warnings).toEqual([
      expect.stringMatching(/plan in this file could not be read/),
    ]);
  });
});

describe('saveImportedPlan', () => {
  it('stores the plan as this device’s own copy', async () => {
    const stored = await saveImportedPlan(webPlan, TRAIL_ID);

    expect(stored).toMatchObject({
      name: 'Easter trip',
      direction: 'SOBO',
      startDate: '2026-04-03',
      stops: webPlan.stops,
      trailId: TRAIL_ID,
    });
    expect(stored?.id).toMatch(/^uuid-/);
    expect(stored?.updatedAt).not.toBe(webPlan.updatedAt);
    expect(await plansRepo.getByTrail(db, TRAIL_ID)).toEqual(stored);
    expect(usePlansStore.getState().byTrail[TRAIL_ID]).toEqual(stored);
  });

  it('replaces a plan the trail already had (once the hiker said so)', async () => {
    await saveImportedPlan({ ...webPlan, name: 'Old' }, TRAIL_ID);
    await saveImportedPlan(webPlan, TRAIL_ID);
    expect((await plansRepo.getByTrail(db, TRAIL_ID))?.name).toBe('Easter trip');
  });
});

describe('existingPlanFor', () => {
  it('is null for a trail with no plan', async () => {
    expect(await existingPlanFor(TRAIL_ID)).toBeNull();
  });

  it('finds a stored plan the cache has not read yet', async () => {
    await plansRepo.upsertLocal(db, { ...webPlan, id: 'phone-plan' });
    usePlansStore.setState({ byTrail: {}, lastError: {} });
    expect((await existingPlanFor(TRAIL_ID))?.id).toBe('phone-plan');
  });
});
