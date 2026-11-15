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

/**
 * Download links are plain GETs so the browser's native download manager can use them:
 *   GET {baseUrl}/{endpointPath}?{input as query}          (authenticated by the app's cookie/session)
 *   GET {baseUrl}/{endpointPath}/l/{linkTicket}             (sealed, expiring, for links shared without a session)
 * Both re-run `resolve` (authorization) on every hit, then redirect or proxy.
 */
export type DownloadLinkKind = 'session' | 'sealed';
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
  readonly resume?: { readonly tickets?: readonly string[]; readonly byFingerprint?: boolean };
}

export interface InitSession {
  readonly sessionId: string;
  /** Signed, opaque session ticket. Contains no secret. */
  readonly ticket: string;
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
  readonly ticket: string;
  readonly parts: readonly { readonly partNumber: number; readonly checksum?: string }[];
}
export interface SignedPart {
  readonly partNumber: number;
  readonly request: SignedRequest;
}
export interface SignResponse {
  readonly parts: readonly SignedPart[];
}

// --- status (reconciliation; also refreshes the session ticket) -----------

export interface WirePart {
  readonly partNumber: number;
  readonly size: number;
  readonly checksum?: string;
}
export interface StatusRequest {
  readonly ticket: string;
}
export interface StatusResponse {
  readonly state: 'uploading' | 'completed' | 'aborted' | 'expired';
  readonly uploadedParts: readonly WirePart[];
  /** Sliding renewal: the server may hand back a ticket with a later expiry. */
  readonly ticket: string;
  readonly expiresAt: EpochMs;
}

// --- complete --------------------------------------------------------------

export interface CompleteRequest {
  readonly ticket: string;
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
  /** Sealed completion receipt (see server `verifyReceipt`). Opaque to the client; forward it to the host. */
  readonly receipt: string;
  /** True when this call found the upload already completed (idempotent retry). */
  readonly alreadyCompleted: boolean;
}

// --- abort -----------------------------------------------------------------

export interface AbortRequest {
  readonly ticket: string;
}

// --- download --------------------------------------------------------------

export interface DownloadRequest<TInput = unknown> {
  readonly input: TInput;
}
export interface DownloadResponse {
  /** Stable link for `<a href download>`; per-user, re-authorized on every hit. Prefer this for native downloads. */
  readonly link: string;
  /** Direct presigned request (managed downloads, `<video src>`). Short-lived. */
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
