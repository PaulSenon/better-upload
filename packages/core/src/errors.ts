import type { AnySchema, SchemaOutput } from './standard-schema.js';

/**
 * Errors are split in two families:
 *  - built-in codes, produced by the SDK itself (network, storage, session, integrity, ...);
 *  - contract codes, declared per endpoint with `.errors({...})` and thrown by server hooks.
 * Both reach the client as one discriminated union on `code`.
 */

/** What the UI can sensibly propose to the end user. */
export type UserAction =
  /** Nothing to do, the SDK keeps retrying on its own (e.g. waiting for network). */
  | 'wait'
  /** A manual retry may succeed (e.g. after the retry budget is exhausted). */
  | 'retry'
  /** The original file must be selected again (lost handle after reload, or mismatch). */
  | 'reselect-file'
  /** Nothing is left to resume (expired / discarded session): only a restart from 0 % is possible. Ask first. */
  | 'restart'
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
  | 'SESSION_INVALID'
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
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  // auth (thrown by user middleware / hooks)
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
  /** Default developer-facing message (UIs should map codes to their own copy). */
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
  /** Underlying cause (network error, provider XML error code, ...). Never contains secrets. Not serialized. */
  readonly cause?: unknown;
}

export interface BuiltinErrorData {
  readonly providerCode?: string;
  readonly partNumber?: number;
  readonly limit?: number;
  readonly actual?: number;
  readonly retryAfterMs?: number;
}

export type BuiltinError = UploadErrorShape<BuiltinErrorCode, BuiltinErrorData | undefined>;

/** Errors declared in a contract, turned into a union. */
export type ContractErrors<TMap extends ErrorMap> = {
  [K in keyof TMap & string]: UploadErrorShape<K, SchemaOutput<TMap[K]['data']>>;
}[keyof TMap & string];

/** Every error a client call for a given endpoint can produce. */
export type EndpointError<TMap extends ErrorMap> = BuiltinError | ContractErrors<TMap>;

interface BuiltinDefaults {
  readonly status: number;
  readonly retryable: boolean;
  readonly userAction: UserAction;
  readonly message: string;
}

/** Defaults for built-in codes. Exposed so UIs and other clients (Swift, Kotlin) can stay consistent. */
export const BUILTIN_ERRORS: Readonly<Record<BuiltinErrorCode, BuiltinDefaults>> = {
  NETWORK_ERROR: { status: 0, retryable: true, userAction: 'wait', message: 'Network error' },
  OFFLINE: { status: 0, retryable: true, userAction: 'wait', message: 'The device is offline' },
  TIMEOUT: { status: 0, retryable: true, userAction: 'wait', message: 'The request timed out' },
  SIGNED_URL_EXPIRED: { status: 403, retryable: true, userAction: 'wait', message: 'A signed URL expired' },
  SESSION_EXPIRED: {
    status: 410,
    retryable: false,
    userAction: 'restart',
    message: 'This upload expired. It must be restarted from the beginning.',
  },
  SESSION_NOT_FOUND: {
    status: 410,
    retryable: false,
    userAction: 'restart',
    message: 'The storage no longer has this upload. It must be restarted from the beginning.',
  },
  SESSION_CONFLICT: {
    status: 409,
    retryable: true,
    userAction: 'wait',
    message: 'This upload is already running elsewhere (another tab?)',
  },
  SESSION_INVALID: { status: 400, retryable: false, userAction: 'restart', message: 'Invalid upload ticket' },
  FILE_MISMATCH: {
    status: 409,
    retryable: false,
    userAction: 'reselect-file',
    message: 'The selected file is not the one this upload started with',
  },
  FILE_UNREADABLE: {
    status: 0,
    retryable: false,
    userAction: 'reselect-file',
    message: 'The file can no longer be read',
  },
  INTEGRITY_MISMATCH: {
    status: 422,
    retryable: true,
    userAction: 'retry',
    message: 'Uploaded bytes failed verification',
  },
  FILE_TOO_LARGE: { status: 413, retryable: false, userAction: 'change-file', message: 'The file is too large' },
  FILE_TOO_SMALL: { status: 400, retryable: false, userAction: 'change-file', message: 'The file is too small' },
  FILE_TYPE_NOT_ALLOWED: {
    status: 415,
    retryable: false,
    userAction: 'change-file',
    message: 'This file type is not allowed',
  },
  TOO_MANY_FILES: { status: 400, retryable: false, userAction: 'change-file', message: 'Too many files' },
  INPUT_INVALID: { status: 400, retryable: false, userAction: 'contact-support', message: 'Invalid input' },
  BAD_REQUEST: { status: 400, retryable: false, userAction: 'contact-support', message: 'Bad request' },
  NOT_FOUND: { status: 404, retryable: false, userAction: 'contact-support', message: 'Not found' },
  UNAUTHORIZED: { status: 401, retryable: false, userAction: 'sign-in', message: 'Authentication required' },
  FORBIDDEN: { status: 403, retryable: false, userAction: 'contact-support', message: 'Not allowed' },
  PROVIDER_LIMIT_EXCEEDED: {
    status: 413,
    retryable: false,
    userAction: 'change-file',
    message: 'The storage provider cannot accept this file',
  },
  STORAGE_ERROR: { status: 502, retryable: true, userAction: 'retry', message: 'Storage error' },
  STORAGE_THROTTLED: { status: 503, retryable: true, userAction: 'wait', message: 'Storage is throttling requests' },
  LOCAL_STORAGE_UNAVAILABLE: {
    status: 0,
    retryable: false,
    userAction: 'contact-support',
    message: 'Local persistence is unavailable',
  },
  CANCELED: { status: 499, retryable: false, userAction: 'retry', message: 'Canceled' },
  INTERNAL_ERROR: { status: 500, retryable: false, userAction: 'contact-support', message: 'Internal error' },
};

export function isBuiltinErrorCode(code: string): code is BuiltinErrorCode {
  return Object.hasOwn(BUILTIN_ERRORS, code);
}

/**
 * Runtime error class used on both sides. It implements {@link UploadErrorShape}, so a caught `UploadError`
 * can be narrowed on `code` exactly like a snapshot error.
 */
export class UploadError<TCode extends string = string, TData = unknown>
  extends Error
  implements UploadErrorShape<TCode, TData>
{
  override readonly name = 'UploadError';
  readonly code: TCode;
  readonly retryable: boolean;
  readonly userAction: UserAction;
  readonly status?: number;
  readonly data: TData;

  constructor(shape: {
    code: TCode;
    message?: string;
    retryable?: boolean;
    userAction?: UserAction;
    status?: number;
    data?: TData;
    cause?: unknown;
  }) {
    const defaults = isBuiltinErrorCode(shape.code) ? BUILTIN_ERRORS[shape.code] : undefined;
    super(
      shape.message ?? defaults?.message ?? shape.code,
      shape.cause === undefined ? undefined : { cause: shape.cause },
    );
    this.code = shape.code;
    this.retryable = shape.retryable ?? defaults?.retryable ?? false;
    this.userAction = shape.userAction ?? defaults?.userAction ?? 'contact-support';
    const status = shape.status ?? defaults?.status;
    if (status !== undefined) this.status = status;
    this.data = shape.data as TData;
  }

  /** Wire form (no stack, no cause). */
  toJSON(): Omit<UploadErrorShape<TCode, TData>, 'cause'> {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      userAction: this.userAction,
      ...(this.status === undefined ? {} : { status: this.status }),
      data: this.data,
    };
  }

  static builtin<C extends BuiltinErrorCode>(
    code: C,
    options: { message?: string; data?: BuiltinErrorData; cause?: unknown; retryable?: boolean } = {},
  ): UploadError<C, BuiltinErrorData | undefined> {
    return new UploadError({ code, ...options });
  }

  static from(error: unknown): UploadError {
    if (error instanceof UploadError) return error;
    if (isUploadErrorShape(error)) return new UploadError(error);
    if (isAbortError(error)) return UploadError.builtin('CANCELED', { cause: error });
    return UploadError.builtin('INTERNAL_ERROR', { cause: error });
  }
}

export function isUploadErrorShape(value: unknown): value is UploadErrorShape {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { code?: unknown }).code === 'string' &&
    typeof (value as { message?: unknown }).message === 'string' &&
    typeof (value as { retryable?: unknown }).retryable === 'boolean'
  );
}

/** Narrowing helper: `if (isUploadError(e, 'QUOTA_EXCEEDED')) e.data...` */
export function isUploadError<C extends string = string>(error: unknown, code?: C): error is UploadError<C> {
  return error instanceof UploadError && (code === undefined || error.code === code);
}

export function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}
