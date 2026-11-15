import { checksumBytes, uc } from '@bu-draft/core';
import { createUploadServer, implement } from '@bu-draft/server';
import { memoryStorage } from '@bu-draft/server/testing';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
  createUploadClient,
  fetchTransport,
  memoryStore,
  type ResumeStore,
  type Transport,
  type UploadTask,
} from './index.js';

const MiB = 1024 * 1024;

const contract = uc.router({
  videos: uc
    .upload()
    .files({ accept: ['video/*'], maxFiles: 5 })
    .input(z.object({ albumId: z.string() }))
    .output(z.object({ mediaId: z.string() }))
    .errors({ QUOTA_EXCEEDED: { status: 403, data: z.object({ remainingBytes: z.number() }) } }),
  avatar: uc.upload().files({ accept: ['image/*'], maxFileSize: '5MB' }),
  files: { download: uc.download().input(z.object({ id: z.string() })) },
});

const digest = async (b: Uint8Array | ArrayBuffer) =>
  checksumBytes('sha256', b instanceof Uint8Array ? b : new Uint8Array(b));

function makeFile(size: number, seed = 1, name = 'clip.mp4', lastModified = 1000): File {
  const bytes = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    bytes[i] = x >>> 24;
  }
  return new File([bytes], name, { type: name.endsWith('.png') ? 'image/png' : 'video/mp4', lastModified });
}

type Fault = (req: { url: string; attempt: number; partNumber: number }) => 'network' | 503 | 'expired' | undefined;

function setup(
  opts: { quota?: number; fault?: Fault; persistence?: ResumeStore; storage?: ReturnType<typeof memoryStorage> } = {},
) {
  const storage = opts.storage ?? memoryStorage();
  const tickets: string[] = [];
  const t = implement(contract).$context<{ user: string }>();
  const server = createUploadServer({
    storage,
    secret: 's'.repeat(32),
    router: t.router({
      videos: t.videos.handler({
        onUploadRequested: ({ input, sessionId, files, errors }) => {
          if (opts.quota !== undefined && files[0]!.size > opts.quota)
            errors('QUOTA_EXCEEDED', { data: { remainingBytes: opts.quota } });
          return { key: `albums/${input.albumId}/${sessionId}` };
        },
        onUploadStarted: ({ ticket }) => {
          tickets.push(ticket);
        },
        onUploadCompleted: ({ session }) => ({ mediaId: `m-${session.id}` }),
      }),
      avatar: t.avatar.handler({ onUploadRequested: ({ sessionId }) => ({ key: `avatars/${sessionId}` }) }),
      files: { download: t.files.download.handler({ onDownloadRequested: ({ input }) => ({ key: input.id }) }) },
    }),
  });
  const attempts = new Map<string, number>();
  const puts: number[] = [];
  const base = fetchTransport(storage.fetch);
  const transport: Transport = {
    async send(args) {
      const url = new URL(args.request.url);
      const partNumber = Number(url.searchParams.get('partNumber') ?? 1);
      const id = `${url.searchParams.get('uploadId')}:${partNumber}`;
      const attempt = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, attempt);
      const fault = opts.fault?.({ url: args.request.url, attempt, partNumber });
      if (fault === 'network') throw Object.assign(new Error('boom'), { name: 'NetworkError' });
      if (fault === 503) return { status: 503, headers: {}, body: '<Error><Code>SlowDown</Code></Error>' };
      if (fault === 'expired')
        return {
          status: 403,
          headers: {},
          body: '<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>',
        };
      puts.push(partNumber);
      return base.send(args);
    },
  };
  const persistence = opts.persistence ?? memoryStore();
  const newClient = () =>
    createUploadClient<typeof contract>({
      baseUrl: 'http://app.test/api/upload',
      contract,
      fetch: (input, init) => server.fetch(new Request(input, init), { user: 'u1' }),
      transport,
      persistence,
      retry: { baseDelayMs: 1, maxDelayMs: 5 },
    });
  return { storage, server, tickets, puts, persistence, client: newClient(), newClient };
}

function settle(task: UploadTask<any, any>, statuses: string[]): Promise<string> {
  return new Promise((resolve) => {
    const check = () => {
      const s = task.getSnapshot().status;
      if (statuses.includes(s)) {
        off();
        resolve(s);
      }
    };
    const off = task.subscribe(check);
    check();
  });
}

describe('upload client', () => {
  it('uploads a multipart file end to end with typed output and progress', async () => {
    const { client, storage } = setup();
    const file = makeFile(21 * MiB + 5);
    const task = client.videos.upload(file, { input: { albumId: 'a1' } });
    const seen = new Set<string>();
    task.subscribe(() => seen.add(task.getSnapshot().status));
    const output = await task.result;
    expectTypeOf(output).toEqualTypeOf<{ mediaId: string }>();
    expect(output.mediaId).toMatch(/^m-/);
    const snap = task.getSnapshot();
    expect(snap).toMatchObject({ status: 'completed', progress: { fraction: 1, partsConfirmed: 3, partsTotal: 3 } });
    expect(snap.receipt).toBeTruthy();
    expect([...seen]).toEqual(expect.arrayContaining(['initializing', 'uploading', 'completing', 'completed']));
    const stored = storage.objects.get(snap.key!)!;
    expect(await digest(await file.arrayBuffer())).toBe(await digest(stored.body));
  });

  it('retries network errors and throttling without failing', async () => {
    const { client } = setup({
      fault: ({ attempt, partNumber }) => (attempt <= 2 ? (partNumber % 2 ? 'network' : 503) : undefined),
    });
    const task = client.videos.upload(makeFile(17 * MiB), { input: { albumId: 'a' } });
    await expect(task.result).resolves.toBeDefined();
  });

  it('re-signs expired part URLs transparently', async () => {
    const { client } = setup({ fault: ({ attempt }) => (attempt === 1 ? 'expired' : undefined) });
    await expect(client.videos.upload(makeFile(9 * MiB), { input: { albumId: 'a' } }).result).resolves.toBeDefined();
  });

  it('fails as retryable after the retry budget, and retry() continues', async () => {
    let broken = true;
    const { client } = setup({ fault: () => (broken ? 'network' : undefined) });
    const task = client.videos.upload(makeFile(9 * MiB), { input: { albumId: 'a' } });
    await settle(task, ['failed']);
    expect(task.getSnapshot().error).toMatchObject({ code: 'NETWORK_ERROR', retryable: true });
    broken = false;
    task.retry();
    await expect(task.result).resolves.toBeDefined();
  });

  it('pauses and resumes', async () => {
    const { client } = setup();
    const task = client.videos.upload(makeFile(30 * MiB), { input: { albumId: 'a' }, paused: true });
    expect(task.getSnapshot().status).toBe('paused');
    task.resume();
    await settle(task, ['uploading']);
    task.pause();
    expect(task.getSnapshot().status).toBe('paused');
    task.resume();
    await expect(task.result).resolves.toBeDefined();
  });

  it('continues an unfinished upload after a reload, sending only the missing parts', async () => {
    const first = setup({ fault: ({ partNumber }) => (partNumber >= 3 ? 'network' : undefined) });
    const file = makeFile(40 * MiB, 7);
    const task = first.client.videos.upload(file, { input: { albumId: 'a' } });
    await settle(task, ['failed']);
    expect(task.getSnapshot().progress.partsConfirmed).toBe(2);

    // "Reload": a new client over the same persisted records and storage, the same file re-selected.
    const second = setup({ storage: first.storage, persistence: first.persistence });
    const again = second.client.videos.upload(file, { input: { albumId: 'a' } });
    await again.result;
    expect(again.getSnapshot().resumed).toBe(true);
    expect(second.puts.sort((a, b) => a - b)).toEqual([3, 4, 5]);
    expect(await digest(await file.arrayBuffer())).toBe(
      await digest(second.storage.objects.get(again.getSnapshot().key!)!.body),
    );
  });

  it('never mixes files: same name and size but different bytes starts a fresh upload', async () => {
    const first = setup({ fault: ({ partNumber }) => (partNumber >= 2 ? 'network' : undefined) });
    const task = first.client.videos.upload(makeFile(20 * MiB, 1), { input: { albumId: 'a' } });
    await settle(task, ['failed']);
    const second = setup({ storage: first.storage, persistence: first.persistence });
    const other = makeFile(20 * MiB, 2);
    const fresh = second.client.videos.upload(other, { input: { albumId: 'a' } });
    await fresh.result;
    expect(fresh.getSnapshot().resumed).toBe(false);
    expect(await digest(await other.arrayBuffer())).toBe(
      await digest(second.storage.objects.get(fresh.getSnapshot().key!)!.body),
    );
  });

  it('restores pending uploads as needs-file and checks the re-selected file', async () => {
    const first = setup({ fault: ({ partNumber }) => (partNumber >= 2 ? 'network' : undefined) });
    const file = makeFile(20 * MiB, 3);
    await settle(first.client.videos.upload(file, { input: { albumId: 'a' } }), ['failed']);

    const second = setup({ storage: first.storage, persistence: first.persistence });
    const [pending] = await second.client.videos.pending();
    expect(pending?.getSnapshot()).toMatchObject({ status: 'needs-file', file: { name: 'clip.mp4', size: 20 * MiB } });
    await expect(pending!.attachFile(makeFile(20 * MiB, 9))).rejects.toMatchObject({ code: 'FILE_MISMATCH' });
    expect(pending!.getSnapshot().status).toBe('needs-file');
    await pending!.attachFile(file);
    await expect(pending!.result).resolves.toMatchObject({ mediaId: expect.any(String) });
    expect(second.puts.sort()).toEqual([2, 3]);
  });

  it('marks an upload discarded by the storage as expired and restarts only on request', async () => {
    const env = setup({ fault: ({ partNumber }) => (partNumber >= 2 ? 'network' : undefined) });
    const file = makeFile(20 * MiB);
    const task = env.client.videos.upload(file, { input: { albumId: 'a' } });
    await settle(task, ['failed']);
    for (const id of env.storage.uploads.keys()) env.storage.expireUpload(id);
    task.retry();
    await settle(task, ['expired']);
    expect(task.getSnapshot().error).toMatchObject({ code: 'SESSION_NOT_FOUND', userAction: 'restart' });
    await expect(task.result).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    expect(await env.persistence.list()).toHaveLength(0);
  });

  it('restart() on an expired task uploads again from zero', async () => {
    let fail = true;
    const env = setup({ fault: ({ partNumber }) => (fail && partNumber >= 2 ? 'network' : undefined) });
    const task = env.client.videos.upload(makeFile(20 * MiB), { input: { albumId: 'a' } });
    await settle(task, ['failed']);
    for (const id of env.storage.uploads.keys()) env.storage.expireUpload(id);
    task.retry();
    await settle(task, ['expired']);
    fail = false;
    task.restart();
    await settle(task, ['completed']);
    expect(task.getSnapshot().output?.mediaId).toBeTruthy();
  });

  it('resumes from a ticket stored by the host app (another device)', async () => {
    const first = setup({ fault: ({ partNumber }) => (partNumber >= 2 ? 'network' : undefined) });
    const file = makeFile(20 * MiB, 4);
    await settle(first.client.videos.upload(file, { input: { albumId: 'a' } }), ['failed']);
    const otherDevice = setup({ storage: first.storage, persistence: memoryStore() });
    const task = otherDevice.client.videos.resume(file, { ticket: first.tickets[0]! });
    await expect(task.result).resolves.toBeDefined();
    expect(otherDevice.puts.sort()).toEqual([2, 3]);
  });

  it('surfaces typed contract errors', async () => {
    const { client } = setup({ quota: 10 });
    const task = client.videos.upload(makeFile(100), { input: { albumId: 'a' } });
    await settle(task, ['failed']);
    const error = task.getSnapshot().error!;
    expect(error).toMatchObject({ code: 'QUOTA_EXCEEDED', data: { remainingBytes: 10 }, retryable: false });
    if (error.code === 'QUOTA_EXCEEDED') expectTypeOf(error.data).toEqualTypeOf<{ remainingBytes: number }>();
  });

  it('validates files on the client when the contract value is given', () => {
    const { client } = setup();
    expect(client.avatar.accept).toBe('image/*');
    expect(client.avatar.validate(makeFile(10, 1, 'a.mp4'))?.code).toBe('FILE_TYPE_NOT_ALLOWED');
    expect(() => client.avatar.upload(makeFile(6_000_000, 1, 'a.png'))).toThrow(/limit/);
  });

  it('builds stable download links and resolves them', async () => {
    const { client, storage } = setup();
    storage.objects.set('k', { body: new Uint8Array(3), object: { key: 'k', size: 3, etag: '"e"', metadata: {} } });
    expect(client.files.download.link({ input: { id: 'k' } })).toBe(
      'http://app.test/api/upload/files/download?input=%7B%22id%22%3A%22k%22%7D',
    );
    await expect(client.files.download.resolve({ input: { id: 'k' } })).resolves.toMatchObject({ object: { size: 3 } });
  });

  it('uploads several files with one init', async () => {
    const { client } = setup();
    const tasks = client.videos.uploadMany([makeFile(1000, 1, 'a.mp4'), makeFile(9 * MiB, 2, 'b.mp4')], {
      input: { albumId: 'a' },
    });
    const outputs = await Promise.all(tasks.map((t) => t.result));
    expect(new Set(outputs.map((o) => o.mediaId)).size).toBe(2);
    expect(client.$tasks.getSnapshot()).toHaveLength(2);
  });

  it('types: input is required when declared', () => {
    const { client } = setup();
    // @ts-expect-error input is required by the contract
    expect(() => client.videos.upload(makeFile(1))).toBeDefined();
    client.avatar.upload(makeFile(1, 1, 'a.png')).cancel();
    // @ts-expect-error unknown endpoint
    client.nope;
  });

  it('works with only the contract type (no value)', async () => {
    const env = setup();
    const typeOnly = createUploadClient<typeof contract>({
      baseUrl: 'http://app.test/api/upload',
      fetch: (input, init) => env.server.fetch(new Request(input, init), { user: 'u1' }),
      transport: fetchTransport(env.storage.fetch),
      persistence: false,
    });
    await expect(typeOnly.videos.upload(makeFile(9 * MiB), { input: { albumId: 'x' } }).result).resolves.toBeDefined();
    expect(typeOnly.files.download.link({ input: { id: '1' } })).toContain('/files/download?input=');
  });
});
