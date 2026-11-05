/**
 * The Plan screen's export: the text comes from `@lib/plan-export` (tested
 * there); this checks the file is written whole before the share sheet gets
 * its URI, and that a calendar without a start date is never shared.
 */

import * as Sharing from 'expo-sharing';
import type { PlanExportInput } from '@lib/plan-export';
import { buildPlanExport, sharePlanExport } from '../plan-export-share';

const mockDisk = new Map<string, string>();

jest.mock('expo-file-system', () => {
  class MockDirectory {
    uri: string;
    constructor(parent: { uri: string }, name: string) {
      this.uri = `${parent.uri}/${name}`;
    }
    get exists() {
      return [...mockDisk.keys()].some((path) => path.startsWith(`${this.uri}/`));
    }
    delete() {
      for (const path of [...mockDisk.keys()]) {
        if (path.startsWith(`${this.uri}/`)) mockDisk.delete(path);
      }
    }
    create() {}
  }
  class MockFile {
    uri: string;
    constructor(dir: { uri: string }, name: string) {
      this.uri = `${dir.uri}/${name}`;
    }
    writeSync(contents: string) {
      mockDisk.set(this.uri, contents);
    }
  }
  return { Directory: MockDirectory, File: MockFile, Paths: { cache: { uri: 'file:///cache' } } };
});

jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(),
  shareAsync: jest.fn(),
}));

const mockShare = Sharing.shareAsync as jest.Mock;
const mockAvailable = Sharing.isAvailableAsync as jest.Mock;

function input(startDate: string | null): PlanExportInput {
  const points = Array.from({ length: 11 }, (_, i) => ({
    lat: -35,
    lon: 149 + i * 0.01,
    ele: 100,
    dist: i,
  }));
  return {
    plan: {
      id: 'p1',
      trailId: 't1',
      name: 'Spring walk',
      direction: 'NOBO',
      startDate,
      stops: [{ waypointId: 'w_a', km: 5, name: 'Camp A', nights: 1 }],
    },
    trail: { config: { name: 'Trail' }, track: { points, totalDistance: 10 }, waypoints: [] },
    days: [
      {
        dayNumber: 1,
        ...(startDate ? { date: startDate } : {}),
        startName: 'Start',
        endName: 'Camp A',
        startKm: 0,
        endKm: 5,
        distanceKm: 5,
        ascentM: 0,
        descentM: 0,
        estimatedHours: 1.2,
        waterSources: 0,
      },
    ],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDisk.clear();
  mockAvailable.mockResolvedValue(true);
  mockShare.mockResolvedValue(undefined);
});

describe('sharePlanExport', () => {
  it('writes the GPX to the cache and shares that file', async () => {
    await sharePlanExport('gpx', input(null));
    const uri = 'file:///cache/plan-export/spring-walk.gpx';
    expect(mockDisk.get(uri)).toContain('<gpx version="1.1"');
    expect(mockShare).toHaveBeenCalledWith(
      uri,
      expect.objectContaining({ mimeType: 'application/gpx+xml' }),
    );
  });

  it('shares a calendar once there is a start date', async () => {
    await sharePlanExport('ics', input('2027-01-10'));
    const uri = 'file:///cache/plan-export/spring-walk.ics';
    expect(mockDisk.get(uri)).toContain('DTSTART;VALUE=DATE:20270110');
    expect(mockShare).toHaveBeenCalledWith(
      uri,
      expect.objectContaining({ mimeType: 'text/calendar' }),
    );
  });

  it('never shares a calendar without a start date', async () => {
    expect(buildPlanExport('ics', input(null), new Date())).toBeNull();
    await expect(sharePlanExport('ics', input(null))).rejects.toThrow('start date');
    expect(mockShare).not.toHaveBeenCalled();
  });

  it('says so when the device cannot share', async () => {
    mockAvailable.mockResolvedValue(false);
    await expect(sharePlanExport('gpx', input(null))).rejects.toThrow('not available');
    expect(mockDisk.size).toBe(0);
  });
});
