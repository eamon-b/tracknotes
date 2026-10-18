import { appCredits, mapCredits, trailDataCredit } from '../map-credits';
import { TRAIL_DATA } from '../../../services/trail-assets';

describe('trailDataCredit', () => {
  it('reads a dataSource with its link', () => {
    expect(
      trailDataCredit({ text: ' From the trust. ', url: 'https://example.org/', linkText: 'Trust' }),
    ).toEqual({
      label: 'Trail data',
      text: 'From the trust.',
      url: 'https://example.org/',
      linkText: 'Trust',
    });
  });

  it('labels a link with its URL when there is no linkText', () => {
    expect(trailDataCredit({ text: 'x', url: 'https://example.org/' })?.linkText).toBe(
      'https://example.org/',
    );
  });

  it('drops a link that is not http(s)', () => {
    const line = trailDataCredit({ text: 'x', url: 'javascript:alert(1)', linkText: 'y' });
    expect(line).toEqual({ label: 'Trail data', text: 'x' });
    expect(trailDataCredit({ text: 'x', url: 'example.org' })?.url).toBeUndefined();
  });

  it('is null without usable text', () => {
    expect(trailDataCredit(undefined)).toBeNull();
    expect(trailDataCredit('text')).toBeNull();
    expect(trailDataCredit({ text: '  ' })).toBeNull();
    expect(trailDataCredit({ url: 'https://example.org/' })).toBeNull();
  });
});

describe('mapCredits', () => {
  const labels = (basemap: 'online' | 'offline' | null, ds?: unknown) =>
    mapCredits(basemap, ds).map((l) => l.label);

  it('credits the base map that mounted, OSM, contours and the trail', () => {
    expect(labels('online', { text: 'x' })).toEqual([
      'Base map',
      'Map data',
      'Contours',
      'Trail data',
    ]);
    expect(mapCredits('online', undefined)[0].text).toMatch(/OpenFreeMap/);
    expect(mapCredits('offline', undefined)[0].text).toMatch(/Protomaps/);
  });

  it('has no base map line for the fallback style, and always credits OSM', () => {
    expect(labels(null)).toEqual(['Map data', 'Contours']);
    expect(mapCredits(null, undefined)[0].text).toMatch(/OpenStreetMap contributors/);
  });
});

it('app credits include Open-Meteo for the climate data', () => {
  expect(appCredits().some((l) => /Open-Meteo/.test(l.text))).toBe(true);
});

it('every bundled trail credits its track data', () => {
  for (const [id, trail] of Object.entries(TRAIL_DATA)) {
    expect([id, trailDataCredit(trail.config.dataSource) !== null]).toEqual([id, true]);
  }
});
