import { mapPointOf, requestMapTarget, takeMapTarget } from '../map-target';

describe('map-target', () => {
  it('hands a request over once, to its own trail only', () => {
    requestMapTarget('bibbulmun', { lat: -34.9, lon: 117.9 });

    expect(takeMapTarget('heysen')).toBeNull();
    expect(takeMapTarget('bibbulmun')).toEqual({ lat: -34.9, lon: 117.9 });
    expect(takeMapTarget('bibbulmun')).toBeNull();
  });

  it('keeps only the latest request for a trail', () => {
    requestMapTarget('heysen', { lat: 1, lon: 1 });
    requestMapTarget('heysen', { lat: 2, lon: 2 });

    expect(takeMapTarget('heysen')).toEqual({ lat: 2, lon: 2 });
  });
});

describe('mapPointOf', () => {
  it("takes the place's own position and its walk in", () => {
    const path: [number, number][] = [
      [-36.09, 148.46],
      [-36.08, 148.45],
    ];
    expect(mapPointOf({ lat: -36.08, lon: 148.45, offTrailPath: path })).toEqual({
      lat: -36.08,
      lon: 148.45,
      accessPath: path,
    });
  });

  it('has no walk for a place without one', () => {
    expect(mapPointOf({ lat: 1, lon: 2 })).toEqual({ lat: 1, lon: 2 });
  });
});
