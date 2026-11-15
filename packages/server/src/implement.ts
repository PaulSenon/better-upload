import {
  type AnyEndpointContract,
  type ContractRouter,
  type DefOf,
  type DownloadContract,
  type Duration,
  type EpochMs,
  type ErrorMap,
  type FileDescriptor,
  type InferDownloadParsedInput,
  type InferUploadOutput,
  type InferUploadParsedInput,
  isDownloadContract,
  isUploadContract,
  type PartPlan,
  type PartSizePolicy,
  type SchemaOutput,
  type StoredObject,
  type UploadContract,
  UploadError,
} from '@bu-draft/core';

// ---------------------------------------------------------------------------
// Context & middleware (oRPC-style: the context is typed and extended by middleware)
// ---------------------------------------------------------------------------

/** Always available in hooks and middleware, whatever the adapter. */
export interface BaseContext {
  readonly request: Request;
}

/** Operations a middleware can see. Upload ops, plus `download` for download links and `resolve`. */
export type ServerOp = 'init' | 'sign' | 'status' | 'complete' | 'abort' | 'download';

declare const middlewareResult: unique symbol;
export interface MiddlewareResult<TAdded extends object> {
  readonly [middlewareResult]: TAdded;
}

/**
 * Runs before the hooks of every operation of the endpoints it is attached to. Call `next()` to continue,
 * optionally with context to add (`next({ user })`), or throw an `UploadError` to reject.
 */
export type Middleware<TIn extends object, TAdded extends object> = (args: {
  readonly context: TIn & BaseContext;
  readonly endpoint: string;
  readonly op: ServerOp;
  readonly next: <A extends object = {}>(added?: A) => Promise<MiddlewareResult<A>>;
}) => Promise<MiddlewareResult<TAdded>>;

type AnyMiddleware = (args: {
  context: any;
  endpoint: string;
  op: ServerOp;
  next: (added?: object) => Promise<any>;
}) => Promise<any>;

/** Throws a typed error declared in the contract, or one of the built-in auth/lookup codes. */
export type ErrorFactory<TErrors extends ErrorMap> = <
  K extends (keyof TErrors & string) | 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND',
>(
  code: K,
  ...rest: K extends keyof TErrors
    ? SchemaOutput<TErrors[K]['data']> extends undefined
      ? [options?: { message?: string }]
      : [options: { message?: string; data: SchemaOutput<TErrors[K]['data']> }]
    : [options?: { message?: string }]
) => never;

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** What the server knows about one file upload. Carried inside the sealed ticket; no database. */
export interface UploadSession<TMeta = unknown> {
  readonly id: string;
  /** Endpoint path, e.g. `media/avatar`. */
  readonly endpoint: string;
  /** Object key in the bucket (as returned by `onUploadRequested`, without the adapter's `keyPrefix`). */
  readonly key: string;
  /** Storage multipart upload id (absent for single-PUT sessions). */
  readonly uploadId?: string;
  readonly file: FileDescriptor;
  readonly plan: PartPlan;
  /** Server-only data returned by `onUploadRequested`. Sealed (encrypted) in the ticket: keep it small. */
  readonly meta: TMeta;
  readonly createdAt: EpochMs;
  readonly expiresAt: EpochMs;
}

// ---------------------------------------------------------------------------
// Upload hooks
// ---------------------------------------------------------------------------

/** Return value of `onUploadRequested`. */
export interface UploadDecision<TMeta> {
  /** Object key in the bucket. Never derived from the user's file name alone: include an id. */
  readonly key: string;
  /** Server-only data kept with the session and passed to every later hook (owner id, record id...). */
  readonly meta?: TMeta;
}

interface UploadHookBase<C extends UploadContract<any>, TCtx extends object, TMeta> {
  /**
   * **1. A client asks to upload a file.** Called once per file, after the contract's file rules and `input`
   * schema passed. Authorize here (throw with `errors(...)` to reject) and decide where the file goes.
   */
  onUploadRequested(args: {
    readonly context: TCtx & BaseContext;
    readonly input: InferUploadParsedInput<C>;
    readonly file: FileDescriptor;
    /** Every file of the batch (for batch-level checks such as quotas). */
    readonly files: readonly FileDescriptor[];
    /** Unique id of the upload session being created; handy for keys. */
    readonly sessionId: string;
    readonly errors: ErrorFactory<DefOf<C>['errors']>;
  }): UploadDecision<TMeta> | Promise<UploadDecision<TMeta>>;

  /**
   * **2. The upload was accepted and exists in the bucket.** Optional. The place to record an "upload in
   * progress" row in your own database, storing `ticket` if you want to resume it from another device later.
   */
  onUploadStarted?(args: {
    readonly context: TCtx & BaseContext;
    readonly input: InferUploadParsedInput<C>;
    readonly session: UploadSession<TMeta>;
    /** Portable, opaque ticket. Pass it to `client.<endpoint>.resume(file, { ticket })` to continue anywhere. */
    readonly ticket: string;
  }): void | Promise<void>;

  /**
   * Optional. Re-checks permissions every time the client continues an existing upload (signing parts,
   * checking status, completing, aborting). By default a valid ticket is enough.
   */
  reauthorize?(args: {
    readonly context: TCtx & BaseContext;
    readonly session: UploadSession<TMeta>;
    readonly op: 'sign' | 'status' | 'complete' | 'abort';
    readonly errors: ErrorFactory<DefOf<C>['errors']>;
  }): void | Promise<void>;

  /** **4. The upload was cancelled** by the client. Optional. */
  onUploadAborted?(args: {
    readonly context: TCtx & BaseContext;
    readonly session: UploadSession<TMeta>;
  }): void | Promise<void>;

  /** Optional per-endpoint part sizing (e.g. bigger parts for a video endpoint). */
  readonly partSize?: Partial<PartSizePolicy>;
}

interface CompletedArgs<C extends UploadContract<any>, TCtx extends object, TMeta> {
  readonly context: TCtx & BaseContext;
  readonly session: UploadSession<TMeta>;
  /** The object as the storage reports it. */
  readonly object: StoredObject;
  /**
   * `true` when this call found the upload already completed (a retried request). Delivery is at-least-once:
   * use `session.id` as an idempotency key in your database.
   */
  readonly alreadyCompleted: boolean;
  readonly errors: ErrorFactory<DefOf<C>['errors']>;
}

/**
 * **3. The file is fully stored.** Return the contract `output` (e.g. `{ url }` or the id of the record you
 * created). Required when the contract declares an `output`.
 */
type CompletedHook<C extends UploadContract<any>, TCtx extends object, TMeta> = DefOf<C>['output'] extends undefined
  ? {
      onUploadCompleted?(args: CompletedArgs<C, TCtx, TMeta>): void | Promise<void>;
    }
  : {
      onUploadCompleted(args: CompletedArgs<C, TCtx, TMeta>): InferUploadOutput<C> | Promise<InferUploadOutput<C>>;
    };

export type UploadHooks<C extends UploadContract<any>, TCtx extends object, TMeta> = UploadHookBase<C, TCtx, TMeta> &
  CompletedHook<C, TCtx, TMeta>;

// ---------------------------------------------------------------------------
// Download hooks
// ---------------------------------------------------------------------------

export interface DownloadTarget {
  readonly key: string;
  /** Pin a version so a resumed download cannot mix two versions of an object. */
  readonly versionId?: string;
  /** File name proposed to the browser (`Content-Disposition`). */
  readonly fileName?: string;
  /** `attachment` (download, default) or `inline` (open in the browser). */
  readonly disposition?: 'attachment' | 'inline';
  readonly contentType?: string;
  /**
   * Validity of the presigned URL behind the link. Browsers resume an interrupted download against the
   * *final* URL, so resume works while it is valid; a retry always works (it re-hits the stable link).
   * Default 1 h, capped by the provider (7 d) and by temporary credentials.
   */
  readonly expiresIn?: Duration;
}

export interface DownloadHooks<C extends DownloadContract<any>, TCtx extends object> {
  /**
   * A user asks for a file (link clicked, or `url()` called). Authorize, then say which object to serve.
   * Runs on every hit of the stable link, so revoked access is enforced immediately.
   */
  onDownloadRequested(args: {
    readonly context: TCtx & BaseContext;
    readonly input: InferDownloadParsedInput<C>;
    readonly errors: ErrorFactory<DefOf<C>['errors']>;
  }): DownloadTarget | Promise<DownloadTarget>;
}

// ---------------------------------------------------------------------------
// Implementer (builder that mirrors the contract tree)
// ---------------------------------------------------------------------------

export interface ImplementedUpload<C extends UploadContract<any>, TCtx extends object, TMeta> {
  readonly '~kind': 'implemented-upload';
  readonly '~contract': C;
  readonly '~hooks': UploadHooks<C, TCtx, TMeta>;
  readonly '~middleware': readonly AnyMiddleware[];
}
export interface ImplementedDownload<C extends DownloadContract<any>, TCtx extends object> {
  readonly '~kind': 'implemented-download';
  readonly '~contract': C;
  readonly '~hooks': DownloadHooks<C, TCtx>;
  readonly '~middleware': readonly AnyMiddleware[];
}

export interface UploadImplementer<C extends UploadContract<any>, TCtx extends object> {
  /** Adds middleware for this endpoint only (e.g. `requireUser`). */
  use<TAdded extends object>(middleware: Middleware<TCtx, TAdded>): UploadImplementer<C, TCtx & TAdded>;
  /** Implements the endpoint. `meta`'s type is inferred from what `onUploadRequested` returns. */
  handler<TMeta = undefined>(hooks: UploadHooks<C, TCtx, TMeta>): ImplementedUpload<C, TCtx, TMeta>;
}
export interface DownloadImplementer<C extends DownloadContract<any>, TCtx extends object> {
  use<TAdded extends object>(middleware: Middleware<TCtx, TAdded>): DownloadImplementer<C, TCtx & TAdded>;
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

/** What `router()` must receive: one implementation per contract endpoint (a missing one is a type error). */
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
  readonly '~kind': 'implemented-router';
  readonly '~contract': T;
  readonly '~context'?: TCtx;
  readonly '~endpoints': ReadonlyMap<string, ImplementedUpload<any, any, any> | ImplementedDownload<any, any>>;
}

/**
 * `TCtx`: context seen by hooks (after middleware). `TInitial`: context your adapter must pass to `server.fetch()`.
 */
export type RootImplementer<
  T extends ContractRouter,
  TCtx extends object,
  TInitial extends object = TCtx,
> = Implementer<T, TCtx> & {
  /** Declares the context your adapter provides (e.g. `{ user: User | null }`). Types only. */
  $context<TNew extends object>(): RootImplementer<T, TNew, TNew>;
  /** Middleware applied to every endpoint. */
  use<TAdded extends object>(middleware: Middleware<TCtx, TAdded>): RootImplementer<T, TCtx & TAdded, TInitial>;
  /** Assembles the implementations. Every endpoint of the contract must be implemented. */
  router(implementation: RouterImplementation<T>): ImplementedRouter<T, TInitial>;
};

function endpointImplementer(contract: AnyEndpointContract, middleware: readonly AnyMiddleware[]): any {
  return {
    use: (mw: AnyMiddleware) => endpointImplementer(contract, [...middleware, mw]),
    handler: (hooks: object) => ({
      '~kind': isUploadContract(contract) ? 'implemented-upload' : 'implemented-download',
      '~contract': contract,
      '~hooks': hooks,
      '~middleware': middleware,
    }),
  };
}

function treeImplementer(router: ContractRouter, middleware: readonly AnyMiddleware[]): any {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(router)) {
    out[key] =
      isUploadContract(value) || isDownloadContract(value)
        ? endpointImplementer(value, middleware)
        : treeImplementer(value as ContractRouter, middleware);
  }
  return out;
}

function collect(
  contract: ContractRouter,
  impl: Record<string, any>,
  prefix: string,
  out: Map<string, ImplementedUpload<any, any, any> | ImplementedDownload<any, any>>,
): void {
  for (const [key, value] of Object.entries(contract)) {
    const path = prefix ? `${prefix}/${key}` : key;
    const implementation = impl?.[key];
    if (isUploadContract(value) || isDownloadContract(value)) {
      const expected = isUploadContract(value) ? 'implemented-upload' : 'implemented-download';
      if (!implementation || implementation['~kind'] !== expected) {
        throw new TypeError(`router(): endpoint "${path}" is not implemented (call .handler() on it)`);
      }
      if (implementation['~contract'] !== value) {
        throw new TypeError(`router(): endpoint "${path}" is implemented with another endpoint's builder`);
      }
      out.set(path, implementation);
    } else {
      collect(value as ContractRouter, implementation ?? {}, path, out);
    }
  }
}

/** Starts implementing a contract: `implement(contract).$context<Ctx>()`. */
export function implement<T extends ContractRouter>(contract: T): RootImplementer<T, {}> {
  const build = (middleware: readonly AnyMiddleware[]): any => ({
    ...treeImplementer(contract, middleware),
    $context: () => build(middleware),
    use: (mw: AnyMiddleware) => build([...middleware, mw]),
    router: (implementation: Record<string, any>) => {
      const endpoints = new Map();
      collect(contract, implementation, '', endpoints);
      return { '~kind': 'implemented-router', '~contract': contract, '~endpoints': endpoints };
    },
  });
  return build([]);
}

/** Builds the `errors(...)` helper given to hooks. */
export function createErrorFactory(
  errors: ErrorMap,
): (code: string, options?: { message?: string; data?: unknown }) => never {
  return (code, options) => {
    const def = errors[code];
    if (def) {
      throw new UploadError({
        code,
        ...((options?.message ?? def.message) ? { message: options?.message ?? def.message } : {}),
        status: def.status ?? 400,
        retryable: def.retryable ?? false,
        userAction: def.userAction ?? 'contact-support',
        data: options?.data,
      });
    }
    if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN' || code === 'NOT_FOUND') {
      throw UploadError.builtin(code, options?.message ? { message: options.message } : {});
    }
    throw new TypeError(`errors(): "${code}" is not declared in the contract`);
  };
}

export type { AnyMiddleware };
