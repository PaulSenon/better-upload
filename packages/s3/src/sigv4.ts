/**
 * Minimal AWS Signature Version 4 for S3, on Web Crypto (Node ≥ 20, browsers, Workers, Deno, Bun, Convex).
 * Two modes: query-string presigning (URLs handed to browsers) and Authorization-header signing
 * (server → storage calls). Reference: https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-authenticating-requests.html
 */

export interface SigV4Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

export interface SignInput {
  readonly method: string;
  readonly url: URL;
  /** Headers to sign (names are lower-cased). `host` is added automatically. */
  readonly headers?: Record<string, string>;
  /** Header names that are signed but not returned to the caller (e.g. `content-length`, set by the browser). */
  readonly implicitHeaders?: Record<string, string>;
  readonly region: string;
  readonly service?: string;
  readonly credentials: SigV4Credentials;
  readonly now?: Date;
}

const encoder = new TextEncoder();
const UNSIGNED = 'UNSIGNED-PAYLOAD';
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** RFC 3986 encoding as SigV4 requires (`encodeURIComponent` leaves `!'()*` alone). */
export function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Encodes an object key as a URL path, keeping `/` separators. */
export function encodeKeyPath(key: string): string {
  return key.split('/').map(rfc3986).join('/');
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data;
  return toHex(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey(
    'raw',
    key as Uint8Array<ArrayBuffer>,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', k, encoder.encode(data));
}

const signingKeyCache = new Map<string, ArrayBuffer>();
async function signingKey(secret: string, date: string, region: string, service: string): Promise<ArrayBuffer> {
  const cacheKey = `${secret}\n${date}\n${region}\n${service}`;
  const cached = signingKeyCache.get(cacheKey);
  if (cached) return cached;
  const kDate = await hmac(encoder.encode(`AWS4${secret}`), date);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, 'aws4_request');
  if (signingKeyCache.size > 64) signingKeyCache.clear();
  signingKeyCache.set(cacheKey, kSigning);
  return kSigning;
}

function amzDate(now: Date): { long: string; short: string } {
  const long = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { long, short: long.slice(0, 8) };
}

function canonicalQuery(params: URLSearchParams): string {
  return [...params.entries()]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

function canonicalHeaders(headers: Record<string, string>): { canonical: string; signed: string } {
  const entries = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, ' ')] as const)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return {
    canonical: entries.map(([k, v]) => `${k}:${v}\n`).join(''),
    signed: entries.map(([k]) => k).join(';'),
  };
}

/** Builds a presigned URL valid for `expiresIn` seconds. The returned headers must be sent verbatim. */
export async function presignUrl(
  input: SignInput & { expiresIn: number },
): Promise<{ url: string; headers: Record<string, string> }> {
  const service = input.service ?? 's3';
  const { long, short } = amzDate(input.now ?? new Date());
  const scope = `${short}/${input.region}/${service}/aws4_request`;
  const url = new URL(input.url);
  const sent: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers ?? {})) sent[k.toLowerCase()] = v;
  const all = { ...sent, ...lower(input.implicitHeaders), host: url.host };
  const { canonical, signed } = canonicalHeaders(all);

  url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  url.searchParams.set('X-Amz-Credential', `${input.credentials.accessKeyId}/${scope}`);
  url.searchParams.set('X-Amz-Date', long);
  url.searchParams.set('X-Amz-Expires', String(Math.max(1, Math.min(604800, Math.floor(input.expiresIn)))));
  url.searchParams.set('X-Amz-SignedHeaders', signed);
  if (input.credentials.sessionToken) url.searchParams.set('X-Amz-Security-Token', input.credentials.sessionToken);

  const request = [input.method, url.pathname, canonicalQuery(url.searchParams), canonical, signed, UNSIGNED].join(
    '\n',
  );
  const toSign = ['AWS4-HMAC-SHA256', long, scope, await sha256Hex(request)].join('\n');
  const key = await signingKey(input.credentials.secretAccessKey, short, input.region, service);
  url.searchParams.set('X-Amz-Signature', toHex(await hmac(key, toSign)));
  // URLSearchParams serializes spaces as '+'; S3 accepts it, but keep %20 for strict providers.
  return { url: url.toString().replace(/\+/g, '%20'), headers: sent };
}

/** Signs a server-side request with the `Authorization` header. Returns the headers to send. */
export async function signHeaders(input: SignInput & { payloadHash?: string }): Promise<Record<string, string>> {
  const service = input.service ?? 's3';
  const { long, short } = amzDate(input.now ?? new Date());
  const scope = `${short}/${input.region}/${service}/aws4_request`;
  const payloadHash = input.payloadHash ?? UNSIGNED;
  const headers: Record<string, string> = {
    ...lower(input.headers),
    host: input.url.host,
    'x-amz-date': long,
    'x-amz-content-sha256': payloadHash,
  };
  if (input.credentials.sessionToken) headers['x-amz-security-token'] = input.credentials.sessionToken;
  const { canonical, signed } = canonicalHeaders(headers);
  const request = [
    input.method,
    input.url.pathname,
    canonicalQuery(input.url.searchParams),
    canonical,
    signed,
    payloadHash,
  ].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', long, scope, await sha256Hex(request)].join('\n');
  const key = await signingKey(input.credentials.secretAccessKey, short, input.region, service);
  const signature = toHex(await hmac(key, toSign));
  const { host: _host, ...rest } = headers;
  return {
    ...rest,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
  };
}

function lower(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) out[k.toLowerCase()] = v;
  return out;
}
