import type { PartChecksumAlgorithm, ContentHashAlgorithm } from './contract.js';
import type { SignedRequest } from './storage.js';
import type { EpochMs } from './units.js';
import type { UploadErrorShape } from './errors.js';

/**
 * DESIGN DRAFT — not implemented.
 *
 * Wire protocol between the derived client and the server router. Users never call it
 * directly; it is documented so that other clients (Swift, Kotlin, CLI) can exist.
 *
 *   POST {baseUrl}/{endpointPath}/{op}      Content-Type: application/json
 *
 * `op` ∈ init | sign | status | complete | abort | download.
 * Versioned with the `bu-protocol: 1` request header.
 */

export type ProtocolOp = 'init' | 'sign' | 'status' | 'complete' | 'abort' | 'download';
export const PROTOCOL_VERSION = 1 as const;

/** What the client tells the server about a file. Never the content. */
export interface FileDescriptor {
  readonly name: string;
  readonly size: number;
  readonly type: string;
  readonly lastModified: EpochMs;
  /**
   * Opaque client fingerprint (see identity.ts). Used only to find a resumable session;
   * the server treats it as untrusted.
   */
  readonly fingerprint?: string;
}

/** Fixed for the life of a session: resume requires the exact same plan. */
export interface PartPlan {
  readonly strategy: 'single' | 'multipart';
  readonly fileSize: number;
  readonly partSize: number;
  readonly partCount: number;
  readonly checksum: PartChecksumAlgorithm;
  readonly checksumType: 'composite' | 'full-object';
}

// --- init ------------------------------------------------------------------

export interface InitRequest<TInput = unknown> {
  readonly input: TInput;
  readonly files: readonly FileDescriptor[];
  /** Ask the server to look for an existing resumable session for these files. */
  readonly resume?: { readonly tokens?: readonly string[]; readonly byFingerprint?: boolean };
}

export interface InitSession {
  readonly sessionId: string;
  /** Signed, opaque session token (or reference when a SessionStore is used). Contains no secret. */
  readonly token: string;
  readonly plan: PartPlan;
  readonly expiresAt: EpochMs;
  /** Parts the storage already holds (non-empty when an existing session is resumed). */
  readonly uploadedParts: readonly WirePart[];
  readonly resumed: boolean;
  /** Optional initial batch of signed URLs to save a round-trip. */
  readonly signed?: readonly SignedPart[];
}

export interface InitResponse {
  readonly sessions: readonly InitSession[];
}

// --- sign ------------------------------------------------------------------

export interface SignRequest {
  readonly token: string;
  readonly parts: readonly { readonly partNumber: number; readonly checksum?: string }[];
}
export interface SignedPart {
  readonly partNumber: number;
  readonly request: SignedRequest;
}
export interface SignResponse {
  readonly parts: readonly SignedPart[];
}

// --- status (reconciliation; also refreshes the session token) -----------

export interface WirePart {
  readonly partNumber: number;
  readonly size: number;
  readonly checksum?: string;
}
export interface StatusRequest {
  readonly token: string;
}
export interface StatusResponse {
  readonly state: 'uploading' | 'completed' | 'aborted' | 'expired';
  readonly uploadedParts: readonly WirePart[];
  /** Sliding renewal: the server may hand back a token with a later expiry. */
  readonly token: string;
  readonly expiresAt: EpochMs;
}

// --- complete --------------------------------------------------------------

export interface CompleteRequest {
  readonly token: string;
  /**
   * Optional ETags read by the client (needs CORS `ExposeHeaders: ETag`). The server always
   * re-lists parts from storage, checks part count, per-part size against the plan (guards against
   * empty-body browser bugs) and checksums, and cross-checks these ETags when provided.
   */
  readonly clientParts?: readonly { readonly partNumber: number; readonly etag: string }[];
  /** Whole-file CRC when the plan uses a full-object checksum. */
  readonly fullObjectChecksum?: string;
  readonly contentHash?: { readonly algorithm: ContentHashAlgorithm; readonly value: string };
}
export interface CompleteResponse<TOutput = unknown> {
  readonly output: TOutput;
  /** True when this call found the upload already completed (idempotent retry). */
  readonly alreadyCompleted: boolean;
}

// --- abort -----------------------------------------------------------------

export interface AbortRequest {
  readonly token: string;
}

// --- download --------------------------------------------------------------

export interface DownloadRequest<TInput = unknown> {
  readonly input: TInput;
}
export interface DownloadResponse {
  readonly request: SignedRequest;
  readonly object: {
    readonly size: number;
    readonly etag: string;
    readonly versionId?: string;
    readonly contentType?: string;
    readonly fileName?: string;
  };
}

// --- errors ----------------------------------------------------------------

export interface ErrorResponse {
  readonly error: Omit<UploadErrorShape, 'cause'>;
}
