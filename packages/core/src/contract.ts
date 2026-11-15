import type { AnySchema, SchemaInput, SchemaOutput } from './standard-schema.js';
import type { ByteSize, Duration } from './units.js';
import type { ErrorMap } from './errors.js';

/**
 * DESIGN DRAFT — not implemented.
 *
 * A contract is a plain, isomorphic, secret-free description of *logical* endpoints.
 * One `upload()` declaration hides the protocol operations
 * (init / sign-parts / status / complete / abort) behind a single name.
 * The same value can be imported by the server (to implement it) and by the client
 * (for typing and optional client-side pre-validation). It never references a bucket,
 * a credential, a database or a framework.
 */

// ---------------------------------------------------------------------------
// File rules
// ---------------------------------------------------------------------------

export interface FileRules {
  /** MIME patterns or extensions: `'image/*'`, `'video/mp4'`, `'.heic'`. Advisory on the client, enforced on the server where possible. */
  readonly accept?: readonly string[];
  /** No SDK default limit. Provider limits are enforced separately by the storage adapter. */
  readonly maxFileSize?: ByteSize;
  readonly minFileSize?: ByteSize;
  /** Max files per `init` batch. Defaults to 1. */
  readonly maxFiles?: number;
}

// ---------------------------------------------------------------------------
// Resume / integrity policies
// ---------------------------------------------------------------------------

export interface ResumePolicy {
  /** `false` disables persistence: uploads survive network drops but not reloads. */
  readonly enabled: boolean;
  /**
   * How long a session may stay resumable. Must be ≤ the bucket lifecycle rule that aborts
   * incomplete multipart uploads (the server warns at startup when it can check).
   */
  readonly ttl: Duration;
  /**
   * How a re-selected file is proven to be the same as the one partially uploaded.
   * Always compared against checksums the *storage* reports (ListParts), never against client claims.
   *  - `'auto'` (default): `'sample'`, escalated to `'full'` when the cheap signals disagree
   *                  (lastModified or type changed, several candidates, sample incomplete).
   *                  Goal: a different file is practically never accepted, and the common case stays cheap.
   *  - `'metadata'`: name + size + lastModified (+ type). Fast, can be fooled. Opt-in only.
   *  - `'sample'`  : metadata + re-checksum first, last and k random already uploaded parts (no escalation).
   *  - `'full'`    : re-checksum every already uploaded part. Local read only (no network), bounded memory,
   *                  O(uploaded bytes) CPU — much cheaper than re-uploading, but not free on a phone.
   */
  readonly verify: 'auto' | 'metadata' | 'sample' | 'full';
}

export type PartChecksumAlgorithm = 'none' | 'crc32' | 'crc32c' | 'crc64nvme' | 'sha1' | 'sha256';
export type ContentHashAlgorithm = 'sha256' | 'blake3';

export interface IntegrityPolicy {
  /**
   * Checksum computed per part on the client, signed into the part URL, verified by the storage.
   * Provider support differs (e.g. R2: CRC32/CRC32C/SHA* composite only, CRC64NVME full-object only;
   * Supabase S3: none). `'auto'` picks the best algorithm the storage adapter declares.
   */
  readonly partChecksum: PartChecksumAlgorithm | 'auto';
  /** S3 `x-amz-checksum-type`. Full-object is only possible with CRC algorithms. */
  readonly checksumType: 'composite' | 'full-object' | 'auto';
  /**
   * Optional whole-content hash computed incrementally on the client (worker, bounded memory)
   * and returned to server hooks. Useful for dedupe / content addressing. Off by default:
   * it costs a full read of the file and its intermediate state must be persisted to resume.
   */
  readonly contentHash: ContentHashAlgorithm | false;
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
  /** Client-provided, user-controlled metadata (e.g. `{ albumId }`). Validated on the server. */
  readonly input: TInput;
  /** Shape returned to the client after `complete` (e.g. `{ url, id }`). */
  readonly output: TOutput;
  readonly errors: TErrors;
  readonly files: TFiles;
  readonly resume: ResumePolicy;
  readonly integrity: IntegrityPolicy;
  /** Free-form documentation metadata (OpenAPI-like description, tags). */
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

/** Nested routers are allowed for namespacing: `{ media: { avatar, video } }` → path `media/avatar`. */
export interface ContractRouter {
  readonly [key: string]: AnyEndpointContract | ContractRouter;
}

// ---------------------------------------------------------------------------
// Builders (oRPC-like chain; every call returns a new immutable builder)
// ---------------------------------------------------------------------------

export interface UploadBuilder<TDef extends UploadDef> extends UploadContract<TDef> {
  input<S extends AnySchema>(schema: S): UploadBuilder<Replace<TDef, 'input', S>>;
  output<S extends AnySchema>(schema: S): UploadBuilder<Replace<TDef, 'output', S>>;
  errors<M extends ErrorMap>(errors: M): UploadBuilder<Replace<TDef, 'errors', TDef['errors'] & M>>;
  files<R extends FileRules>(rules: R): UploadBuilder<Replace<TDef, 'files', R>>;
  resume(policy: Partial<ResumePolicy> | false): UploadBuilder<TDef>;
  integrity(policy: Partial<IntegrityPolicy>): UploadBuilder<TDef>;
  meta(meta: Readonly<Record<string, unknown>>): UploadBuilder<TDef>;
}

export interface DownloadBuilder<TDef extends DownloadDef> extends DownloadContract<TDef> {
  input<S extends AnySchema>(schema: S): DownloadBuilder<Replace<TDef, 'input', S>>;
  errors<M extends ErrorMap>(errors: M): DownloadBuilder<Replace<TDef, 'errors', TDef['errors'] & M>>;
  meta(meta: Readonly<Record<string, unknown>>): DownloadBuilder<TDef>;
}

/** Replaces one key of a definition, keeping every other key (and the `kind` discriminant). */
type Replace<T, K extends keyof T, V> = { readonly [P in keyof T]: P extends K ? V : T[P] };

export type InitialUploadDef = UploadDef<undefined, undefined, {}, { maxFiles: 1 }>;
export type InitialDownloadDef = DownloadDef<undefined, {}>;

/** Entry point. `uc` = "upload contract". Name is provisional. */
export interface ContractBuilder {
  upload(): UploadBuilder<InitialUploadDef>;
  download(): DownloadBuilder<InitialDownloadDef>;
  router<T extends ContractRouter>(router: T): T;
}

export declare const uc: ContractBuilder;

// ---------------------------------------------------------------------------
// Inference helpers
// ---------------------------------------------------------------------------

export type DefOf<C> = C extends { readonly '~def': infer D } ? D : never;

export type InferUploadInput<C extends UploadContract<any>> = SchemaInput<DefOf<C>['input']>;
export type InferUploadParsedInput<C extends UploadContract<any>> = SchemaOutput<DefOf<C>['input']>;
export type InferUploadOutput<C extends UploadContract<any>> = SchemaOutput<DefOf<C>['output']>;
export type InferDownloadInput<C extends DownloadContract<any>> = SchemaInput<DefOf<C>['input']>;
export type InferErrors<C extends AnyEndpointContract> = DefOf<C>['errors'];

/** Flattened `'media/avatar'`-style paths of a router, used for the wire protocol. */
export type RouterPaths<T extends ContractRouter, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends AnyEndpointContract
    ? `${P}${K}`
    : T[K] extends ContractRouter
      ? RouterPaths<T[K], `${P}${K}/`>
      : never;
}[keyof T & string];
