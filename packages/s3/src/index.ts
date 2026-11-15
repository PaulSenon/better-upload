import {
  checksumAlgorithmName,
  checksumHeader,
  type PartChecksumAlgorithm,
  type StorageAdapter,
  type StorageCapabilities,
  type StoredObject,
  type StoredPart,
} from '@open-upload/core';
import { type CredentialsProvider, S3Client, xmlBlocks, xmlEscape, xmlValue } from './client.js';

export { type CredentialsProvider, S3Client, type S3ClientOptions, type S3Credentials } from './client.js';
export { presignUrl, signHeaders } from './sigv4.js';

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const TiB = 1024 ** 4;
const DAY = 86_400_000;

/** Provider presets: capabilities and URL conventions. Sources are in docs/research/storage-and-browser.md. */
export type S3Preset = 'aws' | 'cloudflare-r2' | 'minio' | 'backblaze-b2' | 'generic';

const BASE: StorageCapabilities = {
  maxParts: 10_000,
  minPartSize: 5 * MiB,
  maxPartSize: 5 * GiB,
  maxObjectSize: 5 * TiB,
  maxSinglePutSize: 5 * GiB,
  maxPresignExpiry: 7 * 86_400,
  checksums: [],
  incompleteUploadExpiry: null,
  conditionalWrites: false,
};

export const PRESETS: Readonly<Record<S3Preset, { capabilities: StorageCapabilities; forcePathStyle: boolean }>> = {
  aws: {
    forcePathStyle: false,
    capabilities: {
      ...BASE,
      maxObjectSize: 50 * TiB,
      checksums: ['crc32c', 'crc32', 'sha256', 'sha1'],
      conditionalWrites: true,
    },
  },
  'cloudflare-r2': {
    forcePathStyle: true,
    capabilities: {
      ...BASE,
      maxObjectSize: 4.995 * TiB,
      checksums: ['crc32c', 'crc32', 'sha256', 'sha1'],
      incompleteUploadExpiry: 7 * DAY,
      conditionalWrites: true,
    },
  },
  minio: {
    forcePathStyle: true,
    capabilities: {
      ...BASE,
      maxObjectSize: 50 * TiB,
      checksums: ['crc32c', 'crc32', 'sha256', 'sha1'],
      incompleteUploadExpiry: 1 * DAY,
      conditionalWrites: true,
    },
  },
  'backblaze-b2': {
    forcePathStyle: false,
    capabilities: { ...BASE, maxObjectSize: 10 * TiB, checksums: [] },
  },
  generic: { forcePathStyle: true, capabilities: BASE },
};

export interface S3StorageOptions {
  readonly bucket: string;
  readonly credentials: CredentialsProvider;
  /** Fills capabilities and URL style. Default `'generic'` (conservative: no checksums). */
  readonly preset?: S3Preset;
  /** Default `'us-east-1'` (`'auto'` for R2). */
  readonly region?: string;
  /**
   * Storage endpoint. Defaults: AWS `https://s3.{region}.amazonaws.com`; R2 `https://{accountId}.r2.cloudflarestorage.com`.
   * Required for MinIO and generic providers.
   */
  readonly endpoint?: string;
  /** Cloudflare R2 account id (builds the endpoint). */
  readonly accountId?: string;
  readonly forcePathStyle?: boolean;
  /** Override detected capabilities (e.g. a MinIO with a custom stale-upload expiry). */
  readonly capabilities?: Partial<StorageCapabilities>;
  /** Prefix prepended to every key (defence in depth: the server can never write outside it). */
  readonly keyPrefix?: string;
  /** Sign `content-length` into presigned PUTs so the browser cannot send a different size. Default true. */
  readonly signContentLength?: boolean;
  readonly fetch?: typeof fetch;
}

/** S3-compatible {@link StorageAdapter}. */
export function s3Storage(options: S3StorageOptions): StorageAdapter & { readonly client: S3Client } {
  const preset = PRESETS[options.preset ?? 'generic'];
  const region = options.region ?? (options.preset === 'cloudflare-r2' ? 'auto' : 'us-east-1');
  const endpoint =
    options.endpoint ??
    (options.preset === 'aws'
      ? `https://s3.${region}.amazonaws.com`
      : options.preset === 'cloudflare-r2' && options.accountId
        ? `https://${options.accountId}.r2.cloudflarestorage.com`
        : undefined);
  if (!endpoint) throw new TypeError(`s3Storage: "endpoint" is required for preset "${options.preset ?? 'generic'}"`);
  const client = new S3Client({
    endpoint,
    region,
    bucket: options.bucket,
    credentials: options.credentials,
    forcePathStyle: options.forcePathStyle ?? preset.forcePathStyle,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const capabilities: StorageCapabilities = { ...preset.capabilities, ...options.capabilities };
  const prefix = options.keyPrefix ?? '';
  const fullKey = (key: string) => `${prefix}${key}`;
  const signLength = options.signContentLength ?? true;

  const metaHeaders = (metadata: Record<string, string> | undefined) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(metadata ?? {})) out[`x-amz-meta-${k.toLowerCase()}`] = v;
    return out;
  };

  return {
    name: `s3:${options.preset ?? 'generic'}`,
    capabilities,
    client,

    async signPutObject(args) {
      const headers: Record<string, string> = { ...metaHeaders(args.metadata) };
      if (args.contentType) headers['content-type'] = args.contentType;
      if (args.checksum && args.checksum.algorithm !== 'none')
        headers[checksumHeader(args.checksum.algorithm)] = args.checksum.value;
      const signed = await client.presign({
        method: 'PUT',
        key: fullKey(args.key),
        headers,
        ...(signLength ? { implicitHeaders: { 'content-length': String(args.contentLength) } } : {}),
        expiresIn: args.expiresIn,
      });
      return { method: 'PUT', url: signed.url, headers: signed.headers, expiresAt: signed.expiresAt };
    },

    async createMultipartUpload(args) {
      const headers: Record<string, string> = { ...metaHeaders(args.metadata) };
      if (args.contentType) headers['content-type'] = args.contentType;
      if (args.checksumAlgorithm && args.checksumAlgorithm !== 'none') {
        headers['x-amz-checksum-algorithm'] = checksumAlgorithmName(args.checksumAlgorithm);
      }
      const response = await client.request({
        method: 'POST',
        key: fullKey(args.key),
        query: { uploads: '' },
        headers,
      });
      const uploadId = xmlValue(await response.text(), 'UploadId');
      if (!uploadId) throw new Error('CreateMultipartUpload: missing UploadId');
      return { key: args.key, uploadId };
    },

    async signUploadPart(args) {
      const headers: Record<string, string> = {};
      if (args.checksum && args.checksum.algorithm !== 'none')
        headers[checksumHeader(args.checksum.algorithm)] = args.checksum.value;
      const signed = await client.presign({
        method: 'PUT',
        key: fullKey(args.key),
        query: { partNumber: String(args.partNumber), uploadId: args.uploadId },
        headers,
        ...(signLength ? { implicitHeaders: { 'content-length': String(args.contentLength) } } : {}),
        expiresIn: args.expiresIn,
      });
      return { method: 'PUT', url: signed.url, headers: signed.headers, expiresAt: signed.expiresAt };
    },

    async listParts(args) {
      const parts: StoredPart[] = [];
      let marker: string | undefined;
      const tag = checksumTag(args.checksumAlgorithm);
      for (;;) {
        const response = await client.request({
          method: 'GET',
          key: fullKey(args.key),
          query: { uploadId: args.uploadId, 'max-parts': '1000', 'part-number-marker': marker },
          allow: [404],
        });
        const xml = await response.text();
        if (response.status === 404) {
          if (xmlValue(xml, 'Code') === 'NoSuchUpload' || xml === '') return null;
          throw new Error(`ListParts: ${xmlValue(xml, 'Code')}`);
        }
        for (const block of xmlBlocks(xml, 'Part')) {
          const checksum = tag ? xmlValue(block, tag) : undefined;
          parts.push({
            partNumber: Number(xmlValue(block, 'PartNumber')),
            size: Number(xmlValue(block, 'Size')),
            etag: xmlValue(block, 'ETag') ?? '',
            ...(checksum ? { checksum } : {}),
          });
        }
        if (xmlValue(xml, 'IsTruncated') !== 'true') break;
        marker = xmlValue(xml, 'NextPartNumberMarker');
        if (!marker) break;
      }
      return parts.sort((a, b) => a.partNumber - b.partNumber);
    },

    async completeMultipartUpload(args) {
      const tag = checksumTag(args.checksumAlgorithm);
      const body =
        '<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
        args.parts
          .map(
            (p) =>
              `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${xmlEscape(p.etag)}</ETag>` +
              (tag && p.checksum ? `<${tag}>${p.checksum}</${tag}>` : '') +
              '</Part>',
          )
          .join('') +
        '</CompleteMultipartUpload>';
      const response = await client.request({
        method: 'POST',
        key: fullKey(args.key),
        query: { uploadId: args.uploadId },
        headers: { 'content-type': 'application/xml' },
        body,
        allow: [404],
      });
      const xml = await response.text();
      if (response.status === 404) {
        if (xmlValue(xml, 'Code') === 'NoSuchUpload') return null;
        throw new Error(`CompleteMultipartUpload: ${xmlValue(xml, 'Code')}`);
      }
      // S3 may answer 200 with an <Error> body.
      if (xml.includes('<Error>')) {
        const code = xmlValue(xml, 'Code');
        if (code === 'NoSuchUpload') return null;
        throw new Error(`CompleteMultipartUpload: ${code}: ${xmlValue(xml, 'Message')}`);
      }
      const versionId = response.headers.get('x-amz-version-id');
      return { etag: xmlValue(xml, 'ETag') ?? '', ...(versionId ? { versionId } : {}) };
    },

    async abortMultipartUpload(args) {
      await client.request({
        method: 'DELETE',
        key: fullKey(args.key),
        query: { uploadId: args.uploadId },
        allow: [404],
      });
    },

    async headObject(args) {
      const response = await client.request({
        method: 'HEAD',
        key: fullKey(args.key),
        query: { versionId: args.versionId },
        allow: [404, 403],
      });
      if (response.status === 404 || response.status === 403) return null;
      return toStoredObject(args.key, response.headers);
    },

    async signGetObject(args) {
      const signed = await client.presign({
        method: 'GET',
        key: fullKey(args.key),
        query: {
          versionId: args.versionId,
          'response-content-disposition': args.responseContentDisposition,
          'response-content-type': args.responseContentType,
        },
        expiresIn: args.expiresIn,
      });
      return { method: 'GET', url: signed.url, headers: signed.headers, expiresAt: signed.expiresAt };
    },

    async deleteObject(args) {
      await client.request({
        method: 'DELETE',
        key: fullKey(args.key),
        query: { versionId: args.versionId },
        allow: [404],
      });
    },
  };
}

function checksumTag(algorithm: PartChecksumAlgorithm | undefined): string | undefined {
  if (!algorithm || algorithm === 'none') return undefined;
  return `Checksum${algorithm.toUpperCase()}`;
}

function toStoredObject(key: string, headers: Headers): StoredObject {
  const metadata: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (name.startsWith('x-amz-meta-')) metadata[name.slice('x-amz-meta-'.length)] = value;
  });
  const versionId = headers.get('x-amz-version-id');
  const contentType = headers.get('content-type');
  const lastModified = headers.get('last-modified');
  return {
    key,
    size: Number(headers.get('content-length') ?? 0),
    etag: headers.get('etag') ?? '',
    metadata,
    ...(versionId ? { versionId } : {}),
    ...(contentType ? { contentType } : {}),
    ...(lastModified ? { lastModified: Date.parse(lastModified) } : {}),
  };
}

/**
 * The bucket configuration the SDK expects. It is printed, never applied automatically.
 *  - CORS: browsers PUT parts and GET objects directly. `ETag` is exposed for debugging only (the server re-lists parts).
 *  - Lifecycle: abort incomplete multipart uploads after N days, so abandoned uploads stop costing money.
 */
export function recommendedBucketConfig(args: { allowedOrigins: readonly string[]; abortIncompleteAfterDays: number }) {
  return {
    cors: [
      {
        AllowedOrigins: [...args.allowedOrigins],
        AllowedMethods: ['GET', 'PUT', 'HEAD'],
        AllowedHeaders: ['content-type', 'x-amz-checksum-*', 'x-amz-meta-*', 'range', 'if-range', 'if-match'],
        ExposeHeaders: ['ETag', 'Content-Length', 'Content-Range', 'Accept-Ranges'],
        MaxAgeSeconds: 3600,
      },
    ],
    lifecycle: {
      Rules: [
        {
          ID: 'abort-incomplete-multipart-uploads',
          Status: 'Enabled',
          Filter: { Prefix: '' },
          AbortIncompleteMultipartUpload: { DaysAfterInitiation: args.abortIncompleteAfterDays },
        },
      ],
    },
  };
}
