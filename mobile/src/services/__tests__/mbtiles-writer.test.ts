/**
 * The phone-side MBTiles writer: TMS rows on disk, XYZ keys in and out.
 */

import { openMbtilesWriter, tileKey, tmsRow } from '../mbtiles-writer';
import { dbAt, resetStorage } from './fake-tile-storage';

// jest.mock factories cannot import; requiring the fake shares its state with the test.
/* eslint-disable @typescript-eslint/no-require-imports */
jest.mock('expo-file-system', () => require('./fake-tile-storage').fileSystemModule);
jest.mock('expo-sqlite', () => require('./fake-tile-storage').sqliteModule);
/* eslint-enable @typescript-eslint/no-require-imports */

const DIR = '/mock/document/tiles/u_x';

beforeEach(() => resetStorage());

describe('tmsRow', () => {
  it('flips y per the MBTiles spec', () => {
    expect(tmsRow(0, 0)).toBe(0);
    expect(tmsRow(1, 0)).toBe(1);
    expect(tmsRow(15, 19_000)).toBe(32_767 - 19_000);
  });
});

describe('openMbtilesWriter', () => {
  it('stores XYZ tiles under their TMS row and reads them back as XYZ', async () => {
    const writer = await openMbtilesWriter(DIR, 'base.mbtiles.part');
    await writer.putTiles([
      { z: 15, x: 28_000, y: 19_000, data: new Uint8Array([1]) },
      { z: 9, x: 400, y: 300, data: new Uint8Array([2]) },
    ]);
    await writer.setMetadata({ format: 'pbf', minzoom: '9' });

    const db = dbAt('u_x/base.mbtiles.part')!;
    expect(db.tiles.has(`15/28000/${32_767 - 19_000}`)).toBe(true);
    expect(db.tiles.has(`9/400/${511 - 300}`)).toBe(true);

    expect(await writer.existingTiles()).toEqual(
      new Set([tileKey(15, 28_000, 19_000), tileKey(9, 400, 300)]),
    );
    expect(await writer.stats()).toEqual({ count: 2, minZoom: 9, maxZoom: 15 });
    expect(await writer.readMetadata()).toEqual({ format: 'pbf', minzoom: '9' });
    await writer.close();
  });

  it('reports no stats for an empty file', async () => {
    const writer = await openMbtilesWriter(DIR, 'contours.mbtiles.part');
    expect(await writer.stats()).toBeNull();
    await writer.close();
  });
});
