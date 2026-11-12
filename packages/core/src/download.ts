import type { BuiltinError, UploadErrorShape } from './errors.js';
import type { ReadableStore } from './task.js';
import type { EpochMs } from './units.js';

/**
 * DESIGN DRAFT — not implemented.
 *
 * Downloads are *not* the mirror of multipart uploads:
 *  - no server-side session, nothing to complete or abort, nothing billed while paused;
 *  - any byte range can be requested (HTTP Range, RFC 9110 §14), not fixed numbered parts;
 *  - consistency comes from validators (ETag / version id) instead of an upload id:
 *    resumed ranges are sent with `If-Range` / `If-Match`, and a pinned `versionId`
 *    when the bucket is versioned, so a changed object is detected, never mixed;
 *  - the hard part is *where the bytes go* on the client (memory, OPFS, a
 *    FileSystemWritableFileStream, a service-worker stream, or the browser's own download manager).
 */

export type DownloadStatus =
  | 'resolving'
  | 'downloading'
  | 'paused'
  | 'waiting-network'
  | 'retrying'
  | 'completed'
  | 'failed'
  | 'canceled';

export interface DownloadSnapshot<TError extends UploadErrorShape = BuiltinError> {
  readonly id: string;
  readonly status: DownloadStatus;
  readonly totalBytes?: number;
  readonly receivedBytes: number;
  readonly etag?: string;
  readonly versionId?: string;
  readonly bytesPerSecond?: number;
  readonly error?: TError;
  readonly updatedAt: EpochMs;
}

/** Where downloaded bytes are written. Must support writing at an offset to resume. */
export interface DownloadSink {
  readonly id: 'memory' | 'opfs' | 'file-system-access' | 'service-worker' | (string & {});
  /** Bytes already persisted from a previous session (0 if none). */
  resumeOffset(key: string, validator: string): Promise<number>;
  write(key: string, offset: number, chunk: Uint8Array): Promise<void>;
  finalize(key: string): Promise<Blob | void>;
  discard(key: string): Promise<void>;
}

export interface DownloadTask<TError extends UploadErrorShape = BuiltinError>
  extends ReadableStore<DownloadSnapshot<TError>> {
  pause(): void;
  resume(): void;
  cancel(): Promise<void>;
  readonly result: Promise<Blob | void>;
}
