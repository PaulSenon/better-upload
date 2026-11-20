import { createUploadClient, fetchTransport, memoryStore, type Transport } from '@open-upload/client';
import { ConvexHttpClient } from 'convex/browser';
import { describe, expect, it } from 'vitest';
import { contract } from '../example/convex/uploads.js';

/**
 * End to end against a real local Convex backend (`npx convex dev`, anonymous mode) and MinIO:
 * browser-like client → Convex HTTP action → MinIO, with the component tracking uploads.
 * Runs when CONVEX_URL / CONVEX_SITE_URL are set (see .github/workflows/ci.yml).
 */
const CONVEX_URL = process.env.CONVEX_URL;
const SITE = process.env.CONVEX_SITE_URL;
const MiB = 1024 * 1024;

function file(size: number, seed: number) {
  const bytes = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    bytes[i] = x >>> 24;
  }
  return new File([bytes], `convex-${seed}.bin`, { type: 'application/octet-stream', lastModified: 1 });
}

describe.skipIf(!CONVEX_URL || !SITE)('Convex component on a local backend', () => {
  const convex = CONVEX_URL ? new ConvexHttpClient(CONVEX_URL) : (undefined as never);
  const client = (transport: Transport = fetchTransport()) =>
    createUploadClient<typeof contract>({
      baseUrl: `${SITE}/api/upload`,
      contract,
      transport,
      persistence: memoryStore(),
      retry: { baseDelayMs: 1, maxDelayMs: 10, maxAttempts: 3 },
    });

  it('uploads multipart through Convex HTTP actions and tracks it in the component', async () => {
    const task = client().files.upload(file(12 * MiB, 1));
    await task.result;
    const row = await convex.query('uploads:upload' as any, { sessionId: task.getSnapshot().id });
    expect(row).toMatchObject({ status: 'completed', object: { size: 12 * MiB } });
  });

  it('lists an interrupted upload as pending and resumes it from its ticket on "another device"', async () => {
    let sent = 0;
    const crashing: Transport = {
      send: async (args) => {
        if (++sent > 1) throw Object.assign(new Error('reset'), { name: 'NetworkError' });
        return fetchTransport().send(args);
      },
    };
    const f = file(20 * MiB, 2);
    const first = client(crashing).files.upload(f);
    await new Promise<void>((resolve) => {
      const check = () => first.getSnapshot().status === 'failed' && resolve();
      first.subscribe(check);
      check();
    });
    const pending = (await convex.query('uploads:myPendingUploads' as any, {})) as {
      sessionId: string;
      ticket: string;
    }[];
    const mine = pending.find((p) => p.sessionId === first.getSnapshot().id);
    expect(mine).toBeDefined();
    const second = client().files.resume(f, { ticket: mine!.ticket });
    await second.result;
    expect(await convex.query('uploads:upload' as any, { sessionId: mine!.sessionId })).toMatchObject({
      status: 'completed',
    });
  });
});
