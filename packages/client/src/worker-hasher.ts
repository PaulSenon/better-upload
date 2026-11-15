import type { PartChecksumAlgorithm } from '@open-upload/core';
import { chunkedHasher } from './hasher.js';
import type { Hasher } from './types.js';

/**
 * Off-main-thread checksums with **zero byte copies between threads**.
 *
 * Posting a `Blob` / `File` to a worker clones a *reference* to the underlying data, not the bytes. The worker then
 * reads its slice straight from disk with `blob.slice(start, end).stream()`, hashes it chunk by chunk (memory stays
 * at one stream chunk whatever the part size), and posts back a 12–44 character string. The main thread never touches
 * file bytes for hashing, and the upload itself sends the same Blob slice through XHR, which also streams from disk.
 *
 * A small pool (default: up to 4 workers, at most `hardwareConcurrency - 1`) hashes several parts in parallel, and the
 * engine hashes the next parts ahead of the network, so hashing never sits on the critical path.
 *
 * The worker is created from an inline script (Blob URL), so it needs no bundler configuration. Apps with a strict
 * Content-Security-Policy must allow `worker-src blob:`, or pass `workerHasher({ createWorker })` with their own
 * worker built from `@open-upload/client/hash-worker`.
 */
export interface WorkerHasherOptions {
  /** Pool size. Default `min(4, max(1, hardwareConcurrency - 1))`. */
  readonly workers?: number;
  /** Custom worker factory (CSP-strict apps). Must run the code returned by {@link hashWorkerSource}. */
  readonly createWorker?: () => Worker;
}

interface Job {
  readonly id: number;
  readonly blob: Blob;
  readonly algorithm: Exclude<PartChecksumAlgorithm, 'none'>;
  readonly resolve: (value: string) => void;
  readonly reject: (error: unknown) => void;
}

export function workerHasher(options: WorkerHasherOptions = {}): Hasher & { dispose(): void } {
  const fallback = chunkedHasher();
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL?.createObjectURL !== 'function') {
    return { ...fallback, dispose() {} };
  }
  const cores = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency ?? 2) : 2;
  const size = Math.max(1, options.workers ?? Math.min(4, Math.max(1, cores - 1)));
  let url: string | undefined;
  const create = (): Worker => {
    if (options.createWorker) return options.createWorker();
    url ??= URL.createObjectURL(new Blob([hashWorkerSource()], { type: 'text/javascript' }));
    return new Worker(url);
  };

  const idle: Worker[] = [];
  const all: Worker[] = [];
  const queue: Job[] = [];
  const running = new Map<Worker, Job>();
  let nextId = 0;
  let broken = false;

  const pump = () => {
    while (queue.length > 0) {
      let worker = idle.pop();
      if (!worker && all.length < size) {
        try {
          worker = create();
        } catch {
          broken = true; // e.g. CSP forbids blob: workers → main-thread fallback
          for (const job of queue.splice(0)) fallback.checksum(job.blob, job.algorithm).then(job.resolve, job.reject);
          return;
        }
        all.push(worker);
        worker.onmessage = (event: MessageEvent<{ id: number; value?: string; error?: string }>) => {
          const job = running.get(worker!);
          running.delete(worker!);
          idle.push(worker!);
          if (job && job.id === event.data.id) {
            if (event.data.error !== undefined) job.reject(new Error(event.data.error));
            else job.resolve(event.data.value!);
          }
          pump();
        };
        worker.onerror = (event) => {
          event.preventDefault();
          const job = running.get(worker!);
          running.delete(worker!);
          all.splice(all.indexOf(worker!), 1);
          worker!.terminate();
          // Retry this job on the main thread rather than failing the upload.
          if (job) fallback.checksum(job.blob, job.algorithm).then(job.resolve, job.reject);
          pump();
        };
      }
      if (!worker) return;
      const job = queue.shift()!;
      running.set(worker, job);
      worker.postMessage({ id: job.id, blob: job.blob, algorithm: job.algorithm });
    }
  };

  return {
    checksum(blob, algorithm, signal) {
      if (broken) return fallback.checksum(blob, algorithm, signal);
      return new Promise<string>((resolve, reject) => {
        const job: Job = { id: nextId++, blob, algorithm, resolve, reject };
        signal?.addEventListener(
          'abort',
          () => {
            const i = queue.indexOf(job);
            if (i >= 0) queue.splice(i, 1);
            reject(signal.reason);
          },
          { once: true },
        );
        queue.push(job);
        pump();
      });
    },
    dispose() {
      for (const w of all) w.terminate();
      all.length = 0;
      idle.length = 0;
      if (url) URL.revokeObjectURL(url);
    },
  };
}

/**
 * Source of the hash worker: self-contained (CRC-32, CRC-32C, CRC-64/NVME tables, SHA via Web Crypto), no imports.
 * Exposed so CSP-strict apps can serve it as a file and pass `createWorker: () => new Worker('/hash-worker.js')`.
 */
export function hashWorkerSource(): string {
  return `(${workerMain.toString()})();`;
}

/** Worker body. Must stay self-contained: it is serialized with `toString()`. */
export function workerMain() {
  const crc32Tables = (poly: number) => {
    const t: Uint32Array[] = [];
    for (let s = 0; s < 8; s++) t.push(new Uint32Array(256));
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ poly : c >>> 1;
      t[0]![i] = c >>> 0;
    }
    for (let i = 0; i < 256; i++) {
      let c = t[0]![i]!;
      for (let s = 1; s < 8; s++) {
        c = (c >>> 8) ^ t[0]![c & 0xff]!;
        t[s]![i] = c >>> 0;
      }
    }
    return t;
  };
  const cache: Record<string, Uint32Array[]> = {};
  const b64 = (bytes: Uint8Array) => {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
    return btoa(s);
  };
  const crc32 = (poly: number) => {
    const t = (cache[poly] ??= crc32Tables(poly));
    const [t0, t1, t2, t3, t4, t5, t6, t7] = t as [
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
      update(d: Uint8Array) {
        let c = crc;
        let i = 0;
        const n = d.length;
        while (n - i >= 8) {
          const a = (d[i]! | (d[i + 1]! << 8) | (d[i + 2]! << 16) | (d[i + 3]! << 24)) ^ c;
          c =
            t7[a & 0xff]! ^
            t6[(a >>> 8) & 0xff]! ^
            t5[(a >>> 16) & 0xff]! ^
            t4[a >>> 24]! ^
            t3[d[i + 4]!]! ^
            t2[d[i + 5]!]! ^
            t1[d[i + 6]!]! ^
            t0[d[i + 7]!]!;
          i += 8;
        }
        while (i < n) c = (c >>> 8) ^ t0[(c ^ d[i++]!) & 0xff]!;
        crc = c;
      },
      digest() {
        const v = (crc ^ 0xffffffff) >>> 0;
        return b64(new Uint8Array([v >>> 24, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]));
      },
    };
  };
  const crc64 = () => {
    const th = new Uint32Array(256);
    const tl = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let hi = 0;
      let lo = i;
      for (let k = 0; k < 8; k++) {
        const lsb = lo & 1;
        lo = ((lo >>> 1) | ((hi & 1) << 31)) >>> 0;
        hi = hi >>> 1;
        if (lsb) {
          hi = (hi ^ 0x9a6c9329) >>> 0;
          lo = (lo ^ 0xac4bc9b5) >>> 0;
        }
      }
      th[i] = hi;
      tl[i] = lo;
    }
    let h = 0xffffffff;
    let l = 0xffffffff;
    return {
      update(d: Uint8Array) {
        for (let i = 0; i < d.length; i++) {
          const idx = (l ^ d[i]!) & 0xff;
          const nl = ((l >>> 8) | (h << 24)) >>> 0;
          h = ((h >>> 8) ^ th[idx]!) >>> 0;
          l = (nl ^ tl[idx]!) >>> 0;
        }
      },
      digest() {
        const a = (h ^ 0xffffffff) >>> 0;
        const b = (l ^ 0xffffffff) >>> 0;
        return b64(
          new Uint8Array([
            a >>> 24,
            (a >>> 16) & 0xff,
            (a >>> 8) & 0xff,
            a & 0xff,
            b >>> 24,
            (b >>> 16) & 0xff,
            (b >>> 8) & 0xff,
            b & 0xff,
          ]),
        );
      },
    };
  };
  self.onmessage = async (event: MessageEvent<{ id: number; blob: Blob; algorithm: string }>) => {
    const { id, blob, algorithm } = event.data;
    try {
      let value: string;
      if (algorithm === 'sha1' || algorithm === 'sha256') {
        const digest = await crypto.subtle.digest(algorithm === 'sha1' ? 'SHA-1' : 'SHA-256', await blob.arrayBuffer());
        value = b64(new Uint8Array(digest));
      } else {
        const state = algorithm === 'crc32' ? crc32(0xedb88320) : algorithm === 'crc32c' ? crc32(0x82f63b78) : crc64();
        const reader = blob.stream().getReader();
        for (;;) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          state.update(chunk);
        }
        value = state.digest();
      }
      (self as unknown as Worker).postMessage({ id, value });
    } catch (error) {
      (self as unknown as Worker).postMessage({ id, error: String((error as Error)?.message ?? error) });
    }
  };
}
