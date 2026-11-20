import type { PartChecksumAlgorithm } from './contract.js';
import type { UploadErrorShape } from './errors.js';
import type { SignedRequest } from './storage.js';
import type { EpochMs } from './units.js';

/**
 * Wire protocol between the client and the server router. Users never call it directly; it is documented
 * so that other clients (Swift, Kotlin, CLI) can exist.
 *
 *   POST {baseUrl}/{endpointPath}/{op}      Content-Type: application/json, header `x-upload-protocol: 1`
 *   GET  {baseUrl}/{endpointPath}?input=…   download link (native download manager), 302 → presigned URL
 *
 * `op` ∈ init | sign | status | complete | abort (uploads) and `resolve` (downloads).
 */
export type UploadOp = 'init' | 'sign' | 'status' | 'complete' | 'abort';
export type DownloadOp = 'resolve' | 'link';
export type ProtocolOp = UploadOp | DownloadOp;

export const PROTOCOL_VERSION = 1 as const;
export const PROTOCOL_HEADER = 'x-upload-protocol';

/** What the client tells the server about a file. Never the content. */
export interface FileDescriptor {
  readonly name: string;
  readonly size: number;
  readonly type: string;
  readonly lastModified: EpochMs;
}

/** Fixed for the life of a session: resume requires the exact same plan. */
export interface PartPlan {
  /** `single`: one presigned PUT. `multipart`: S3 multipart upload. */
  readonly strategy: 'single' | 'multipart';
  readonly fileSize: number;
  /** Size of every part but the last. */
  readonly partSize: number;
  readonly partCount: number;
  readonly checksum: PartChecksumAlgorithm;
}

export interface WirePart {
  readonly partNumber: number;
  readonly size: number;
  /** Base64 checksum the storage holds for this part, when the plan uses one. */
  readonly checksum?: string;
}

// --- init ------------------------------------------------------------------

export interface InitRequest<TInput = unknown> {
  readonly input: TInput;
  readonly files: readonly FileDescriptor[];
}
export interface InitSession {
  readonly sessionId: string;
  /** Sealed, opaque session ticket. Send it back on every later op. */
  readonly ticket: string;
  readonly key: string;
  readonly plan: PartPlan;
  readonly expiresAt: EpochMs;
  /** Endpoint resume policy, so a client that only has the contract *type* still behaves correctly. */
  readonly resume: { readonly enabled: boolean; readonly verify: 'auto' | 'metadata' | 'sample' | 'full' };
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

// --- status (reconciliation; also renews the ticket) -----------------------

export interface StatusRequest {
  readonly ticket: string;
}
export interface StatusResponse {
  readonly state: 'uploading' | 'completed';
  readonly sessionId: string;
  /** The file this session was started with (to verify a re-selected file). */
  readonly file: FileDescriptor;
  readonly key: string;
  readonly plan: PartPlan;
  readonly resume: { readonly enabled: boolean; readonly verify: 'auto' | 'metadata' | 'sample' | 'full' };
  readonly uploadedParts: readonly WirePart[];
  /** Sliding renewal: a ticket with a later expiry (never past the absolute resume TTL). */
  readonly ticket: string;
  readonly expiresAt: EpochMs;
}

// --- complete --------------------------------------------------------------

export interface CompleteRequest {
  readonly ticket: string;
}
export interface CompleteResponse<TOutput = unknown> {
  readonly output: TOutput;
  /** Sealed completion receipt (see server `verifyReceipt`). Opaque; forward it to your own backend if needed. */
  readonly receipt: string;
  /** True when this call found the upload already completed (idempotent retry). */
  readonly alreadyCompleted: boolean;
}

// --- abort -----------------------------------------------------------------

export interface AbortRequest {
  readonly ticket: string;
}

// --- download --------------------------------------------------------------

export interface ResolveRequest<TInput = unknown> {
  readonly input: TInput;
}
export interface ResolveResponse {
  /** Stable link for `<a href download>`; re-authorized on every hit. */
  readonly link: string;
  /** Direct presigned request (`<video src>`, managed downloads). Short-lived. */
  readonly request: SignedRequest;
  readonly object: {
    readonly key: string;
    readonly size?: number;
    readonly etag?: string;
    readonly versionId?: string;
    readonly contentType?: string;
    readonly fileName?: string;
  };
}

// --- errors ----------------------------------------------------------------

export interface ErrorResponse {
  readonly error: Omit<UploadErrorShape, 'cause'>;
}

/** Builds the query string of a download link. Input is JSON so any schema round-trips. */
export function encodeLinkInput(input: unknown): string {
  return input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`;
}
