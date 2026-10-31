/**
 * The personal export follows every page and sends the stored token.
 */

import { fetchMyComments } from '../my-comments';
import { NO_IDENTITY_MESSAGE } from '../link';
import { getSession } from '../auth';

jest.mock('../auth', () => ({ getSession: jest.fn() }));

const mockGetSession = getSession as jest.Mock;

function scriptedFetch(bodies: unknown[]) {
  let i = 0;
  const fn = jest.fn(async () => {
    const body = bodies[Math.min(i, bodies.length - 1)];
    i += 1;
    return { ok: true, status: 200, statusText: '', text: async () => JSON.stringify(body) };
  });
  return fn as unknown as typeof fetch;
}

const comment = (id: string) => ({
  id,
  trailId: 'heysen',
  waypointId: 'w_00000001',
  text: id,
  waterStatus: null,
  observedAt: null,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  photoUrls: [],
  deletedAt: null,
  deletedBy: null,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSession.mockResolvedValue({ userId: 'u1', token: 'tok', displayName: 'Me' });
});

describe('fetchMyComments', () => {
  it('follows the cursor to the last page with the session token', async () => {
    const fetchImpl = scriptedFetch([
      { comments: [comment('a'), comment('b')], nextCursor: 'c1' },
      { comments: [comment('c')], nextCursor: null },
    ]);
    const got = await fetchMyComments({ baseUrl: 'https://api.test', fetchImpl });
    expect(got.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    const calls = (fetchImpl as unknown as jest.Mock).mock.calls;
    expect(calls.map((c) => c[0])).toEqual([
      'https://api.test/v1/me/comments',
      'https://api.test/v1/me/comments?cursor=c1',
    ]);
    expect(calls[0][1].headers.Authorization).toBe('Bearer tok');
  });

  it('refuses without an identity', async () => {
    mockGetSession.mockResolvedValue(null);
    await expect(
      fetchMyComments({ baseUrl: 'https://api.test', fetchImpl: scriptedFetch([{}]) }),
    ).rejects.toThrow(NO_IDENTITY_MESSAGE);
  });
});
