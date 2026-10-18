/**
 * `useLocalDate` moves on at local midnight, so Today and its header button
 * never show yesterday on a phone left open overnight.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { useLocalDate } from '../use-today-plan';

let seen: string[];
function Probe() {
  seen.push(useLocalDate());
  return null;
}

let tree: ReactTestRenderer;
beforeEach(() => {
  seen = [];
  jest.useFakeTimers({ now: new Date(2026, 9, 17, 23, 59, 0) });
  act(() => {
    tree = TestRenderer.create(<Probe />);
  });
});

afterEach(() => {
  act(() => tree.unmount());
  jest.useRealTimers();
});

it('rolls over to the next day at local midnight, and again the night after', () => {
  expect(seen.at(-1)).toBe('2026-10-17');
  act(() => jest.advanceTimersByTime(30_000));
  expect(seen.at(-1)).toBe('2026-10-17');
  act(() => jest.advanceTimersByTime(60_000));
  expect(seen.at(-1)).toBe('2026-10-18');
  act(() => jest.advanceTimersByTime(24 * 3_600_000));
  expect(seen.at(-1)).toBe('2026-10-19');
});

it('arms the next timer when one fires before the date has changed', () => {
  // A timer that fires early: the clock is pulled back before it runs.
  jest.setSystemTime(new Date(2026, 9, 17, 22, 0, 0));
  act(() => jest.advanceTimersByTime(61_000));
  expect(seen.at(-1)).toBe('2026-10-17');
  act(() => jest.advanceTimersByTime(2 * 3_600_000));
  expect(seen.at(-1)).toBe('2026-10-18');
});
