import { SELF, env } from 'cloudflare:test';
import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  authHeaders,
  createComment,
  makeAdmin,
  registerDevice,
  reportComment,
  uploadPhoto,
  url,
  wpId,
  type Device,
} from './helpers';
import { registerAgedDevice } from './community-fixtures';
import { hideCommentPhotos } from '../src/photos';
import { reviewOnReport } from '../src/content-review';
import type { ReviewClient } from '../src/community-review';
import type {
  AdminCommentsResponse,
  BulkSyncResponse,
  UploadCommentPhotoResponse,
} from '../../../src/lib/comments-api-types';

const BASE = 'https://photos.test/';

function keyOf(photoUrl: string): string {
  return photoUrl.replace(BASE, '');
}

function jpeg(n: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, n, n + 1, n + 2]);
}

async function newAdmin(): Promise<Device> {
  const admin = await registerDevice('Moderator');
  await makeAdmin(admin.userId);
  return admin;
}

async function rowOf(id: string) {
  return env.DB.prepare(`SELECT photo_urls_json, photo_hashes_json, deleted_by, updated_at FROM comments WHERE id = ?`)
    .bind(id)
    .first<{
      photo_urls_json: string | null;
      photo_hashes_json: string | null;
      deleted_by: string | null;
      updated_at: string;
    }>();
}

async function urlsOf(id: string): Promise<string[]> {
  return JSON.parse((await rowOf(id))?.photo_urls_json ?? '[]') as string[];
}

/** A comment on `trail` with two photos; returns its id, owner and photo URLs. */
async function commentWithPhotos(label: string, trailId = 'heysen') {
  const owner = await registerDevice('Author');
  const { id } = await createComment(owner, { trailId, waypointId: wpId(label), text: 'Win big at the casino!' });
  const urls: string[] = [];
  for (const n of [1, 2]) {
    const res = await uploadPhoto(owner, id, jpeg(n));
    expect(res.status).toBe(201);
    urls.push(((await res.json()) as UploadCommentPhotoResponse).photoUrl);
  }
  return { owner, id, urls };
}

/** Poll until the hide's waitUntil has moved the photos off `before`. */
async function waitForMove(id: string, before: string[]): Promise<string[]> {
  let now = await urlsOf(id);
  for (let i = 0; i < 40 && now.some((u) => before.includes(u)); i++) {
    await new Promise((r) => setTimeout(r, 25));
    now = await urlsOf(id);
  }
  return now;
}

async function exists(photoUrl: string): Promise<boolean> {
  return (await env.PHOTOS.head(keyOf(photoUrl))) !== null;
}

describe('a comment hidden by reports', () => {
  it('moves its photos off the URLs clients hold, and a restore brings the new ones back', async () => {
    const admin = await newAdmin();
    const { id, urls } = await commentWithPhotos('hidden-photos-reports', 'bibbulmun');
    const hashesBefore = (await rowOf(id))?.photo_hashes_json;
    for (let i = 0; i < 3; i++) {
      expect((await reportComment(await registerAgedDevice(), id, { reason: 'spam' })).status).toBe(201);
    }
    expect((await rowOf(id))?.deleted_by).toBe('reports');

    const moved = await waitForMove(id, urls);
    expect(moved).toHaveLength(2);
    for (const [i, u] of moved.entries()) {
      expect(urls).not.toContain(u);
      expect(u.startsWith(`${BASE}comments/${id}/`)).toBe(true);
      // Same bytes, same type, under the new key; nothing at the old one.
      const obj = await env.PHOTOS.get(keyOf(u));
      expect(Array.from(new Uint8Array(await obj!.arrayBuffer()))).toEqual(Array.from(jpeg(i + 1)));
      expect(obj!.httpMetadata?.contentType).toBe('image/jpeg');
      expect(await exists(urls[i])).toBe(false);
    }
    // Hashes stay index-aligned (same bytes).
    expect((await rowOf(id))?.photo_hashes_json).toBe(hashesBefore);

    // The admin page shows the photos at their new URLs.
    const list = (await (
      await SELF.fetch(url('/v1/admin/comments?reported=1&limit=500'), { headers: authHeaders(admin) })
    ).json()) as AdminCommentsResponse;
    expect(list.comments.find((c) => c.id === id)?.photoUrls).toEqual(moved);

    // A restore un-hides it; the delta delivers the new URLs to every phone.
    const since = (await rowOf(id))!.updated_at;
    const restored = await SELF.fetch(url(`/v1/admin/comments/${id}/restore`), {
      method: 'POST',
      headers: authHeaders(admin),
    });
    expect(restored.status).toBe(204);
    const delta = (await (
      await SELF.fetch(url(`/v1/trails/bibbulmun/comments?since=${encodeURIComponent(since)}`))
    ).json()) as BulkSyncResponse;
    const entry = delta.comments.find((c) => c.id === id);
    expect(entry && 'photoUrls' in entry ? entry.photoUrls : undefined).toEqual(moved);
    for (const u of moved) expect(await exists(u)).toBe(true);
  });

  it('an owner delete of the hidden comment still removes every photo', async () => {
    const { owner, id, urls } = await commentWithPhotos('hidden-photos-delete');
    for (let i = 0; i < 3; i++) await reportComment(await registerAgedDevice(), id, { reason: 'spam' });
    await waitForMove(id, urls);
    const del = await SELF.fetch(url(`/v1/comments/${id}`), { method: 'DELETE', headers: authHeaders(owner) });
    expect(del.status).toBe(204);
    let left = Infinity;
    for (let i = 0; i < 40 && left > 0; i++) {
      left = (await env.PHOTOS.list({ prefix: `comments/${id}/` })).objects.length;
      if (left > 0) await new Promise((r) => setTimeout(r, 25));
    }
    expect(left).toBe(0);
  });
});

describe('a comment hidden by the automated review', () => {
  it('moves its photos too', async () => {
    const { id, urls } = await commentWithPhotos('hidden-photos-review');
    expect((await reportComment(await registerAgedDevice(), id, { reason: 'spam' })).status).toBe(201);
    const client = {
      beta: {
        messages: {
          create: async () =>
            ({
              id: 'msg_test',
              type: 'message',
              role: 'assistant',
              model: 'claude-sonnet-5-5',
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    verdict: 'remove',
                    confidence: 0.95,
                    summary: 'Advert.',
                    categories: ['spam'],
                  }),
                  citations: null,
                },
              ],
              stop_reason: 'end_turn',
              stop_sequence: null,
              usage: { input_tokens: 10, output_tokens: 10 },
            }) as unknown as Anthropic.Beta.Messages.BetaMessage,
        },
      },
    } as unknown as ReviewClient;
    await reviewOnReport(env, 'comment', id, { client });
    expect((await rowOf(id))?.deleted_by).toBe('reports');
    const moved = await urlsOf(id);
    expect(moved).toHaveLength(2);
    for (const [i, u] of moved.entries()) {
      expect(urls).not.toContain(u);
      expect(await exists(u)).toBe(true);
      expect(await exists(urls[i])).toBe(false);
    }
  });
});

describe('hideCommentPhotos', () => {
  it('does nothing to a live comment, and removes its copies if the row was restored meanwhile', async () => {
    const { id, urls } = await commentWithPhotos('hidden-photos-live');
    await hideCommentPhotos(env, id);
    expect(await urlsOf(id)).toEqual(urls);
    expect((await env.PHOTOS.list({ prefix: `comments/${id}/` })).objects).toHaveLength(2);

    // Hidden when the move reads it, restored before the swap: the swap
    // misses, the copies go, and the old URLs stay as they were.
    await env.DB.prepare(`UPDATE comments SET deleted_at = ?, deleted_by = 'reports' WHERE id = ?`)
      .bind(new Date().toISOString(), id)
      .run();
    const racing = {
      ...env,
      PHOTOS: {
        get: (key: string) => env.PHOTOS.get(key),
        put: async (...args: Parameters<R2Bucket['put']>) => {
          await env.DB.prepare(`UPDATE comments SET deleted_at = NULL, deleted_by = NULL WHERE id = ?`).bind(id).run();
          return env.PHOTOS.put(...args);
        },
        delete: (keys: string | string[]) => env.PHOTOS.delete(keys),
      } as unknown as R2Bucket,
    };
    await hideCommentPhotos(racing, id);
    expect(await urlsOf(id)).toEqual(urls);
    const keys = (await env.PHOTOS.list({ prefix: `comments/${id}/` })).objects.map((o) => o.key).sort();
    expect(keys).toEqual(urls.map(keyOf).sort());
  });

  it('leaves the hide standing when R2 fails part-way, and cleans up its copies', async () => {
    const { id, urls } = await commentWithPhotos('hidden-photos-r2-fail');
    await env.DB.prepare(`UPDATE comments SET deleted_at = ?, deleted_by = 'reports' WHERE id = ?`)
      .bind(new Date().toISOString(), id)
      .run();
    let puts = 0;
    const flaky = {
      ...env,
      PHOTOS: {
        get: (key: string) => env.PHOTOS.get(key),
        put: async (...args: Parameters<R2Bucket['put']>) => {
          if (++puts === 2) throw new Error('R2 down');
          return env.PHOTOS.put(...args);
        },
        delete: (keys: string | string[]) => env.PHOTOS.delete(keys),
      } as unknown as R2Bucket,
    };
    await expect(hideCommentPhotos(flaky, id)).resolves.toBeUndefined();
    expect((await rowOf(id))?.deleted_by).toBe('reports');
    expect(await urlsOf(id)).toEqual(urls);
    const keys = (await env.PHOTOS.list({ prefix: `comments/${id}/` })).objects.map((o) => o.key).sort();
    expect(keys).toEqual(urls.map(keyOf).sort());
  });
});
