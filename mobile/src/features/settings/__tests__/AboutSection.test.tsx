/**
 * Settings' About section.
 *
 * This link is a store-release requirement (the policy must be reachable from
 * inside the app), so what's worth pinning down is that it points at the exact
 * published URL — a typo here ships a dead privacy link — and that a failure to
 * open it tells the user the URL rather than doing nothing.
 */

import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { openURL } from 'expo-linking';
import {
  AboutSection,
  PRIVACY_POLICY_URL,
  PRIVACY_OPEN_FAILED_MESSAGE,
  TERMS_OPEN_FAILED_MESSAGE,
} from '../AboutSection';
import { TERMS_URL } from '@lib/contribution-licence';

jest.mock('../../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));

jest.mock('expo-linking', () => ({ openURL: jest.fn() }));

const mockOpenURL = openURL as jest.Mock;

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
    tree = TestRenderer.create(<AboutSection />);
  });
  mounted = tree;
  return tree;
}

function renderedText(r: ReactTestRenderer): string {
  return (
    r.root
      .findAllByType(Text)
      .flatMap((n) => [n.props.children].flat())
      // Nested <Text> links are elements; their own strings are found separately.
      .filter((c): c is string => typeof c === 'string')
      .join(' ')
  );
}

async function pressAsync(r: ReactTestRenderer, accessibilityLabel: string) {
  const target = r.root.findAll(
    (n) =>
      n.props?.accessibilityLabel === accessibilityLabel && typeof n.props?.onPress === 'function',
  )[0];
  await act(async () => {
    (target.props.onPress as () => void)();
    await new Promise((resolve) => setImmediate(resolve));
  });
}

describe('AboutSection', () => {
  it('points at the published privacy policy URL', () => {
    // Hard-coded on purpose: this is the URL the store listings link, and the
    // Vercel deploy of public/privacy.html. Changing one means changing both.
    expect(PRIVACY_POLICY_URL).toBe('https://trail-maps.vercel.app/privacy.html');
  });

  it('offers the policy without needing an identity or a network', () => {
    const r = mount();
    const text = renderedText(r);
    expect(text).toContain('About');
    expect(text).toContain('Privacy policy');
  });

  it('credits the app-wide data sources, climate included', () => {
    const text = renderedText(mount());
    expect(text).toContain('Data credits');
    expect(text).toContain('© OpenStreetMap contributors');
    expect(text).toContain('Open-Meteo');
  });

  it('opens the policy URL when the link is pressed', async () => {
    const r = mount();
    await pressAsync(r, 'Open privacy policy');

    expect(mockOpenURL).toHaveBeenCalledTimes(1);
    expect(mockOpenURL).toHaveBeenCalledWith(PRIVACY_POLICY_URL);
    expect(renderedText(r)).not.toContain('Couldn’t open');
  });

  it('exposes the link to assistive tech as a link', () => {
    const r = mount();
    const link = r.root.findAll((n) => n.props?.accessibilityLabel === 'Open privacy policy')[0];
    expect(link.props.accessibilityRole).toBe('link');
  });

  it('spells out the URL when the OS refuses to open it', async () => {
    mockOpenURL.mockRejectedValue(new Error('no activity found'));
    const r = mount();
    await pressAsync(r, 'Open privacy policy');

    const text = renderedText(r);
    expect(text).toContain(PRIVACY_OPEN_FAILED_MESSAGE);
    expect(text).toContain(PRIVACY_POLICY_URL);
  });

  it('clears a previous failure when the link is retried successfully', async () => {
    mockOpenURL.mockRejectedValueOnce(new Error('no activity found'));
    const r = mount();
    await pressAsync(r, 'Open privacy policy');
    expect(renderedText(r)).toContain(PRIVACY_OPEN_FAILED_MESSAGE);

    await pressAsync(r, 'Open privacy policy');
    expect(renderedText(r)).not.toContain(PRIVACY_OPEN_FAILED_MESSAGE);
  });

  it('points at the published terms of service, beside the privacy policy', () => {
    expect(TERMS_URL).toBe('https://trail-maps.vercel.app/terms.html');
  });

  it('opens the terms of service, and spells out the URL when it cannot', async () => {
    const r = mount();
    await pressAsync(r, 'Open terms of service');
    expect(mockOpenURL).toHaveBeenCalledWith(TERMS_URL);

    mockOpenURL.mockRejectedValue(new Error('no activity found'));
    await pressAsync(r, 'Open terms of service');
    expect(renderedText(r)).toContain(TERMS_OPEN_FAILED_MESSAGE);
  });
});
