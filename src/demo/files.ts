// The demo's Supabase Storage: the shop-photos bucket the app adds photos
// to, with the bucket's limits and the policies from supabase/migrations.
// Photos added in the demo are kept in memory while its page is open (a
// phone's localStorage holds a few MB at most); the sample photos of Ali's
// cuts are drawn from their names (sample-photos.ts), so they are always
// there. The app shows a file by its public link, which here is a blob: or
// data: link, as the demo page lets images come only from those.

import { nowIso, newId, tables } from './db.ts';
import { missingFile, sampleFile } from './sample-photos.ts';

export const PHOTO_BUCKET = 'shop-photos';

/** Each bucket's limits, as the migration sets them. */
const BUCKETS: Record<string, { maxBytes: number; types: string[] }> = {
  [PHOTO_BUCKET]: { maxBytes: 2 * 1024 * 1024, types: ['image/jpeg', 'image/png', 'image/webp'] },
};

type StoredFile = { id: string; bytes: Uint8Array; type: string; created_at: string; url?: string };

const files = new Map<string, StoredFile>();
/** Sample files their shop removed, until the demo is reset. */
const removedSamples = new Set<string>();
const keyOf = (bucket: string, path: string) => `${bucket}/${path}`;

/** Forgets every photo added in the demo and brings the samples back. */
export function resetFiles() {
  for (const file of files.values()) if (file.url?.startsWith('blob:')) URL.revokeObjectURL(file.url);
  files.clear();
  removedSamples.clear();
}

function sample(bucket: string, path: string): string | null {
  return bucket === PHOTO_BUCKET && !removedSamples.has(keyOf(bucket, path)) ? sampleFile(path) : null;
}

const svgUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * The link the app shows a file by, as Supabase's public link would be:
 * a photo added in the demo, a sample one, or a card saying the demo no
 * longer has it (one added before the page was last opened).
 */
export function demoFileUrl(bucket: string, path: string): string {
  const file = files.get(keyOf(bucket, path));
  if (file) {
    file.url ??=
      typeof URL.createObjectURL === 'function' && typeof Blob !== 'undefined'
        ? URL.createObjectURL(new Blob([file.bytes as BlobPart], { type: file.type }))
        : `data:${file.type};base64,${base64(file.bytes)}`;
    return file.url;
  }
  return svgUrl(sample(bucket, path) ?? missingFile());
}

// Requests -------------------------------------------------------------------

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

/** Storage's errors carry their own status code as text, besides the HTTP one. */
const storageError = (status: number, error: string, message: string): Reply => ({
  status,
  body: { statusCode: String(status), error, message },
});
const notAllowed = () => storageError(403, 'Unauthorized', 'new row violates row-level security policy');

/** storage.foldername(name)[1] = my_shop_id(): only into, or out of, the caller's own shop's folder. */
function inOwnFolder(path: string, uid: string | null): boolean {
  const shop = uid == null ? undefined : tables().shops.find((s) => s.owner_id === uid);
  const parts = path.split('/');
  return shop != null && parts.length > 1 && parts[0] === shop.id;
}

/** The file in a request: raw bytes with their type in the header, or a form with one file in it. */
async function fileFrom(body: unknown, headers: Headers): Promise<{ bytes: Uint8Array; type: string } | null> {
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const part = [...body.values()].find((v): v is File => typeof v !== 'string');
    return part ? { bytes: new Uint8Array(await part.arrayBuffer()), type: part.type } : null;
  }
  const type = (headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (body instanceof Uint8Array) return { bytes: body, type };
  if (body instanceof ArrayBuffer) return { bytes: new Uint8Array(body), type };
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return { bytes: new Uint8Array(await body.arrayBuffer()), type: body.type || type };
  }
  if (typeof body === 'string') return { bytes: new TextEncoder().encode(body), type };
  return null;
}

/**
 * /storage/v1/object/...: upload (POST <bucket>/<path>), remove (DELETE
 * <bucket> with the paths) and the public link (GET public/<bucket>/<path>).
 */
export async function handleStorage(
  method: string,
  route: string,
  headers: Headers,
  body: unknown,
  uid: string | null,
): Promise<Reply | Response> {
  const [first, ...rest] = route.split('/');
  const isPublic = first === 'public' && method === 'GET';
  const bucket = isPublic ? rest[0] : first;
  const path = (isPublic ? rest.slice(1) : rest).join('/');
  const limits = BUCKETS[bucket ?? ''];
  if (!limits) return storageError(404, 'Bucket not found', 'Bucket not found');

  if (isPublic) {
    const file = files.get(keyOf(bucket, path));
    const svg = file ? null : sample(bucket, path);
    if (!file && svg == null) return storageError(404, 'not_found', 'Object not found');
    return new Response(file ? (file.bytes as BodyInit) : svg, {
      status: 200,
      headers: { 'content-type': file ? file.type : 'image/svg+xml', 'cache-control': 'max-age=31536000' },
    });
  }

  if (method === 'POST' && path !== '') {
    if (!inOwnFolder(path, uid)) return notAllowed();
    const file = await fileFrom(body, headers);
    if (!file) return storageError(400, 'InvalidRequest', 'No file was sent');
    if (!limits.types.includes(file.type)) {
      return storageError(415, 'invalid_mime_type', `mime type ${file.type || 'unknown'} is not supported`);
    }
    if (file.bytes.length > limits.maxBytes) {
      return storageError(413, 'Payload too large', 'The object exceeded the maximum allowed size');
    }
    const key = keyOf(bucket, path);
    if (files.has(key) || sample(bucket, path) != null) {
      // Writing over a file needs an update policy, and owners have none.
      return headers.get('x-upsert') === 'true' ? notAllowed() : storageError(409, 'Duplicate', 'The resource already exists');
    }
    const stored: StoredFile = { id: newId(), bytes: file.bytes, type: file.type, created_at: nowIso() };
    files.set(key, stored);
    return { status: 200, body: { Id: stored.id, Key: key } };
  }

  if (method === 'DELETE' && path === '') {
    const prefixes = (body as { prefixes?: unknown } | undefined)?.prefixes;
    if (!Array.isArray(prefixes)) return storageError(400, 'InvalidRequest', 'body must have required property prefixes');
    // Like Storage, files the caller may not remove are left out of the answer, not refused.
    const removed: Record<string, unknown>[] = [];
    for (const name of new Set(prefixes.map(String))) {
      if (!inOwnFolder(name, uid)) continue;
      const key = keyOf(bucket, name);
      const file = files.get(key);
      if (file) {
        if (file.url?.startsWith('blob:')) URL.revokeObjectURL(file.url);
        files.delete(key);
        removed.push({ name, bucket_id: bucket, id: file.id, metadata: { size: file.bytes.length, mimetype: file.type } });
      } else if (sample(bucket, name) != null) {
        removedSamples.add(key);
        removed.push({ name, bucket_id: bucket, id: null, metadata: { mimetype: 'image/svg+xml' } });
      }
    }
    return { status: 200, body: removed };
  }

  return storageError(400, 'InvalidRequest', `The demo can't do ${method} ${route} yet.`);
}

/** Whether the demo holds a file (tests). */
export function demoHasFile(bucket: string, path: string): boolean {
  return files.has(keyOf(bucket, path)) || sample(bucket, path) != null;
}
