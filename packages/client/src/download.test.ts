import { checksumBytes, uc } from '@open-upload/core';
import { createUploadServer, implement } from '@open-upload/server';
import { memoryStorage } from '@open-upload/server/testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createUploadClient, type DownloadTask } from './index.js';

const contract = uc.router({ file: uc.download().input(z.object({ key: z.string() })) });
const MiB = 1024 * 1024;

function setup(
  fault?: (req: { range: string; n: number }) => 'drop' | 'expired' | 'midstream' | undefined,
  delayMs = 0,
) {
  const storage = memoryStorage();
  const data = new Uint8Array(10 * MiB + 123).map((_, i) => (i * 31 + 7) & 0xff);
  storage.objects.set('big.bin', {
    body: data,
    object: { key: 'big.bin', size: data.length, etag: '"v1"', metadata: {} },
  });
  const t = implement(contract);
  const server = createUploadServer({
    storage,
    secret: 'd'.repeat(32),
    router: t.router({
      file: t.file.handler({ onDownloadRequested: ({ input }) => ({ key: input.key, fileName: 'big.bin' }) }),
    }),
  });
  let n = 0;
  let resolves = 0;
  const client = createUploadClient<typeof contract>({
    baseUrl: 'http://app.test/api/upload',
    contract,
    fetch: (i, init) => {
      if (String(i).endsWith('/resolve')) resolves++;
      return server.fetch(new Request(i, init), {});
    },
    persistence: false,
    retry: { baseDelayMs: 1, maxDelayMs: 5 },
    storageFetch: async (input, init) => {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const range = new Headers(init?.headers).get('range') ?? '';
      const f = fault?.({ range, n: ++n });
      if (f === 'drop') throw new TypeError('fetch failed');
      if (f === 'expired')
        return new Response('<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>', {
          status: 403,
        });
      const res = await storage.fetch(String(input), init);
      if (f === 'midstream') {
        // Deliver half of the body, then fail the stream.
        const bytes = new Uint8Array(await res.arrayBuffer());
        const body = new ReadableStream({
          start(c) {
            // Several small chunks, like a real network, then a reset: partial bytes must never leak into the file.
            for (let o = 0; o < bytes.length >> 1; o += 65_536)
              c.enqueue(bytes.slice(o, Math.min(o + 65_536, bytes.length >> 1)));
            c.error(new TypeError('network reset'));
          },
        });
        return new Response(body, { status: res.status, headers: res.headers });
      }
      return res;
    },
  });
  return { client, data, storage, resolves: () => resolves };
}

const finished = (task: DownloadTask) =>
  new Promise<void>((resolve) => {
    const check = () => ['completed', 'failed', 'canceled'].includes(task.getSnapshot().status) && resolve();
    task.subscribe(check);
    check();
  });

describe('managed downloads', () => {
  it('downloads in parallel ranges into memory, byte-exact', async () => {
    const { client, data } = setup();
    const task = client.file.download({ input: { key: 'big.bin' }, sink: 'memory', chunkSize: MiB, save: false });
    const blob = (await task.result)!;
    expect(await checksumBytes('sha256', new Uint8Array(await blob.arrayBuffer()))).toBe(
      await checksumBytes('sha256', data),
    );
    expect(task.getSnapshot()).toMatchObject({ status: 'completed', fraction: 1, sink: 'memory', fileName: 'big.bin' });
  });

  it('retries dropped connections and broken streams', async () => {
    const { client, data } = setup(({ n }) => (n % 3 === 1 ? 'drop' : n % 3 === 2 ? 'midstream' : undefined));
    const blob = (await client.file.download({
      input: { key: 'big.bin' },
      sink: 'memory',
      chunkSize: 2 * MiB,
      save: false,
    }).result)!;
    expect(blob.size).toBe(data.length);
    expect(await checksumBytes('sha256', new Uint8Array(await blob.arrayBuffer()))).toBe(
      await checksumBytes('sha256', data),
    );
  });

  it('re-resolves when the presigned URL expired', async () => {
    const env = setup(({ n }) => (n === 2 ? 'expired' : undefined));
    const blob = await env.client.file.download({
      input: { key: 'big.bin' },
      sink: 'memory',
      chunkSize: 4 * MiB,
      save: false,
    }).result;
    expect(blob?.size).toBe(env.data.length);
    expect(env.resolves()).toBe(2);
  });

  it('never mixes versions: a changed object fails the download', async () => {
    const env = setup(undefined, 20);
    const task = env.client.file.download({
      input: { key: 'big.bin' },
      sink: 'memory',
      chunkSize: MiB,
      concurrency: 1,
      save: false,
    });
    await new Promise((r) => setTimeout(r, 50));
    env.storage.objects.get('big.bin')!.object = { ...env.storage.objects.get('big.bin')!.object, etag: '"v2"' };
    await finished(task);
    expect(task.getSnapshot()).toMatchObject({ status: 'failed', error: { code: 'INTEGRITY_MISMATCH' } });
  });

  it('pauses and resumes without re-downloading finished ranges', async () => {
    const ranges: string[] = [];
    const env = setup(({ range }) => {
      ranges.push(range);
      return undefined;
    }, 20);
    const task = env.client.file.download({
      input: { key: 'big.bin' },
      sink: 'memory',
      chunkSize: MiB,
      concurrency: 1,
      save: false,
    });
    await new Promise<void>((r) => {
      const off = task.subscribe(() => {
        if (task.getSnapshot().receivedBytes >= 3 * MiB) {
          off();
          r();
        }
      });
    });
    task.pause();
    expect(task.getSnapshot().status).toBe('paused');
    task.resume();
    const blob = await task.result;
    expect(blob?.size).toBe(env.data.length);
    expect(new Set(ranges.filter((r) => r === 'bytes=0-1048575')).size).toBe(1);
  });

  it('falls back to the native download manager when no sink fits', async () => {
    const { client } = setup();
    const task = client.file.download({ input: { key: 'big.bin' }, sink: 'auto', maxMemoryBytes: 1 });
    expect(await task.result).toBeUndefined();
    expect(task.getSnapshot().sink).toBe('native');
  });
});
