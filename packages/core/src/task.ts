import type { BuiltinError, UploadErrorShape } from './errors.js';
import type { FileDescriptor, PartPlan } from './protocol.js';
import type { PartChecksumAlgorithm, ContentHashAlgorithm } from './contract.js';
import type { SignedRequest } from './storage.js';
import type { EpochMs } from './units.js';

/**
 * DESIGN DRAFT — not implemented.
 *
 * Framework-agnostic upload task model (TanStack-style core: a small store with
 * `subscribe` / `getSnapshot`, consumed by thin framework bindings).
 */

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export type UploadStatus =
  /** Restored from local persistence; waiting for the user to re-select the file. */
  | 'needs-file'
  /** Reading file metadata / sampling / verifying already uploaded parts. */
  | 'preparing'
  | 'initializing'
  | 'uploading'
  /** Paused by the user (`task.pause()`); no network activity. */
  | 'paused'
  /** Lost connectivity or page hidden; resumes automatically. */
  | 'waiting-network'
  /** Transient error, backing off before the next attempt. */
  | 'retrying'
  | 'completing'
  | 'completed'
  /** Terminal unless `error.retryable` (then `task.retry()`). */
  | 'failed'
  /**
   * The session can no longer be resumed: the ticket expired, or the bucket already discarded the
   * incomplete upload (lifecycle rule, provider cleanup). Never restarted silently: the UI must tell the
   * user and `task.restart()` starts again from 0 % (owner decision, Q7). `error.code` says which case.
   */
  | 'expired'
  | 'canceled';

export interface UploadProgress {
  readonly totalBytes: number;
  /** Bytes in parts the storage confirmed (survives reloads). */
  readonly confirmedBytes: number;
  /** Bytes in flight according to transport progress events (lost if the request fails). */
  readonly inflightBytes: number;
  readonly partsTotal: number;
  readonly partsConfirmed: number;
  /** Smoothed throughput, bytes/s. `undefined` until enough samples. */
  readonly bytesPerSecond?: number;
  readonly etaMs?: number;
}

export interface UploadSnapshot<TOutput = unknown, TError extends UploadErrorShape = BuiltinError> {
  readonly id: string;
  readonly endpoint: string;
  readonly file: FileDescriptor;
  readonly status: UploadStatus;
  readonly progress: UploadProgress;
  readonly attempt: number;
  readonly concurrency: number;
  readonly nextRetryAt?: EpochMs;
  readonly error?: TError;
  readonly output?: TOutput;
  /** Sealed completion receipt, present once `completed`. Forward it to a host "commit" endpoint if you create records separately. */
  readonly receipt?: string;
  readonly createdAt: EpochMs;
  readonly updatedAt: EpochMs;
  readonly sessionExpiresAt?: EpochMs;
}

/** Minimal external-store contract (compatible with React `useSyncExternalStore`, Vue refs, Svelte stores, Solid signals). */
export interface ReadableStore<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}

export interface UploadTask<TOutput = unknown, TError extends UploadErrorShape = BuiltinError>
  extends ReadableStore<UploadSnapshot<TOutput, TError>> {
  readonly id: string;
  /** Portable, opaque session ticket (undefined until `init` returned). The host app may store it to resume elsewhere. */
  readonly ticket: string | undefined;
  pause(): void;
  resume(): void;
  /** Re-run after a retryable failure (resets the retry budget). */
  retry(): void;
  /**
   * Only on an `'expired'` task: starts a new session for the same file, from 0 %.
   * Explicit by design: the SDK never re-sends bytes that were already sent without the app asking.
   */
  restart(): Promise<void>;
  /** Aborts the multipart upload on the server (best effort) and forgets local state. */
  cancel(options?: { keepRemote?: boolean }): Promise<void>;
  /** Attach the re-selected file to a `needs-file` task. Rejects with FILE_MISMATCH. */
  attachFile(file: Blob & { readonly name: string; readonly lastModified: number }): Promise<void>;
  /** Resolves with the typed output; rejects with a typed error. */
  readonly result: Promise<TOutput>;
}

// ---------------------------------------------------------------------------
// Client-side ports (all replaceable; defaults live in @bu-draft/client)
// ---------------------------------------------------------------------------

/** What is persisted locally to resume after a reload. Contains no file bytes and no presigned URLs by default. */
export interface PersistedUpload {
  readonly id: string;
  readonly endpoint: string;
  readonly baseUrl: string;
  readonly file: FileDescriptor;
  readonly ticket: string;
  readonly plan: PartPlan;
  readonly confirmedParts: readonly { partNumber: number; size: number; checksum?: string }[];
  /** Serialized incremental hash state when `contentHash` is enabled. */
  readonly contentHashState?: { readonly algorithm: ContentHashAlgorithm; readonly upToPart: number; readonly state: Uint8Array };
  /** App-provided, JSON-serializable. Never put secrets here. */
  readonly input: unknown;
  readonly expiresAt: EpochMs;
  readonly createdAt: EpochMs;
  readonly updatedAt: EpochMs;
}

export interface ResumeStore {
  get(id: string): Promise<PersistedUpload | undefined>;
  list(filter?: { endpoint?: string }): Promise<PersistedUpload[]>;
  put(record: PersistedUpload): Promise<void>;
  delete(id: string): Promise<void>;
  /** Optional: `navigator.storage.persist()` and quota reporting. */
  persist?(): Promise<boolean>;
}

/** Computes checksums off the main thread with bounded memory (one part in memory per worker). */
export interface Hasher {
  checksum(blob: Blob, algorithm: PartChecksumAlgorithm, signal?: AbortSignal): Promise<string>;
  incremental?(algorithm: ContentHashAlgorithm, from?: Uint8Array): IncrementalHash;
  dispose(): void;
}
export interface IncrementalHash {
  update(blob: Blob): Promise<void>;
  saveState(): Promise<Uint8Array>;
  digest(): Promise<string>;
}

export interface TransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}
/** Sends one part. XHR by default (fetch has no upload progress in browsers). */
export interface Transport {
  send(args: {
    request: SignedRequest;
    body: Blob;
    signal: AbortSignal;
    onProgress?: (loadedBytes: number) => void;
  }): Promise<TransportResponse>;
}

// ---------------------------------------------------------------------------
// Scheduling policies
// ---------------------------------------------------------------------------

export interface RetryPolicy {
  /** Attempts per part before the task fails as retryable. `Infinity` allowed. */
  readonly maxAttemptsPerPart: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Full jitter by default. */
  readonly jitter: 'full' | 'equal' | 'none';
  /** Network-down waiting does not consume attempts. */
  readonly pauseWhileOffline: boolean;
}

export interface ConcurrencyPolicy {
  readonly initial: number;
  readonly min: number;
  readonly max: number;
  /** AIMD: +1 after a healthy window, ×0.5 on timeouts / throttling. `'fixed'` disables adaptation. */
  readonly mode: 'adaptive' | 'fixed';
}

export interface PartSizePolicy {
  /** Preferred part size; clamped to provider min/max and to `ceil(size / maxParts)`. */
  readonly preferred: number;
  /** Below this file size, use a single PUT instead of multipart. */
  readonly singlePutThreshold: number;
}
