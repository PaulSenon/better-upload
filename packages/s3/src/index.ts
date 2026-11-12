/**
 * @bu-draft/s3 — DESIGN DRAFT (types only).
 * S3-compatible StorageAdapter. Implementation intent: SigV4 presigning with a small signer
 * (e.g. aws4fetch-like) rather than the full AWS SDK, to stay edge-runtime friendly. Open question.
 */
import type { Duration, StorageAdapter, StorageCapabilities } from '@bu-draft/core';

export interface S3Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  /** Temporary credentials cap presigned URL lifetime; the adapter clamps to this. */
  readonly expiresAt?: number;
}

export type CredentialsProvider = S3Credentials | (() => Promise<S3Credentials>);

/** Provider presets fill capabilities + endpoint conventions; values are documented in docs/research/storage-limits.md. */
export type S3Preset = 'aws' | 'cloudflare-r2' | 'backblaze-b2' | 'minio' | 'wasabi' | 'tigris' | 'gcs-xml' | 'scaleway' | 'ovh' | 'digitalocean' | 'generic';

export interface S3StorageOptions {
  readonly bucket: string;
  readonly region: string;
  /** Custom endpoint for non-AWS providers. */
  readonly endpoint?: string;
  readonly forcePathStyle?: boolean;
  readonly credentials: CredentialsProvider;
  readonly preset?: S3Preset;
  /** Override detected capabilities (e.g. a MinIO with custom limits). */
  readonly capabilities?: Partial<StorageCapabilities>;
  /** Optional prefix enforced on every key (defence in depth). */
  readonly keyPrefix?: string;
  readonly defaultUrlTtl?: Duration;
}

export declare function s3Storage(options: S3StorageOptions): StorageAdapter;

/** Generates (does not apply) the bucket config the SDK expects: CORS + lifecycle rule. */
export declare function recommendedBucketConfig(args: {
  allowedOrigins: readonly string[];
  abortIncompleteAfterDays: number;
}): { cors: unknown; lifecycle: unknown };
