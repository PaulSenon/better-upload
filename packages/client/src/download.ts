import { type ResolveResponse, UploadError, type UploadErrorShape } from '@open-upload/core';
import type { ControlTransport } from './control.js';
import type { NetworkMonitor } from './network.js';
import type { ReadableStore, RetryPolicy } from './types.js';

/**
 * Managed downloads (v1): parallel ranged GETs straight from the storage into the best local sink, with validators,
 * retries, re-signing and pause/resume. A progressive enhancement over the stable link: when no sink fits, it falls
 * back to the browser's own download manager.
 *
 * Downloads are not the mirror of uploads: there is no server session, nothing to complete, and any byte range can be
 * fetched. Consistency comes from the object's ETag (`If-Match`), so a changed object is detected, never mixed.
 */

export type DownloadStatus =
  | 'resolving'
  | 'downloading'
  | 'paused'
  | 'waiting-network'
  | 'retrying'
  | 'saving'
  | 'completed'
  | 'failed'
  | 'canceled';

export interface DownloadSnapshot<TError extends UploadErrorShape = UploadErrorShape> {
  readonly status: DownloadStatus;
  readonly fileName: string;
  readonly totalBytes: number;
  readonly receivedBytes: number;
  readonly fraction: number;
  readonly bytesPerSecond?: number;
  /** Where the bytes go: `file-system-access`, `opfs`, `memory`, or `native` (handed to the browser). */
  readonly sink: string;
  readonly error?: TError;
}

export interface DownloadTask<TError extends UploadErrorShape = UploadErrorShape>
  extends ReadableStore<DownloadSnapshot<TError>> {
  pause(): void;
  resume(): void;
  retry(): void;
  cancel(): void;
  /** The file as a Blob (memory and OPFS sinks), or `undefined` once written to disk / handed to the browser. */
  readonly result: Promise<Blob | undefined>;
}

/** Where downloaded bytes are written. Must accept writes at any offset (chunks arrive out of order). */
export interface DownloadSink {
  readonly id: string;
  open(info: { size: number; fileName: string; etag: string; key: string }): Promise<void>;
  /** Byte ranges already present from an earlier, interrupted download of the same object version. */
  existing?(): Promise<readonly [number, number][]>;
  write(offset: number, chunk: Uint8Array): Promise<void>;
  /** Called once every byte is written. Returns the Blob when the sink holds one. */
  close(): Promise<Blob | undefined>;
  abort(): Promise<void>;
}

export type SinkChoice = 'auto' | 'file-system-access' | 'opfs' | 'memory' | DownloadSink;

export interface ManagedDownloadOptions {
  readonly sink?: SinkChoice;
  /** Bytes per ranged request. Default 8 MiB. */
  readonly chunkSize?: number;
  /** Parallel ranged requests. Default 4. */
  readonly concurrency?: number;
  /** For memory / OPFS sinks: hand the finished file to the browser's save dialog. Default true. */
  readonly save?: boolean;
  /** Name proposed in the save dialog (File System Access asks before the server answers). Default: `download`. */
  readonly fileName?: string;
  /** Above this size the memory sink is never chosen automatically. Default 256 MiB. */
  readonly maxMemoryBytes?: number;
  readonly signal?: AbortSignal;
}

interface Deps {
  readonly control: ControlTransport;
  readonly network: NetworkMonitor;
  readonly retry: RetryPolicy;
  readonly fetch: typeof fetch;
}

const MiB = 1024 * 1024;

export function startDownload(
  deps: Deps,
  args: { path: string; input: unknown; link: string } & ManagedDownloadOptions,
): DownloadTask {
  return new ManagedDownload(deps, args);
}

function hasFileSystemAccess(): boolean {
  return typeof window !== 'undefined' && typeof (window as any).showSaveFilePicker === 'function';
}

class ManagedDownload implements DownloadTask {
  readonly result: Promise<Blob | undefined>;
  #deps: Deps;
  #args: { path: string; input: unknown; link: string } & ManagedDownloadOptions;
  #status: DownloadStatus = 'resolving';
  #error: UploadError | undefined;
  #resolved: ResolveResponse | undefined;
  #sink: DownloadSink | undefined;
  #sinkId = 'pending';
  #done: [number, number][] = [];
  #inflight = new Map<number, number>();
  #run: AbortController | undefined;
  #listeners = new Set<() => void>();
  #snapshot: DownloadSnapshot;
  #settle!: { resolve: (b: Blob | undefined) => void; reject: (e: unknown) => void };
  #speed: { at: number; bytes: number; bps?: number } | undefined;
  #pickerHandle: Promise<unknown> | undefined;

  constructor(deps: Deps, args: { path: string; input: unknown; link: string } & ManagedDownloadOptions) {
    this.#deps = deps;
    this.#args = args;
    this.result = new Promise((resolve, reject) => {
      this.#settle = { resolve, reject };
    });
    this.result.catch(() => {});
    this.#snapshot = this.#build();
    // File System Access needs the user gesture that called download(): open the picker synchronously.
    const wantsPicker =
      (args.sink === undefined || args.sink === 'auto' || args.sink === 'file-system-access') && hasFileSystemAccess();
    if (wantsPicker) {
      this.#pickerHandle = (window as any)
        .showSaveFilePicker({ suggestedName: args.fileName ?? 'download' })
        .catch((error: unknown) => ({ error }));
    }
    args.signal?.addEventListener('abort', () => this.cancel(), { once: true });
    this.#start();
  }

  getSnapshot = () => this.#snapshot;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  pause() {
    if (this.#status !== 'downloading' && this.#status !== 'retrying' && this.#status !== 'waiting-network') return;
    this.#run?.abort(new DOMException('paused', 'AbortError'));
    this.#inflight.clear();
    this.#set('paused');
  }
  resume() {
    if (this.#status === 'paused') this.#start();
  }
  retry() {
    if (this.#status === 'failed' && this.#error?.retryable) {
      this.#error = undefined;
      this.#start();
    }
  }
  cancel() {
    if (this.#status === 'completed' || this.#status === 'canceled') return;
    this.#run?.abort(new DOMException('canceled', 'AbortError'));
    void this.#sink?.abort().catch(() => {});
    this.#set('canceled');
    this.#settle.reject(UploadError.builtin('CANCELED'));
  }

  #start() {
    const run = new AbortController();
    this.#run = run;
    void this.#execute(run.signal).catch((error) => {
      if (run.signal.aborted) return;
      const e = UploadError.from(error);
      this.#error = e;
      this.#set('failed');
      if (!e.retryable) this.#settle.reject(e);
    });
  }

  async #resolve(signal: AbortSignal): Promise<ResolveResponse> {
    this.#set('resolving');
    this.#resolved = await this.#withRetry(
      () => this.#deps.control.call<ResolveResponse>(this.#args.path, 'resolve', { input: this.#args.input }, signal),
      signal,
    );
    return this.#resolved;
  }

  async #execute(signal: AbortSignal) {
    const previous = this.#resolved;
    const resolved = previous ?? (await this.#resolve(signal));
    const size = resolved.object.size ?? 0;
    const etag = resolved.object.etag ?? '';
    if (!this.#sink) {
      this.#sink = await this.#chooseSink(size);
      if (!this.#sink) {
        // Nothing fits (no FS Access, no OPFS quota, too big for memory): the browser's own manager takes over.
        this.#sinkId = 'native';
        triggerNativeDownload(this.#args.link);
        this.#set('completed');
        this.#settle.resolve(undefined);
        return;
      }
      this.#sinkId = this.#sink.id;
      await this.#sink.open({ size, fileName: this.#fileName(), etag, key: resolved.object.key });
      this.#done = [...((await this.#sink.existing?.()) ?? [])];
    }
    this.#set('downloading');
    const chunk = Math.max(256 * 1024, this.#args.chunkSize ?? 8 * MiB);
    const queue: [number, number][] = [];
    for (let start = 0; start < size; start += chunk) {
      const end = Math.min(size, start + chunk);
      if (!this.#covered(start, end)) queue.push([start, end]);
    }
    await this.#pool(queue, signal);
    this.#set('saving');
    const blob = await this.#sink.close();
    if (blob && (this.#args.save ?? true)) saveBlob(blob, this.#fileName());
    this.#set('completed');
    this.#settle.resolve(blob);
  }

  #fileName(): string {
    const r = this.#resolved;
    return r?.object.fileName ?? r?.object.key.split('/').pop() ?? 'download';
  }

  async #chooseSink(size: number): Promise<DownloadSink | undefined> {
    const choice = this.#args.sink ?? 'auto';
    if (typeof choice === 'object') return choice;
    if (choice === 'memory') return memorySink();
    if (choice === 'file-system-access' || (choice === 'auto' && this.#pickerHandle)) {
      const handle = await this.#pickerHandle;
      if (handle && !(handle as { error?: unknown }).error) return fileHandleSink(handle as FileSystemFileHandle);
      if (choice === 'file-system-access') {
        throw UploadError.builtin('CANCELED', {
          message: 'No file was chosen',
          cause: (handle as { error?: unknown })?.error,
        });
      }
      if (isUserAbort((handle as { error?: unknown })?.error))
        throw UploadError.builtin('CANCELED', { message: 'No file was chosen' });
    }
    if (choice === 'opfs' || choice === 'auto') {
      const opfs = await opfsSink(size);
      if (opfs) return opfs;
      if (choice === 'opfs')
        throw UploadError.builtin('LOCAL_STORAGE_UNAVAILABLE', { message: 'OPFS is unavailable or full' });
    }
    if (choice === 'auto' && size <= (this.#args.maxMemoryBytes ?? 256 * MiB)) return memorySink();
    return undefined;
  }

  #covered(start: number, end: number): boolean {
    return this.#done.some(([a, b]) => a <= start && b >= end);
  }

  async #pool(queue: [number, number][], signal: AbortSignal) {
    const concurrency = this.#args.concurrency ?? 4;
    await new Promise<void>((resolve, reject) => {
      let active = 0;
      let failure: unknown;
      const pump = () => {
        if (failure !== undefined) {
          if (active === 0) reject(failure);
          return;
        }
        if (queue.length === 0 && active === 0) return resolve();
        while (active < concurrency && queue.length > 0) {
          const range = queue.shift()!;
          active++;
          this.#fetchRange(range, signal).then(
            () => {
              active--;
              pump();
            },
            (error) => {
              active--;
              failure ??= error;
              pump();
            },
          );
        }
      };
      pump();
    });
  }

  async #fetchRange([start, end]: [number, number], signal: AbortSignal): Promise<void> {
    let attempt = 0;
    for (;;) {
      signal.throwIfAborted();
      await this.#waitOnline(signal);
      const resolved = this.#resolved!;
      let response: Response;
      try {
        response = await this.#deps.fetch(resolved.request.url, {
          headers: {
            ...resolved.request.headers,
            range: `bytes=${start}-${end - 1}`,
            ...(resolved.object.etag ? { 'if-match': resolved.object.etag } : {}),
          },
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        attempt = await this.#failAttempt(attempt, UploadError.builtin('NETWORK_ERROR', { cause: error }), signal);
        continue;
      }
      if (response.status === 403 || (response.status === 400 && Date.now() > resolved.request.expiresAt - 30_000)) {
        // Presigned URL expired: re-resolve (re-authorizes on the server) and continue.
        await response.body?.cancel();
        await this.#resolve(signal);
        if (this.#resolved!.object.etag !== resolved.object.etag) throw objectChanged();
        this.#set('downloading');
        continue;
      }
      if (response.status === 412) throw objectChanged();
      if (response.status === 200 && (start !== 0 || end !== resolved.object.size)) {
        // The server ignored Range: only acceptable if it is the whole object.
        await response.body?.cancel();
        throw UploadError.builtin('STORAGE_ERROR', {
          message: 'The storage does not support ranged downloads',
          retryable: false,
        });
      }
      if (response.status !== 206 && response.status !== 200) {
        await response.body?.cancel();
        const e = UploadError.builtin(response.status === 503 ? 'STORAGE_THROTTLED' : 'STORAGE_ERROR');
        attempt = await this.#failAttempt(attempt, e, signal);
        continue;
      }
      try {
        await this.#consume(response, start, end, signal);
        this.#done.push([start, end]);
        return;
      } catch (error) {
        if (signal.aborted) throw error;
        attempt = await this.#failAttempt(attempt, UploadError.builtin('NETWORK_ERROR', { cause: error }), signal);
      }
    }
  }

  /** Streams one range into the sink; the range is only marked done once fully written. */
  async #consume(response: Response, start: number, end: number, signal: AbortSignal) {
    const reader = response.body!.getReader();
    let offset = start;
    this.#inflight.set(start, 0);
    try {
      for (;;) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        await this.#sink!.write(offset, value);
        offset += value.length;
        this.#inflight.set(start, offset - start);
        this.#emitThrottled();
      }
      if (offset !== end) throw new Error(`Range ended early (${offset - start} of ${end - start} bytes)`);
    } finally {
      this.#inflight.delete(start);
    }
  }

  async #failAttempt(attempt: number, error: UploadError, signal: AbortSignal): Promise<number> {
    const next = this.#deps.network.isOffline() ? attempt : attempt + 1;
    if (next >= this.#deps.retry.maxAttempts) throw error;
    this.#set('retrying');
    const delay = Math.random() * Math.min(this.#deps.retry.maxDelayMs, this.#deps.retry.baseDelayMs * 2 ** next);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, delay);
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(signal.reason);
      });
    });
    this.#set('downloading');
    return next;
  }

  async #withRetry<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
    let attempt = 0;
    for (;;) {
      await this.#waitOnline(signal);
      try {
        return await fn();
      } catch (error) {
        const e = UploadError.from(error);
        if (signal.aborted || !e.retryable) throw e;
        attempt = await this.#failAttempt(attempt, e, signal);
      }
    }
  }

  async #waitOnline(signal: AbortSignal) {
    if (!this.#deps.network.isOffline()) return;
    const previous = this.#status;
    this.#set('waiting-network');
    await this.#deps.network.waitOnline(signal);
    this.#set(previous === 'waiting-network' ? 'downloading' : previous);
  }

  #set(status: DownloadStatus) {
    this.#status = status;
    this.#emit();
  }

  #timer: ReturnType<typeof setTimeout> | undefined;
  #emitThrottled() {
    this.#timer ??= setTimeout(() => {
      this.#timer = undefined;
      this.#emit();
    }, 100);
  }

  #emit() {
    this.#snapshot = this.#build();
    for (const l of [...this.#listeners]) l();
  }

  #build(): DownloadSnapshot {
    const total = this.#resolved?.object.size ?? 0;
    let received = 0;
    for (const [a, b] of this.#done) received += b - a;
    for (const n of this.#inflight.values()) received += n;
    received = Math.min(received, total);
    const now = Date.now();
    if (this.#status === 'downloading') {
      if (!this.#speed) this.#speed = { at: now, bytes: received };
      else if (now - this.#speed.at >= 500) {
        const instant = ((received - this.#speed.bytes) * 1000) / (now - this.#speed.at);
        this.#speed = {
          at: now,
          bytes: received,
          bps: this.#speed.bps === undefined ? instant : this.#speed.bps * 0.7 + instant * 0.3,
        };
      }
    }
    return {
      status: this.#status,
      fileName: this.#fileName(),
      totalBytes: total,
      receivedBytes: received,
      fraction: total === 0 ? (this.#status === 'completed' ? 1 : 0) : received / total,
      sink: this.#sinkId,
      ...(this.#speed?.bps !== undefined ? { bytesPerSecond: this.#speed.bps } : {}),
      ...(this.#error ? { error: this.#error } : {}),
    };
  }
}

function objectChanged() {
  return UploadError.builtin('INTEGRITY_MISMATCH', {
    message: 'The file changed on the server during the download. Start it again.',
    retryable: false,
  });
}

function isUserAbort(error: unknown): boolean {
  return (error as { name?: string })?.name === 'AbortError';
}

/** Navigates to the stable link: the browser's own download manager takes over. */
export function triggerNativeDownload(href: string) {
  if (typeof document === 'undefined') return;
  const a = document.createElement('a');
  a.href = href;
  a.download = '';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function saveBlob(blob: Blob, fileName: string) {
  if (typeof document === 'undefined') return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ---------------------------------------------------------------------------
// Sinks
// ---------------------------------------------------------------------------

/**
 * Holds the whole file in one preallocated buffer; writes are positional, so a range retried after a broken stream
 * simply overwrites its partial bytes. Small files only.
 */
export function memorySink(): DownloadSink {
  let buffer = new Uint8Array(0);
  return {
    id: 'memory',
    async open({ size }) {
      buffer = new Uint8Array(size);
    },
    async write(offset, chunk) {
      buffer.set(chunk, offset);
    },
    async close() {
      return new Blob([buffer]);
    },
    async abort() {
      buffer = new Uint8Array(0);
    },
  };
}

/** Writes straight into the file the user picked (Chromium File System Access). No double disk use. */
export function fileHandleSink(handle: FileSystemFileHandle): DownloadSink {
  let writable: FileSystemWritableFileStream | undefined;
  let queue: Promise<void> = Promise.resolve();
  return {
    id: 'file-system-access',
    async open() {
      writable = await handle.createWritable({ keepExistingData: false });
    },
    write(offset, chunk) {
      // Serialize writes: FileSystemWritableFileStream is not safe for concurrent writes.
      queue = queue.then(() =>
        writable!.write({ type: 'write', position: offset, data: chunk as Uint8Array<ArrayBuffer> }),
      );
      return queue;
    },
    async close() {
      await queue;
      await writable!.close();
      return undefined;
    },
    async abort() {
      await writable?.abort().catch(() => {});
    },
  };
}

/**
 * Origin Private File System: bytes go to disk as they arrive, so large downloads don't sit in memory. Exporting the
 * finished file to the user's Downloads folder temporarily doubles disk use. Pause/resume and retries work within the
 * page; a reload restarts the download (writes are committed when the file is closed).
 */
export async function opfsSink(size: number): Promise<DownloadSink | undefined> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return undefined;
  try {
    const estimate = await navigator.storage.estimate?.();
    if (estimate?.quota !== undefined && estimate.usage !== undefined && estimate.quota - estimate.usage < size * 1.1)
      return undefined;
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('open-upload-downloads', { create: true });
    const name = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const handle = await dir.getFileHandle(name, { create: true });
    if (typeof (handle as any).createWritable !== 'function') {
      await dir.removeEntry(name).catch(() => {});
      return undefined; // Safari < 26: no async writable in OPFS
    }
    let writable: FileSystemWritableFileStream | undefined;
    let queue: Promise<void> = Promise.resolve();
    return {
      id: 'opfs',
      async open() {
        writable = await handle.createWritable({ keepExistingData: false });
      },
      write(offset, chunk) {
        queue = queue.then(() =>
          writable!.write({ type: 'write', position: offset, data: chunk as Uint8Array<ArrayBuffer> }),
        );
        return queue;
      },
      async close() {
        await queue;
        await writable!.close();
        const file = await handle.getFile();
        // Removed a bit later, once the browser has copied it to the user's Downloads.
        setTimeout(() => void dir.removeEntry(name).catch(() => {}), 120_000);
        return file;
      },
      async abort() {
        await queue.catch(() => {});
        await writable?.abort().catch(() => {});
        await dir.removeEntry(name).catch(() => {});
      },
    };
  } catch {
    return undefined;
  }
}
