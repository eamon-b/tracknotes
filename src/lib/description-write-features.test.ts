import { describe, expect, it } from 'vitest';
import { DESCRIPTION_WRITE_FEATURES, guardsDescriptionWrites } from './description-write-features';

describe('guardsDescriptionWrites', () => {
  it('is yes only for a read that lists both features', () => {
    expect(guardsDescriptionWrites({ writeFeatures: [...DESCRIPTION_WRITE_FEATURES] })).toBe(true);
    // A later worker may list more.
    expect(guardsDescriptionWrites({ writeFeatures: ['ifUpdatedAt', 'something-new', 'source'] })).toBe(true);
  });

  it('is no for a worker that predates the marker, or says anything else', () => {
    // What the worker in production before this answered: the rows and the clock, nothing more.
    expect(guardsDescriptionWrites({ descriptions: [], syncedAt: '2026-11-01T00:00:00.000Z' } as object)).toBe(false);
    for (const writeFeatures of [undefined, null, [], ['source'], ['ifUpdatedAt'], 'source,ifUpdatedAt', true, {}]) {
      expect(guardsDescriptionWrites({ writeFeatures }), JSON.stringify(writeFeatures)).toBe(false);
    }
    expect(guardsDescriptionWrites(null)).toBe(false);
    expect(guardsDescriptionWrites(undefined)).toBe(false);
  });
});
