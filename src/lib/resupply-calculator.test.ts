import { describe, it, expect } from 'vitest';
import { extractResupplyPoints, computeResupplyGaps } from './resupply-calculator';
import type { PlanWaypoint } from './plan-types';

const waypoints: PlanWaypoint[] = [
  { name: 'Springfield', type: 'town', totalDistance: 50 },
  { name: 'Shelbyville', type: 'food', totalDistance: 120 },
  { name: 'Shelby Creek', type: 'water', totalDistance: 80 }, // not a resupply
  { name: 'Capitol City', type: 'town', totalDistance: 200 },
];

describe('extractResupplyPoints', () => {
  it('includes town and food waypoints only', () => {
    const points = extractResupplyPoints(waypoints);
    expect(points).toHaveLength(3);
    expect(points.map(p => p.name)).toEqual(['Springfield', 'Shelbyville', 'Capitol City']);
  });

  it('sorts by km', () => {
    const shuffled: PlanWaypoint[] = [
      { name: 'Far', type: 'town', totalDistance: 200 },
      { name: 'Near', type: 'town', totalDistance: 50 },
    ];
    const points = extractResupplyPoints(shuffled);
    expect(points[0].km).toBe(50);
    expect(points[1].km).toBe(200);
  });

  it('returns empty array when no resupply waypoints', () => {
    const noResupply: PlanWaypoint[] = [{ name: 'Creek', type: 'water', totalDistance: 30 }];
    expect(extractResupplyPoints(noResupply)).toHaveLength(0);
  });

  it('includes standalone resupply-type caches', () => {
    const points = extractResupplyPoints([
      { name: 'Cache', type: 'resupply', totalDistance: 90 },
      { name: 'Creek', type: 'water', totalDistance: 30 },
    ]);
    expect(points).toHaveLength(1);
    expect(points[0].name).toBe('Cache');
    expect(points[0].type).toBe('resupply');
  });

  it('mixes and sorts town, food and resupply types by km', () => {
    const points = extractResupplyPoints([
      { name: 'Town', type: 'town', totalDistance: 50 },
      { name: 'Cache', type: 'resupply', totalDistance: 90 },
      { name: 'Kiosk', type: 'food', totalDistance: 10 },
      { name: 'Hut', type: 'hut', totalDistance: 70 }, // not a resupply
    ]);
    expect(points.map(p => p.name)).toEqual(['Kiosk', 'Town', 'Cache']);
    expect(points.map(p => p.type)).toEqual(['food', 'town', 'resupply']);
  });
});

describe('computeResupplyGaps', () => {
  it('computes gaps between resupply points', () => {
    const points = extractResupplyPoints(waypoints);
    const gaps = computeResupplyGaps(points, 0, 250);
    // Gaps: start→Springfield (50km), Springfield→Shelbyville (70km),
    //       Shelbyville→CapitolCity (80km), CapitolCity→end (50km)
    expect(gaps).toHaveLength(4);
    expect(gaps[0].fromName).toBe('Trail Start');
    expect(gaps[0].distanceKm).toBe(50);
    expect(gaps[1].fromName).toBe('Springfield');
    expect(gaps[1].distanceKm).toBe(70);
    expect(gaps[3].toName).toBe('Trail End');
    expect(gaps[3].distanceKm).toBe(50);
  });

  it('makes the whole range one gap when there are no points (the full carry)', () => {
    const gaps = computeResupplyGaps([], 10, 130);
    expect(gaps).toEqual([{ fromName: 'Trail Start', toName: 'Trail End', fromKm: 10, toKm: 130, distanceKm: 120 }]);
  });

  it('returns no gaps for an empty range', () => {
    expect(computeResupplyGaps([], 50, 50)).toHaveLength(0);
  });
});

// --- Edge cases from code review ---

describe('computeResupplyGaps edge cases', () => {
  it('does not produce zero-distance gap when two points at same km', () => {
    const points = extractResupplyPoints([
      { name: 'Store A', type: 'food', totalDistance: 50 },
      { name: 'Store B', type: 'food', totalDistance: 50 },
      { name: 'Town', type: 'town', totalDistance: 100 },
    ]);
    const gaps = computeResupplyGaps(points, 0, 150);
    // No gap should have distance <= 0
    for (const gap of gaps) {
      expect(gap.distanceKm).toBeGreaterThan(0);
    }
  });

  it('splits a gap at a standalone resupply cache', () => {
    // Two towns with a resupply cache between them: one long leg becomes two.
    const withCache = extractResupplyPoints([
      { name: 'Town A', type: 'town', totalDistance: 0 },
      { name: 'Cache', type: 'resupply', totalDistance: 60 },
      { name: 'Town B', type: 'town', totalDistance: 120 },
    ]);
    const gaps = computeResupplyGaps(withCache, 0, 120);
    // Town A→Cache (60km) and Cache→Town B (60km) — no single 120km leg.
    expect(gaps).toHaveLength(2);
    expect(gaps.map(g => g.distanceKm)).toEqual([60, 60]);
    expect(gaps.every(g => g.distanceKm < 120)).toBe(true);
  });
});

// --- Regression: Larapinta resupply caches (real-shape fixture) ---

describe('Larapinta resupply caches', () => {
  // Mirrors mobile/assets/trails/larapinta.json: food kiosks co-located with
  // resupply caches at Ormiston (49.7) and Standley (166.8), plus standalone
  // caches at Serpentine (91.9) and Ellery (105.1). Before 'resupply' was a
  // recognised type, the planner saw only the two food kiosks → one ~117km
  // leg. It must now split into three legs between Ormiston and Standley.
  const larapinta: PlanWaypoint[] = [
    { name: 'Kiosk: Ormiston Gorge', type: 'food', totalDistance: 49.7 },
    { name: 'R: Ormiston Gorge', type: 'resupply', totalDistance: 49.7 },
    { name: 'R: Serpentine Gorge', type: 'resupply', totalDistance: 91.9 },
    { name: 'R: Ellery Creek', type: 'resupply', totalDistance: 105.1 },
    { name: 'R: Standley Chasm', type: 'resupply', totalDistance: 166.8 },
    { name: 'Kiosk: Standley Chasm', type: 'food', totalDistance: 166.8 },
  ];

  it('recognises all four supply points', () => {
    const points = extractResupplyPoints(larapinta);
    // Six waypoints, but the two co-located pairs dedupe to four legs' worth.
    const kms = points.filter((p, i) => i === 0 || p.km !== points[i - 1].km);
    expect(kms.map(p => p.km)).toEqual([49.7, 91.9, 105.1, 166.8]);
  });

  it('splits Ormiston→Standley into three legs, not one', () => {
    const gaps = computeResupplyGaps(extractResupplyPoints(larapinta), 49.7, 166.8);
    // Ormiston→Serpentine, Serpentine→Ellery, Ellery→Standley.
    expect(gaps).toHaveLength(3);
    expect(gaps.map(g => g.distanceKm)).toEqual([42.2, 13.2, 61.7]);
    // The whole span is ~117km; no single leg should span it.
    expect(gaps.every(g => g.distanceKm < 117)).toBe(true);
  });
});
