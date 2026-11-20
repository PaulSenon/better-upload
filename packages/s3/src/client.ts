import { UploadError } from '@open-upload/core';
import { encodeKeyPath, presignUrl, type SigV4Credentials, sha256Hex, signHeaders } from './sigv4.js';

export interface S3Credentials extends SigV4Credentials {
  /** Expiry of temporary credentials (epoch ms). Presigned URL lifetimes are clamped to it. */
  readonly expiresAt?: number;
}

/** Static credentials, or a provider called (and cached until `expiresAt`) for temporary credentials. */
export type CredentialsProvider = S3Credentials | (() => S3Credentials | Promise<S3Credentials>);

export interface S3ClientOptions {
  /** e.g. `https://s3.eu-west-3.amazonaws.com`, `https://<account>.r2.cloudflarestorage.com`, `http://localhost:9000`. */
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly credentials: CredentialsProvider;
  /** `true`: `endpoint/bucket/key`. `false`: `bucket.endpoint/key` (AWS default). */
  readonly forcePathStyle: boolean;
  /** Custom fetch (tests, proxies). */
  readonly fetch?: typeof fetch;
  /** Attempts for server → storage calls on network errors / 5xx / throttling. Default 3. */
  readonly maxAttempts?: number;
}

export interface S3RequestInit {
  readonly method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD';
  readonly key?: string;
  readonly query?: Record<string, string | undefined>;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  /** Statuses returned to the caller instead of being thrown. */
  readonly allow?: readonly number[];
}

/**
 * Small S3 REST client: URL building, SigV4, retries, XML errors. Exposed for advanced use
 * (bucket setup scripts, tests); the upload server only needs the {@link StorageAdapter} built on it.
 */
export class S3Client {
  readonly options: S3ClientOptions;
  #cached: S3Credentials | undefined;

  constructor(options: S3ClientOptions) {
    this.options = options;
  }

  async credentials(): Promise<S3Credentials> {
    const provider = this.options.credentials;
    if (typeof provider !== 'function') return provider;
    if (this.#cached && (this.#cached.expiresAt === undefined || this.#cached.expiresAt - Date.now() > 60_000)) {
      return this.#cached;
    }
    this.#cached = await provider();
    return this.#cached;
  }

  url(key?: string, query?: Record<string, string | undefined>): URL {
    const base = new URL(this.options.endpoint);
    const path = key === undefined ? '' : `/${encodeKeyPath(key)}`;
    const url = this.options.forcePathStyle
      ? new URL(`${base.origin}${base.pathname.replace(/\/$/, '')}/${this.options.bucket}${path}`)
      : new URL(
          `${base.protocol}//${this.options.bucket}.${base.host}${base.pathname.replace(/\/$/, '')}${path || '/'}`,
        );
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
    return url;
  }

  async presign(args: {
    method: 'GET' | 'PUT' | 'HEAD';
    key: string;
    query?: Record<string, string | undefined>;
    headers?: Record<string, string>;
    implicitHeaders?: Record<string, string>;
    expiresIn: number;
  }): Promise<{ url: string; headers: Record<string, string>; expiresAt: number }> {
    const credentials = await this.credentials();
    let expiresIn = args.expiresIn;
    if (credentials.expiresAt !== undefined)
      expiresIn = Math.min(expiresIn, Math.floor((credentials.expiresAt - Date.now()) / 1000));
    const now = new Date();
    const signed = await presignUrl({
      method: args.method,
      url: this.url(args.key, args.query),
      ...(args.headers ? { headers: args.headers } : {}),
      ...(args.implicitHeaders ? { implicitHeaders: args.implicitHeaders } : {}),
      region: this.options.region,
      credentials,
      expiresIn,
      now,
    });
    return { ...signed, expiresAt: now.getTime() + expiresIn * 1000 };
  }

  /** Signed server-side request with retries. Throws {@link UploadError} on failure. */
  async request(init: S3RequestInit): Promise<Response> {
    const fetchImpl = this.options.fetch ?? fetch;
    const maxAttempts = this.options.maxAttempts ?? 3;
    const url = this.url(init.key, init.query);
    const payloadHash = init.body === undefined ? undefined : await sha256Hex(init.body);
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const headers = await signHeaders({
          method: init.method,
          url,
          headers: init.headers ?? {},
          region: this.options.region,
          credentials: await this.credentials(),
          ...(payloadHash ? { payloadHash } : {}),
        });
        const response = await fetchImpl(url, {
          method: init.method,
          headers,
          ...(init.body === undefined ? {} : { body: init.body }),
        });
        if (response.ok || init.allow?.includes(response.status)) return response;
        const error = await toStorageError(response);
        if (!error.retryable || attempt === maxAttempts) throw error;
        lastError = error;
      } catch (error) {
        if (error instanceof UploadError && (!error.retryable || attempt === maxAttempts)) throw error;
        if (!(error instanceof UploadError) && attempt === maxAttempts) {
          throw UploadError.builtin('STORAGE_ERROR', { message: 'Storage unreachable', cause: error });
        }
        lastError = error;
      }
      await new Promise((r) => setTimeout(r, Math.random() * 200 * 2 ** attempt));
    }
    throw UploadError.from(lastError);
  }
}

async function toStorageError(response: Response): Promise<UploadError> {
  const text = await response.text().catch(() => '');
  const code = xmlValue(text, 'Code') ?? `HTTP_${response.status}`;
  const message = xmlValue(text, 'Message') ?? response.statusText;
  if (response.status === 503 || code === 'SlowDown') {
    return UploadError.builtin('STORAGE_THROTTLED', { message, data: { providerCode: code } });
  }
  if (response.status >= 500) return UploadError.builtin('STORAGE_ERROR', { message, data: { providerCode: code } });
  if (code === 'EntityTooLarge') {
    return UploadError.builtin('PROVIDER_LIMIT_EXCEEDED', { message, data: { providerCode: code } });
  }
  return UploadError.builtin('STORAGE_ERROR', {
    message: `${code}: ${message}`,
    data: { providerCode: code },
    retryable: false,
  });
}

// ---------------------------------------------------------------------------
// Minimal XML helpers (S3 responses are flat and well-known; no XML library needed)
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function xmlUnescape(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    if (e[0] === '#')
      return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e.toLowerCase()] ?? _;
  });
}

export function xmlEscape(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => `&${({ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": 'apos' } as const)[c as '&']};`,
  );
}

export function xmlValue(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match ? xmlUnescape(match[1]!) : undefined;
}

export function xmlBlocks(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1]!);
}
