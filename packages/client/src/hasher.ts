import { checksumBlob } from '@bu-draft/core';
import type { Hasher } from './types.js';

/**
 * Default hasher: pure-TypeScript CRC over 1 MiB slices, yielding to the event loop between slices so the
 * UI stays responsive. Memory is bounded by the slice size whatever the file size.
 */
export function chunkedHasher(options: { chunkSize?: number } = {}): Hasher {
  return {
    checksum: (blob, algorithm, signal) =>
      checksumBlob(algorithm, blob, { chunkSize: options.chunkSize ?? 1024 * 1024, ...(signal ? { signal } : {}) }),
  };
}
