import type { PartChecksumAlgorithm } from './contract.js';

/**
 * Checksums used for per-part integrity. Pure TypeScript, no WASM, no dependency, so the same code runs in
 * browsers, workers, Node, Workers and React Native. Values are encoded like S3 expects them:
 * base64 of the big-endian digest.
 *
 * CRC32/CRC32C use slicing-by-8 tables; CRC64/NVME uses a byte-wise table on two 32-bit halves.
 */

export interface ChecksumState {
  update(chunk: Uint8Array): void;
  digest(): string;
}

function makeCrc32Tables(poly: number): Uint32Array[] {
  const tables = Array.from({ length: 8 }, () => new Uint32Array(256));
  const t0 = tables[0]!;
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ poly : c >>> 1;
    t0[i] = c >>> 0;
  }
  for (let i = 0; i < 256; i++) {
    let c = t0[i]!;
    for (let s = 1; s < 8; s++) {
      c = (c >>> 8) ^ t0[c & 0xff]!;
      tables[s]![i] = c >>> 0;
    }
  }
  return tables;
}

const tableCache = new Map<number, Uint32Array[]>();
function crc32Tables(poly: number): Uint32Array[] {
  let t = tableCache.get(poly);
  if (!t) {
    t = makeCrc32Tables(poly);
    tableCache.set(poly, t);
  }
  return t;
}

function crc32State(poly: number): ChecksumState {
  const [t0, t1, t2, t3, t4, t5, t6, t7] = crc32Tables(poly) as [
    Uint32Array,
    Uint32Array,
    Uint32Array,
    Uint32Array,
    Uint32Array,
    Uint32Array,
    Uint32Array,
    Uint32Array,
  ];
  let crc = 0xffffffff;
  return {
    update(data) {
      let c = crc;
      let i = 0;
      const n = data.length;
      while (n - i >= 8) {
        const a = (data[i]! | (data[i + 1]! << 8) | (data[i + 2]! << 16) | (data[i + 3]! << 24)) ^ c;
        c =
          t7[a & 0xff]! ^
          t6[(a >>> 8) & 0xff]! ^
          t5[(a >>> 16) & 0xff]! ^
          t4[a >>> 24]! ^
          t3[data[i + 4]!]! ^
          t2[data[i + 5]!]! ^
          t1[data[i + 6]!]! ^
          t0[data[i + 7]!]!;
        i += 8;
      }
      while (i < n) c = (c >>> 8) ^ t0[(c ^ data[i++]!) & 0xff]!;
      crc = c;
    },
    digest() {
      const v = (crc ^ 0xffffffff) >>> 0;
      return toBase64(new Uint8Array([v >>> 24, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]));
    },
  };
}

// CRC-64/NVME: reflected polynomial 0x9a6c9329ac4bc9b5, init and xorout all ones.
let crc64Hi: Uint32Array | undefined;
let crc64Lo: Uint32Array | undefined;
function crc64Tables(): [Uint32Array, Uint32Array] {
  if (!crc64Hi || !crc64Lo) {
    crc64Hi = new Uint32Array(256);
    crc64Lo = new Uint32Array(256);
    const polyHi = 0x9a6c9329;
    const polyLo = 0xac4bc9b5;
    for (let i = 0; i < 256; i++) {
      let hi = 0;
      let lo = i;
      for (let k = 0; k < 8; k++) {
        const lsb = lo & 1;
        lo = ((lo >>> 1) | ((hi & 1) << 31)) >>> 0;
        hi = hi >>> 1;
        if (lsb) {
          hi = (hi ^ polyHi) >>> 0;
          lo = (lo ^ polyLo) >>> 0;
        }
      }
      crc64Hi[i] = hi;
      crc64Lo[i] = lo;
    }
  }
  return [crc64Hi, crc64Lo];
}

function crc64State(): ChecksumState {
  const [th, tl] = crc64Tables();
  let hi = 0xffffffff;
  let lo = 0xffffffff;
  return {
    update(data) {
      let h = hi;
      let l = lo;
      for (let i = 0; i < data.length; i++) {
        const idx = (l ^ data[i]!) & 0xff;
        const nl = ((l >>> 8) | (h << 24)) >>> 0;
        const nh = h >>> 8;
        h = (nh ^ th[idx]!) >>> 0;
        l = (nl ^ tl[idx]!) >>> 0;
      }
      hi = h;
      lo = l;
    },
    digest() {
      const h = (hi ^ 0xffffffff) >>> 0;
      const l = (lo ^ 0xffffffff) >>> 0;
      return toBase64(
        new Uint8Array([
          h >>> 24,
          (h >>> 16) & 0xff,
          (h >>> 8) & 0xff,
          h & 0xff,
          l >>> 24,
          (l >>> 16) & 0xff,
          (l >>> 8) & 0xff,
          l & 0xff,
        ]),
      );
    },
  };
}

/** Creates an incremental checksum. `sha1` / `sha256` are not incremental here: use {@link checksumBytes}. */
export function createChecksum(algorithm: 'crc32' | 'crc32c' | 'crc64nvme'): ChecksumState {
  switch (algorithm) {
    case 'crc32':
      return crc32State(0xedb88320);
    case 'crc32c':
      return crc32State(0x82f63b78);
    case 'crc64nvme':
      return crc64State();
  }
}

/** Checksum of a full buffer. SHA variants use Web Crypto. */
export async function checksumBytes(
  algorithm: Exclude<PartChecksumAlgorithm, 'none'>,
  data: Uint8Array,
): Promise<string> {
  if (algorithm === 'sha1' || algorithm === 'sha256') {
    const digest = await crypto.subtle.digest(
      algorithm === 'sha1' ? 'SHA-1' : 'SHA-256',
      data as Uint8Array<ArrayBuffer>,
    );
    return toBase64(new Uint8Array(digest));
  }
  const state = createChecksum(algorithm);
  state.update(data);
  return state.digest();
}

/** Reads a Blob in bounded chunks and checksums it (memory stays O(chunkSize)). */
export async function checksumBlob(
  algorithm: Exclude<PartChecksumAlgorithm, 'none'>,
  blob: Blob,
  options: { chunkSize?: number; signal?: AbortSignal } = {},
): Promise<string> {
  if (algorithm === 'sha1' || algorithm === 'sha256') {
    return checksumBytes(algorithm, new Uint8Array(await blob.arrayBuffer()));
  }
  const chunkSize = options.chunkSize ?? 1024 * 1024;
  const state = createChecksum(algorithm);
  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    options.signal?.throwIfAborted();
    state.update(new Uint8Array(await blob.slice(offset, offset + chunkSize).arrayBuffer()));
  }
  return state.digest();
}

/** S3 header name for a checksum algorithm (`x-amz-checksum-crc32c`). */
export function checksumHeader(algorithm: Exclude<PartChecksumAlgorithm, 'none'>): string {
  return `x-amz-checksum-${algorithm}`;
}

/** S3 `x-amz-checksum-algorithm` value. */
export function checksumAlgorithmName(algorithm: Exclude<PartChecksumAlgorithm, 'none'>): string {
  return algorithm.toUpperCase();
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function toBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[n >>> 18]! + B64[(n >>> 12) & 63]! + B64[(n >>> 6) & 63]! + B64[n & 63]!;
  }
  if (i < bytes.length) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8);
    out += B64[n >>> 18]! + B64[(n >>> 12) & 63]! + (i + 1 < bytes.length ? B64[(n >>> 6) & 63]! : '=') + '=';
  }
  return out;
}

/** Validates the shape of a base64 checksum for an algorithm (length check only). */
export function isChecksumValue(algorithm: Exclude<PartChecksumAlgorithm, 'none'>, value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(value)) return false;
  const lengths: Record<typeof algorithm, number> = { crc32: 8, crc32c: 8, crc64nvme: 12, sha1: 28, sha256: 44 };
  return value.length === lengths[algorithm];
}
