/**
 * @bu-draft/server — DESIGN DRAFT (types only, no runtime).
 *
 * Implements a contract. Produces a framework-independent router exposing a
 * Fetch-standard handler `(Request) => Promise<Response>`; framework adapters
 * (Node http / Express / Fastify / Hono / Next / ...) are thin wrappers.
 */
import type {
  AnyEndpointContract,
  ContractRouter,
  DefOf,
  DownloadContract,
  Duration,
  EndpointError,
  ErrorMap,
  FileDescriptor,
  InferUploadOutput,
  InferUploadParsedInput,
  PartPlan,
  PartSizePolicy,
  SchemaOutput,
  StorageAdapter,
  StoredObject,
  UploadContract,
  UploadErrorShape,
  EpochMs,
} from '@bu-draft/core';

// ---------------------------------------------------------------------------
// Context & middleware (oRPC-style: context is typed, extended by middleware)
// ---------------------------------------------------------------------------

/** Always available, regardless of adapter. */
export interface BaseContext {
  readonly request: Request;
}

export type MiddlewareResult<TAdded extends object> = { readonly context: TAdded };

export type Middleware<TIn extends object, TAdded extends object> = (args: {
  readonly context: TIn & BaseContext;
  readonly endpoint: string;
  readonly op: 'init' | 'sign' | 'status' | 'complete' | 'abort' | 'download';
  readonly next: <A extends object = {}>(added?: A) => MiddlewareResult<A>;
}) => MiddlewareResult<TAdded> | Promise<MiddlewareResult<TAdded>>;

/** Throws a typed error declared in the contract (or a built-in code). */
export type ErrorFactory<TErrors extends ErrorMap> = <K extends (keyof TErrors & string) | 'UNAUTHORIZED' | 'FORBIDDEN'>(
  code: K,
  ...rest: K extends keyof TErrors
    ? SchemaOutput<TErrors[K]['data']> extends undefined
      ? [options?: { message?: string }]
      : [options: { message?: string; data: SchemaOutput<TErrors[K]['data']> }]
    : [options?: { message?: string }]
) => never;

// ---------------------------------------------------------------------------
// Session (what the server knows about one file upload)
// ---------------------------------------------------------------------------

export interface UploadSession<TMeta = unknown> {
  readonly id: string;
  readonly endpoint: string;
  readonly key: string;
  readonly uploadId?: string;
  readonly file: FileDescriptor;
  readonly plan: PartPlan;
  /** Server-only data returned by `authorize`, carried inside the signed token (keep it small) or the SessionStore. */
  readonly meta: TMeta;
  readonly createdAt: EpochMs;
  readonly expiresAt: EpochMs;
}

// ---------------------------------------------------------------------------
// Endpoint implementation hooks
// ---------------------------------------------------------------------------

export interface UploadHooks<C extends UploadContract<any>, TCtx extends object, TMeta> {
  /**
   * Runs on `init` (once per batch), after input/file-rule validation. Authorize and return
   * server-only metadata attached to every session of the batch. Throw via `errors` to reject.
   * On every later op (sign/status/complete/abort) the session token is verified instead;
   * use `reauthorize` to re-check permissions on those ops.
   */
  authorize(args: {
    readonly context: TCtx & BaseContext;
    readonly input: InferUploadParsedInput<C>;
    readonly files: readonly FileDescriptor[];
    readonly errors: ErrorFactory<DefOf<C>['errors']>;
  }): TMeta | Promise<TMeta>;

  /** Re-check permissions on later ops (e.g. user still exists, quota). Default: token validity only. */
  reauthorize?(args: {
    readonly context: TCtx & BaseContext;
    readonly session: UploadSession<TMeta>;
    readonly op: 'sign' | 'status' | 'complete' | 'abort';
    readonly errors: ErrorFactory<DefOf<C>['errors']>;
  }): void | Promise<void>;

  /** Object key. Must be deterministic per session; never trust `file.name` as a path. */
  key(args: {
    readonly meta: TMeta;
    readonly file: FileDescriptor;
    readonly sessionId: string;
    readonly input: InferUploadParsedInput<C>;
  }): string;

  /** Optional per-file plan override (e.g. bigger parts for a video endpoint). */
  plan?: Partial<PartSizePolicy>;

  /**
   * After the storage confirmed the object. Delivery is *at-least-once* (a retried `complete`
   * may call it again with `alreadyCompleted: true`); use `session.id` as idempotency key.
   * The return value is validated against the contract `output` schema.
   */
  onComplete(args: {
    readonly context: TCtx & BaseContext;
    readonly session: UploadSession<TMeta>;
    readonly object: StoredObject;
    readonly input: InferUploadParsedInput<C>;
    readonly alreadyCompleted: boolean;
    readonly errors: ErrorFactory<DefOf<C>['errors']>;
  }): InferUploadOutput<C> | Promise<InferUploadOutput<C>>;

  onAbort?(args: { readonly session: UploadSession<TMeta>; readonly reason: 'client' | 'expired' | 'janitor' }): void | Promise<void>;
}

export interface DownloadHooks<C extends DownloadContract<any>, TCtx extends object> {
  resolve(args: {
    readonly context: TCtx & BaseContext;
    readonly input: SchemaOutput<DefOf<C>['input']>;
    readonly errors: ErrorFactory<DefOf<C>['errors']>;
  }):
    | DownloadTarget
    | Promise<DownloadTarget>;
}

export interface DownloadTarget {
  readonly key: string;
  /** Pin a version so resumed ranges cannot mix two object versions. */
  readonly versionId?: string;
  readonly fileName?: string;
  readonly disposition?: 'attachment' | 'inline';
  readonly expiresIn?: Duration;
}

// ---------------------------------------------------------------------------
// Implementer (builder that mirrors the contract tree)
// ---------------------------------------------------------------------------

export interface ImplementedUpload<C extends UploadContract<any>, TCtx extends object, TMeta> {
  readonly '~contract': C;
  readonly '~hooks': UploadHooks<C, TCtx, TMeta>;
}
export interface ImplementedDownload<C extends DownloadContract<any>, TCtx extends object> {
  readonly '~contract': C;
  readonly '~hooks': DownloadHooks<C, TCtx>;
}

export interface UploadImplementer<C extends UploadContract<any>, TCtx extends object> {
  use<TAdded extends object>(mw: Middleware<TCtx, TAdded>): UploadImplementer<C, TCtx & TAdded>;
  /** TMeta is inferred from `authorize`'s return type. */
  handler<TMeta>(hooks: UploadHooks<C, TCtx, TMeta>): ImplementedUpload<C, TCtx, TMeta>;
}
export interface DownloadImplementer<C extends DownloadContract<any>, TCtx extends object> {
  use<TAdded extends object>(mw: Middleware<TCtx, TAdded>): DownloadImplementer<C, TCtx & TAdded>;
  handler(hooks: DownloadHooks<C, TCtx>): ImplementedDownload<C, TCtx>;
}

export type Implementer<T extends ContractRouter, TCtx extends object> = {
  readonly [K in keyof T]: T[K] extends UploadContract<any>
    ? UploadImplementer<T[K], TCtx>
    : T[K] extends DownloadContract<any>
      ? DownloadImplementer<T[K], TCtx>
      : T[K] extends ContractRouter
        ? Implementer<T[K], TCtx>
        : never;
};

/** What `router()` must receive: one implementation per contract leaf (missing leaf = type error). */
export type RouterImplementation<T extends ContractRouter> = {
  readonly [K in keyof T]: T[K] extends UploadContract<any>
    ? ImplementedUpload<T[K], any, any>
    : T[K] extends DownloadContract<any>
      ? ImplementedDownload<T[K], any>
      : T[K] extends ContractRouter
        ? RouterImplementation<T[K]>
        : never;
};

export interface ImplementedRouter<T extends ContractRouter, TCtx extends object> {
  readonly '~contract': T;
  readonly '~context': TCtx;
}

export type RootImplementer<T extends ContractRouter, TCtx extends object> = Implementer<T, TCtx> & {
  /** Declare the context the adapter must provide (e.g. `{ user?: User }` from your auth). */
  $context<TNew extends object>(): RootImplementer<T, TNew>;
  /** Global middleware applied to every endpoint. */
  use<TAdded extends object>(mw: Middleware<TCtx, TAdded>): RootImplementer<T, TCtx & TAdded>;
  router(impl: RouterImplementation<T>): ImplementedRouter<T, TCtx>;
};

export declare function implement<T extends ContractRouter>(contract: T): RootImplementer<T, {}>;

// ---------------------------------------------------------------------------
// Server-side state (optional)
// ---------------------------------------------------------------------------

/**
 * Optional. Default mode is *stateless*: session data is carried in a signed (HMAC) token,
 * and the storage (ListParts / HeadObject) is the source of truth for progress.
 * Provide a SessionStore when you need: revocation, cross-device resume, resume after the
 * client lost its local state, quotas across sessions, exactly-once completion bookkeeping,
 * or an admin view of in-progress uploads.
 */
export interface SessionStore {
  get(id: string): Promise<UploadSession | undefined>;
  put(session: UploadSession, ttlMs: number): Promise<void>;
  delete(id: string): Promise<void>;
  /** Lookup used by `init` with `resume.byFingerprint`. Scoped by an owner chosen in `authorize`. */
  findByFingerprint?(args: { endpoint: string; owner: string; fingerprint: string }): Promise<UploadSession | undefined>;
  /** Mark completion atomically; returns false if it was already marked. */
  markCompleted?(id: string): Promise<boolean>;
}

export interface TokenSigner {
  sign(payload: Uint8Array): Promise<string>;
  verify(token: string): Promise<Uint8Array | null>;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface UploadServerOptions<T extends ContractRouter, TCtx extends object> {
  readonly router: ImplementedRouter<T, TCtx>;
  readonly storage: StorageAdapter;
  /**
   * Secret used to sign session tokens (≥ 32 random bytes). Rotatable: pass an array, first signs, all verify.
   * Not a storage credential.
   */
  readonly secret: string | readonly string[] | TokenSigner;
  readonly sessions?: SessionStore;
  /** Must match the client `baseUrl` path. Default `/api/upload`. */
  readonly basePath?: string;
  /** Presigned URL validity per batch. Default 15 min; capped by `storage.capabilities.maxPresignExpiry`. */
  readonly signedUrlTtl?: Duration;
  /** How many part URLs a single `sign` may return. Default 50. */
  readonly maxSignBatch?: number;
  readonly partSize?: Partial<PartSizePolicy>;
  /** Called for every error before serialization (logging / metrics). Never leaks to the client. */
  readonly onError?: (error: UploadErrorShape, info: { endpoint: string; op: string }) => void;
}

export interface UploadServer<T extends ContractRouter, TCtx extends object> {
  /** Fetch-standard handler. Works as-is on Bun, Deno, Cloudflare Workers, Hono, Next route handlers. */
  fetch(request: Request, context: TCtx): Promise<Response>;
  /** Startup self-check: CORS, lifecycle rule vs resume TTL, credentials expiry vs URL TTL. */
  check(): Promise<readonly { level: 'ok' | 'warn' | 'error'; message: string }[]>;
  readonly '~contract': T;
}

export declare function createUploadServer<T extends ContractRouter, TCtx extends object>(
  options: UploadServerOptions<T, TCtx>,
): UploadServer<T, TCtx>;

/** Type-only helper for apps that want every possible error of one endpoint. */
export type ServerEndpointError<C extends AnyEndpointContract> = EndpointError<DefOf<C>['errors']>;
