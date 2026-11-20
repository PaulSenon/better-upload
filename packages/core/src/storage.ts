import type { PartChecksumAlgorithm } from './contract.js';
import type { EpochMs } from './units.js';

/**
 * Storage port: the only thing to implement to support a new kind of storage. `@open-upload/s3` implements it once for
 * every S3-compatible service; anything else (Azure Blob, GCS JSON API, Bunny, a local disk for dev) is one object with
 * the 8 required methods below, validated by `checkStorageConformance()` from `@open-upload/server/testing`.
 * Runs server-side only: it holds credentials. Every method is idempotent where the provider allows it.
 */

/** Static, per-provider facts the planner and server use. Adapters ship presets (aws, r2, minio, ...). */
export interface StorageCapabilities {
  /** 10,000 on S3. */
  readonly maxParts: number;
  /** 5 MiB on S3 (last part exempt). */
  readonly minPartSize: number;
  /** 5 GiB on S3. */
  readonly maxPartSize: number;
  /** Max object size the provider accepts (provider limit, not an SDK limit). */
  readonly maxObjectSize: number;
  /** Max single PUT size (5 GiB on S3). */
  readonly maxSinglePutSize: number;
  /** Longest validity of a presigned URL (7 days for SigV4 query auth). */
  readonly maxPresignExpiry: number;
  /** Checksum algorithms supported for multipart parts, best first. Empty = none. */
  readonly checksums: readonly PartChecksumAlgorithm[];
  /**
   * Provider-side delay after which incomplete multipart uploads are discarded even without a lifecycle rule
   * (R2: 7 d, MinIO: 24 h). `null` = kept (and billed) until aborted (AWS).
   */
  readonly incompleteUploadExpiry: number | null;
  /** `If-None-Match: *` on PutObject / CompleteMultipartUpload. */
  readonly conditionalWrites: boolean;
}

/** A request the browser performs directly against the storage. No credentials inside, only a signature. */
export interface SignedRequest {
  readonly method: 'PUT' | 'GET' | 'HEAD';
  readonly url: string;
  /** Headers the client MUST send verbatim (signed checksum / metadata headers). */
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: EpochMs;
}

export interface StoredPart {
  readonly partNumber: number;
  readonly size: number;
  readonly etag: string;
  readonly checksum?: string;
}

export interface StoredObject {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly versionId?: string;
  readonly contentType?: string;
  /** User metadata (`x-amz-meta-*`, lower-cased keys without the prefix). */
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

  /** Presigned single PUT (small files). Signed headers must be sent verbatim by the client. */
  signPutObject(args: {
    key: string;
    contentType?: string;
    contentLength: number;
    checksum?: { algorithm: PartChecksumAlgorithm; value: string };
    metadata?: Record<string, string>;
    expiresIn: number;
  }): Promise<SignedRequest>;

  createMultipartUpload(args: {
    key: string;
    contentType?: string;
    checksumAlgorithm?: PartChecksumAlgorithm;
    metadata?: Record<string, string>;
  }): Promise<MultipartRef>;

  signUploadPart(
    args: MultipartRef & {
      partNumber: number;
      contentLength: number;
      checksum?: { algorithm: PartChecksumAlgorithm; value: string };
      expiresIn: number;
    },
  ): Promise<SignedRequest>;

  /** Source of truth for progress. Returns `null` when the upload no longer exists (`NoSuchUpload`). */
  listParts(args: MultipartRef & { checksumAlgorithm?: PartChecksumAlgorithm }): Promise<StoredPart[] | null>;

  /** Returns `null` when the upload no longer exists (`NoSuchUpload`). */
  completeMultipartUpload(
    args: MultipartRef & {
      parts: readonly StoredPart[];
      checksumAlgorithm?: PartChecksumAlgorithm;
    },
  ): Promise<{ etag: string; versionId?: string } | null>;

  /** Idempotent: aborting an unknown upload succeeds. */
  abortMultipartUpload(args: MultipartRef): Promise<void>;

  headObject(args: { key: string; versionId?: string }): Promise<StoredObject | null>;

  signGetObject(args: {
    key: string;
    versionId?: string;
    expiresIn: number;
    responseContentDisposition?: string;
    responseContentType?: string;
  }): Promise<SignedRequest>;

  /** Optional: streams the object itself (Range pass-through). Used by `delivery: 'proxy'`. */
  getObject?(args: { key: string; versionId?: string; headers: Headers }): Promise<Response>;

  /** Optional: not used by the upload flow; handy for apps and tests. */
  deleteObject?(args: { key: string; versionId?: string }): Promise<void>;
}
