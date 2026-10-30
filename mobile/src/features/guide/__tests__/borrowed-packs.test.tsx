/**
 * My Guides' borrowed offline packs: which bundled pack an import or
 * community route shows the status of, read once per guide.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import {
  needsBorrowedPack,
  resetBorrowedPacks,
  resolveBorrowedPack,
  useBorrowedPacks,
} from '../borrowed-packs';
import { getTrailJson, listTrails, type TrailIndexEntry } from '../../../services/trail-loader';

// As a build with a tile server configured: an uncovered route with points gets
// a corridor pack of its own.
jest.mock('../../../services/offline-pack-resolver', () => {
  const actual = jest.requireActual('../../../services/offline-pack-resolver');
  return {
    ...actual,
    resolveOfflinePack: (id: string, trail: unknown) =>
      actual.resolveOfflinePack(id, trail, undefined, true),
  };
});

const bundled = listTrails()[0];
const bundledTrail = getTrailJson(bundled.id)!;

/** An import running along the first few km of a bundled trail. */
const insideTrail = {
  track: { displayPoints: bundledTrail.track.displayPoints.slice(0, 20) },
};
/** An import on the other side of the world. */
const outsideTrail = {
  track: {
    displayPoints: [
      { lat: 64.1, lon: -21.9 },
      { lat: 64.2, lon: -21.8 },
    ],
  },
};

function entry(over: Partial<TrailIndexEntry>): TrailIndexEntry {
  return { id: 'u_x', name: 'X', shortName: 'X', lengthKm: 1, source: 'imported', ...over };
}

beforeEach(() => resetBorrowedPacks());

describe('needsBorrowedPack', () => {
  it('asks for imports and downloaded community routes only', () => {
    expect(needsBorrowedPack(entry({}))).toBe(true);
    expect(needsBorrowedPack(entry({ id: 'c_1', source: 'community', downloaded: true }))).toBe(
      true,
    );
    expect(needsBorrowedPack(entry({ id: 'c_1', source: 'community', downloaded: false }))).toBe(
      false,
    );
    expect(needsBorrowedPack(entry({ id: bundled.id, source: 'bundled' }))).toBe(false);
    expect(needsBorrowedPack(entry({ id: 'r', source: 'remote', downloaded: true }))).toBe(false);
  });
});

describe('resolveBorrowedPack', () => {
  it('names the bundled pack covering the track', async () => {
    const pack = await resolveBorrowedPack(entry({}), async () => insideTrail);
    expect(pack).toEqual({ packTrailId: bundled.id, packName: bundled.name });
  });

  it('is null outside every pack', async () => {
    expect(await resolveBorrowedPack(entry({}), async () => outsideTrail)).toBeNull();
  });

  it("is the guide's own corridor pack outside every bundled pack, when it has points", async () => {
    const withPoints = {
      track: { ...outsideTrail.track, points: outsideTrail.track.displayPoints },
    };
    expect(await resolveBorrowedPack(entry({}), async () => withPoints)).toEqual({
      packTrailId: 'u_x',
    });
  });

  it('reads a guide once, and again when the copy on the phone changes', async () => {
    const load = jest.fn(async () => insideTrail);
    const route = entry({ id: 'c_1', source: 'community', downloaded: true, installedMd5: 'a' });
    await resolveBorrowedPack(route, load);
    await resolveBorrowedPack({ ...route, updatedAt: 'status change' }, load);
    expect(load).toHaveBeenCalledTimes(1);
    await resolveBorrowedPack({ ...route, installedMd5: 'b' }, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('shares a read already under way', async () => {
    let finish: (t: typeof insideTrail) => void = () => {};
    const load = jest.fn(() => new Promise<typeof insideTrail>((r) => (finish = r)));
    const first = resolveBorrowedPack(entry({}), load);
    const second = resolveBorrowedPack(entry({}), load);
    finish(insideTrail);
    expect(await first).toEqual(await second);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('remembers a guide it could not read as having no pack', async () => {
    const load = jest.fn(async () => {
      throw new Error('torn');
    });
    expect(await resolveBorrowedPack(entry({}), load)).toBeNull();
    expect(await resolveBorrowedPack(entry({}), load)).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('useBorrowedPacks', () => {
  it('fills in each local guide that borrows a pack, and skips the rest', async () => {
    const load = jest.fn(async (id: string) => (id === 'u_in' ? insideTrail : outsideTrail));
    const trails = [
      entry({ id: bundled.id, source: 'bundled' }),
      entry({ id: 'u_in' }),
      entry({ id: 'u_out' }),
    ];
    let packs: ReturnType<typeof useBorrowedPacks> = {};
    function Probe() {
      packs = useBorrowedPacks(trails, load);
      return null;
    }
    await act(async () => {
      TestRenderer.create(<Probe />);
    });
    expect(packs).toEqual({
      u_in: { packTrailId: bundled.id, packName: bundled.name },
    });
    expect(load).not.toHaveBeenCalledWith(bundled.id);
  });

  it('shows an answer a cancelled pass stored, when the list re-renders', async () => {
    let finish: (t: typeof insideTrail) => void = () => {};
    const load = jest.fn(() => new Promise<typeof insideTrail>((r) => (finish = r)));
    let packs: ReturnType<typeof useBorrowedPacks> = {};
    function Probe({ trails }: { trails: TrailIndexEntry[] }) {
      packs = useBorrowedPacks(trails, load);
      return null;
    }
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<Probe trails={[entry({ id: 'u_in' })]} />);
    });
    // A new list array (a focus refresh) cancels the first pass mid-read.
    await act(async () => {
      renderer.update(<Probe trails={[entry({ id: 'u_in' })]} />);
    });
    await act(async () => {
      finish(insideTrail);
    });
    expect(packs).toEqual({ u_in: { packTrailId: bundled.id, packName: bundled.name } });
    expect(load).toHaveBeenCalledTimes(1);
  });
});
