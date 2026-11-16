import {
  type BuiltinError,
  type CompleteResponse,
  type FileDescriptor,
  type InitSession,
  type PartPlan,
  partLength,
  partRange,
  type SignedRequest,
  type SignResponse,
  type StatusResponse,
  UploadError,
  type WirePart,
} from '@open-upload/core';
import { type ControlTransport, isOffline } from './control.js';
import type { NetworkMonitor } from './network.js';
import type {
  ConcurrencyPolicy,
  Hasher,
  PersistedUpload,
  ResumeStore,
  RetryPolicy,
  Transport,
  UploadableFile,
  UploadProgress,
  UploadSnapshot,
  UploadStatus,
  UploadTask,
} from './types.js';

export interface EngineDeps {
  readonly baseUrl: string;
  readonly control: ControlTransport;
  readonly transport: Transport;
  readonly hasher: Hasher;
  readonly store: ResumeStore | undefined;
  readonly network: NetworkMonitor;
  readonly retry: RetryPolicy;
  readonly concurrency: ConcurrencyPolicy;
  readonly stallTimeoutMs: number;
  /** Called when a task is created or finishes, for the client-wide task list. */
  readonly onTasksChanged: () => void;
}

/** How the task obtains its session. */
export type TaskSource =
  | {
      readonly kind: 'new';
      readonly init: () => Promise<InitSession>;
      /** Looks for an unfinished upload of the same file on this device, to continue it instead. */
      readonly match?: () => Promise<PersistedUpload | undefined>;
    }
  | { readonly kind: 'record'; readonly record: PersistedUpload; readonly fallback?: () => Promise<InitSession> }
  | { readonly kind: 'ticket'; readonly ticket: string };

interface Session {
  readonly sessionId: string;
  ticket: string;
  readonly key: string;
  readonly plan: PartPlan;
  expiresAt: number;
  readonly verify: 'auto' | 'metadata' | 'sample' | 'full';
  readonly persist: boolean;
}

const SIGN_BATCH = 10;
/** With SHA (opt-in), each hash buffers a whole part: hash ahead only while it fits in this budget. */
const SHA_LOOKAHEAD_BYTES = 128 * 1024 * 1024;
const URL_MARGIN_MS = 60_000;

/** Adaptive concurrency: additive increase after a healthy streak, multiplicative decrease on congestion. */
class Concurrency {
  current: number;
  #streak = 0;
  constructor(readonly policy: ConcurrencyPolicy) {
    this.current = policy.initial;
  }
  success() {
    if (this.policy.mode !== 'adaptive') return;
    if (++this.#streak >= this.current * 2 && this.current < this.policy.max) {
      this.current++;
      this.#streak = 0;
    }
  }
  congestion() {
    if (this.policy.mode !== 'adaptive') return;
    this.current = Math.max(this.policy.min, Math.floor(this.current / 2));
    this.#streak = 0;
  }
}

function backoff(attempt: number, policy: RetryPolicy): number {
  // Full jitter (AWS architecture blog): random in [0, min(cap, base * 2^attempt)].
  return Math.random() * Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function describeFile(file: UploadableFile): FileDescriptor {
  return { name: file.name, size: file.size, type: file.type, lastModified: file.lastModified };
}

class PauseSignal extends Error {
  override name = 'AbortError';
}

export class UploadTaskImpl<TOutput = unknown> implements UploadTask<TOutput, any> {
  readonly id: string;
  readonly result: Promise<TOutput>;
  readonly endpoint: string;

  #deps: EngineDeps;
  #source: TaskSource;
  #input: unknown;
  #file: UploadableFile | undefined;
  #descriptor: FileDescriptor;
  #session: Session | undefined;
  #status: UploadStatus;
  #error: UploadError | undefined;
  #output: TOutput | undefined;
  #receipt: string | undefined;
  #resumed: boolean;
  #nextRetryAt: number | undefined;
  #confirmed = new Map<number, number>();
  #inflight = new Map<number, number>();
  #checksums = new Map<number, string>();
  /** Checksums being computed ahead of the network (worker pool), keyed by part number. */
  #hashing = new Map<number, Promise<string>>();
  #signed = new Map<number, SignedRequest>();
  /** Sign round-trips in flight, keyed by every part they cover (so parallel parts share one batch). */
  #signing = new Map<number, Promise<unknown>>();
  #concurrency: Concurrency;
  #run: AbortController | undefined;
  #listeners = new Set<() => void>();
  #snapshot: UploadSnapshot<TOutput, any>;
  #createdAt = Date.now();
  #emitTimer: ReturnType<typeof setTimeout> | undefined;
  #speed: { at: number; bytes: number; bps?: number } | undefined;
  #settle!: { resolve: (v: TOutput) => void; reject: (e: unknown) => void };
  #settled = false;

  constructor(
    deps: EngineDeps,
    args: {
      endpoint: string;
      source: TaskSource;
      file: UploadableFile | undefined;
      descriptor?: FileDescriptor;
      input: unknown;
      paused?: boolean;
      signal?: AbortSignal;
    },
  ) {
    this.#deps = deps;
    this.endpoint = args.endpoint;
    this.#source = args.source;
    this.#input = args.input;
    this.#file = args.file;
    this.#descriptor = args.file ? describeFile(args.file) : args.descriptor!;
    this.#resumed = args.source.kind !== 'new';
    this.id =
      args.source.kind === 'record' ? args.source.record.id : `local-${Math.random().toString(36).slice(2, 12)}`;
    this.#concurrency = new Concurrency(deps.concurrency);
    this.#status = !args.file ? 'needs-file' : args.paused ? 'paused' : 'preparing';
    if (args.source.kind === 'record') this.#adoptRecord(args.source.record);
    this.result = new Promise<TOutput>((resolve, reject) => {
      this.#settle = { resolve, reject };
    });
    this.result.catch(() => {});
    this.#snapshot = this.#buildSnapshot();
    args.signal?.addEventListener('abort', () => void this.cancel(), { once: true });
    if (this.#status === 'preparing') queueMicrotask(() => this.#start());
  }

  // ---------------------------------------------------------------------------
  // public API
  // ---------------------------------------------------------------------------

  getSnapshot = (): UploadSnapshot<TOutput, any> => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  pause(): void {
    if (!this.#isActive()) return;
    this.#stopRun();
    this.#setStatus('paused');
  }

  resume(): void {
    if (this.#status !== 'paused') return;
    this.#start();
  }

  retry(): void {
    if (this.#status !== 'failed' || !this.#error?.retryable) return;
    this.#error = undefined;
    this.#start();
  }

  restart(): void {
    if (this.#status !== 'expired' || !this.#file) return;
    const file = this.#file;
    const input = this.#input;
    const endpoint = this.endpoint;
    const control = this.#deps.control;
    this.#session = undefined;
    this.#confirmed.clear();
    this.#checksums.clear();
    this.#hashing.clear();
    this.#signed.clear();
    this.#signing.clear();
    this.#error = undefined;
    this.#resumed = false;
    this.#source = {
      kind: 'new',
      init: async () => {
        const response = await control.call<{ sessions: InitSession[] }>(endpoint, 'init', {
          input,
          files: [describeFile(file)],
        });
        return response.sessions[0]!;
      },
    };
    this.#start();
  }

  async cancel(): Promise<void> {
    if (this.#settled && this.#status !== 'needs-file') return;
    this.#stopRun();
    const session = this.#session;
    this.#setStatus('canceled');
    this.#finish(UploadError.builtin('CANCELED'));
    if (session) {
      await this.#deps.store?.delete(session.sessionId).catch(() => {});
      await this.#deps.control.call(this.endpoint, 'abort', { ticket: session.ticket }).catch(() => {});
    } else if (this.#source.kind === 'record') {
      await this.#deps.store?.delete(this.#source.record.id).catch(() => {});
    }
  }

  /** Internal: another task took over this restored session. Settles silently, no network, record kept. */
  detach(): void {
    this.#stopRun();
    this.#status = 'canceled';
    this.#finish(UploadError.builtin('CANCELED', { message: 'Continued by another upload of the same file' }));
    this.#emit();
  }

  async attachFile(file: UploadableFile): Promise<void> {
    if (this.#status !== 'needs-file') throw new Error('attachFile() is only possible on a task waiting for its file');
    const expected = this.#descriptor;
    if (file.size !== expected.size) {
      throw UploadError.builtin('FILE_MISMATCH', {
        message: `Expected a file of ${expected.size} bytes, got ${file.size}`,
      });
    }
    this.#file = file;
    this.#start();
    // Surface an identity failure to the caller of attachFile().
    await new Promise<void>((resolve, reject) => {
      const off = this.subscribe(() => {
        const s = this.#status;
        if (s === 'needs-file' && this.#error?.code === 'FILE_MISMATCH') {
          off();
          reject(this.#error);
        } else if (s === 'uploading' || s === 'completing' || s === 'completed' || s === 'failed' || s === 'expired') {
          off();
          resolve();
        }
      });
    });
  }

  // ---------------------------------------------------------------------------
  // engine
  // ---------------------------------------------------------------------------

  #isActive(): boolean {
    return ['preparing', 'initializing', 'uploading', 'waiting-network', 'retrying', 'completing'].includes(
      this.#status,
    );
  }

  #stopRun() {
    this.#run?.abort(new PauseSignal('paused'));
    this.#run = undefined;
    this.#inflight.clear();
  }

  #start() {
    this.#stopRun();
    const run = new AbortController();
    this.#run = run;
    this.#setStatus('preparing');
    void this.#execute(run.signal).catch((error) => this.#onRunError(error, run.signal));
  }

  async #execute(signal: AbortSignal): Promise<void> {
    if (!this.#file) {
      this.#setStatus('needs-file');
      return;
    }
    if (!this.#session) await this.#establishSession(signal);
    else await this.#reconcile(signal);
    if (signal.aborted) return;
    await withLock(`upload-sdk:${this.#session!.sessionId}`, signal, async () => {
      for (let round = 0; round < 3; round++) {
        if (this.#confirmed.size < this.#session!.plan.partCount) await this.#uploadParts(signal);
        const done = await this.#complete(signal);
        if (done) return;
      }
      throw UploadError.builtin('INTEGRITY_MISMATCH', { message: 'The storage kept rejecting the assembled file' });
    });
  }

  async #establishSession(signal: AbortSignal): Promise<void> {
    const source = this.#source;
    if (source.kind === 'new') {
      const match = await source.match?.().catch(() => undefined);
      if (match) {
        this.#source = { kind: 'record', record: match, fallback: source.init };
        this.#resumed = true;
        return this.#establishSession(signal);
      }
      this.#setStatus('initializing');
      const init = await this.#withRetry(() => source.init(), signal);
      this.#session = {
        sessionId: init.sessionId,
        ticket: init.ticket,
        key: init.key,
        plan: init.plan,
        expiresAt: init.expiresAt,
        verify: init.resume.verify,
        persist: init.resume.enabled,
      };
      await this.#persist();
      this.#emit();
      return;
    }
    // Continue an existing session (local record or host-provided ticket): ask the storage what it holds,
    // then prove the selected file is the one this session started with.
    const ticket = source.kind === 'record' ? source.record.ticket : source.ticket;
    this.#setStatus('preparing');
    let status: StatusResponse;
    try {
      status = await this.#withRetry(
        () => this.#deps.control.call<StatusResponse>(this.endpoint, 'status', { ticket }, signal),
        signal,
      );
    } catch (error) {
      const e = UploadError.from(error);
      if (
        source.kind === 'record' &&
        source.fallback &&
        (e.code === 'SESSION_EXPIRED' || e.code === 'SESSION_NOT_FOUND' || e.code === 'SESSION_INVALID')
      ) {
        // Auto-matched an old record that can't be continued: forget it and start fresh (nothing to tell the user).
        await this.#deps.store?.delete(source.record.id).catch(() => {});
        this.#source = { kind: 'new', init: source.fallback };
        this.#resumed = false;
        return this.#establishSession(signal);
      }
      throw e;
    }
    this.#session = {
      sessionId: status.sessionId,
      ticket: status.ticket,
      key: status.key,
      plan: status.plan,
      expiresAt: status.expiresAt,
      verify: status.resume.verify,
      persist: status.resume.enabled,
    };
    this.#descriptor = { ...this.#descriptor, size: status.file.size };
    try {
      await this.#verifyFile(status, signal);
    } catch (error) {
      if (UploadError.from(error).code === 'FILE_MISMATCH' && source.kind === 'record' && source.fallback) {
        // Auto-matched by name and size, but it is another file: start a new upload, keep the old record.
        this.#session = undefined;
        this.#confirmed.clear();
        this.#checksums.clear();
        this.#hashing.clear();
        this.#signed.clear();
        this.#signing.clear();
        this.#source = { kind: 'new', init: source.fallback };
        this.#resumed = false;
        return this.#establishSession(signal);
      }
      throw error;
    }
    this.#applyStatus(status);
    await this.#persist();
  }

  async #reconcile(signal: AbortSignal) {
    const session = this.#session!;
    this.#setStatus('preparing');
    const status = await this.#withRetry(
      () => this.#deps.control.call<StatusResponse>(this.endpoint, 'status', { ticket: session.ticket }, signal),
      signal,
    );
    this.#applyStatus(status);
  }

  #applyStatus(status: StatusResponse) {
    const session = this.#session!;
    session.ticket = status.ticket;
    session.expiresAt = status.expiresAt;
    this.#confirmed.clear();
    if (status.state === 'completed') {
      for (let n = 1; n <= session.plan.partCount; n++) this.#confirmed.set(n, partLength(session.plan, n));
    } else {
      for (const part of status.uploadedParts) {
        if (part.size === partLength(session.plan, part.partNumber)) this.#confirmed.set(part.partNumber, part.size);
      }
    }
    this.#emit();
  }

  /** Proves that the bytes already in the storage equal the selected file's bytes at the same offsets. */
  async #verifyFile(status: StatusResponse, signal: AbortSignal) {
    const file = this.#file!;
    const expected = status.file;
    const mismatch = (message: string) => UploadError.builtin('FILE_MISMATCH', { message });
    if (file.size !== expected.size) throw mismatch(`Expected ${expected.size} bytes, got ${file.size}`);
    const plan = status.plan;
    const uploaded = status.uploadedParts.filter((p) => p.size === partLength(plan, p.partNumber));
    const sameMeta =
      file.lastModified === expected.lastModified && file.type === expected.type && file.name === expected.name;
    let mode = status.resume.verify;
    if (mode === 'auto') mode = sameMeta ? 'sample' : 'full';
    if (mode === 'metadata' || plan.checksum === 'none' || uploaded.length === 0 || status.state === 'completed') {
      if (mode === 'metadata' && !sameMeta) throw mismatch('The file metadata differs');
      return;
    }
    const toCheck: WirePart[] = mode === 'full' ? uploaded : sample(uploaded, 3);
    // Parts are hashed in parallel by the worker pool; the first mismatch stops the check.
    const verifying = new AbortController();
    const stop = () => verifying.abort(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    try {
      await Promise.all(
        toCheck.map(async (part) => {
          if (!part.checksum) return;
          const { start, end } = partRange(plan, part.partNumber);
          const checksum = await this.#readChecksum(file.slice(start, end), plan, verifying.signal);
          if (checksum !== part.checksum) {
            verifying.abort();
            throw mismatch(`Part ${part.partNumber} differs from the uploaded bytes`);
          }
          this.#checksums.set(part.partNumber, checksum);
        }),
      );
    } finally {
      signal.removeEventListener('abort', stop);
    }
    signal.throwIfAborted();
  }

  /** Checksum of one part, computed once (and possibly ahead of time by {@link #hashAhead}). */
  #checksumOf(partNumber: number, signal: AbortSignal): Promise<string> {
    const known = this.#checksums.get(partNumber);
    if (known !== undefined) return Promise.resolve(known);
    let pending = this.#hashing.get(partNumber);
    if (!pending) {
      const plan = this.#session!.plan;
      const { start, end } = partRange(plan, partNumber);
      pending = this.#readChecksum(this.#file!.slice(start, end), plan, signal).then(
        (value) => {
          this.#checksums.set(partNumber, value);
          this.#hashing.delete(partNumber);
          return value;
        },
        (error) => {
          this.#hashing.delete(partNumber);
          throw error;
        },
      );
      pending.catch(() => {});
      this.#hashing.set(partNumber, pending);
    }
    return pending;
  }

  /** Starts hashing the next parts while earlier ones are on the network, so hashing is off the critical path. */
  #hashAhead(queue: readonly number[], signal: AbortSignal) {
    const plan = this.#session?.plan;
    if (!plan || plan.checksum === 'none') return;
    // CRC hashing streams (constant memory): look far enough ahead to fill a sign batch. SHA buffers whole parts.
    const window = plan.checksum.startsWith('sha')
      ? Math.floor(SHA_LOOKAHEAD_BYTES / Math.max(1, plan.partSize))
      : Math.max(SIGN_BATCH, this.#concurrency.current + 2);
    for (const partNumber of queue.slice(0, window)) void this.#checksumOf(partNumber, signal).catch(() => {});
  }

  async #readChecksum(blob: Blob, plan: PartPlan, signal: AbortSignal): Promise<string> {
    if (plan.checksum === 'none') return '';
    try {
      return await this.#deps.hasher.checksum(blob, plan.checksum, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      throw UploadError.builtin('FILE_UNREADABLE', {
        message: 'The file can no longer be read. Select it again.',
        cause: error,
      });
    }
  }

  async #uploadParts(signal: AbortSignal) {
    const plan = this.#session!.plan;
    const queue: number[] = [];
    for (let n = 1; n <= plan.partCount; n++) if (!this.#confirmed.has(n)) queue.push(n);
    this.#setStatus('uploading');
    await new Promise<void>((resolve, reject) => {
      let active = 0;
      let failure: unknown;
      const pump = () => {
        // On a part failure, stop scheduling but let in-flight parts finish: their bytes are not wasted.
        if (failure !== undefined) {
          if (active === 0) reject(failure);
          return;
        }
        if (queue.length === 0 && active === 0) return resolve();
        while (active < this.#concurrency.current && queue.length > 0) {
          const partNumber = queue.shift()!;
          this.#hashAhead(queue, signal);
          active++;
          this.#uploadPart(partNumber, signal).then(
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

  async #uploadPart(partNumber: number, signal: AbortSignal): Promise<void> {
    const session = this.#session!;
    const plan = session.plan;
    const { start, end } = partRange(plan, partNumber);
    const blob = this.#file!.slice(start, end, plan.strategy === 'single' ? this.#file!.type : '');
    const retry = this.#deps.retry;
    let attempt = 0;
    let lastError: UploadError | undefined;
    while (attempt < retry.maxAttempts) {
      signal.throwIfAborted();
      await this.#waitOnline(signal);
      const checksum = await this.#checksumOf(partNumber, signal);
      const request = await this.#signedRequest(partNumber, checksum, signal);
      this.#inflight.set(partNumber, 0);
      this.#emitThrottled();
      let response: { status: number; body: string } | undefined;
      let transportError: unknown;
      try {
        response = await this.#deps.transport.send({
          request,
          body: blob,
          signal,
          stallTimeoutMs: this.#deps.stallTimeoutMs,
          onProgress: (loaded) => {
            this.#inflight.set(partNumber, Math.min(loaded, blob.size));
            this.#emitThrottled();
          },
        });
      } catch (error) {
        transportError = error;
      } finally {
        this.#inflight.delete(partNumber);
      }
      signal.throwIfAborted();
      if (response && response.status >= 200 && response.status < 300) {
        this.#confirmed.set(partNumber, blob.size);
        this.#signed.delete(partNumber);
        this.#concurrency.success();
        this.#emitThrottled();
        return;
      }
      attempt++;
      if (transportError) {
        this.#concurrency.congestion();
        lastError = UploadError.builtin(
          (transportError as Error)?.name === 'TimeoutError' ? 'TIMEOUT' : isOffline() ? 'OFFLINE' : 'NETWORK_ERROR',
          { data: { partNumber }, cause: transportError },
        );
        if (isOffline()) attempt--; // offline time doesn't consume attempts
      } else {
        const { status, body } = response!;
        const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1];
        if (status === 403 && (/expired/i.test(body) || code === 'AccessDenied' || code === 'SignatureDoesNotMatch')) {
          // Signed URL expired (laptop slept, long backoff): re-sign transparently once per attempt.
          this.#signed.delete(partNumber);
          lastError = UploadError.builtin('SIGNED_URL_EXPIRED', {
            data: { partNumber, ...(code ? { providerCode: code } : {}) },
          });
          if (Date.now() >= request.expiresAt - URL_MARGIN_MS || /expired/i.test(body)) {
            attempt--;
            continue;
          }
        } else if (status === 404 || code === 'NoSuchUpload') {
          throw UploadError.builtin('SESSION_NOT_FOUND', { data: { partNumber } });
        } else if (code === 'BadDigest' || code === 'InvalidDigest' || code === 'XAmzContentChecksumMismatch') {
          // The bytes we read no longer match the checksum we computed: the file changed on disk.
          throw UploadError.builtin('FILE_UNREADABLE', {
            message: 'The file changed while it was being uploaded',
            data: { partNumber },
          });
        } else if (status === 429 || status === 503 || code === 'SlowDown') {
          this.#concurrency.congestion();
          lastError = UploadError.builtin('STORAGE_THROTTLED', { data: { partNumber } });
        } else if (status >= 500) {
          lastError = UploadError.builtin('STORAGE_ERROR', {
            data: { partNumber, ...(code ? { providerCode: code } : {}) },
          });
        } else {
          throw UploadError.builtin('STORAGE_ERROR', {
            message: `The storage refused part ${partNumber}: ${code ?? status}`,
            retryable: false,
            data: { partNumber, ...(code ? { providerCode: code } : {}) },
          });
        }
      }
      if (attempt >= retry.maxAttempts) break;
      await this.#backoff(attempt, signal);
    }
    throw lastError ?? UploadError.builtin('NETWORK_ERROR', { data: { partNumber } });
  }

  async #signedRequest(partNumber: number, checksum: string, signal: AbortSignal): Promise<SignedRequest> {
    const fresh = () => {
      const cached = this.#signed.get(partNumber);
      return cached && cached.expiresAt - URL_MARGIN_MS > Date.now() ? cached : undefined;
    };
    const cached = fresh();
    if (cached) return cached;
    // Another part's sign batch already covers this one: wait for it instead of a round-trip of our own.
    const pending = this.#signing.get(partNumber);
    if (pending) {
      await pending.catch(() => {});
      signal.throwIfAborted();
      const shared = fresh();
      if (shared) return shared;
    }
    const session = this.#session!;
    const plan = session.plan;
    // Sign this part plus the next few missing ones in one round-trip, when their checksums are known or cheap.
    const batch = [{ partNumber, ...(checksum ? { checksum } : {}) }];
    for (let n = partNumber + 1; n <= plan.partCount && batch.length < SIGN_BATCH; n++) {
      if (this.#confirmed.has(n) || this.#signed.has(n) || this.#signing.has(n)) continue;
      const known = this.#checksums.get(n);
      if (plan.checksum !== 'none' && known === undefined) break;
      batch.push({ partNumber: n, ...(known ? { checksum: known } : {}) });
    }
    const call = this.#withRetry(
      () =>
        this.#deps.control.call<SignResponse>(this.endpoint, 'sign', { ticket: session.ticket, parts: batch }, signal),
      signal,
    ).then((response) => {
      for (const part of response.parts) this.#signed.set(part.partNumber, part.request);
    });
    for (const { partNumber: n } of batch) this.#signing.set(n, call);
    try {
      await call;
    } finally {
      for (const { partNumber: n } of batch) if (this.#signing.get(n) === call) this.#signing.delete(n);
    }
    return this.#signed.get(partNumber)!;
  }

  async #complete(signal: AbortSignal): Promise<boolean> {
    const session = this.#session!;
    this.#setStatus('completing');
    let response: CompleteResponse<TOutput>;
    try {
      response = await this.#withRetry(
        () =>
          this.#deps.control.call<CompleteResponse<TOutput>>(
            this.endpoint,
            'complete',
            { ticket: session.ticket },
            signal,
          ),
        signal,
      );
    } catch (error) {
      const e = UploadError.from(error);
      const part = (e.data as { partNumber?: number } | undefined)?.partNumber;
      if (e.code === 'INTEGRITY_MISMATCH') {
        // The storage is the truth: re-list and upload what is missing or wrong.
        if (part !== undefined) {
          this.#confirmed.delete(part);
          this.#checksums.delete(part);
        }
        await this.#reconcile(signal);
        if (part !== undefined) this.#confirmed.delete(part);
        return false;
      }
      throw e;
    }
    this.#output = response.output;
    this.#receipt = response.receipt;
    await this.#deps.store?.delete(session.sessionId).catch(() => {});
    this.#setStatus('completed');
    this.#finish(undefined, response.output);
    return true;
  }

  /** Retries control calls (your server) on transient errors; waits for the network without consuming attempts. */
  async #withRetry<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
    let attempt = 0;
    for (;;) {
      signal.throwIfAborted();
      await this.#waitOnline(signal);
      try {
        return await fn();
      } catch (error) {
        const e = UploadError.from(error);
        if (signal.aborted) throw e;
        if (!e.retryable) throw e;
        if (e.code !== 'OFFLINE') attempt++;
        if (attempt >= this.#deps.retry.maxAttempts) throw e;
        const previous = this.#status;
        await this.#backoff(attempt, signal);
        if (this.#status === 'retrying') this.#setStatus(previous);
      }
    }
  }

  async #backoff(attempt: number, signal: AbortSignal) {
    const delay = backoff(attempt, this.#deps.retry);
    this.#nextRetryAt = Date.now() + delay;
    if (this.#inflight.size === 0) this.#setStatus('retrying');
    try {
      await sleep(delay, signal);
    } finally {
      this.#nextRetryAt = undefined;
      if (this.#status === 'retrying' && this.#session && this.#confirmed.size < this.#session.plan.partCount)
        this.#setStatus('uploading');
    }
  }

  async #waitOnline(signal: AbortSignal) {
    if (!this.#deps.network.isOffline()) return;
    const previous = this.#status;
    this.#setStatus('waiting-network');
    await this.#deps.network.waitOnline(signal);
    if (this.#status === 'waiting-network') this.#setStatus(previous === 'waiting-network' ? 'uploading' : previous);
  }

  #onRunError(error: unknown, signal: AbortSignal) {
    if (signal.reason instanceof PauseSignal || this.#status === 'canceled') return;
    const e = UploadError.from(error);
    this.#stopRun();
    this.#error = e;
    if (e.code === 'SESSION_EXPIRED' || e.code === 'SESSION_NOT_FOUND' || e.code === 'SESSION_INVALID') {
      const session = this.#session;
      if (session) void this.#deps.store?.delete(session.sessionId).catch(() => {});
      else if (this.#source.kind === 'record') void this.#deps.store?.delete(this.#source.record.id).catch(() => {});
      this.#setStatus('expired');
      this.#finish(e);
      return;
    }
    if (e.code === 'FILE_MISMATCH' && this.#source.kind !== 'new') {
      // Wrong file picked for a restored upload: let the user pick again.
      this.#file = undefined;
      this.#session = undefined;
      this.#setStatus('needs-file');
      return;
    }
    if (e.code === 'FILE_UNREADABLE') {
      this.#file = undefined;
      this.#setStatus('needs-file');
      return;
    }
    this.#setStatus('failed');
    if (!e.retryable) this.#finish(e);
  }

  #finish(error: UploadError | undefined, output?: TOutput) {
    if (this.#settled) return;
    this.#settled = true;
    if (error) this.#settle.reject(error);
    else this.#settle.resolve(output as TOutput);
    this.#deps.onTasksChanged();
  }

  async #persist() {
    const session = this.#session;
    if (!session?.persist || !this.#deps.store) return;
    const now = Date.now();
    await this.#deps.store
      .put({
        id: session.sessionId,
        endpoint: this.endpoint,
        baseUrl: this.#deps.baseUrl,
        file: this.#descriptor,
        ticket: session.ticket,
        key: session.key,
        plan: session.plan,
        verify: session.verify,
        input: this.#input ?? null,
        expiresAt: session.expiresAt,
        createdAt: this.#createdAt,
        updatedAt: now,
      })
      .catch(() => {});
  }

  #adoptRecord(record: PersistedUpload) {
    this.#descriptor = record.file;
    this.#input = record.input ?? undefined;
    this.#createdAt = record.createdAt;
  }

  // ---------------------------------------------------------------------------
  // snapshot
  // ---------------------------------------------------------------------------

  #setStatus(status: UploadStatus) {
    if (this.#status === status) return;
    this.#status = status;
    this.#emit();
  }

  #emitThrottled() {
    if (this.#emitTimer) return;
    this.#emitTimer = setTimeout(() => {
      this.#emitTimer = undefined;
      this.#emit();
    }, 100);
  }

  #emit() {
    if (this.#emitTimer) {
      clearTimeout(this.#emitTimer);
      this.#emitTimer = undefined;
    }
    this.#snapshot = this.#buildSnapshot();
    for (const listener of [...this.#listeners]) listener();
  }

  #progress(): UploadProgress {
    const plan = this.#session?.plan;
    const totalBytes = this.#descriptor.size;
    let confirmedBytes = 0;
    for (const size of this.#confirmed.values()) confirmedBytes += size;
    let inflightBytes = 0;
    for (const size of this.#inflight.values()) inflightBytes += size;
    const done = confirmedBytes + inflightBytes;
    const now = Date.now();
    if (this.#status === 'uploading' || this.#status === 'retrying') {
      if (!this.#speed) this.#speed = { at: now, bytes: done };
      else if (now - this.#speed.at >= 500) {
        const instant = ((done - this.#speed.bytes) * 1000) / (now - this.#speed.at);
        const bps = this.#speed.bps === undefined ? instant : this.#speed.bps * 0.7 + instant * 0.3;
        this.#speed = { at: now, bytes: done, bps: Math.max(0, bps) };
      }
    } else if (this.#status !== 'waiting-network') this.#speed = undefined;
    const bps = this.#speed?.bps;
    return {
      totalBytes,
      confirmedBytes,
      inflightBytes,
      fraction: totalBytes === 0 ? (this.#status === 'completed' ? 1 : 0) : Math.min(1, done / totalBytes),
      partsTotal: plan?.partCount ?? 0,
      partsConfirmed: this.#confirmed.size,
      ...(bps !== undefined ? { bytesPerSecond: bps } : {}),
      ...(bps ? { etaMs: ((totalBytes - done) / bps) * 1000 } : {}),
    };
  }

  #buildSnapshot(): UploadSnapshot<TOutput, any> {
    const s = this.#session;
    return {
      id: s?.sessionId ?? this.id,
      endpoint: this.endpoint,
      file: this.#descriptor,
      status: this.#status,
      progress: this.#progress(),
      concurrency: this.#concurrency.current,
      resumed: this.#resumed,
      createdAt: this.#createdAt,
      updatedAt: Date.now(),
      ...(this.#nextRetryAt ? { nextRetryAt: this.#nextRetryAt } : {}),
      ...(this.#error ? { error: this.#error as unknown as BuiltinError } : {}),
      ...(this.#output !== undefined ? { output: this.#output } : {}),
      ...(this.#receipt ? { receipt: this.#receipt } : {}),
      ...(s ? { key: s.key, ticket: s.ticket, sessionExpiresAt: s.expiresAt } : {}),
    };
  }
}

/** Picks first, last and `k` random uploaded parts (random: no fixed blind spot). */
function sample(parts: readonly WirePart[], k: number): WirePart[] {
  if (parts.length <= k + 2) return [...parts];
  const picked = new Set([0, parts.length - 1]);
  while (picked.size < k + 2) picked.add(1 + Math.floor(Math.random() * (parts.length - 2)));
  return [...picked].map((i) => parts[i]!);
}

/** Web Locks keep two tabs from uploading the same session. Falls back to no lock where unsupported. */
async function withLock(name: string, signal: AbortSignal, fn: () => Promise<void>): Promise<void> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) return fn();
  let ran = false;
  await locks.request(name, { ifAvailable: true }, async (lock) => {
    if (!lock) return;
    ran = true;
    await fn();
  });
  if (!ran && !signal.aborted) throw UploadError.builtin('SESSION_CONFLICT');
}
