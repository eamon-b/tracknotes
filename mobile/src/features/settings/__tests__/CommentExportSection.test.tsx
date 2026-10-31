/**
 * Settings' comment export: hidden without an account, hands the share sheet
 * the JSON, says when there is nothing to export, and reports a failure inline.
 */

import React from 'react';
import { Share, Text } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { CommentExportSection, EXPORT_FAILED_MESSAGE } from '../CommentExportSection';
import { useIdentityStore } from '../../../state/identity-store';
import { getSession } from '../../../api/auth';
import { fetchMyComments } from '../../../api/my-comments';

jest.mock('../../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));

jest.mock('../../../api/client', () => ({
  ...jest.requireActual('../../../api/client'),
  isApiConfigured: () => true,
}));

jest.mock('../../../api/auth', () => ({
  getSession: jest.fn(),
  registerDevice: jest.fn(),
  updateDisplayName: jest.fn(),
  deleteAccount: jest.fn(),
}));

jest.mock('../../../api/my-comments', () => ({ fetchMyComments: jest.fn() }));

const mockGetSession = getSession as jest.Mock;
const mockFetch = fetchMyComments as jest.Mock;

const SESSION = { userId: 'u1', token: 't1', displayName: 'Trail Ghost' };
const COMMENT = {
  id: 'c1',
  trailId: 'heysen',
  waypointId: 'w_00000001',
  text: 'Tank full',
  waterStatus: 'flowing',
  observedAt: null,
  createdAt: '2026-10-01T07:00:00Z',
  updatedAt: '2026-10-01T07:00:00Z',
  photoUrls: [],
  deletedAt: null,
  deletedBy: null,
};

let mounted: ReactTestRenderer | null = null;
let shareSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  useIdentityStore.setState({ status: 'unknown', session: null, authError: false });
  shareSpy = jest
    .spyOn(Share, 'share')
    .mockResolvedValue({ action: Share.sharedAction, activityType: undefined });
});

afterEach(() => {
  shareSpy.mockRestore();
  const tree = mounted;
  mounted = null;
  if (tree) act(() => tree.unmount());
});

async function mount(): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(<CommentExportSection />);
    await new Promise((resolve) => setImmediate(resolve));
  });
  mounted = tree;
  return tree;
}

function renderedText(r: ReactTestRenderer): string {
  return r.root
    .findAllByType(Text)
    .map((n) => JSON.stringify(n.props.children))
    .join(' ');
}

async function pressExport(r: ReactTestRenderer) {
  const target = r.root.findAll(
    (n) =>
      n.props?.accessibilityLabel === 'Export my comments' &&
      typeof n.props?.onPress === 'function',
  )[0];
  await act(async () => {
    (target.props.onPress as () => void)();
    await new Promise((resolve) => setImmediate(resolve));
  });
}

describe('CommentExportSection', () => {
  it('is hidden on a device with no identity', async () => {
    mockGetSession.mockResolvedValue(null);
    const r = await mount();
    expect(r.toJSON()).toBeNull();
  });

  it('shares the comments as JSON, without the display name', async () => {
    mockGetSession.mockResolvedValue(SESSION);
    mockFetch.mockResolvedValue([COMMENT]);
    const r = await mount();
    await pressExport(r);

    expect(shareSpy).toHaveBeenCalledTimes(1);
    const { message } = shareSpy.mock.calls[0][0] as { message: string };
    expect(JSON.parse(message).comments).toEqual([COMMENT]);
    expect(message).not.toContain('Trail Ghost');
    expect(renderedText(r)).toContain('Exported 1 comment.');
  });

  it('says so, and opens no sheet, when there is nothing to export', async () => {
    mockGetSession.mockResolvedValue(SESSION);
    mockFetch.mockResolvedValue([]);
    const r = await mount();
    await pressExport(r);

    expect(shareSpy).not.toHaveBeenCalled();
    expect(renderedText(r)).toContain('You haven’t posted any comments.');
  });

  it('reports a failed fetch inline', async () => {
    mockGetSession.mockResolvedValue(SESSION);
    mockFetch.mockRejectedValue(new Error('boom'));
    const r = await mount();
    await pressExport(r);

    expect(shareSpy).not.toHaveBeenCalled();
    expect(renderedText(r)).toContain(EXPORT_FAILED_MESSAGE);
  });
});
