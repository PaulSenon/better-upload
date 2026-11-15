import { createUploadClient, fetchTransport, memoryStore, type Transport } from '@bu-draft/client';
import { checksumBytes, uc } from '@bu-draft/core';
import { createUploadServer, implement } from '@bu-draft/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runId, targets } from './env.js';

const MiB = 1024 * 1024;
const contract = uc.router({
  videos: uc
    .upload()
    .files({ accept: ['video/*'] })
    .input(z.object({ albumId: z.string() }))
    .output(z.object({ key: z.string(), size: z.number() })),
  files: { get: uc.download().input(z.object({ key: z.string() })) },
});

/** Resolves when the task reaches one of the statuses (a retryable failure doesn't settle `task.result`). */
function until(
  task: { getSnapshot(): { status: string }; subscribe(l: () => void): () => void },
  ...statuses: string[]
) {
  return new Promise<void>((resolve) => {
    const check = () => {
      if (statuses.includes(task.getSnapshot().status)) {
        off();
        resolve();
      }
    };
    const off = task.subscribe(check);
    check();
  });
}

function makeFile(size: number, seed: number): File {
  const bytes = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    bytes[i] = x >>> 24;
  }
  return new File([bytes], `clip-${seed}.mp4`, { type: 'video/mp4', lastModified: 1 });
}

for (const target of targets) {
  describe(`client ↔ server ↔ ${target.name}`, () => {
    const storage = target.create(`${runId}full/`);
    const t = implement(contract);
    const server = createUploadServer({
      storage,
      secret: 'integration-secret-integration-secret',
      router: t.router({
        videos: t.videos.handler({
          onUploadRequested: ({ input, sessionId }) => ({ key: `${input.albumId}/${sessionId}.mp4` }),
          onUploadCompleted: ({ object }) => ({ key: object.key, size: object.size }),
        }),
        files: {
          get: t.files.get.handler({ onDownloadRequested: ({ input }) => ({ key: input.key, fileName: 'été.mp4' }) }),
        },
      }),
    });
    const fetchServer = (input: RequestInfo | URL, init?: RequestInit) => server.fetch(new Request(input, init), {});
    beforeAll(async () => target.setup?.());

    const client = (transport: Transport, persistence = memoryStore()) =>
      createUploadClient<typeof contract>({
        baseUrl: 'http://app.test/api/upload',
        contract,
        fetch: fetchServer,
        transport,
        persistence,
        retry: { baseDelayMs: 1, maxDelayMs: 10, maxAttempts: 3 },
      });

    it('uploads 25 MiB multipart with storage-verified checksums, then downloads it through the stable link', async () => {
      const file = makeFile(25 * MiB + 123, 1);
      const task = client(fetchTransport()).videos.upload(file, { input: { albumId: 'a' } });
      const output = await task.result;
      expect(output.size).toBe(file.size);

      const link = client(fetchTransport()).files.get.link({ input: { key: output.key } });
      const redirect = await server.fetch(new Request(link), {});
      expect(redirect.status).toBe(302);
      const location = redirect.headers.get('location')!;
      const full = await fetch(location);
      expect(full.headers.get('content-disposition')).toContain("filename*=UTF-8''%C3%A9t%C3%A9.mp4");
      const body = new Uint8Array(await full.arrayBuffer());
      expect(await checksumBytes('sha256', body)).toBe(
        await checksumBytes('sha256', new Uint8Array(await file.arrayBuffer())),
      );
      // A browser resuming an interrupted download sends Range against the final URL.
      const tail = await fetch(location, { headers: { range: `bytes=${file.size - 10}-` } });
      expect(tail.status).toBe(206);
      expect((await tail.arrayBuffer()).byteLength).toBe(10);
    });

    it('resumes after a crash mid-upload, re-sending only missing parts, and the object is byte-exact', async () => {
      const file = makeFile(30 * MiB, 2);
      const persistence = memoryStore();
      let sent = 0;
      const crashing: Transport = {
        send: async (args) => {
          if (++sent > 2) throw Object.assign(new Error('connection reset'), { name: 'NetworkError' });
          return fetchTransport().send(args);
        },
      };
      const first = client(crashing, persistence).videos.upload(file, { input: { albumId: 'b' } });
      await until(first, 'failed');
      expect(first.getSnapshot()).toMatchObject({ status: 'failed', progress: { partsConfirmed: 2 } });

      const puts: number[] = [];
      const counting: Transport = {
        send: (args) => {
          puts.push(Number(new URL(args.request.url).searchParams.get('partNumber')));
          return fetchTransport().send(args);
        },
      };
      const second = client(counting, persistence).videos.upload(file, { input: { albumId: 'b' } });
      const output = await second.result;
      expect(second.getSnapshot().resumed).toBe(true);
      expect(puts.sort((a, b) => a - b)).toEqual([3, 4]);
      const head = await storage.headObject({ key: output.key });
      expect(head?.size).toBe(file.size);
    });

    it('refuses a different file with the same name and size and uploads it fresh', async () => {
      const persistence = memoryStore();
      const a = makeFile(20 * MiB, 3);
      const b = new File([await makeFile(20 * MiB, 4).arrayBuffer()], a.name, {
        type: a.type,
        lastModified: a.lastModified,
      });
      let sent = 0;
      const crashing: Transport = {
        send: async (args) => {
          if (++sent > 1) throw Object.assign(new Error('reset'), { name: 'NetworkError' });
          return fetchTransport().send(args);
        },
      };
      await until(client(crashing, persistence).videos.upload(a, { input: { albumId: 'c' } }), 'failed');
      const task = client(fetchTransport(), persistence).videos.upload(b, { input: { albumId: 'c' } });
      const output = await task.result;
      expect(task.getSnapshot().resumed).toBe(false);
      const get = await storage.signGetObject({ key: output.key, expiresIn: 60 });
      const stored = new Uint8Array(await (await fetch(get.url)).arrayBuffer());
      expect(await checksumBytes('sha256', stored)).toBe(
        await checksumBytes('sha256', new Uint8Array(await b.arrayBuffer())),
      );
    });
  });
}
