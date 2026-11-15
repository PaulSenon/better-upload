import { checksumBytes, PROTOCOL_HEADER, partRange, uc } from '@open-upload/core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { createUploadServer, implement } from './index.js';
import { memoryStorage } from './testing.js';

const contract = uc.router({
  avatar: uc
    .upload()
    .files({ accept: ['image/*'], maxFileSize: '1MB' })
    .output(z.object({ url: z.string() })),
  videos: uc
    .upload()
    .files({ accept: ['video/*'], maxFiles: 3 })
    .input(z.object({ albumId: z.string() }))
    .output(z.object({ mediaId: z.string() }))
    .errors({ QUOTA_EXCEEDED: { status: 403, data: z.object({ remainingBytes: z.number() }) } }),
  media: { download: uc.download().input(z.object({ id: z.string() })) },
});

const SECRET = 'x'.repeat(40);
const MiB = 1024 * 1024;

function setup(opts: { quota?: number } = {}) {
  const storage = memoryStorage();
  const events: string[] = [];
  const t = implement(contract).$context<{ userId: string | null }>();
  const authed = t.videos.use(async ({ context, next }) => {
    if (!context.userId) throw new Error('no user');
    return next({ userId: context.userId });
  });
  const router = t.router({
    avatar: t.avatar.handler({
      onUploadRequested: ({ sessionId }) => ({ key: `avatars/${sessionId}` }),
      onUploadCompleted: ({ object }) => ({ url: `https://cdn.test/${object.key}` }),
    }),
    videos: authed.handler({
      onUploadRequested: ({ context, input, file, files, sessionId, errors }) => {
        expectTypeOf(context.userId).toEqualTypeOf<string>();
        const total = files.reduce((n, f) => n + f.size, 0);
        if (opts.quota !== undefined && total > opts.quota)
          errors('QUOTA_EXCEEDED', { data: { remainingBytes: opts.quota } });
        return { key: `albums/${input.albumId}/${sessionId}-${file.name}`, meta: { owner: context.userId } };
      },
      onUploadStarted: ({ session }) => {
        expectTypeOf(session.meta).toEqualTypeOf<{ owner: string }>();
        events.push(`started:${session.id}`);
      },
      onUploadCompleted: ({ session, alreadyCompleted }) => {
        events.push(`completed:${session.id}:${alreadyCompleted}`);
        return { mediaId: `m-${session.id}` };
      },
      onUploadAborted: ({ session }) => {
        events.push(`aborted:${session.id}`);
      },
    }),
    media: {
      download: t.media.download.handler({
        onDownloadRequested: ({ input, errors }) => {
          if (input.id === 'missing') errors('NOT_FOUND');
          return { key: input.id, fileName: 'Vidéo été.mp4' };
        },
      }),
    },
  });
  const server = createUploadServer({ router, storage, secret: SECRET });
  const call = async (path: string, body: unknown, userId: string | null = 'u1') => {
    const res = await server.fetch(
      new Request(`http://app.test/api/upload/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [PROTOCOL_HEADER]: '1' },
        body: JSON.stringify(body),
      }),
      { userId },
    );
    return { status: res.status, body: (await res.json()) as any };
  };
  return { storage, server, call, events };
}

const file = (size: number, name = 'clip.mp4', type = 'video/mp4') => ({ name, size, type, lastModified: 1 });
const data = (size: number) => new Uint8Array(size).map((_, i) => (i * 7) & 0xff);

async function uploadAllParts(
  storage: ReturnType<typeof memoryStorage>,
  call: ReturnType<typeof setup>['call'],
  session: any,
  bytes: Uint8Array,
  path = 'videos',
) {
  for (let n = 1; n <= session.plan.partCount; n++) {
    const { start, end } = partRange(session.plan, n);
    const body = bytes.subarray(start, end);
    const signed = await call(`${path}/sign`, {
      ticket: session.ticket,
      parts: [{ partNumber: n, checksum: await checksumBytes('crc32c', body) }],
    });
    expect(signed.status).toBe(200);
    const req = signed.body.parts[0].request;
    const res = await storage.fetch(req.url, { method: 'PUT', headers: req.headers, body: body as BodyInit });
    expect(res.status).toBe(200);
  }
}

describe('upload server', () => {
  it('runs a full multipart upload with typed hooks, status and receipt', async () => {
    const { storage, server, call, events } = setup();
    const bytes = data(20 * MiB + 3);
    const init = await call('videos/init', { input: { albumId: 'a1' }, files: [file(bytes.length)] });
    expect(init.status).toBe(200);
    const session = init.body.sessions[0];
    expect(session.plan).toMatchObject({ strategy: 'multipart', partCount: 3, checksum: 'crc32c' });
    expect(events).toEqual([`started:${session.sessionId}`]);

    await uploadAllParts(storage, call, session, bytes);
    const status = await call('videos/status', { ticket: session.ticket });
    expect(status.body.uploadedParts.map((p: any) => p.partNumber)).toEqual([1, 2, 3]);

    const done = await call('videos/complete', { ticket: session.ticket });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ output: { mediaId: `m-${session.sessionId}` }, alreadyCompleted: false });
    expect(await checksumBytes('sha256', storage.objects.get(session.key)!.body)).toBe(
      await checksumBytes('sha256', bytes),
    );

    const again = await call('videos/complete', { ticket: session.ticket });
    expect(again.body.alreadyCompleted).toBe(true);
    expect(events.at(-1)).toBe(`completed:${session.sessionId}:true`);

    const receipt = await server.verifyReceipt<{ owner: string }>(done.body.receipt, { endpoint: 'videos' });
    expect(receipt).toMatchObject({
      sessionId: session.sessionId,
      meta: { owner: 'u1' },
      object: { size: bytes.length },
    });
    expect(await server.verifyReceipt(done.body.receipt, { endpoint: 'avatar' })).toBeNull();
    expect(await server.verifyReceipt(session.ticket)).toBeNull();
  });

  it('uses a single PUT for small files', async () => {
    const { storage, call } = setup();
    const bytes = data(1000);
    const init = await call('avatar/init', { files: [file(1000, 'me.png', 'image/png')] });
    const session = init.body.sessions[0];
    expect(session.plan.strategy).toBe('single');
    await uploadAllParts(storage, call, session, bytes, 'avatar');
    const done = await call('avatar/complete', { ticket: session.ticket });
    expect(done.body.output.url).toBe(`https://cdn.test/${session.key}`);
    expect(storage.objects.get(session.key)?.object.contentType).toBe('image/png');
  });

  it('enforces file rules, input schema, middleware and typed errors', async () => {
    const { call } = setup({ quota: 100 });
    expect((await call('avatar/init', { files: [file(10, 'a.pdf', 'application/pdf')] })).body.error.code).toBe(
      'FILE_TYPE_NOT_ALLOWED',
    );
    expect((await call('avatar/init', { files: [file(2_000_000, 'a.png', 'image/png')] })).body.error).toMatchObject({
      code: 'FILE_TOO_LARGE',
      status: 413,
      userAction: 'change-file',
    });
    expect(
      (await call('videos/init', { input: { albumId: 'a' }, files: [file(1), file(1), file(1), file(1)] })).body.error
        .code,
    ).toBe('TOO_MANY_FILES');
    expect((await call('videos/init', { input: {}, files: [file(1)] })).body.error.code).toBe('INPUT_INVALID');
    expect((await call('videos/init', { input: { albumId: 'a' }, files: [file(1)] }, null)).body.error.code).toBe(
      'INTERNAL_ERROR',
    );
    const quota = await call('videos/init', { input: { albumId: 'a' }, files: [file(500)] });
    expect(quota.status).toBe(403);
    expect(quota.body.error).toMatchObject({ code: 'QUOTA_EXCEEDED', data: { remainingBytes: 100 } });
  });

  it('refuses incomplete, wrong-size or checksum-less uploads at completion', async () => {
    const { call } = setup();
    const init = await call('videos/init', { input: { albumId: 'a' }, files: [file(12 * MiB)] });
    const done = await call('videos/complete', { ticket: init.body.sessions[0].ticket });
    expect(done.body.error).toMatchObject({ code: 'INTEGRITY_MISMATCH', data: { partNumber: 1 } });
    const bad = await call('videos/sign', { ticket: init.body.sessions[0].ticket, parts: [{ partNumber: 1 }] });
    expect(bad.body.error.code).toBe('BAD_REQUEST');
    const out = await call('videos/sign', {
      ticket: init.body.sessions[0].ticket,
      parts: [{ partNumber: 99, checksum: 'AAAAAA==' }],
    });
    expect(out.body.error.message).toContain('Invalid part number');
  });

  it('rejects forged, foreign and expired tickets; aborts are idempotent', async () => {
    const { storage, call, events } = setup();
    const init = await call('videos/init', { input: { albumId: 'a' }, files: [file(12 * MiB)] });
    const { ticket, sessionId } = init.body.sessions[0];
    expect((await call('videos/status', { ticket: `${ticket}x` })).body.error.code).toBe('SESSION_INVALID');
    expect((await call('avatar/status', { ticket })).body.error.code).toBe('SESSION_INVALID');
    storage.expireUpload([...storage.uploads.keys()][0]!);
    const gone = await call('videos/status', { ticket });
    expect(gone.status).toBe(410);
    expect(gone.body.error).toMatchObject({ code: 'SESSION_NOT_FOUND', userAction: 'restart' });
    expect((await call('videos/abort', { ticket })).status).toBe(200);
    expect((await call('videos/abort', { ticket })).status).toBe(200);
    expect(events).toContain(`aborted:${sessionId}`);
  });

  it('requires the protocol header (CSRF guard)', async () => {
    const { server } = setup();
    const res = await server.fetch(
      new Request('http://app.test/api/upload/avatar/init', { method: 'POST', body: '{}' }),
      { userId: null },
    );
    expect(res.status).toBe(400);
  });

  it('serves stable download links as redirects and resolves with object info', async () => {
    const { storage, server, call } = setup();
    storage.objects.set('k1', { body: data(5), object: { key: 'k1', size: 5, etag: '"e"', metadata: {} } });
    const res = await server.fetch(
      new Request(`http://app.test/api/upload/media/download?input=${encodeURIComponent('{"id":"k1"}')}`),
      { userId: 'u1' },
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(location.searchParams.get('disposition')).toBe(
      `attachment; filename="Vid_o _t_.mp4"; filename*=UTF-8''Vid%C3%A9o%20%C3%A9t%C3%A9.mp4`,
    );
    const resolved = await call('media/download/resolve', { input: { id: 'k1' } });
    expect(resolved.body).toMatchObject({
      link: '/api/upload/media/download?input=%7B%22id%22%3A%22k1%22%7D',
      object: { size: 5 },
    });
    const missing = await server.fetch(
      new Request(`http://app.test/api/upload/media/download?input=${encodeURIComponent('{"id":"missing"}')}`),
      { userId: 'u1' },
    );
    expect(missing.status).toBe(404);
  });

  it('fails fast when an endpoint is not implemented', () => {
    const t = implement(contract);
    expect(() =>
      // @ts-expect-error missing endpoints are a type error
      t.router({
        avatar: t.avatar.handler({ onUploadRequested: () => ({ key: 'k' }), onUploadCompleted: () => ({ url: '' }) }),
      }),
    ).toThrow(/not implemented/);
  });

  it('types: output is required when declared and checked', () => {
    const t = implement(contract);
    // @ts-expect-error onUploadCompleted is required because the contract declares an output
    t.avatar.handler({ onUploadRequested: () => ({ key: 'k' }) });
    // @ts-expect-error wrong output shape
    t.avatar.handler({ onUploadRequested: () => ({ key: 'k' }), onUploadCompleted: () => ({ nope: 1 }) });
    const noOutput = implement(uc.router({ a: uc.upload() }));
    noOutput.a.handler({ onUploadRequested: () => ({ key: 'k' }) });
  });
});

describe('storage conformance kit', () => {
  it('the in-memory storage passes every check', async () => {
    const storage = memoryStorage();
    const results = await (await import('./testing.js')).checkStorageConformance(storage, { fetch: storage.fetch });
    for (const r of results) expect(r.ok, `${r.name}: ${r.error}`).toBe(true);
    expect(results.length).toBeGreaterThanOrEqual(8);
  });
});
