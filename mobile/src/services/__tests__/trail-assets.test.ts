import { bundledTrailIds, getBundledTrail, isBundledTrailId } from '../trail-assets';

// Counts evaluations of one bundled file: the module must not build any trail
// until something reads it, and then only once.
let mockAawtEvaluations = 0;
jest.mock('../../../assets/trails/aawt.json', () => {
  mockAawtEvaluations += 1;
  return { config: { id: 'aawt' }, waypoints: [], track: { points: [] } };
});

describe('trail-assets', () => {
  it('evaluates no trail JSON until a trail is read', () => {
    expect(isBundledTrailId('aawt')).toBe(true);
    expect(bundledTrailIds()).toContain('aawt');
    expect(mockAawtEvaluations).toBe(0);
  });

  it('evaluates a trail once, on first read, and caches it', () => {
    const first = getBundledTrail('aawt');
    const second = getBundledTrail('aawt');
    expect(first?.config.id).toBe('aawt');
    expect(second).toBe(first);
    expect(mockAawtEvaluations).toBe(1);
  });

  it('answers null for an id that is not bundled', () => {
    expect(isBundledTrailId('u_abc')).toBe(false);
    expect(isBundledTrailId('toString')).toBe(false);
    expect(getBundledTrail('u_abc')).toBeNull();
  });

  it('bundles every trail the index lists', () => {
    const index = require('../../../assets/trails/index.json') as { id: string }[];
    expect(bundledTrailIds().sort()).toEqual(index.map((e) => e.id).sort());
  });
});
