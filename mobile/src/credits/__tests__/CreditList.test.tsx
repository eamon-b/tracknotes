/**
 * A credit link shows its name, not its address, so when the OS cannot open
 * it the address has to appear on screen instead of the tap doing nothing.
 */

import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { openURL } from 'expo-linking';
import { CreditList, creditOpenFailedMessage } from '../CreditList';
import type { CreditLine } from '../credits';

jest.mock('../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));

jest.mock('expo-linking', () => ({ openURL: jest.fn() }));

const mockOpenURL = openURL as jest.Mock;

const LINES: CreditLine[] = [
  { label: 'Trail data', text: 'From the trust.', url: 'https://example.org/', linkText: 'Trust' },
  { label: 'Contours', text: 'SRTM.' },
];

let mounted: ReactTestRenderer | null = null;

beforeEach(() => {
  jest.clearAllMocks();
  mockOpenURL.mockResolvedValue(true);
});

afterEach(() => {
  const tree = mounted;
  mounted = null;
  if (tree) act(() => tree.unmount());
});

function mount(): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<CreditList lines={LINES} />);
  });
  mounted = tree;
  return tree;
}

function texts(r: ReactTestRenderer): string[] {
  return r.root
    .findAllByType(Text)
    .flatMap((n) => [n.props.children].flat())
    .filter((c): c is string => typeof c === 'string');
}

async function pressLink(r: ReactTestRenderer) {
  const link = r.root.findAll(
    (n) => n.props?.accessibilityRole === 'link' && typeof n.props?.onPress === 'function',
  )[0];
  await act(async () => {
    (link.props.onPress as () => void)();
    await new Promise((resolve) => setImmediate(resolve));
  });
}

it('shows each credit, and a link by its name', () => {
  const shown = texts(mount());
  expect(shown).toEqual(
    expect.arrayContaining(['Trail data', 'From the trust.', 'Trust', 'SRTM.']),
  );
  expect(shown).not.toContain('https://example.org/');
});

it('opens the link', async () => {
  const r = mount();
  await pressLink(r);
  expect(mockOpenURL).toHaveBeenCalledWith('https://example.org/');
  expect(texts(r)).not.toContain(creditOpenFailedMessage('https://example.org/'));
});

it('spells out the address when the OS cannot open it, and clears it on a retry that works', async () => {
  mockOpenURL.mockRejectedValueOnce(new Error('no activity found'));
  const r = mount();
  await pressLink(r);
  const message = creditOpenFailedMessage('https://example.org/');
  expect(message).toContain('https://example.org/');
  expect(texts(r)).toContain(message);

  await pressLink(r);
  expect(texts(r)).not.toContain(message);
});
