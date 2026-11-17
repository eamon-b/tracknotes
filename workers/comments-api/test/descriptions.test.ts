import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { authHeaders, linkCode, linkDevice, makeAdmin, putDescription, registerDevice, url } from './helpers';
import type { Device } from './helpers';
import type {
  DescriptionConflictResponse,
  LinkDeviceResponse,
  TrailDescriptionsResponse,
  WaypointDescription,
} from '../../../src/lib/comments-api-types';

function errorCode(body: unknown): string {
  return (body as { error: { code: string } }).error.code;
}

/** A registered device that has been promoted to admin. */
async function adminDevice(name = 'Editor') {
  const device = await registerDevice(name);
  await makeAdmin(device.userId);
  return device;
}

/** A browser linked to `phone`'s account with a link code (a `linked` token). */
async function linkedBrowser(phone: Device): Promise<Device> {
  const { code } = await linkCode(phone);
  const res = await linkDevice({ code, label: 'Admin browser' });
  expect(res.status).toBe(201);
  const body = (await res.json()) as LinkDeviceResponse;
  return { userId: body.userId, token: body.token, displayName: body.displayName };
}

async function readDescriptions(trailId: string, since?: string): Promise<TrailDescriptionsResponse> {
  const query = since === undefined ? '' : `?since=${encodeURIComponent(since)}`;
  const res = await SELF.fetch(url(`/v1/trails/${trailId}/descriptions${query}`));
  expect(res.status).toBe(200);
  return (await res.json()) as TrailDescriptionsResponse;
}

describe('PUT /v1/admin/trails/:trailId/descriptions/:waypointId', () => {
  it('creates a description and returns the stored row', async () => {
    const admin = await adminDevice();
    const res = await putDescription(admin, 'heysen', 'desc-create-wp', {
      description: '  A shady campsite with a reliable tank.  ',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as WaypointDescription;
    expect(body.waypointId).toBe('desc-create-wp');
    expect(body.description).toBe('A shady campsite with a reliable tank.'); // trimmed
    expect(typeof body.updatedAt).toBe('string');

    const row = await env.DB.prepare(
      `SELECT description, updated_at FROM waypoint_descriptions
        WHERE trail_id = ? AND waypoint_id = ?`
    )
      .bind('heysen', 'desc-create-wp')
      .first<{ description: string; updated_at: string }>();
    expect(row?.description).toBe('A shady campsite with a reliable tank.');
    expect(row?.updated_at).toBe(body.updatedAt);
  });

  it('upserts in place, bumping updated_at and keeping one row', async () => {
    const admin = await adminDevice();
    const first = (await (
      await putDescription(admin, 'heysen', 'desc-upsert-wp', { description: 'v1' })
    ).json()) as WaypointDescription;

    // Force a distinguishable clock gap so the bump is observable.
    await env.DB.prepare(`UPDATE waypoint_descriptions SET updated_at = ? WHERE trail_id = ? AND waypoint_id = ?`)
      .bind(new Date(Date.now() - 60_000).toISOString(), 'heysen', 'desc-upsert-wp')
      .run();

    const second = (await (
      await putDescription(admin, 'heysen', 'desc-upsert-wp', { description: 'v2' })
    ).json()) as WaypointDescription;
    expect(second.description).toBe('v2');
    expect(Date.parse(second.updatedAt)).toBeGreaterThan(Date.parse(first.updatedAt) - 60_000);

    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM waypoint_descriptions WHERE waypoint_id = ?`)
      .bind('desc-upsert-wp')
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('leaves updated_at alone when the text is unchanged', async () => {
    // Every `upload-descriptions` run re-PUTs the whole file; a bump here would
    // re-ship every description to every phone on every run.
    const admin = await adminDevice();
    await putDescription(admin, 'heysen', 'desc-same-wp', { description: 'same' });
    const stamp = new Date(Date.now() - 60_000).toISOString();
    await env.DB.prepare(`UPDATE waypoint_descriptions SET updated_at = ? WHERE trail_id = ? AND waypoint_id = ?`)
      .bind(stamp, 'heysen', 'desc-same-wp')
      .run();

    const res = await putDescription(admin, 'heysen', 'desc-same-wp', { description: ' same ' });
    expect(res.status).toBe(200);
    expect((await res.json()) as WaypointDescription).toEqual({
      waypointId: 'desc-same-wp',
      description: 'same',
      updatedAt: stamp,
      source: 'upload',
    });

    // So a delta since before the re-PUT does not carry it.
    const delta = await readDescriptions('heysen', new Date(Date.now() - 30_000).toISOString());
    expect(delta.descriptions.some((d) => d.waypointId === 'desc-same-wp')).toBe(false);

    // A withdrawal of already-withdrawn prose is the same no-op.
    await putDescription(admin, 'heysen', 'desc-same-wp', { description: '' });
    const cleared = await env.DB.prepare(
      `SELECT updated_at FROM waypoint_descriptions WHERE trail_id = ? AND waypoint_id = ?`
    )
      .bind('heysen', 'desc-same-wp')
      .first<{ updated_at: string }>();
    await new Promise((r) => setTimeout(r, 5));
    const again = (await (
      await putDescription(admin, 'heysen', 'desc-same-wp', { description: '' })
    ).json()) as WaypointDescription;
    expect(again.updatedAt).toBe(cleared?.updated_at);
  });

  it('accepts an empty description as a cleared tombstone', async () => {
    const admin = await adminDevice();
    await putDescription(admin, 'heysen', 'desc-clear-wp', { description: 'something' });

    const res = await putDescription(admin, 'heysen', 'desc-clear-wp', { description: '   ' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as WaypointDescription).description).toBe('');

    // Cleared rows are still served, so clients learn the prose was withdrawn.
    const body = await readDescriptions('heysen');
    const row = body.descriptions.find((d) => d.waypointId === 'desc-clear-wp');
    expect(row?.description).toBe('');
  });

  it('accepts exactly 4000 chars and rejects 4001', async () => {
    const admin = await adminDevice();
    const ok = await putDescription(admin, 'heysen', 'desc-len-wp', {
      description: 'x'.repeat(4000),
    });
    expect(ok.status).toBe(200);

    const tooLong = await putDescription(admin, 'heysen', 'desc-len-wp', {
      description: 'x'.repeat(4001),
    });
    expect(tooLong.status).toBe(400);
    expect(errorCode(await tooLong.json())).toBe('invalid_description');
  });

  it('400 for a missing or non-string description', async () => {
    const admin = await adminDevice();
    const missing = await putDescription(admin, 'heysen', 'desc-bad-wp', {});
    expect(missing.status).toBe(400);
    expect(errorCode(await missing.json())).toBe('invalid_description');

    const wrongType = await putDescription(admin, 'heysen', 'desc-bad-wp', { description: 42 });
    expect(wrongType.status).toBe(400);
    expect(errorCode(await wrongType.json())).toBe('invalid_description');
  });

  it('400 for an unknown trail or malformed waypoint id', async () => {
    const admin = await adminDevice();
    const badTrail = await putDescription(admin, 'not-a-trail', 'desc-x-wp', { description: 'x' });
    expect(badTrail.status).toBe(400);
    expect(errorCode(await badTrail.json())).toBe('invalid_trail');

    const badWaypoint = await putDescription(admin, 'heysen', 'ab', { description: 'x' });
    expect(badWaypoint.status).toBe(400);
    expect(errorCode(await badWaypoint.json())).toBe('invalid_waypoint');
  });

  it('401 unauthenticated and 403 for a non-admin', async () => {
    const anon = await SELF.fetch(url('/v1/admin/trails/heysen/descriptions/desc-auth-wp'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'nope' }),
    });
    expect(anon.status).toBe(401);

    const plain = await registerDevice('Plain');
    const res = await putDescription(plain, 'heysen', 'desc-auth-wp', { description: 'nope' });
    expect(res.status).toBe(403);
    expect(errorCode(await res.json())).toBe('forbidden');

    // Nothing was written by either attempt.
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM waypoint_descriptions WHERE waypoint_id = ?`)
      .bind('desc-auth-wp')
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("accepts a linked browser of an admin account, and refuses one of a non-admin's", async () => {
    // The live description editor (src/web/admin-descriptions.html) writes with
    // the linked browser's token, as the moderation pages do.
    const admin = await adminDevice('Linked editor');
    const browser = await linkedBrowser(admin);
    const res = await putDescription(browser, 'heysen', 'desc-linked-wp', { description: 'Edited in the browser.' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as WaypointDescription).description).toBe('Edited in the browser.');

    const plainBrowser = await linkedBrowser(await registerDevice('Plain phone'));
    const refused = await putDescription(plainBrowser, 'heysen', 'desc-linked-wp', { description: 'nope' });
    expect(refused.status).toBe(403);
    const row = await env.DB.prepare(
      `SELECT description FROM waypoint_descriptions WHERE trail_id = ? AND waypoint_id = ?`
    )
      .bind('heysen', 'desc-linked-wp')
      .first<{ description: string }>();
    expect(row?.description).toBe('Edited in the browser.');
  });

  describe('source: which tool wrote the text', () => {
    async function storedSource(trailId: string, waypointId: string): Promise<string | null | undefined> {
      const row = await env.DB.prepare(
        `SELECT source FROM waypoint_descriptions WHERE trail_id = ? AND waypoint_id = ?`
      )
        .bind(trailId, waypointId)
        .first<{ source: string | null }>();
      return row?.source;
    }

    it('stores the source a write names and serves it on the public read', async () => {
      const admin = await adminDevice();
      const live = (await (
        await putDescription(admin, 'overland', 'src-live-wp', { description: 'Tank is closed.', source: 'live' })
      ).json()) as WaypointDescription;
      expect(live.source).toBe('live');
      const uploaded = (await (
        await putDescription(admin, 'overland', 'src-upload-wp', { description: 'From the file.', source: 'upload' })
      ).json()) as WaypointDescription;
      expect(uploaded.source).toBe('upload');

      const read = await readDescriptions('overland');
      expect(read.descriptions.map((d) => [d.waypointId, d.source])).toEqual([
        ['src-live-wp', 'live'],
        ['src-upload-wp', 'upload'],
      ]);
      // Which tool, never who: the row holds nothing about the account or token.
      const columns = await env.DB.prepare(`PRAGMA table_info(waypoint_descriptions)`).all<{ name: string }>();
      expect(columns.results.map((c) => c.name).sort()).toEqual([
        'description',
        'source',
        'trail_id',
        'updated_at',
        'waypoint_id',
      ]);
    });

    it('serves a row with no stored source (older, or a write that names none) as an upload', async () => {
      const admin = await adminDevice();
      // A row as migration 0012 found it.
      await env.DB.prepare(
        `INSERT INTO waypoint_descriptions (trail_id, waypoint_id, description, updated_at)
         VALUES ('thorsborne', 'src-old-wp', 'Uploaded long ago.', '2026-01-01T00:00:00.000Z')`
      ).run();
      const sourceless = (await (
        await putDescription(admin, 'thorsborne', 'src-none-wp', { description: 'No source named.' })
      ).json()) as WaypointDescription;
      expect(sourceless.source).toBe('upload');
      expect(await storedSource('thorsborne', 'src-none-wp')).toBeNull();

      const read = await readDescriptions('thorsborne');
      expect(read.descriptions.map((d) => d.source)).toEqual(['upload', 'upload']);
    });

    it('400 for a source it does not know, writing nothing', async () => {
      const admin = await adminDevice();
      const res = await putDescription(admin, 'heysen', 'src-bad-wp', { description: 'x', source: 'phone' });
      expect(res.status).toBe(400);
      expect(errorCode(await res.json())).toBe('invalid_source');
      expect(await storedSource('heysen', 'src-bad-wp')).toBeUndefined();
    });

    it('follows the text: an upload over a live edit, and a live edit over an upload', async () => {
      const admin = await adminDevice();
      await putDescription(admin, 'heysen', 'src-follow-wp', { description: 'File v1.', source: 'upload' });
      await putDescription(admin, 'heysen', 'src-follow-wp', { description: 'Live fix.', source: 'live' });
      expect(await storedSource('heysen', 'src-follow-wp')).toBe('live');
      // A live clear is a live write too.
      await putDescription(admin, 'heysen', 'src-follow-wp', { description: '', source: 'live' });
      expect(await storedSource('heysen', 'src-follow-wp')).toBe('live');
      await putDescription(admin, 'heysen', 'src-follow-wp', { description: 'File v2.', source: 'upload' });
      expect(await storedSource('heysen', 'src-follow-wp')).toBe('upload');
    });

    it('lets an upload of the same text take a live edit over, without re-shipping it to phones', async () => {
      // The live edit was committed to descriptions.json: the next upload
      // re-sends its text, after which a later file change is an ordinary edit.
      const admin = await adminDevice();
      await putDescription(admin, 'heysen', 'src-adopt-wp', { description: 'Committed since.', source: 'live' });
      const stamp = new Date(Date.now() - 60_000).toISOString();
      await env.DB.prepare(`UPDATE waypoint_descriptions SET updated_at = ? WHERE trail_id = ? AND waypoint_id = ?`)
        .bind(stamp, 'heysen', 'src-adopt-wp')
        .run();

      const res = await putDescription(admin, 'heysen', 'src-adopt-wp', {
        description: 'Committed since.',
        source: 'upload',
      });
      expect(res.status).toBe(200);
      expect((await res.json()) as WaypointDescription).toEqual({
        waypointId: 'src-adopt-wp',
        description: 'Committed since.',
        updatedAt: stamp,
        source: 'upload',
      });
      expect(await storedSource('heysen', 'src-adopt-wp')).toBe('upload');
      const delta = await readDescriptions('heysen', new Date(Date.now() - 30_000).toISOString());
      expect(delta.descriptions.some((d) => d.waypointId === 'src-adopt-wp')).toBe(false);
    });

    it('does not call an unchanged text a live edit', async () => {
      // Saving, from the page, the text an upload already sent changes nothing.
      const admin = await adminDevice();
      await putDescription(admin, 'heysen', 'src-same-wp', { description: 'From the file.', source: 'upload' });
      const res = await putDescription(admin, 'heysen', 'src-same-wp', {
        description: 'From the file.',
        source: 'live',
      });
      expect(((await res.json()) as WaypointDescription).source).toBe('upload');
      expect(await storedSource('heysen', 'src-same-wp')).toBe('upload');
    });
  });

  describe('ifUpdatedAt: the live editor’s optimistic check', () => {
    async function conflictOf(res: Response): Promise<DescriptionConflictResponse> {
      expect(res.status).toBe(409);
      const body = (await res.json()) as DescriptionConflictResponse;
      expect(body.error.code).toBe('description_conflict');
      return body;
    }

    it('writes when the row is the version the client read', async () => {
      const admin = await adminDevice();
      const first = (await (
        await putDescription(admin, 'kep_track', 'pre-ok-wp', { description: 'v1', source: 'upload' })
      ).json()) as WaypointDescription;
      const res = await putDescription(admin, 'kep_track', 'pre-ok-wp', {
        description: 'v2',
        source: 'live',
        ifUpdatedAt: first.updatedAt,
      });
      expect(res.status).toBe(200);
      expect((await res.json()) as WaypointDescription).toMatchObject({ description: 'v2', source: 'live' });
    });

    it('409s with the current row, writing nothing, when the row changed since', async () => {
      // Admin A read v1; admin B saved since; A's save must not replace B's text.
      const admin = await adminDevice();
      const first = (await (
        await putDescription(admin, 'kep_track', 'pre-stale-wp', { description: 'v1', source: 'upload' })
      ).json()) as WaypointDescription;
      await env.DB.prepare(`UPDATE waypoint_descriptions SET updated_at = ? WHERE trail_id = ? AND waypoint_id = ?`)
        .bind(new Date(Date.now() - 60_000).toISOString(), 'kep_track', 'pre-stale-wp')
        .run();
      const theirs = (await (
        await putDescription(admin, 'kep_track', 'pre-stale-wp', { description: 'B’s fix.', source: 'live' })
      ).json()) as WaypointDescription;

      const conflict = await conflictOf(
        await putDescription(admin, 'kep_track', 'pre-stale-wp', {
          description: 'A’s typo fix.',
          source: 'live',
          ifUpdatedAt: first.updatedAt,
        })
      );
      expect(conflict.current).toEqual(theirs);
      const read = await readDescriptions('kep_track');
      expect(read.descriptions.find((d) => d.waypointId === 'pre-stale-wp')).toEqual(theirs);

      // With the version it was just shown, the same save goes through.
      const retry = await putDescription(admin, 'kep_track', 'pre-stale-wp', {
        description: 'A’s typo fix.',
        source: 'live',
        ifUpdatedAt: conflict.current!.updatedAt,
      });
      expect(retry.status).toBe(200);
    });

    it('takes null as "I read no row": creates one, or 409s when one has appeared', async () => {
      const admin = await adminDevice();
      const created = await putDescription(admin, 'kep_track', 'pre-null-wp', {
        description: 'First.',
        source: 'live',
        ifUpdatedAt: null,
      });
      expect(created.status).toBe(200);
      const row = (await created.json()) as WaypointDescription;

      const conflict = await conflictOf(
        await putDescription(admin, 'kep_track', 'pre-null-wp', {
          description: 'Second.',
          source: 'live',
          ifUpdatedAt: null,
        })
      );
      expect(conflict.current).toEqual(row);
    });

    it('409s with no current row when the client names a row that does not exist', async () => {
      const admin = await adminDevice();
      const conflict = await conflictOf(
        await putDescription(admin, 'kep_track', 'pre-missing-wp', {
          description: 'x',
          source: 'live',
          ifUpdatedAt: '2026-11-01T00:00:00.000Z',
        })
      );
      expect(conflict.current).toBeNull();
    });

    it('is not a conflict when the row already holds the text sent', async () => {
      const admin = await adminDevice();
      const stored = (await (
        await putDescription(admin, 'kep_track', 'pre-same-wp', { description: 'Agreed.', source: 'live' })
      ).json()) as WaypointDescription;
      const res = await putDescription(admin, 'kep_track', 'pre-same-wp', {
        description: 'Agreed.',
        source: 'live',
        ifUpdatedAt: '2020-01-01T00:00:00.000Z',
      });
      expect(res.status).toBe(200);
      expect((await res.json()) as WaypointDescription).toEqual(stored);
    });

    it('stays unconditional without one, as the upload and older clients send', async () => {
      const admin = await adminDevice();
      await putDescription(admin, 'kep_track', 'pre-none-wp', { description: 'v1' });
      const res = await putDescription(admin, 'kep_track', 'pre-none-wp', { description: 'v2', source: 'upload' });
      expect(res.status).toBe(200);
      expect(((await res.json()) as WaypointDescription).description).toBe('v2');
    });

    it('400 for a precondition that is not a timestamp or null', async () => {
      const admin = await adminDevice();
      for (const ifUpdatedAt of ['yesterday', 7, {}]) {
        const res = await putDescription(admin, 'kep_track', 'pre-bad-wp', { description: 'x', ifUpdatedAt });
        expect(res.status).toBe(400);
        expect(errorCode(await res.json())).toBe('invalid_precondition');
      }
    });
  });

  it('405 for a wrong method on the admin descriptions path', async () => {
    const admin = await adminDevice();
    const res = await SELF.fetch(url('/v1/admin/trails/heysen/descriptions/desc-method-wp'), {
      method: 'GET',
      headers: authHeaders(admin),
    });
    expect(res.status).toBe(405);
    expect(errorCode(await res.json())).toBe('method_not_allowed');
  });
});

describe('GET /v1/trails/:trailId/descriptions', () => {
  it('is public, ordered by waypoint id, and scoped to the trail', async () => {
    const admin = await adminDevice();
    await putDescription(admin, 'heysen', 'zzz-read-wp', { description: 'last' });
    await putDescription(admin, 'heysen', 'aaa-read-wp', { description: 'first' });
    await putDescription(admin, 'larapinta', 'mmm-read-wp', { description: 'other trail' });

    const heysen = await readDescriptions('heysen');
    const ids = heysen.descriptions.map((d) => d.waypointId);
    expect(ids).toEqual([...ids].sort());
    expect(ids).toContain('aaa-read-wp');
    expect(ids).toContain('zzz-read-wp');
    expect(ids).not.toContain('mmm-read-wp');
    expect(typeof heysen.syncedAt).toBe('string');

    const larapinta = await readDescriptions('larapinta');
    expect(larapinta.descriptions.map((d) => d.waypointId)).toEqual(['mmm-read-wp']);
  });

  it('filters to rows updated after `since`', async () => {
    const admin = await adminDevice();
    await putDescription(admin, 'bibbulmun', 'desc-since-old-wp', { description: 'old' });

    // Backdate the first row and take a watermark between the two writes.
    const oldStamp = new Date(Date.now() - 120_000).toISOString();
    await env.DB.prepare(`UPDATE waypoint_descriptions SET updated_at = ? WHERE trail_id = ? AND waypoint_id = ?`)
      .bind(oldStamp, 'bibbulmun', 'desc-since-old-wp')
      .run();
    const since = new Date(Date.now() - 60_000).toISOString();

    await putDescription(admin, 'bibbulmun', 'desc-since-new-wp', { description: 'new' });

    const delta = await readDescriptions('bibbulmun', since);
    expect(delta.descriptions.map((d) => d.waypointId)).toEqual(['desc-since-new-wp']);

    // The full read still returns both.
    const full = await readDescriptions('bibbulmun');
    expect(full.descriptions.map((d) => d.waypointId)).toEqual(['desc-since-new-wp', 'desc-since-old-wp']);

    // A watermark past every row yields an empty delta with a fresh syncedAt.
    // (+1 ms: the boundary is inclusive, and a row may share `syncedAt`'s ms.)
    const past = new Date(Date.parse(full.syncedAt) + 1).toISOString();
    const empty = await readDescriptions('bibbulmun', past);
    expect(empty.descriptions).toEqual([]);
    expect(Date.parse(empty.syncedAt)).toBeGreaterThanOrEqual(Date.parse(full.syncedAt));
  });

  it('delivers a row stamped exactly at `since`', async () => {
    // `syncedAt` is taken before the SELECT, so a write that commits in the
    // same millisecond just after it would fall through a strict `>`.
    const admin = await adminDevice();
    const stored = (await (
      await putDescription(admin, 'heysen', 'desc-boundary-wp', { description: 'edge' })
    ).json()) as WaypointDescription;

    const delta = await readDescriptions('heysen', stored.updatedAt);
    expect(delta.descriptions.map((d) => d.waypointId)).toContain('desc-boundary-wp');
  });

  it('returns cleared rows in a delta so clients drop stale prose', async () => {
    const admin = await adminDevice();
    await putDescription(admin, 'aawt', 'desc-delta-clear-wp', { description: 'was here' });

    // Backdate the original write so the clear is unambiguously newer than the
    // watermark even if both requests land in the same millisecond.
    await env.DB.prepare(`UPDATE waypoint_descriptions SET updated_at = ? WHERE trail_id = ? AND waypoint_id = ?`)
      .bind(new Date(Date.now() - 120_000).toISOString(), 'aawt', 'desc-delta-clear-wp')
      .run();
    const before = new Date(Date.now() - 60_000).toISOString();

    await putDescription(admin, 'aawt', 'desc-delta-clear-wp', { description: '' });

    const delta = await readDescriptions('aawt', before);
    expect(delta.descriptions).toEqual([
      expect.objectContaining({ waypointId: 'desc-delta-clear-wp', description: '' }),
    ]);
  });

  it('returns an empty list for a trail with no descriptions', async () => {
    const body = await readDescriptions('cape_to_cape');
    expect(body.descriptions).toEqual([]);
  });

  it('400 for an unknown trail id', async () => {
    const res = await SELF.fetch(url('/v1/trails/atlantis/descriptions'));
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('invalid_trail');
  });

  it('405 for a wrong method on the public descriptions path', async () => {
    const res = await SELF.fetch(url('/v1/trails/heysen/descriptions'), { method: 'DELETE' });
    expect(res.status).toBe(405);
  });
});
