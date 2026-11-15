import type { StorageAdapter } from '@open-upload/core';

/** The subset of the Cloudflare Workers `R2Bucket` binding used here (structural, so no workers-types dependency). */
export interface R2BucketLike {
  get(
    key: string,
    options?: { range?: Headers; onlyIf?: Headers },
  ): Promise<{
    size: number;
    httpEtag: string;
    range?: { offset?: number; length?: number; suffix?: number };
    body?: ReadableStream;
    writeHttpMetadata(headers: Headers): void;
  } | null>;
}

/**
 * Adds `getObject` to an R2 storage adapter using the Worker's R2 binding, which enables `delivery: 'proxy'` for
 * downloads: the stable link streams the bytes itself, with `Range` / `If-Range` / `If-None-Match`, so browsers can
 * resume interrupted downloads at any time (no presigned URL to expire). R2 egress is free; the Worker only pipes.
 *
 * Uploads keep using presigned URLs from the S3 API (bindings cannot presign).
 */
export function withR2Binding<S extends StorageAdapter>(
  storage: S,
  bucket: R2BucketLike,
  options: { keyPrefix?: string } = {},
): S {
  const prefix = options.keyPrefix ?? '';
  return {
    ...storage,
    async getObject({ key, headers }) {
      const object = await bucket.get(`${prefix}${key}`, { range: headers, onlyIf: headers });
      if (!object) return new Response('Not found', { status: 404 });
      const out = new Headers({ etag: object.httpEtag, 'accept-ranges': 'bytes' });
      object.writeHttpMetadata(out);
      if (!object.body) {
        // A precondition failed: 304 for If-None-Match, 412 otherwise.
        return new Response(null, { status: headers.has('if-none-match') ? 304 : 412, headers: out });
      }
      const range = object.range;
      if (range && headers.has('range')) {
        const offset = range.offset ?? (range.suffix !== undefined ? object.size - range.suffix : 0);
        const length = range.length ?? object.size - offset;
        out.set('content-range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
        out.set('content-length', String(length));
        return new Response(object.body, { status: 206, headers: out });
      }
      out.set('content-length', String(object.size));
      return new Response(object.body, { status: 200, headers: out });
    },
  };
}
