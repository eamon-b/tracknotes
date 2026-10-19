/**
 * The comments block shared by the waypoint and POI screens: which note it
 * shows when there is no channel, that it reads and files comments under the
 * id it is handed (a POI's `osm_…` id as readily as a waypoint's), and that it
 * reads nothing at all when it has no id.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { CommentsSection } from '../CommentsSection';
import type { ComposerSubmitArgs } from '../Composer';

let mockServerKnown = true;
let mockApiConfigured = true;
const mockList = jest.fn();
const mockCount = jest.fn();
const mockSubmit = jest.fn();
const mockPull = jest.fn();
let mockComposerSubmit: ((args: ComposerSubmitArgs) => Promise<void>) | null = null;
const mockSession = { userId: 'u1', token: 't', displayName: 'Me' };

jest.mock('../../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));
jest.mock('../../../services/server-trails', () => ({
  isServerKnown: () => mockServerKnown,
}));
jest.mock('../../../api/client', () => ({
  isApiConfigured: () => mockApiConfigured,
}));
jest.mock('../../../db/database', () => ({
  getDatabase: async () => ({}),
}));
jest.mock('../../../db/comments-repo', () => ({
  listByWaypoint: (...args: unknown[]) => mockList(...args),
  countByWaypoint: (...args: unknown[]) => mockCount(...args),
}));
jest.mock('../../../sync/comment-sync', () => ({
  pullTrail: (...args: unknown[]) => mockPull(...args),
  submitComment: (...args: unknown[]) => mockSubmit(...args),
  deleteOwnComment: jest.fn(),
  retryOutbox: jest.fn(),
  submitReport: jest.fn(),
}));
jest.mock('../../../sync/sync-events', () => ({
  onSyncChange: () => () => {},
}));
jest.mock('../../../state/identity-store', () => {
  const state = {
    status: 'registered',
    session: { userId: 'u1', token: 't', displayName: 'Me' },
    hydrate: async () => {},
    register: async () => ({ userId: 'u1', token: 't', displayName: 'Me' }),
  };
  const useIdentityStore = (selector: (s: typeof state) => unknown) => selector(state);
  useIdentityStore.getState = () => state;
  return { useIdentityStore };
});
jest.mock('../Composer', () => ({
  Composer: (props: { onSubmit: (args: ComposerSubmitArgs) => Promise<void> }) => {
    mockComposerSubmit = props.onSubmit;
    return null;
  },
}));
jest.mock('../ReportDialog', () => ({ ReportDialog: () => null }));

function allText(tree: ReactTestRenderer): string {
  const out: string[] = [];
  tree.root.findAll(() => true).forEach((n) => {
    const c = n.props.children;
    if (typeof c === 'string') out.push(c);
    else if (Array.isArray(c)) c.forEach((x) => typeof x === 'string' && out.push(x));
  });
  return out.join(' ');
}

async function render(props: Partial<React.ComponentProps<typeof CommentsSection>> = {}) {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(
      <CommentsSection trailId="shikoku" waypointId="osm_way_7" waypointType="resupply" {...props} />,
    );
  });
  return tree;
}

describe('CommentsSection', () => {
  beforeEach(() => {
    mockServerKnown = true;
    mockApiConfigured = true;
    mockComposerSubmit = null;
    mockList.mockReset().mockResolvedValue([]);
    mockCount.mockReset().mockResolvedValue(0);
    mockSubmit.mockReset().mockResolvedValue(undefined);
    mockPull.mockReset().mockResolvedValue({ outcome: 'pulled' });
  });

  it('reads the feed filed under the id it is given', async () => {
    mockList.mockResolvedValue([
      {
        id: 'c1',
        trailId: 'shikoku',
        waypointId: 'osm_way_7',
        authorId: 'u2',
        authorName: 'Aki',
        body: 'This FamilyMart has closed.',
        waterStatus: null,
        photoUrls: [],
        createdAt: '2026-10-09T03:00:00Z',
        source: 'server',
        outboxStatus: null,
        photoUploadStatus: null,
      },
    ]);
    mockCount.mockResolvedValue(1);
    const tree = await render();
    expect(mockList).toHaveBeenCalledWith({}, 'shikoku', 'osm_way_7', { limit: 20 });
    expect(allText(tree)).toContain('This FamilyMart has closed.');
    expect(mockPull).toHaveBeenCalledWith('shikoku');
  });

  it('files a new comment under the same id', async () => {
    await render();
    expect(mockComposerSubmit).not.toBeNull();
    await act(async () => {
      await mockComposerSubmit?.({ text: 'Closed', waterStatus: null, photo: null });
    });
    expect(mockSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ trailId: 'shikoku', waypointId: 'osm_way_7', text: 'Closed', session: mockSession }),
    );
  });

  it('says why, and reads nothing, when the place has no id', async () => {
    const tree = await render({ waypointId: null, unavailableText: 'No comments here.' });
    expect(allText(tree)).toContain('No comments here.');
    expect(mockList).not.toHaveBeenCalled();
    expect(mockComposerSubmit).toBeNull();
  });

  it('on a community route, reads and files comments under the route’s own waypoint ids', async () => {
    await render({ trailId: 'c_AbCdEfGhIjKlMnOp', waypointId: 'uw_0a1b2c3d4e5f' });
    expect(mockList).toHaveBeenCalledWith({}, 'c_AbCdEfGhIjKlMnOp', 'uw_0a1b2c3d4e5f', { limit: 20 });
    expect(mockComposerSubmit).not.toBeNull();
  });

  it('on a community route, is off for an id the server would refuse there', async () => {
    const tree = await render({
      trailId: 'c_AbCdEfGhIjKlMnOp',
      waypointId: 'w_00176641',
      unavailableText: 'No comments here.',
    });
    expect(allText(tree)).toContain('No comments here.');
    expect(mockList).not.toHaveBeenCalled();
    expect(mockComposerSubmit).toBeNull();
  });

  it('is off for an imported trail', async () => {
    mockServerKnown = false;
    const tree = await render();
    expect(allText(tree)).toContain('Comments aren’t available for imported trails.');
    expect(mockList).not.toHaveBeenCalled();
    expect(mockPull).not.toHaveBeenCalled();
  });

  it('is off without a configured server', async () => {
    mockApiConfigured = false;
    const tree = await render();
    expect(allText(tree)).toContain('no server is configured');
    expect(mockComposerSubmit).toBeNull();
  });
});
