import type { ErrorMap } from './errors.js';
import type { AnySchema, SchemaInput, SchemaOutput } from './standard-schema.js';
import type { ByteSize, Duration } from './units.js';

/**
 * A contract is a plain, isomorphic, secret-free description of *logical* endpoints.
 * One `upload()` declaration hides the protocol operations (init / sign / status / complete / abort)
 * behind a single name. The same value is imported by the server (to implement it) and, optionally,
 * by the client (for typing and client-side pre-validation). It never references a bucket, a
 * credential, a database or a framework.
 */

// ---------------------------------------------------------------------------
// File rules
// ---------------------------------------------------------------------------

export interface FileRules {
  /**
   * Allowed MIME patterns or extensions: `'image/*'`, `'video/mp4'`, `'.heic'`.
   * Checked on the client (when the contract value is given) and always on the server, against the
   * declared type and extension. Omitted = any file.
   */
  readonly accept?: readonly string[];
  /** Max size of one file. No SDK default: only provider limits apply when omitted. */
  readonly maxFileSize?: ByteSize;
  /** Min size of one file (e.g. reject empty files with `1`). */
  readonly minFileSize?: ByteSize;
  /** Max number of files per batch (`uploadMany`). Defaults to 1. */
  readonly maxFiles?: number;
  /** Max total size of one batch. */
  readonly maxTotalSize?: ByteSize;
}

// ---------------------------------------------------------------------------
// Resume / integrity policies
// ---------------------------------------------------------------------------

export interface ResumePolicy {
  /** `false` disables persistence: uploads survive network drops but not reloads. */
  readonly enabled: boolean;
  /**
   * How long a session may stay resumable. The server clamps it below the provider's cleanup window
   * for incomplete uploads (R2: 7 d, MinIO: 24 h) and below any lifecycle rule you declare.
   */
  readonly ttl: Duration;
  /**
   * How a re-selected file is proven to be the same as the one partially uploaded.
   * Always compared against checksums the *storage* reports (ListParts), never against client claims.
   *  - `'auto'` (default): `'sample'`, escalated to `'full'` when a cheap signal disagrees
   *    (lastModified or type changed, or checksums missing for the sample).
   *  - `'metadata'`: name + size + lastModified + type only. Fast, can be fooled. Opt-in.
   *  - `'sample'`: re-checksum first, last and a few random already uploaded parts.
   *  - `'full'`: re-checksum every already uploaded part (local read, no network).
   */
  readonly verify: 'auto' | 'metadata' | 'sample' | 'full';
}

export type PartChecksumAlgorithm = 'none' | 'crc32' | 'crc32c' | 'crc64nvme' | 'sha1' | 'sha256';
export type ContentHashAlgorithm = 'sha256';

export interface IntegrityPolicy {
  /**
   * Checksum computed per part on the client, signed into the part URL and verified by the storage.
   * `'auto'` picks the best algorithm the storage adapter declares (CRC32C on AWS and R2).
   */
  readonly partChecksum: PartChecksumAlgorithm | 'auto';
}

// ---------------------------------------------------------------------------
// Endpoint definitions
// ---------------------------------------------------------------------------

export interface UploadDef<
  TInput extends AnySchema | undefined = AnySchema | undefined,
  TOutput extends AnySchema | undefined = AnySchema | undefined,
  TErrors extends ErrorMap = ErrorMap,
  TFiles extends FileRules = FileRules,
> {
  readonly kind: 'upload';
  /** Client-provided metadata (e.g. `{ albumId }`). Validated on the server. */
  readonly input: TInput;
  /** Shape returned to the client after completion (e.g. `{ url, id }`). */
  readonly output: TOutput;
  readonly errors: TErrors;
  readonly files: TFiles;
  readonly resume: ResumePolicy;
  readonly integrity: IntegrityPolicy;
  /** Free-form documentation metadata (description, tags). */
  readonly meta: Readonly<Record<string, unknown>>;
}

export interface DownloadDef<
  TInput extends AnySchema | undefined = AnySchema | undefined,
  TErrors extends ErrorMap = ErrorMap,
> {
  readonly kind: 'download';
  /** Identifies what to download (e.g. `{ fileId }`). Validated on the server. */
  readonly input: TInput;
  readonly errors: TErrors;
  readonly meta: Readonly<Record<string, unknown>>;
}

/** `'~def'` is the runtime payload; the builder methods only exist for authoring. */
export interface UploadContract<TDef extends UploadDef = UploadDef> {
  readonly '~kind': 'upload';
  readonly '~def': TDef;
}
export interface DownloadContract<TDef extends DownloadDef = DownloadDef> {
  readonly '~kind': 'download';
  readonly '~def': TDef;
}

export type AnyEndpointContract = UploadContract<any> | DownloadContract<any>;

/** Nested routers namespace endpoints: `{ media: { avatar, video } }` → path `media/avatar`. */
export interface ContractRouter {
  readonly [key: string]: AnyEndpointContract | ContractRouter;
}

// ---------------------------------------------------------------------------
// Builders (oRPC-like chain; every call returns a new immutable builder)
// ---------------------------------------------------------------------------

export interface UploadBuilder<TDef extends UploadDef> extends UploadContract<TDef> {
  /** Which files are accepted: MIME types / extensions, size bounds, how many per batch. */
  files<const R extends FileRules>(rules: R): UploadBuilder<Replace<TDef, 'files', R>>;
  /** Metadata the client sends with the upload (validated on the server). Makes `input` required on the client. */
  input<S extends AnySchema>(schema: S): UploadBuilder<Replace<TDef, 'input', S>>;
  /** What the server returns once the upload is complete (validated before sending). */
  output<S extends AnySchema>(schema: S): UploadBuilder<Replace<TDef, 'output', S>>;
  /** Typed errors your server hooks may throw, received as a typed union on the client. */
  errors<const M extends ErrorMap>(errors: M): UploadBuilder<Replace<TDef, 'errors', TDef['errors'] & M>>;
  /** How long an unfinished upload stays resumable, and how a re-selected file is verified. `false` = no reload resume. */
  resume(policy: Partial<ResumePolicy> | false): UploadBuilder<TDef>;
  /** Per-part checksum verified by the storage. */
  integrity(policy: Partial<IntegrityPolicy>): UploadBuilder<TDef>;
  /** Free-form documentation metadata. */
  meta(meta: Readonly<Record<string, unknown>>): UploadBuilder<TDef>;
}

export interface DownloadBuilder<TDef extends DownloadDef> extends DownloadContract<TDef> {
  /** What identifies the file to download (validated on the server). */
  input<S extends AnySchema>(schema: S): DownloadBuilder<Replace<TDef, 'input', S>>;
  errors<const M extends ErrorMap>(errors: M): DownloadBuilder<Replace<TDef, 'errors', TDef['errors'] & M>>;
  meta(meta: Readonly<Record<string, unknown>>): DownloadBuilder<TDef>;
}

/** Replaces one key of a definition, keeping every other key. */
type Replace<T, K extends keyof T, V> = { readonly [P in keyof T]: P extends K ? V : T[P] };

export type InitialUploadDef = UploadDef<undefined, undefined, {}, { maxFiles: 1 }>;
export type InitialDownloadDef = DownloadDef<undefined, {}>;

export interface ContractBuilder {
  /** Declares an upload endpoint. */
  upload(): UploadBuilder<InitialUploadDef>;
  /** Declares a download endpoint (stable per-user link + presigned access). */
  download(): DownloadBuilder<InitialDownloadDef>;
  /** Groups endpoints. Purely for typing: returns its argument. */
  router<const T extends ContractRouter>(router: T): T;
}

export const DEFAULT_RESUME: ResumePolicy = { enabled: true, ttl: '7d', verify: 'auto' };
export const DEFAULT_INTEGRITY: IntegrityPolicy = { partChecksum: 'auto' };

function uploadBuilder(def: UploadDef): UploadBuilder<any> {
  return {
    '~kind': 'upload',
    '~def': def,
    files: (rules) => uploadBuilder({ ...def, files: { ...rules } }),
    input: (schema) => uploadBuilder({ ...def, input: schema }),
    output: (schema) => uploadBuilder({ ...def, output: schema }),
    errors: (errors) => uploadBuilder({ ...def, errors: { ...def.errors, ...errors } }),
    resume: (policy) =>
      uploadBuilder({
        ...def,
        resume: policy === false ? { ...def.resume, enabled: false } : { ...def.resume, ...policy },
      }),
    integrity: (policy) => uploadBuilder({ ...def, integrity: { ...def.integrity, ...policy } }),
    meta: (meta) => uploadBuilder({ ...def, meta: { ...def.meta, ...meta } }),
  };
}

function downloadBuilder(def: DownloadDef): DownloadBuilder<any> {
  return {
    '~kind': 'download',
    '~def': def,
    input: (schema) => downloadBuilder({ ...def, input: schema }),
    errors: (errors) => downloadBuilder({ ...def, errors: { ...def.errors, ...errors } }),
    meta: (meta) => downloadBuilder({ ...def, meta: { ...def.meta, ...meta } }),
  };
}

/** Entry point. `uc` = "upload contract" (like oRPC's `oc`). */
export const uc: ContractBuilder = {
  upload: () =>
    uploadBuilder({
      kind: 'upload',
      input: undefined,
      output: undefined,
      errors: {},
      files: { maxFiles: 1 },
      resume: DEFAULT_RESUME,
      integrity: DEFAULT_INTEGRITY,
      meta: {},
    }),
  download: () => downloadBuilder({ kind: 'download', input: undefined, errors: {}, meta: {} }),
  router: (router) => router,
};

// ---------------------------------------------------------------------------
// Runtime helpers
// ---------------------------------------------------------------------------

export function isUploadContract(value: unknown): value is UploadContract {
  return typeof value === 'object' && value !== null && (value as { '~kind'?: unknown })['~kind'] === 'upload';
}
export function isDownloadContract(value: unknown): value is DownloadContract {
  return typeof value === 'object' && value !== null && (value as { '~kind'?: unknown })['~kind'] === 'download';
}

/** Flattens a router into `path → contract` (`media/avatar`). Paths are validated (`[A-Za-z0-9_-]` segments). */
export function flattenRouter(router: ContractRouter, prefix = ''): Map<string, AnyEndpointContract> {
  const out = new Map<string, AnyEndpointContract>();
  for (const [key, value] of Object.entries(router)) {
    if (!/^[A-Za-z0-9_-]+$/.test(key))
      throw new TypeError(`Invalid endpoint name "${key}": use letters, digits, - or _`);
    const path = prefix ? `${prefix}/${key}` : key;
    if (isUploadContract(value) || isDownloadContract(value)) out.set(path, value);
    else for (const [p, c] of flattenRouter(value as ContractRouter, path)) out.set(p, c);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Inference helpers
// ---------------------------------------------------------------------------

export type DefOf<C> = C extends { readonly '~def': infer D } ? D : never;

export type InferUploadInput<C extends UploadContract<any>> = SchemaInput<DefOf<C>['input']>;
export type InferUploadParsedInput<C extends UploadContract<any>> = SchemaOutput<DefOf<C>['input']>;
export type InferUploadOutput<C extends UploadContract<any>> = SchemaOutput<DefOf<C>['output']>;
export type InferDownloadInput<C extends DownloadContract<any>> = SchemaInput<DefOf<C>['input']>;
export type InferDownloadParsedInput<C extends DownloadContract<any>> = SchemaOutput<DefOf<C>['input']>;
export type InferErrors<C extends AnyEndpointContract> = DefOf<C>['errors'];

/** Flattened `'media/avatar'`-style paths of a router, used for the wire protocol. */
export type RouterPaths<T extends ContractRouter, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends AnyEndpointContract
    ? `${P}${K}`
    : T[K] extends ContractRouter
      ? RouterPaths<T[K], `${P}${K}/`>
      : never;
}[keyof T & string];
