import {
  checksumBytes,
  checksumHeader,
  type PartChecksumAlgorithm,
  type SignedRequest,
  type StorageAdapter,
  type StorageCapabilities,
  type StoredObject,
  type StoredPart,
} from '@open-upload/core';

/**
 * In-memory {@link StorageAdapter} for tests and local prototyping. Signed URLs look like
 * `memory://bucket/key?...` and are served by {@link MemoryStorage.fetch}, which enforces the signed
 * content length and checksum like S3 does, and expiry.
 */
export interface MemoryStorage extends StorageAdapter {
  /** A `fetch` that serves the signed URLs (pass it to the client's transport in tests). */
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  readonly objects: Map<string, { body: Uint8Array; object: StoredObject }>;
  readonly uploads: Map<
    string,
    {
      key: string;
      metadata: Record<string, string>;
      contentType?: string;
      checksum?: PartChecksumAlgorithm;
      parts: Map<number, { body: Uint8Array; part: StoredPart }>;
    }
  >;
  /** Simulates the provider discarding an incomplete upload (lifecycle rule). */
  expireUpload(uploadId: string): void;
}

const MiB = 1024 * 1024;

export function memoryStorage(options: { capabilities?: Partial<StorageCapabilities> } = {}): MemoryStorage {
  const capabilities: StorageCapabilities = {
    maxParts: 10_000,
    minPartSize: 5 * MiB,
    maxPartSize: 5 * 1024 * MiB,
    maxObjectSize: 5 * 1024 * 1024 * MiB,
    maxSinglePutSize: 5 * 1024 * MiB,
    maxPresignExpiry: 7 * 86_400,
    checksums: ['crc32c', 'sha256'],
    incompleteUploadExpiry: null,
    conditionalWrites: true,
    ...options.capabilities,
  };
  const objects: MemoryStorage['objects'] = new Map();
  const uploads: MemoryStorage['uploads'] = new Map();
  let counter = 0;

  const sign = (
    method: SignedRequest['method'],
    key: string,
    query: Record<string, string>,
    headers: Record<string, string>,
    expiresIn: number,
  ): SignedRequest => {
    const expiresAt = Date.now() + expiresIn * 1000;
    const url = new URL(`memory://bucket/${encodeURIComponent(key)}`);
    for (const [k, v] of Object.entries({ ...query, expires: String(expiresAt) })) url.searchParams.set(k, v);
    return { method, url: url.toString(), headers, expiresAt };
  };

  const storage: MemoryStorage = {
    name: 'memory',
    capabilities,
    objects,
    uploads,

    async signPutObject(args) {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(args.metadata ?? {})) headers[`x-amz-meta-${k}`] = v;
      if (args.contentType) headers['content-type'] = args.contentType;
      if (args.checksum && args.checksum.algorithm !== 'none')
        headers[checksumHeader(args.checksum.algorithm)] = args.checksum.value;
      return sign('PUT', args.key, { length: String(args.contentLength) }, headers, args.expiresIn);
    },
    async createMultipartUpload(args) {
      const uploadId = `u${++counter}`;
      uploads.set(uploadId, {
        key: args.key,
        metadata: args.metadata ?? {},
        parts: new Map(),
        ...(args.contentType ? { contentType: args.contentType } : {}),
        ...(args.checksumAlgorithm ? { checksum: args.checksumAlgorithm } : {}),
      });
      return { key: args.key, uploadId };
    },
    async signUploadPart(args) {
      const headers: Record<string, string> = {};
      if (args.checksum && args.checksum.algorithm !== 'none')
        headers[checksumHeader(args.checksum.algorithm)] = args.checksum.value;
      return sign(
        'PUT',
        args.key,
        { uploadId: args.uploadId, partNumber: String(args.partNumber), length: String(args.contentLength) },
        headers,
        args.expiresIn,
      );
    },
    async listParts(args) {
      const upload = uploads.get(args.uploadId);
      if (!upload) return null;
      return [...upload.parts.values()].map((p) => p.part).sort((a, b) => a.partNumber - b.partNumber);
    },
    async completeMultipartUpload(args) {
      const upload = uploads.get(args.uploadId);
      if (!upload) return null;
      const chunks = args.parts.map((p) => upload.parts.get(p.partNumber)!.body);
      const body = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let offset = 0;
      for (const c of chunks) {
        body.set(c, offset);
        offset += c.length;
      }
      const etag = `"m${counter}-${args.parts.length}"`;
      objects.set(upload.key, {
        body,
        object: {
          key: upload.key,
          size: body.length,
          etag,
          metadata: upload.metadata,
          ...(upload.contentType ? { contentType: upload.contentType } : {}),
        },
      });
      uploads.delete(args.uploadId);
      return { etag };
    },
    async abortMultipartUpload(args) {
      uploads.delete(args.uploadId);
    },
    async headObject(args) {
      return objects.get(args.key)?.object ?? null;
    },
    async signGetObject(args) {
      return sign(
        'GET',
        args.key,
        args.responseContentDisposition ? { disposition: args.responseContentDisposition } : {},
        {},
        args.expiresIn,
      );
    },
    async deleteObject(args) {
      objects.delete(args.key);
    },
    expireUpload(uploadId) {
      uploads.delete(uploadId);
    },

    async fetch(input, init) {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.protocol !== 'memory:') return fetch(input, init);
      if (Number(url.searchParams.get('expires')) < Date.now())
        return new Response('<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>', {
          status: 403,
        });
      const key = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
      const method = (init?.method ?? 'GET').toUpperCase();
      const headers = new Headers(init?.headers);
      if (method === 'GET') {
        const entry = objects.get(key);
        if (!entry) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
        const disposition = url.searchParams.get('disposition');
        const extra: Record<string, string> = disposition ? { 'content-disposition': disposition } : {};
        const ifMatch = headers.get('if-match');
        if (ifMatch && ifMatch !== entry.object.etag) {
          return new Response('<Error><Code>PreconditionFailed</Code></Error>', { status: 412 });
        }
        const range = /^bytes=(\d+)-(\d*)$/.exec(headers.get('range') ?? '');
        if (range) {
          const start = Number(range[1]);
          const end = range[2] ? Math.min(Number(range[2]) + 1, entry.body.length) : entry.body.length;
          return new Response(entry.body.slice(start, end) as Uint8Array<ArrayBuffer>, {
            status: 206,
            headers: {
              ...extra,
              etag: entry.object.etag,
              'content-range': `bytes ${start}-${end - 1}/${entry.body.length}`,
            },
          });
        }
        return new Response(entry.body as Uint8Array<ArrayBuffer>, {
          status: 200,
          headers: { ...extra, etag: entry.object.etag },
        });
      }
      const body = new Uint8Array(await new Response(init?.body ?? null).arrayBuffer());
      if (body.length !== Number(url.searchParams.get('length'))) {
        return new Response('<Error><Code>SignatureDoesNotMatch</Code></Error>', { status: 403 });
      }
      let checksum: string | undefined;
      for (const algorithm of ['crc32c', 'crc32', 'sha256', 'sha1', 'crc64nvme'] as const) {
        const expected = headers.get(checksumHeader(algorithm));
        if (expected) {
          checksum = await checksumBytes(algorithm, body);
          if (checksum !== expected) return new Response('<Error><Code>BadDigest</Code></Error>', { status: 400 });
        }
      }
      const etag = `"${(await checksumBytes('sha1', body)).slice(0, 12)}"`;
      const uploadId = url.searchParams.get('uploadId');
      if (uploadId) {
        const upload = uploads.get(uploadId);
        if (!upload) return new Response('<Error><Code>NoSuchUpload</Code></Error>', { status: 404 });
        const partNumber = Number(url.searchParams.get('partNumber'));
        upload.parts.set(partNumber, {
          body,
          part: { partNumber, size: body.length, etag, ...(checksum ? { checksum } : {}) },
        });
        return new Response('', { status: 200, headers: { etag } });
      }
      const metadata: Record<string, string> = {};
      headers.forEach((v, k) => {
        if (k.startsWith('x-amz-meta-')) metadata[k.slice(11)] = v;
      });
      const contentType = headers.get('content-type');
      objects.set(key, {
        body,
        object: { key, size: body.length, etag, metadata, ...(contentType ? { contentType } : {}) },
      });
      return new Response('', { status: 200, headers: { etag } });
    },
  };
  return storage;
}
export { type ConformanceOptions, type ConformanceResult, checkStorageConformance } from './conformance.js';
