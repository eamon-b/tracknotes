/**
 * Photo attachments for comments.
 *
 * Storage: R2 (`PHOTOS` binding), objects keyed `comments/{commentId}/{uploadId}.{ext}`
 * with a fresh uuid per upload (see `uploadCommentPhoto` for why not the index).
 * Public reads happen directly against `PHOTOS_PUBLIC_BASE` (the bucket's custom-domain
 * URL); the worker only ever returns full public URLs. The comment row carries a
 * JSON array of those URLs in `photo_urls_json` (NULL = none).
 *
 * A comment hidden by reports or the automated review keeps its photos (an
 * admin may restore it), but `hideCommentPhotos` moves each object to a fresh
 * key under the same prefix, so the URLs clients already hold stop resolving.
 */

import { HttpError, json } from './http';
import type { Env } from './http';
import { requireUser, sha256HexBytes } from './auth';
import { RATE_BUCKETS, consumeRateLimit, refundRateLimit } from './rate-limit';
import type { CommentRow } from './comments';
import type { PhotoContentType, UploadCommentPhotoResponse } from '../../../src/lib/comments-api-types';

/** Max photos attachable to a single comment. */
const MAX_PHOTOS_PER_COMMENT = 4;
/** Max size of a single uploaded image. */
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
/**
 * How many times an upload re-reads the row after losing the compare-and-swap
 * to a parallel upload on the same comment. Four photos is the most a comment
 * can hold, so this many rounds is enough for every racer to land or be told
 * the comment is full.
 */
const MAX_ATTACH_ATTEMPTS = MAX_PHOTOS_PER_COMMENT + 1;

const CONTENT_TYPE_EXT: Record<PhotoContentType, string> = {
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/**
 * Parse `photo_urls_json` into a string array. Returns undefined for NULL/empty
 * or anything that isn't a JSON array of strings, so callers can omit the field.
 */
export function parsePhotoUrls(raw: string | null): string[] | undefined {
  if (raw === null || raw === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.some((u) => typeof u !== 'string')) {
    return undefined;
  }
  return parsed.length > 0 ? (parsed as string[]) : undefined;
}

/**
 * Parse `photo_hashes_json` into a string array of sha-256 hex digests, parallel
 * to `photo_urls_json`. Rows predating the column are NULL → empty list, so
 * their photos simply aren't dedupe-protected.
 */
export function parsePhotoHashes(raw: string | null): string[] {
  if (raw === null || raw === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed) || parsed.some((h) => typeof h !== 'string')) {
    return [];
  }
  return parsed as string[];
}

/** Extract + validate the request's image content type, or throw 415. */
function requirePhotoContentType(request: Request): PhotoContentType {
  const header = request.headers.get('Content-Type') ?? '';
  const type = header.split(';', 1)[0].trim().toLowerCase();
  if (type === 'image/jpeg' || type === 'image/webp') {
    return type;
  }
  throw new HttpError(415, 'unsupported_media_type', 'Photo Content-Type must be image/jpeg or image/webp');
}

// ---------------------------------------------------------------------------
// POST /v1/comments/:id/photos — attach an image (owner only)
// ---------------------------------------------------------------------------

/** The comment a photo is being attached to: it must exist, be live, and be the caller's. */
async function readOwnLiveComment(env: Env, id: string, userId: string): Promise<CommentRow> {
  const row = await env.DB.prepare(`SELECT * FROM comments WHERE id = ?`).bind(id).first<CommentRow>();
  if (!row) {
    throw new HttpError(404, 'not_found', 'Comment not found');
  }
  if (row.deleted_at !== null) {
    // Tombstoned — its photos are being (or have been) removed from R2.
    throw new HttpError(410, 'comment_deleted', 'Comment has been deleted');
  }
  if (row.user_id !== userId) {
    throw new HttpError(403, 'forbidden', 'You may only add photos to your own comments');
  }
  return row;
}

export async function uploadCommentPhoto(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  id: string
): Promise<Response> {
  const user = await requireUser(request, env, ctx);

  // Checked before the body is buffered, so nobody uploads 5 MB to be told the
  // comment is not theirs. Each retry round below re-reads and re-checks.
  let row = await readOwnLiveComment(env, id, user.id);

  const contentType = requirePhotoContentType(request);

  // Cheap pre-check from Content-Length before buffering the body.
  const declaredLen = request.headers.get('Content-Length');
  if (declaredLen !== null && Number(declaredLen) > MAX_PHOTO_BYTES) {
    throw new HttpError(413, 'photo_too_large', 'Photo must be at most 5 MB');
  }

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) {
    throw new HttpError(400, 'empty_photo', 'Photo body must not be empty');
  }
  if (bytes.byteLength > MAX_PHOTO_BYTES) {
    throw new HttpError(413, 'photo_too_large', 'Photo must be at most 5 MB');
  }
  const hash = await sha256HexBytes(bytes);

  // The object key is unique per upload, not `{index}`: two uploads racing on
  // one comment both read the same photo count, and with an index key the
  // second `put` would overwrite the first's bytes under a URL the first
  // already returned. Stored lazily, once the first round's checks pass.
  const ext = CONTENT_TYPE_EXT[contentType];
  const key = `comments/${id}/${crypto.randomUUID()}.${ext}`;
  let stored = false;
  // The daily allowance, spent once per upload (not per round) just before
  // the bytes go to R2, and handed back unless the photo ends up attached.
  let charged = false;
  let attached = false;
  let rateEvent: number | undefined;
  const base = env.PHOTOS_PUBLIC_BASE.replace(/\/+$/, '');
  const photoUrl = `${base}/${key}`;

  try {
    for (let attempt = 0; attempt < MAX_ATTACH_ATTEMPTS; attempt++) {
      if (attempt > 0) row = await readOwnLiveComment(env, id, user.id);

      const existing = parsePhotoUrls(row.photo_urls_json) ?? [];
      const hashes = parsePhotoHashes(row.photo_hashes_json);

      // Replay detection: a retried upload of bytes we already stored is a
      // success, not a new photo. It short-circuits ahead of the ban and quota
      // checks — exactly as a replayed comment PUT does — so a client retrying
      // its 4th photo isn't told the comment is full, and the row is untouched.
      const replayIndex = hashes.indexOf(hash);
      if (replayIndex !== -1 && replayIndex < existing.length) {
        const replay: UploadCommentPhotoResponse = {
          photoUrl: existing[replayIndex],
          photoUrls: existing,
        };
        return json(replay, 200);
      }

      // A new photo is new public content: refused for a banned account, as a
      // new comment is.
      if (user.is_banned === 1) {
        throw new HttpError(403, 'banned', 'This account may not post photos');
      }

      if (existing.length >= MAX_PHOTOS_PER_COMMENT) {
        throw new HttpError(409, 'too_many_photos', `A comment may have at most ${MAX_PHOTOS_PER_COMMENT} photos`);
      }

      // Daily upload cap through the event log, so parallel uploads cannot
      // all read "one below the limit" and a delete-and-repost still counts.
      const nowMs = Date.now();
      if (!charged) {
        const spec = RATE_BUCKETS.photoUpload;
        rateEvent = await consumeRateLimit(
          env,
          spec,
          user.id,
          nowMs,
          `Photo upload limit of ${spec.limit} per day reached`,
          ctx
        );
        charged = true;
      }

      if (!stored) {
        await env.PHOTOS.put(key, bytes, { httpMetadata: { contentType } });
        stored = true;
      }

      const photoUrls = [...existing, photoUrl];
      // Hashes stay index-aligned with URLs; a NULL/garbled legacy column is
      // padded so `photo_hashes_json[i]` always describes `photo_urls_json[i]`.
      const photoHashes = [...existing.map((_, i) => hashes[i] ?? ''), hash];

      // Compare-and-swap on the list this round read: a parallel upload that
      // committed in between changed it, and writing our list over theirs
      // would drop their photo from the comment (and a delete that landed in
      // between must not get a photo re-attached). `IS` so NULL compares equal.
      const nowIso = new Date(nowMs).toISOString();
      const written = await env.DB.prepare(
        `UPDATE comments
            SET photo_urls_json = ?, photo_hashes_json = ?, updated_at = ?
          WHERE id = ? AND deleted_at IS NULL AND photo_urls_json IS ?`
      )
        .bind(JSON.stringify(photoUrls), JSON.stringify(photoHashes), nowIso, id, row.photo_urls_json)
        .run();
      if ((written.meta.changes ?? 0) === 1) {
        stored = false; // attached: no longer ours to clean up
        attached = true;
        const payload: UploadCommentPhotoResponse = { photoUrl, photoUrls };
        return json(payload, 201);
      }
      // Lost the race: re-read and try again against the winner's list.
    }
    throw new HttpError(409, 'photo_conflict', 'The comment changed during upload; try again');
  } finally {
    // Ended in a replay, a full comment or a conflict on a later round, or
    // any other refusal after the charge: nothing new was stored.
    if (charged && !attached) {
      ctx.waitUntil(
        refundRateLimit(env, rateEvent).catch(() => {
          /* best effort */
        })
      );
    }
    // An object that never made it onto the row (refused, or out of rounds) is
    // unreachable from any comment; remove it rather than leak it.
    if (stored) {
      const orphan = env.PHOTOS.delete(key).catch(() => {
        /* best effort, as with comment deletes */
      });
      ctx.waitUntil(orphan);
    }
  }
}

/**
 * Best-effort removal of every R2 object under a comment's prefix. Called from
 * soft-delete via `ctx.waitUntil` so tombstoned comments don't leak images.
 * Already-cached client URLs may 404 afterwards — that's acceptable.
 */
export async function deleteCommentPhotos(env: Env, commentId: string): Promise<void> {
  const prefix = `comments/${commentId}/`;
  const listed = await env.PHOTOS.list({ prefix });
  const keys = listed.objects.map((o) => o.key);
  if (keys.length > 0) {
    await env.PHOTOS.delete(keys);
  }
}

/** The R2 key behind one of our public photo URLs, or null for a URL not under `base`. */
function keyOfPhotoUrl(base: string, url: string): string | null {
  const prefix = `${base}/`;
  return url.startsWith(prefix) ? url.slice(prefix.length) : null;
}

/**
 * Make a hidden comment's photos unreachable at the URLs clients already hold,
 * without losing them: each object is copied to a fresh, unguessable key under
 * the same `comments/{id}/` prefix (so `deleteCommentPhotos` still finds it),
 * the row's `photo_urls_json` is swapped to the new URLs, and only then are
 * the old objects deleted. An admin restore just un-hides the row, whose
 * `updated_at` bump delivers the new URLs to every phone in its next delta.
 *
 * The swap is a compare-and-swap on the row still being hidden by reports
 * with the list read here: if it was restored or deleted for good meanwhile,
 * the copies are removed instead and the old URLs left as they were. Called
 * after the hide has committed and never throws, so a failure in R2 leaves
 * the comment hidden (with its photos still at their old URLs).
 */
export async function hideCommentPhotos(
  env: Pick<Env, 'DB' | 'PHOTOS' | 'PHOTOS_PUBLIC_BASE'>,
  commentId: string
): Promise<void> {
  const copied: string[] = [];
  try {
    const row = await env.DB.prepare(`SELECT photo_urls_json, deleted_by FROM comments WHERE id = ?`)
      .bind(commentId)
      .first<{ photo_urls_json: string | null; deleted_by: string | null }>();
    if (!row || row.deleted_by !== 'reports') return;
    const urls = parsePhotoUrls(row.photo_urls_json);
    if (!urls) return;
    const base = env.PHOTOS_PUBLIC_BASE.replace(/\/+$/, '');

    const moved: string[] = [];
    const oldKeys: string[] = [];
    for (const url of urls) {
      const key = keyOfPhotoUrl(base, url);
      if (key === null) {
        moved.push(url); // not ours to move
        continue;
      }
      const obj = await env.PHOTOS.get(key);
      if (!obj) {
        moved.push(url); // already gone: nothing to serve at the old URL
        continue;
      }
      const ext = key.includes('.') ? key.slice(key.lastIndexOf('.')) : '';
      const newKey = `comments/${commentId}/${crypto.randomUUID()}${ext}`;
      await env.PHOTOS.put(newKey, await obj.arrayBuffer(), { httpMetadata: obj.httpMetadata });
      copied.push(newKey);
      oldKeys.push(key);
      moved.push(`${base}/${newKey}`);
    }
    if (copied.length === 0) return;

    // `updated_at` is left alone: a hidden row reaches phones as a tombstone,
    // which carries no photos, so nothing they see changes.
    const swapped = await env.DB.prepare(
      `UPDATE comments SET photo_urls_json = ?
        WHERE id = ? AND deleted_by = 'reports' AND photo_urls_json IS ?`
    )
      .bind(JSON.stringify(moved), commentId, row.photo_urls_json)
      .run();
    if ((swapped.meta.changes ?? 0) !== 1) {
      await env.PHOTOS.delete(copied);
      return;
    }
    copied.length = 0; // on the row now: no longer ours to clean up
    await env.PHOTOS.delete(oldKeys);
  } catch (err) {
    console.error(`Moving hidden photos of ${commentId} failed: ${err instanceof Error ? err.message : String(err)}`);
    if (copied.length > 0) {
      await env.PHOTOS.delete(copied).catch(() => {
        /* best effort */
      });
    }
  }
}
