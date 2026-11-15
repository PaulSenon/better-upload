import type {
  BuiltinError,
  ContractRouter,
  DefOf,
  DownloadContract,
  EndpointError,
  EpochMs,
  FileDescriptor,
  FileRules,
  InferDownloadInput,
  InferUploadInput,
  InferUploadOutput,
  PartChecksumAlgorithm,
  PartPlan,
  ResolveResponse,
  SignedRequest,
  UploadContract,
  UploadErrorShape,
} from '@open-upload/core';

// ---------------------------------------------------------------------------
// Task state machine
// ---------------------------------------------------------------------------

export type UploadStatus =
  /** Restored from local persistence; waiting for the user to re-select the file (`task.attachFile(file)`). */
  | 'needs-file'
  /** Reading the file, verifying a re-selected file against what the storage already holds. */
  | 'preparing'
  /** Asking your server to accept the upload. */
  | 'initializing'
  | 'uploading'
  /** Paused by `task.pause()`; no network activity. */
  | 'paused'
  /** The device is offline; resumes automatically when it comes back. */
  | 'waiting-network'
  /** A transient error; backing off before the next attempt (`nextRetryAt`). */
  | 'retrying'
  | 'completing'
  | 'completed'
  /** Stopped on an error. If `error.retryable`, `task.retry()` continues where it stopped. */
  | 'failed'
  /**
   * Nothing left to resume: the session expired or the storage discarded the incomplete upload.
   * Tell the user; `task.restart()` starts again from 0 %. Never done silently.
   */
  | 'expired'
  | 'canceled';

export interface UploadProgress {
  readonly totalBytes: number;
  /** Bytes in parts the storage confirmed (survives reloads). */
  readonly confirmedBytes: number;
  /** Bytes currently in flight (lost if the request fails). */
  readonly inflightBytes: number;
  /** `(confirmed + inflight) / total`, 0..1. */
  readonly fraction: number;
  readonly partsTotal: number;
  readonly partsConfirmed: number;
  /** Smoothed throughput in bytes/s, once measurable. */
  readonly bytesPerSecond?: number;
  readonly etaMs?: number;
}

export interface UploadSnapshot<TOutput = unknown, TError extends UploadErrorShape = BuiltinError> {
  /** Local task id (equals the session id once the server accepted the upload). */
  readonly id: string;
  readonly endpoint: string;
  readonly file: FileDescriptor;
  readonly status: UploadStatus;
  readonly progress: UploadProgress;
  /** Current number of parallel part uploads (adaptive). */
  readonly concurrency: number;
  /** Set while `retrying`. */
  readonly nextRetryAt?: EpochMs;
  readonly error?: TError;
  readonly output?: TOutput;
  /** Sealed completion receipt, once `completed`. Forward it to your backend if it creates records separately. */
  readonly receipt?: string;
  /** Object key, once the server accepted the upload. */
  readonly key?: string;
  /** Portable session ticket, once the server accepted the upload. */
  readonly ticket?: string;
  readonly sessionExpiresAt?: EpochMs;
  /** True when this task continues an upload started earlier (reload, other device). */
  readonly resumed: boolean;
  readonly createdAt: EpochMs;
  readonly updatedAt: EpochMs;
}

/** Minimal external store (React `useSyncExternalStore`, Vue, Svelte, Solid). */
export interface ReadableStore<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}

export interface UploadTask<TOutput = unknown, TError extends UploadErrorShape = BuiltinError>
  extends ReadableStore<UploadSnapshot<TOutput, TError>> {
  readonly id: string;
  pause(): void;
  resume(): void;
  /** After a retryable failure: continue where it stopped (resets the retry budget). */
  retry(): void;
  /** Only on an `expired` task: start a new session for the same file, from 0 %. */
  restart(): void;
  /** Aborts the upload on the server (best effort) and forgets local state. */
  cancel(): Promise<void>;
  /** Gives the file back to a `needs-file` task. Rejects with `FILE_MISMATCH` if it isn't the same file. */
  attachFile(file: UploadableFile): Promise<void>;
  /** Resolves with the typed output; rejects with a typed {@link UploadErrorShape} (`failed`, `expired`, `canceled`). */
  readonly result: Promise<TOutput>;
}

/** A browser `File`, or any Blob with a name and lastModified (React Native / Node). */
export type UploadableFile = Blob & { readonly name: string; readonly lastModified: number };

// ---------------------------------------------------------------------------
// Ports (all replaceable)
// ---------------------------------------------------------------------------

/** What is persisted locally to resume after a reload. No file bytes, no presigned URLs. */
export interface PersistedUpload {
  readonly id: string;
  readonly endpoint: string;
  readonly baseUrl: string;
  readonly file: FileDescriptor;
  readonly ticket: string;
  readonly key: string;
  readonly plan: PartPlan;
  readonly verify: 'auto' | 'metadata' | 'sample' | 'full';
  /** JSON-serializable input given to `upload()`. Never put secrets here. */
  readonly input: unknown;
  readonly expiresAt: EpochMs;
  readonly createdAt: EpochMs;
  readonly updatedAt: EpochMs;
}

export interface ResumeStore {
  get(id: string): Promise<PersistedUpload | undefined>;
  list(): Promise<PersistedUpload[]>;
  put(record: PersistedUpload): Promise<void>;
  delete(id: string): Promise<void>;
}

/** Computes part checksums with bounded memory. */
export interface Hasher {
  checksum(blob: Blob, algorithm: Exclude<PartChecksumAlgorithm, 'none'>, signal?: AbortSignal): Promise<string>;
}

export interface TransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Sends one part to the storage. XHR in browsers (upload progress), fetch elsewhere. */
export interface Transport {
  send(args: {
    request: SignedRequest;
    body: Blob;
    signal: AbortSignal;
    onProgress?: (loadedBytes: number) => void;
    /** Abort if no progress for this long (ms). */
    stallTimeoutMs: number;
  }): Promise<TransportResponse>;
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

export interface RetryPolicy {
  /** Attempts per part (and per control call) before the task fails as retryable. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export interface ConcurrencyPolicy {
  readonly initial: number;
  readonly min: number;
  readonly max: number;
  /** `adaptive`: +1 after a healthy streak, halved on timeouts / throttling. */
  readonly mode: 'adaptive' | 'fixed';
}

// ---------------------------------------------------------------------------
// Typed client
// ---------------------------------------------------------------------------

type InputArg<TInput> = undefined extends TInput ? { readonly input?: TInput } : { readonly input: TInput };
type OptionalArg<T> = {} extends T ? [options?: T] : [options: T];

export type UploadOptions<C extends UploadContract<any>> = InputArg<InferUploadInput<C>> & {
  readonly signal?: AbortSignal;
  /** Start paused (e.g. "upload on Wi-Fi only" UIs). */
  readonly paused?: boolean;
};

export type EndpointError_<C extends UploadContract<any> | DownloadContract<any>> = EndpointError<DefOf<C>['errors']>;

export type EndpointUploadTask<C extends UploadContract<any>> = UploadTask<InferUploadOutput<C>, EndpointError_<C>>;

export interface UploadEndpointClient<C extends UploadContract<any>> {
  /** Starts an upload, or transparently continues a matching unfinished one (verified first). */
  upload(file: UploadableFile, ...options: OptionalArg<UploadOptions<C>>): EndpointUploadTask<C>;
  /** Several files in one request to your server (one task per file). */
  uploadMany(
    files: readonly UploadableFile[] | FileList,
    ...options: OptionalArg<UploadOptions<C>>
  ): EndpointUploadTask<C>[];
  /**
   * Continues an upload from a ticket your app stored itself (server hook `onUploadStarted`): another device,
   * or after the browser lost its storage. The same file checks apply.
   */
  resume(
    file: UploadableFile,
    options: { readonly ticket: string; readonly signal?: AbortSignal },
  ): EndpointUploadTask<C>;
  /** Unfinished uploads of this endpoint persisted on this device (status `needs-file`). */
  pending(): Promise<EndpointUploadTask<C>[]>;
  /** Client-side check against the contract's file rules (only when the contract value was given). */
  validate(file: UploadableFile | readonly UploadableFile[]): EndpointError_<C> | undefined;
  /** The contract's file rules, when the contract value was given (e.g. for `<input accept>`). */
  readonly rules: FileRules | undefined;
  /** `accept` attribute for `<input type="file">`. */
  readonly accept: string | undefined;
  readonly path: string;
}

export interface DownloadEndpointClient<C extends DownloadContract<any>> {
  /**
   * Stable link for `<a href>` and the browser's own download manager. No network call. Each hit re-authorizes
   * on your server and redirects to a fresh presigned URL, so "retry" in the browser always works.
   */
  link(...options: OptionalArg<InputArg<InferDownloadInput<C>>>): string;
  /** Resolves now: a presigned request plus object info (e.g. for `<video src>` or a custom downloader). */
  resolve(
    ...options: OptionalArg<InputArg<InferDownloadInput<C>> & { readonly signal?: AbortSignal }>
  ): Promise<ResolveResponse>;
  readonly path: string;
}

export type UploadClientTree<T extends ContractRouter> = {
  readonly [K in keyof T]: T[K] extends UploadContract<any>
    ? UploadEndpointClient<T[K]>
    : T[K] extends DownloadContract<any>
      ? DownloadEndpointClient<T[K]>
      : T[K] extends ContractRouter
        ? UploadClientTree<T[K]>
        : never;
};

export type UploadClient<T extends ContractRouter> = UploadClientTree<T> & {
  /** Every task of this client, for global UIs (upload tray, "resume your uploads" banner). */
  readonly $tasks: ReadableStore<readonly UploadTask<unknown, BuiltinError>[]>;
  /** Restores unfinished uploads persisted on this device as `needs-file` tasks. Idempotent. */
  $restore(): Promise<UploadTask<unknown, BuiltinError>[]>;
  $pauseAll(): void;
  $resumeAll(): void;
  /** Stops timers and listeners, aborts in-flight requests (uploads stay resumable). */
  $dispose(): void;
};

export interface UploadClientOptions<T extends ContractRouter> {
  /** e.g. `/api/upload` or `https://api.example.com/api/upload`. Must match the server `basePath`. */
  readonly baseUrl: string;
  /** Pass the contract *value* to validate files on the client before any request. Safe: it holds no secrets. */
  readonly contract?: T;
  /** Extra headers for calls to *your* server (not to the storage), e.g. an auth token. */
  readonly headers?: () => Record<string, string> | Promise<Record<string, string>>;
  readonly credentials?: RequestCredentials;
  /** Default: IndexedDB in browsers, memory elsewhere. `false` disables resume after reload. */
  readonly persistence?: ResumeStore | false;
  /** Default: chunked main-thread hashing (pure TypeScript CRC). */
  readonly hasher?: Hasher;
  /** Default: XHR in browsers, fetch elsewhere. */
  readonly transport?: Transport;
  /** `fetch` used for calls to your server. */
  readonly fetch?: typeof fetch;
  readonly retry?: Partial<RetryPolicy>;
  readonly concurrency?: Partial<ConcurrencyPolicy>;
  /** Default 30 s without progress before a part request is retried. */
  readonly stallTimeoutMs?: number;
}

export type { DownloadContract, UploadContract };
