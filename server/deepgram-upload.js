import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { del, get, head, list, put } from '@vercel/blob';
import { generateClientTokenFromReadWriteToken } from '@vercel/blob/client';

export const MAX_DIRECT_UPLOAD_BYTES = 4 * 1024 * 1024;
export const MAX_BLOB_UPLOAD_BYTES = 100 * 1024 * 1024;
const PREFIX = 'duowen-transcription/v1/';
const GRANT_LIFETIME_MS = 30 * 60 * 1000;
const CLEANUP_GRACE_MS = 10 * 60 * 1000;
const NO_STORE = { 'Cache-Control': 'no-store' };
const BLOB_SDK = { del, get, head, list, put, generateClientTokenFromReadWriteToken };

export function mediaType(value) {
  if (typeof value !== 'string') return null;
  const type = value.split(';')[0].trim().toLowerCase() || 'application/octet-stream';
  return /^(?:(?:audio|video)\/[\w.+-]+|application\/(?:octet-stream|mp4|ogg))$/.test(type) ? type : null;
}

function json(body, status = 200) {
  return Response.json(body, { status, headers: NO_STORE });
}

function failure(status, code, error) {
  return json({ code, error }, status);
}

function equal(left, right) {
  const actual = Buffer.from(left);
  const expected = Buffer.from(right);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function signature(payload, token) {
  const signingKey = createHmac('sha256', token).update('duowen-transcription/upload-capability/v1').digest();
  return createHmac('sha256', signingKey).update(payload).digest('base64url');
}

function grantPath({ expiresAt, id }) {
  return `${PREFIX}${expiresAt}-${id}`;
}

function verify(capability, token) {
  if (typeof capability !== 'string' || capability.length > 512) return null;
  const [payload, proof, extra] = capability.split('.');
  if (!payload || !proof || extra !== undefined || !equal(proof, signature(payload, token))) return null;

  const grant = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (!Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= Date.now()) return null;
  return grant;
}

function expired(pathname, cutoff) {
  if (!pathname.startsWith(PREFIX)) return false;
  const match = /^(\d{13})-[\da-f-]{36}\/(?:recording|claim)$/.exec(pathname.slice(PREFIX.length));
  return Boolean(match && Number(match[1]) <= cutoff);
}

export function createBlobUploadHandler(blob = BLOB_SDK) {
  async function authorize({ contentType, size }, token) {
    const type = mediaType(contentType);
    if (!type) return failure(415, 'UNSUPPORTED_MEDIA', 'Upload an audio or video file.');
    if (!Number.isSafeInteger(size) || size <= MAX_DIRECT_UPLOAD_BYTES || size > MAX_BLOB_UPLOAD_BYTES) {
      return failure(413, 'FILE_TOO_LARGE', 'Direct storage uploads accept files above 4 MB and up to 100 MB.');
    }
    const grant = { id: randomUUID(), expiresAt: Date.now() + GRANT_LIFETIME_MS, size, contentType: type };
    const pathname = grantPath(grant) + '/recording';
    const clientToken = await blob.generateClientTokenFromReadWriteToken({
      token,
      pathname,
      maximumSizeInBytes: size,
      allowedContentTypes: [type],
      validUntil: grant.expiresAt,
      allowOverwrite: false,
      addRandomSuffix: false,
      cacheControlMaxAge: 60,
    });
    const payload = Buffer.from(JSON.stringify(grant)).toString('base64url');
    return json({ pathname, clientToken, capability: `${payload}.${signature(payload, token)}` });
  }

  async function claim(path, token) {
    const abortSignal = AbortSignal.timeout(7000);
    try {
      await blob.put(path, 'consumed', { access: 'private', token, allowOverwrite: false, addRandomSuffix: false, abortSignal });
      return true;
    } catch (error) {
      // Distinguish an existing claim from a storage failure without relying on error message text.
      const existing = await blob.head(path, { token, abortSignal: AbortSignal.timeout(4000) }).catch(() => null);
      if (existing) return false;
      throw error;
    }
  }

  async function removeRecording(path, token) {
    try {
      await blob.del(path, { token, abortSignal: AbortSignal.timeout(7000) });
      return true;
    } catch {
      // The scheduled sweep retries deletions, including when this invocation terminates early.
      console.warn('Duowen recording cleanup deferred to the scheduled sweep.');
      return false;
    }
  }

  async function handle(action, request, { token, transcribe }) {
    try {
      if (action?.action === 'authorize') return await authorize(action, token);
      if (action?.action !== 'transcribe' && action?.action !== 'cancel') {
        return failure(400, 'INVALID_ACTION', 'Choose a supported upload action.');
      }
      const grant = verify(action.capability, token);
      if (!grant) return failure(403, 'UPLOAD_CAPABILITY_INVALID', 'This upload link is invalid or expired. Upload the file again.');

      const folder = grantPath(grant);
      const path = folder + '/recording';
      const claimPath = folder + '/claim';
      const alreadyUsed = () => failure(409, 'UPLOAD_ALREADY_USED', 'This upload has already been submitted or cancelled.');

      if (action.action === 'cancel') {
        if (!await claim(claimPath, token)) return alreadyUsed();
        if (!await removeRecording(path, token)) return failure(503, 'CLEANUP_PENDING', 'The recording is scheduled for cleanup.');
        return new Response(null, { status: 204, headers: NO_STORE });
      }

      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(265_000)]);
      const stored = await blob.get(path, { access: 'private', token, useCache: false, abortSignal: signal });
      if (stored?.statusCode !== 200) return failure(404, 'UPLOAD_NOT_FOUND', 'No completed upload was found. Upload the file again.');

      let claimed = false;
      try {
        claimed = await claim(claimPath, token);
        if (!claimed) return alreadyUsed();
        if (stored.blob.size !== grant.size || mediaType(stored.blob.contentType) !== grant.contentType) {
          return failure(422, 'UPLOAD_MISMATCH', 'The uploaded recording does not match its authorization.');
        }
        return await transcribe(stored.stream, grant.contentType, signal, grant.size);
      } finally {
        if (!stored.stream.locked) await stored.stream.cancel().catch(() => {});
        if (claimed) await removeRecording(path, token);
      }
    } catch {
      return failure(503, 'STORAGE_UNAVAILABLE', 'Temporary upload storage is unavailable. Please try again.');
    }
  }

  async function cleanup(request, { token, cronSecret }) {
    if (!cronSecret || !equal(request.headers.get('authorization') ?? '', `Bearer ${cronSecret}`)) {
      return failure(401, 'UNAUTHORIZED', 'Cleanup authorization is required.');
    }
    if (!token) return failure(503, 'STORAGE_UNAVAILABLE', 'Temporary upload storage is unavailable.');

    const abortSignal = AbortSignal.timeout(260_000);
    const cutoff = Date.now() - CLEANUP_GRACE_MS;
    let cursor;
    let deleted = 0;
    try {
      do {
        const page = await blob.list({ prefix: PREFIX, cursor, limit: 250, token, abortSignal });
        const paths = page.blobs.map(item => item.pathname).filter(pathname => expired(pathname, cutoff));
        if (paths.length) {
          await blob.del(paths, { token, abortSignal });
          deleted += paths.length;
        }
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      return json({ deleted });
    } catch {
      return failure(503, 'CLEANUP_FAILED', 'The temporary storage sweep did not finish.');
    }
  }

  return { handle, cleanup };
}
