/**
 * @bu-draft/client — DESIGN DRAFT (types only, no runtime).
 *
 * Framework-agnostic client derived from a contract *type* (no server code, no secrets).
 * It only knows: the base URL, the endpoint paths (derived from the contract keys),
 * and optional client-side policies (persistence, hashing, transport, retries).
 */
import type {
  BuiltinError,
  ConcurrencyPolicy,
  ContractRouter,
  DefOf,
  DownloadContract,
  DownloadResponse,
  DownloadSink,
  DownloadTask,
  EndpointError,
  FileRules,
  FingerprintStrategy,
  Hasher,
  InferDownloadInput,
  InferUploadInput,
  InferUploadOutput,
  PartSizePolicy,
  PartTransform,
  PersistedUpload,
  ReadableStore,
  ResumeStore,
  RetryPolicy,
  Transport,
  UploadContract,
  UploadSnapshot,
  UploadTask,
} from '@bu-draft/core';

/** A browser `File`, or any Blob with a name & lastModified (React Native / Node polyfills). */
export type UploadableFile = Blob & { readonly name: string; readonly lastModified: number };

type InputArg<TInput> = undefined extends TInput
  ? { readonly input?: TInput }
  : { readonly input: TInput };

export type UploadOptions<C extends UploadContract<any>> = InputArg<InferUploadInput<C>> & {
  readonly signal?: AbortSignal;
  /** Overrides client defaults for this upload. */
  readonly concurrency?: Partial<ConcurrencyPolicy>;
  readonly retry?: Partial<RetryPolicy>;
  /** Start paused (e.g. "upload on Wi-Fi only" UIs). */
  readonly paused?: boolean;
};

export type EndpointUploadTask<C extends UploadContract<any>> = UploadTask<
  InferUploadOutput<C>,
  EndpointError<DefOf<C>['errors']>
>;

export interface UploadEndpointClient<C extends UploadContract<any>> {
  /** Starts (or transparently resumes, if a matching persisted session exists) an upload. */
  upload(file: UploadableFile, options: UploadOptions<C>): EndpointUploadTask<C>;
  /** Batch: one `init` round-trip, one task per file. */
  uploadMany(files: readonly UploadableFile[], options: UploadOptions<C>): readonly EndpointUploadTask<C>[];
  /** Persisted, unfinished uploads of this endpoint (status `needs-file` until a file is attached). */
  pending(): Promise<readonly EndpointUploadTask<C>[]>;
  /**
   * Resume from a ticket the host app stored itself (e.g. in its DB via the server `onInit` hook):
   * another device, or after browser storage was evicted. Same identity checks as a local resume.
   */
  resume(file: UploadableFile, options: { readonly ticket: string; readonly signal?: AbortSignal }): EndpointUploadTask<C>;
  /** Client-side pre-validation using the contract rules (only when the contract *value* was given). */
  validate(file: UploadableFile): readonly EndpointError<DefOf<C>['errors']>[];
  /** Present when the contract value (not only its type) was passed to `createUploadClient`. */
  readonly rules?: FileRules;
}

export type DownloadOptions<C extends DownloadContract<any>> = InputArg<InferDownloadInput<C>> & {
  readonly signal?: AbortSignal;
  /**
   * Where to write bytes. `'auto'` picks by capability: File System Access (Chromium) → OPFS + export
   * (Safari/Firefox; temporarily doubles disk use) → service-worker stream (not resumable) → memory (small files).
   */
  readonly sink?: DownloadSink | 'auto';
  readonly chunkSize?: number;
};

export interface DownloadEndpointClient<C extends DownloadContract<any>> {
  /**
   * Stable, per-user link for the browser's native download manager (no network call: built from the
   * contract path + input). Retrying in the browser re-hits the server, which re-authorizes and re-signs.
   */
  link(options: InputArg<InferDownloadInput<C>>): string;
  /** Resolve the link target now (presigned request + object info), e.g. for `<video src>`. */
  url(options: InputArg<InferDownloadInput<C>>): Promise<DownloadResponse>;
  /** Managed, resumable ranged download into a sink. */
  download(options: DownloadOptions<C>): DownloadTask<EndpointError<DefOf<C>['errors']>>;
}

export type UploadClient<T extends ContractRouter> = {
  readonly [K in keyof T]: T[K] extends UploadContract<any>
    ? UploadEndpointClient<T[K]>
    : T[K] extends DownloadContract<any>
      ? DownloadEndpointClient<T[K]>
      : T[K] extends ContractRouter
        ? UploadClient<T[K]>
        : never;
} & {
  /** All tasks of this client, for global UIs (upload tray, "resume your uploads" banner). */
  readonly $tasks: ReadableStore<readonly UploadSnapshot<unknown, BuiltinError>[]>;
  /** Restores persisted sessions as `needs-file` tasks. Call once on app start. */
  $restore(): Promise<readonly UploadTask<unknown, BuiltinError>[]>;
  /** Pause / resume everything (e.g. a global "pause uploads" toggle). */
  $pauseAll(): void;
  $resumeAll(): void;
  /** Stop workers, timers, listeners. */
  $dispose(): void;
};

export interface UploadClientOptions<T extends ContractRouter> {
  /** e.g. `/api/upload` or `https://api.example.com/upload`. Must match the server `basePath`. */
  readonly baseUrl: string;
  /** Optional: pass the contract value to enable client-side validation and `rules`. Safe: contains no secrets. */
  readonly contract?: T;
  /** Extra headers / credentials for calls to *your* server (not to the storage). */
  readonly headers?: () => Record<string, string> | Promise<Record<string, string>>;
  readonly credentials?: RequestCredentials;
  /** Default: IndexedDB when available, memory otherwise. `false` disables reload-resume. */
  readonly persistence?: ResumeStore | false;
  /** Default: Web Worker pool with WASM checksums; falls back to main thread. */
  readonly hasher?: Hasher;
  readonly fingerprint?: FingerprintStrategy;
  /** Default: XHR (upload progress). */
  readonly transport?: Transport;
  readonly retry?: Partial<RetryPolicy>;
  readonly concurrency?: Partial<ConcurrencyPolicy>;
  readonly partSize?: Partial<PartSizePolicy>;
  /** Reserved (E2EE / compression). Not in v0 scope. */
  readonly transform?: PartTransform;
  /** Auto-pause when `document.visibilityState === 'hidden'` (iOS freezes background tabs anyway). Default false. */
  readonly pauseWhenHidden?: boolean;
}

export declare function createUploadClient<T extends ContractRouter>(options: UploadClientOptions<T>): UploadClient<T>;

// Default port implementations (declared only).
export declare function indexedDBStore(options?: { dbName?: string }): ResumeStore;
export declare function memoryStore(): ResumeStore;
export declare function workerHasher(options?: { workers?: number }): Hasher;
export declare function xhrTransport(): Transport;
export declare function fetchTransport(): Transport;
export declare function opfsSink(): DownloadSink;

/** Type guard for contract-declared errors (oRPC `isDefinedError` equivalent). */
export declare function isUploadError(error: unknown): error is BuiltinError;

export type { PersistedUpload };
