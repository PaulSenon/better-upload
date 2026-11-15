import type { PartChecksumAlgorithm } from './contract.js';
import type { EpochMs } from './units.js';

/**
 * DESIGN DRAFT — not implemented.
 *
 * Storage port. Implemented by `@bu-draft/s3` (S3-compatible) first; other
 * adapters (Azure Blob, GCS JSON, local FS for tests) can follow. Runs server-side only:
 * it holds credentials. Every method is idempotent where the provider allows it.
 */

/** Static + per-provider facts the planner uses. Adapters ship presets (aws, r2, b2, minio, ...). */
export interface StorageCapabilities {
  /** e.g. 10_000 on S3. */
  readonly maxParts: number;
  /** e.g. 5 MiB on S3 (last part exempt). */
  readonly minPartSize: number;
  /** e.g. 5 GiB on S3. */
  readonly maxPartSize: number;
  /** Max object size the provider accepts (provider-documented; not an SDK limit). AWS: 48.8 TiB; R2: 4.995 TiB. */
  readonly maxObjectSize: number;
  /** Max single PUT size (5 GiB on S3). */
  readonly maxSinglePutSize: number;
  /** Cloudflare R2 requires all parts except the last to have the same size. */
  readonly requiresEqualPartSizes: boolean;
  /** Longest validity a presigned URL can have with the *current* credentials. */
  readonly maxPresignExpiry: number;
  readonly checksums: readonly { readonly algorithm: PartChecksumAlgorithm; readonly type: 'composite' | 'full-object' }[];
  /**
   * Provider-side default after which incomplete multipart uploads are discarded even without a
   * lifecycle rule (R2: 7 d, MinIO AIStor: 24 h, DO Spaces: 30 d). `null` = kept forever (and billed: AWS, GCS).
   * The resume TTL of an endpoint must be lower than min(this, configured lifecycle rule).
   */
  readonly defaultIncompleteUploadExpiry: number | null;
  /** Provider can list in-progress uploads by prefix (stateless recovery, janitor). */
  readonly listMultipartUploads: boolean;
  /** `If-None-Match: *` / `If-Match` on put/complete. */
  readonly conditionalWrites: boolean;
  readonly objectVersioning: boolean;
  /** Provider supports lifecycle rule for incomplete multipart uploads. */
  readonly abortIncompleteLifecycle: boolean;
}

/** A request the browser can perform directly against the storage. No credentials inside, only a signature. */
export interface SignedRequest {
  readonly method: 'PUT' | 'GET' | 'POST' | 'HEAD';
  readonly url: string;
  /** Headers the client MUST send verbatim (signed checksum headers, content-type...). */
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: EpochMs;
}

export interface StoredPart {
  readonly partNumber: number;
  readonly size: number;
  readonly etag: string;
  readonly checksum?: string;
  readonly lastModified?: EpochMs;
}

export interface StoredObject {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly versionId?: string;
  readonly contentType?: string;
  readonly checksum?: { readonly algorithm: PartChecksumAlgorithm; readonly value: string; readonly type: 'composite' | 'full-object' };
  readonly metadata: Readonly<Record<string, string>>;
  readonly lastModified?: EpochMs;
}

export interface MultipartRef {
  readonly key: string;
  readonly uploadId: string;
}

export interface StorageAdapter {
  readonly name: string;
  readonly capabilities: StorageCapabilities;

  // --- single PUT (small files) ---
  signPutObject(args: {
    key: string;
    contentType?: string;
    contentLength: number;
    checksum?: { algorithm: PartChecksumAlgorithm; value: string };
    metadata?: Record<string, string>;
    /** Refuse to overwrite an existing object (provider must support conditional writes). */
    ifNoneMatch?: boolean;
    expiresIn: number;
  }): Promise<SignedRequest>;

  // --- multipart ---
  createMultipartUpload(args: {
    key: string;
    contentType?: string;
    checksumAlgorithm?: PartChecksumAlgorithm;
    metadata?: Record<string, string>;
  }): Promise<MultipartRef>;

  signUploadPart(args: MultipartRef & {
    partNumber: number;
    contentLength: number;
    checksum?: { algorithm: PartChecksumAlgorithm; value: string };
    expiresIn: number;
  }): Promise<SignedRequest>;

  /** Source of truth for reconciliation. Adapter handles pagination. */
  listParts(args: MultipartRef): AsyncIterable<StoredPart>;

  completeMultipartUpload(args: MultipartRef & {
    parts: readonly Pick<StoredPart, 'partNumber' | 'etag' | 'checksum'>[];
    ifNoneMatch?: boolean;
  }): Promise<StoredObject>;

  abortMultipartUpload(args: MultipartRef): Promise<void>;

  /** Optional (see `capabilities.listMultipartUploads`). */
  listMultipartUploads?(args: { prefix: string }): AsyncIterable<MultipartRef & { initiated: EpochMs }>;

  // --- objects ---
  headObject(args: { key: string; versionId?: string }): Promise<StoredObject | null>;
  signGetObject(args: {
    key: string;
    versionId?: string;
    expiresIn: number;
    responseContentDisposition?: string;
    responseContentType?: string;
  }): Promise<SignedRequest>;
  /** Optional: needed for `delivery: 'proxy'` (Range pass-through). */
  getObject?(args: { key: string; versionId?: string; range?: string; ifRange?: string; ifMatch?: string }): Promise<Response>;
  deleteObject(args: { key: string; versionId?: string }): Promise<void>;
}
