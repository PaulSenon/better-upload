import type { StorageCapabilities } from '@open-upload/core';

/**
 * A provider is **data**, not code: where the S3 API lives and what it supports. Supporting a new S3-compatible service
 * is a few lines like the ones below (or an inline object), never a new adapter. Values are documented in
 * docs/research/storage-and-browser.md; unknown capabilities fall back to conservative defaults (no checksums).
 */
export interface S3Provider {
  readonly name: string;
  readonly endpoint: string;
  readonly region: string;
  /** `true`: `endpoint/bucket/key`; `false`: `bucket.endpoint/key`. */
  readonly forcePathStyle: boolean;
  readonly capabilities?: Partial<StorageCapabilities>;
}

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const TiB = 1024 ** 4;
const DAY = 86_400_000;

/** Conservative S3 defaults. Anything a provider doesn't state stays here. */
export const S3_DEFAULT_CAPABILITIES: StorageCapabilities = {
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

const S3_CHECKSUMS = ['crc32c', 'crc32', 'sha256', 'sha1'] as const;

/** Amazon S3. Incomplete uploads are kept (and billed) until aborted: add the lifecycle rule. */
export function aws(options: { region: string }): S3Provider {
  return {
    name: 'aws',
    endpoint: `https://s3.${options.region}.amazonaws.com`,
    region: options.region,
    forcePathStyle: false,
    capabilities: { maxObjectSize: 50 * TiB, checksums: S3_CHECKSUMS, conditionalWrites: true },
  };
}

/** Cloudflare R2 (S3 API). Incomplete uploads are discarded after 7 days. Free egress. */
export function cloudflareR2(options: { accountId: string; jurisdiction?: 'eu' | 'fedramp' }): S3Provider {
  const jurisdiction = options.jurisdiction ? `.${options.jurisdiction}` : '';
  return {
    name: 'cloudflare-r2',
    endpoint: `https://${options.accountId}${jurisdiction}.r2.cloudflarestorage.com`,
    region: 'auto',
    forcePathStyle: true,
    capabilities: {
      maxObjectSize: 4.995 * TiB,
      checksums: S3_CHECKSUMS,
      incompleteUploadExpiry: 7 * DAY,
      conditionalWrites: true,
    },
  };
}

/** MinIO (self-hosted). Stale incomplete uploads are discarded after 24 h by default (`api.stale_uploads_expiry`). */
export function minio(options: { endpoint: string; region?: string }): S3Provider {
  return {
    name: 'minio',
    endpoint: options.endpoint,
    region: options.region ?? 'us-east-1',
    forcePathStyle: true,
    capabilities: {
      maxObjectSize: 50 * TiB,
      checksums: S3_CHECKSUMS,
      incompleteUploadExpiry: DAY,
      conditionalWrites: true,
    },
  };
}

/** Backblaze B2 (S3 API). Checksums are not assumed. */
export function backblazeB2(options: { region: string }): S3Provider {
  return {
    name: 'backblaze-b2',
    endpoint: `https://s3.${options.region}.backblazeb2.com`,
    region: options.region,
    forcePathStyle: false,
    capabilities: { maxObjectSize: 10 * TiB },
  };
}

/** Any other S3-compatible service (Wasabi, Tigris, DigitalOcean Spaces, Scaleway, OVH, Hetzner, Garage, …). */
export function s3Compatible(options: {
  endpoint: string;
  region?: string;
  forcePathStyle?: boolean;
  capabilities?: Partial<StorageCapabilities>;
  name?: string;
}): S3Provider {
  return {
    name: options.name ?? 's3-compatible',
    endpoint: options.endpoint,
    region: options.region ?? 'us-east-1',
    forcePathStyle: options.forcePathStyle ?? true,
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
  };
}
