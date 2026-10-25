/**
 * Two pages on one stored plan: each page's edits are replayed on whatever the
 * other saved, never a stale whole document written over it.
 */

import { describe, it, expect } from 'vitest';
import type { PlanDocument } from '@lib/plan-types';
import { PlanEditQueue, replayPlanEdits, type PlanEdit } from './plan-edit-queue';

const doc = (over: Partial<PlanDocument> = {}): PlanDocument =>
  ({
    id: 'p1',
    trailId: 't',
    name: 'Plan',
    direction: 'NOBO',
    startDate: null,
    stops: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  }) as PlanDocument;

const rename =
  (name: string): PlanEdit =>
  d => ({ ...d, name });
const pickStops =
  (ids: string[]): PlanEdit =>
  d => ({ ...d, resupplyStops: ids });

describe('PlanEditQueue', () => {
  it('writes its own copy while storage still holds what the edits were made on', () => {
    const base = doc();
    const queue = new PlanEditQueue(base);
    const ours = rename('Mine')(base);
    queue.record(rename('Mine'));
    expect(queue.resolveForSave(ours, base)).toBe(ours);
    expect(queue.hasPending).toBe(false);
  });

  it('replays its edits on a copy another page saved since', () => {
    const base = doc();
    const queue = new PlanEditQueue(base);
    queue.record(pickStops(['w_1']));
    const ours = pickStops(['w_1'])(base);
    const theirs = rename('Theirs')(base);
    const next = queue.resolveForSave(ours, theirs);
    expect(next.name).toBe('Theirs');
    expect(next.resupplyStops).toEqual(['w_1']);
  });

  it('rebases pending edits when told of another save, and then writes the rebased copy', () => {
    const base = doc();
    const queue = new PlanEditQueue(base);
    queue.record(pickStops(['w_1']));
    const theirs = rename('Theirs')(base);
    const shown = queue.rebase(theirs);
    expect(shown).toEqual({ ...theirs, resupplyStops: ['w_1'] });
    expect(queue.isBase(theirs)).toBe(true);
    expect(queue.resolveForSave(shown, theirs)).toBe(shown);
  });

  it('writes its own copy when storage holds nothing yet', () => {
    const queue = new PlanEditQueue(null);
    const ours = doc();
    queue.record(rename('x'));
    expect(queue.resolveForSave(ours, null)).toBe(ours);
  });

  it('drops an edit the newer copy refuses rather than failing the save', () => {
    const refuse: PlanEdit = () => {
      throw new RangeError('no such stop');
    };
    expect(replayPlanEdits(doc(), [refuse, rename('Kept')]).name).toBe('Kept');
  });
});
