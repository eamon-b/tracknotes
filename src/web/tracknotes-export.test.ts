/**
 * "Export for Tracknotes" with "Include my plan": the checkbox appears only
 * when this browser has a plan for the trail, the file carries the plan only
 * while it is ticked, and the per-device inputs beside the plan never go.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HANDOFF_PLAN_VERSION, HANDOFF_TRAIL_VERSION, parseHandoff } from '@lib/trail-handoff';
import type { PlanDocument } from '@lib/plan-types';
import type { ProcessedTrail } from '@lib/trail-types';
import { initTracknotesExport } from './tracknotes-export';

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
  track: {
    points,
    displayPoints: points,
    totalDistance: 0.85,
    totalAscent: 30,
    totalDescent: 0,
  },
  waypoints: [],
  offTrailWaypoints: [],
  alternates: [],
  sideTrips: [],
  climate: null,
  climateLocations: null,
  direction: null,
};

const plan: PlanDocument = {
  id: '6f1c2e9a-4b7d-4c1e-9a3f-2d8b5e7c1a90',
  trailId: TRAIL_ID,
  name: 'Easter trip',
  direction: 'NOBO',
  startDate: '2026-04-03',
  stops: [{ km: 0.5, name: 'Camp', nights: 1 }],
  updatedAt: '2026-03-01T10:00:00.000Z',
  version: 1,
};

const originalCreateUrl = URL.createObjectURL;
const originalRevokeUrl = URL.revokeObjectURL;
let blobs: Blob[];

function mount(): void {
  document.body.innerHTML = `
    <button id="export-tracknotes-btn" disabled>Export for Tracknotes</button>
    <label id="export-tracknotes-plan-toggle" hidden>
      <input type="checkbox" id="export-tracknotes-plan" checked> Include my plan
    </label>`;
  initTracknotesExport({ trail: () => trail, planTrailId: TRAIL_ID });
}

/** jsdom's Blob has no `text()`. */
function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

async function exportFile(): Promise<ReturnType<typeof parseHandoff> & { version: number }> {
  (document.getElementById('export-tracknotes-btn') as HTMLButtonElement).click();
  const text = await readBlob(blobs[blobs.length - 1]);
  return { ...parseHandoff(text), version: (JSON.parse(text) as { version: number }).version };
}

const toggle = (): HTMLElement => document.getElementById('export-tracknotes-plan-toggle')!;

beforeEach(() => {
  blobs = [];
  URL.createObjectURL = (blob: Blob) => {
    blobs.push(blob);
    return 'blob:x';
  };
  URL.revokeObjectURL = () => {};
  localStorage.clear();
});

afterEach(() => {
  URL.createObjectURL = originalCreateUrl;
  URL.revokeObjectURL = originalRevokeUrl;
  document.body.innerHTML = '';
});

describe('initTracknotesExport', () => {
  it('offers no plan, and writes a trail-only file, when the trail has none', async () => {
    mount();
    expect(toggle().hidden).toBe(true);
    const file = await exportFile();
    expect(file.version).toBe(HANDOFF_TRAIL_VERSION);
    expect(file.plan).toBeNull();
  });

  it('includes the plan by default when there is one — the document only', async () => {
    localStorage.setItem(`trail-plan-doc-${TRAIL_ID}`, JSON.stringify(plan));
    localStorage.setItem(`trail-plan-ui-${TRAIL_ID}`, JSON.stringify({ pace: 'fast', dailyHours: 11 }));
    mount();
    expect(toggle().hidden).toBe(false);

    (document.getElementById('export-tracknotes-btn') as HTMLButtonElement).click();
    const text = await readBlob(blobs[0]);
    expect(text).not.toMatch(/dailyHours|"pace"/);
    const file = await exportFile();
    expect(file.version).toBe(HANDOFF_PLAN_VERSION);
    expect(file.plan).toEqual(plan);
  });

  it('leaves the plan out once unticked', async () => {
    localStorage.setItem(`trail-plan-doc-${TRAIL_ID}`, JSON.stringify(plan));
    mount();
    (document.getElementById('export-tracknotes-plan') as HTMLInputElement).checked = false;
    const file = await exportFile();
    expect(file.version).toBe(HANDOFF_TRAIL_VERSION);
    expect(file.plan).toBeNull();
  });

  it('shows the box when another tab saves a plan', () => {
    mount();
    expect(toggle().hidden).toBe(true);
    localStorage.setItem(`trail-plan-doc-${TRAIL_ID}`, JSON.stringify(plan));
    window.dispatchEvent(new StorageEvent('storage', { key: `trail-plan-doc-${TRAIL_ID}` }));
    expect(toggle().hidden).toBe(false);
  });
});
