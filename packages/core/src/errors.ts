import type { AnySchema, SchemaOutput } from './standard-schema.js';

/**
 * DESIGN DRAFT — not implemented.
 *
 * Errors are split in two families:
 *  - built-in codes, produced by the SDK itself (network, storage, session, integrity, ...);
 *  - contract codes, declared per endpoint with `.errors({...})` and thrown by server hooks.
 * Both are surfaced to the client as one discriminated union on `code`.
 */

/** What the UI can sensibly propose to the end user. */
export type UserAction =
  /** Nothing to do, the SDK keeps retrying on its own (e.g. waiting for network). */
  | 'wait'
  /** A manual retry may succeed (e.g. after retry budget exhausted). */
  | 'retry'
  /** The original file must be selected again (lost handle after reload, or mismatch). */
  | 'reselect-file'
  /** Authentication expired or is missing. */
  | 'sign-in'
  /** The file or request itself is invalid; retrying will not help. */
  | 'change-file'
  /** Nothing the end user can do; developer/operator problem. */
  | 'contact-support';

export type BuiltinErrorCode =
  // transport
  | 'NETWORK_ERROR'
  | 'OFFLINE'
  | 'TIMEOUT'
  // signed URLs / credentials
  | 'SIGNED_URL_EXPIRED'
  // session lifecycle
  | 'SESSION_EXPIRED'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_CONFLICT'
  // identity / integrity
  | 'FILE_MISMATCH'
  | 'FILE_UNREADABLE'
  | 'INTEGRITY_MISMATCH'
  // validation
  | 'FILE_TOO_LARGE'
  | 'FILE_TOO_SMALL'
  | 'FILE_TYPE_NOT_ALLOWED'
  | 'TOO_MANY_FILES'
  | 'INPUT_INVALID'
  // auth (thrown by user middleware through helpers)
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  // storage provider
  | 'PROVIDER_LIMIT_EXCEEDED'
  | 'STORAGE_ERROR'
  | 'STORAGE_THROTTLED'
  // client
  | 'LOCAL_STORAGE_UNAVAILABLE'
  | 'CANCELED'
  | 'INTERNAL_ERROR';

/** Declaration of one contract-level error. Mirrors oRPC's `.errors()` idea. */
export interface ErrorDef<TData extends AnySchema | undefined = AnySchema | undefined> {
  /** HTTP status sent on the wire. Defaults to 400. */
  readonly status?: number;
  /** Default human message (developer-facing; UI should map codes itself). */
  readonly message?: string;
  /** Optional schema for structured error data, validated on the server before sending. */
  readonly data?: TData;
  readonly retryable?: boolean;
  readonly userAction?: UserAction;
}

export type ErrorMap = Readonly<Record<string, ErrorDef>>;

/** Shape of an error as delivered to the client. */
export interface UploadErrorShape<TCode extends string = string, TData = unknown> {
  readonly code: TCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly userAction: UserAction;
  readonly status?: number;
  readonly data: TData;
  /** Underlying cause (network error, provider XML error code, ...). Never contains secrets. */
  readonly cause?: unknown;
}

export type BuiltinError = UploadErrorShape<BuiltinErrorCode, BuiltinErrorData>;

export interface BuiltinErrorData {
  readonly providerCode?: string;
  readonly partNumber?: number;
  readonly limit?: number;
  readonly actual?: number;
  readonly retryAfterMs?: number;
}

/** Errors declared in a contract, turned into a union. */
export type ContractErrors<TMap extends ErrorMap> = {
  [K in keyof TMap & string]: UploadErrorShape<K, SchemaOutput<TMap[K]['data']>>;
}[keyof TMap & string];

/** Every error a client call for a given endpoint can produce. */
export type EndpointError<TMap extends ErrorMap> = BuiltinError | ContractErrors<TMap>;
