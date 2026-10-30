import {
  WATER_STATUS_OPTIONS,
  distanceToLineMeters,
  hikerReportLine,
  isPlaceOffTrail,
  isWaterFamily,
  relativeDate,
  tripToWaypoint,
  waterStatusMeta,
  waypointOffTrailMeters,
} from '../waypoint-detail';

describe('hikerReportLine', () => {
  const now = Date.parse('2026-10-18T12:00:00Z');
  const pin = (info: object) => ({
    id: 'hw_1',
    name: 'Creek',
    type: 'water',
    userWaypoint: {
      visibility: 'shared',
      mine: false,
      authorName: 'Jo',
      createdAt: '2026-10-01T09:00:00Z',
      updatedAt: '2026-10-12T09:00:00Z',
      metresFromTrail: 20,
      ...info,
    },
  });

  it('names another hiker and the date they last saved it', () => {
    expect(hikerReportLine(pin({}), now)).toBe('Reported by Jo · 12 Oct');
    expect(hikerReportLine(pin({ authorName: null }), now)).toBe('Reported by a hiker · 12 Oct');
    expect(hikerReportLine(pin({ updatedAt: '2025-12-30T09:00:00Z' }), now)).toBe(
      'Reported by Jo · 30 Dec 2025',
    );
  });

  it("is null for the hiker's own pins and curated places", () => {
    expect(hikerReportLine(pin({ mine: true }), now)).toBeNull();
    expect(hikerReportLine({ id: 'w_1', name: 'Hut', type: 'hut' }, now)).toBeNull();
  });
});

describe('relativeDate', () => {
  const now = Date.parse('2026-07-29T12:00:00Z');

  it('renders coarse buckets', () => {
    expect(relativeDate('2026-07-29T11:59:30Z', now)).toBe('just now');
    expect(relativeDate('2026-07-29T11:45:00Z', now)).toBe('15 min ago');
    expect(relativeDate('2026-07-29T09:00:00Z', now)).toBe('3 h ago');
    expect(relativeDate('2026-07-27T12:00:00Z', now)).toBe('2 d ago');
  });

  it('falls back to an absolute date past a week', () => {
    expect(relativeDate('2026-07-03T12:00:00Z', now)).toBe('3 Jul');
    expect(relativeDate('2025-12-25T12:00:00Z', now)).toBe('25 Dec 2025');
  });

  it('returns empty for an unparseable timestamp', () => {
    expect(relativeDate('not-a-date', now)).toBe('');
  });
});

describe('water helpers', () => {
  it('detects the water family for the composer chips', () => {
    expect(isWaterFamily('water')).toBe(true);
    expect(isWaterFamily('spring')).toBe(true);
    expect(isWaterFamily('water-tank')).toBe(true);
    expect(isWaterFamily('campsite')).toBe(false);
    expect(isWaterFamily('town')).toBe(false);
  });

  it('maps a status to its label and theme token', () => {
    expect(waterStatusMeta('flowing')).toEqual({ label: 'Flowing', colorToken: 'waterFlowing' });
    expect(waterStatusMeta('low')).toEqual({ label: 'Low', colorToken: 'waterLow' });
    expect(waterStatusMeta('dry')).toEqual({ label: 'Dry', colorToken: 'waterDry' });
    expect(WATER_STATUS_OPTIONS).toEqual(['flowing', 'low', 'dry']);
  });
});

describe('place off trail', () => {
  // A straight equatorial line, 0.01° (~1.1 km) between its two vertices.
  const line = [
    { lat: 0, lon: 0, dist: 0 },
    { lat: 0, lon: 0.01, dist: 1.11 },
  ];

  it('measures to the line, not to its nearest vertex', () => {
    // Mid-segment, 0.0001° (~11 m) north: ~556 m from either vertex.
    const m = distanceToLineMeters(0.0001, 0.005, line)!;
    expect(m).toBeGreaterThan(10);
    expect(m).toBeLessThan(12);
  });

  it("uses a turn-off's own offTrailKm over the straight line", () => {
    expect(waypointOffTrailMeters({ lat: 0, lon: 0.005, offTrailKm: 2.5 }, line)).toBe(2500);
    expect(waypointOffTrailMeters({ lat: 0.01, lon: 0.005 }, line)).toBeGreaterThan(1000);
  });

  it('counts only a real walk as off the trail', () => {
    expect(isPlaceOffTrail(17)).toBe(false);
    expect(isPlaceOffTrail(50)).toBe(false);
    expect(isPlaceOffTrail(51)).toBe(true);
    expect(isPlaceOffTrail(null)).toBe(false);
  });
});
