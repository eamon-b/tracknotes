import { describe, it, expect } from 'vitest';
import { haversineDistance, EARTH_RADIUS_METERS } from './distance';

describe('haversineDistance', () => {
  it('measures Sydney to Melbourne as ~713 km', () => {
    const result = haversineDistance(-33.8688, 151.2093, -37.8136, 144.9631);
    expect(result).toBeGreaterThan(700_000);
    expect(result).toBeLessThan(730_000);
  });
});

describe('edge cases', () => {
  it('antipodal points should be ~20,000 km apart', () => {
    const result = haversineDistance(0, 0, 0, 180);
    expect(result).toBeGreaterThan(20_000_000);
    expect(result).toBeLessThan(20_100_000);
  });

  it('handles points on the international date line', () => {
    // Points straddling the date line should compute correctly
    const result = haversineDistance(0, 179.999, 0, -179.999);
    expect(result).toBeLessThan(300); // very close together
  });

  it('handles points at the poles', () => {
    const northToSouth = haversineDistance(90, 0, -90, 0);
    expect(northToSouth).toBeGreaterThan(20_000_000);
    expect(northToSouth).toBeLessThan(20_100_000);
  });

  it('zero-length segment (same point twice)', () => {
    const result = haversineDistance(-33.8688, 151.2093, -33.8688, 151.2093);
    expect(result).toBe(0);
  });

  it('EARTH_RADIUS_METERS is correct', () => {
    expect(EARTH_RADIUS_METERS).toBe(6371000);
  });
});
