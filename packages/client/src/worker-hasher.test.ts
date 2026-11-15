import { checksumBytes } from '@open-upload/core';
import { describe, expect, it } from 'vitest';
import { hashWorkerSource } from './worker-hasher.js';

/** Runs the serialized worker source in a fake worker scope: proves it is self-contained and correct. */
function fakeWorker() {
  const scope: { onmessage?: (e: { data: unknown }) => Promise<void>; postMessage: (m: unknown) => void } = {
    postMessage: () => {},
  };
  new Function('self', 'btoa', 'crypto', hashWorkerSource())(scope, btoa, crypto);
  return (data: unknown) =>
    new Promise<{ id: number; value?: string; error?: string }>((resolve) => {
      scope.postMessage = (m) => resolve(m as never);
      void scope.onmessage!({ data });
    });
}

describe('hash worker source', () => {
  const bytes = new Uint8Array(3 * 1024 * 1024 + 7).map((_, i) => (i * 13) & 0xff);
  it.each(['crc32', 'crc32c', 'crc64nvme', 'sha256', 'sha1'] as const)('%s matches core', async (algorithm) => {
    const run = fakeWorker();
    const reply = await run({ id: 1, blob: new Blob([bytes]), algorithm });
    expect(reply).toEqual({ id: 1, value: await checksumBytes(algorithm, bytes) });
  });
  it('reports read errors instead of throwing', async () => {
    const run = fakeWorker();
    const broken = {
      stream: () => {
        throw new Error('NotReadableError');
      },
    };
    expect(await run({ id: 2, blob: broken, algorithm: 'crc32c' })).toEqual({ id: 2, error: 'NotReadableError' });
  });
});
