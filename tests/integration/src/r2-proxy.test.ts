import { uc } from '@bu-draft/core';
import { type R2BucketLike, withR2Binding } from '@bu-draft/s3/cloudflare';
import { createUploadServer, implement } from '@bu-draft/server';
import { memoryStorage } from '@bu-draft/server/testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

/** Minimal fake of the Workers R2 binding (range + conditional semantics). */
function fakeR2(objects: Record<string, Uint8Array<ArrayBuffer>>): R2BucketLike {
  return {
    async get(key, options) {
      const data = objects[key];
      if (!data) return null;
      const etag = `"etag-${key}"`;
      const meta = {
        size: data.length,
        httpEtag: etag,
        writeHttpMetadata: (h: Headers) => h.set('content-type', 'video/mp4'),
      };
      const ifNoneMatch = options?.onlyIf?.get('if-none-match');
      if (ifNoneMatch === etag) return meta;
      const ifRange = options?.onlyIf?.get('if-range');
      const range = /bytes=(\d+)-(\d*)/.exec(options?.range?.get('range') ?? '');
      if (range && (!ifRange || ifRange === etag)) {
        const offset = Number(range[1]);
        const end = range[2] ? Number(range[2]) + 1 : data.length;
        return { ...meta, range: { offset, length: end - offset }, body: new Response(data.slice(offset, end)).body! };
      }
      return { ...meta, body: new Response(data).body! };
    },
  };
}

describe('delivery: proxy (Cloudflare R2 binding)', () => {
  const data = new Uint8Array(1000).map((_, i) => i & 0xff);
  const contract = uc.router({ file: uc.download().input(z.object({ key: z.string() })) });
  const t = implement(contract);
  const make = (storage = withR2Binding(memoryStorage(), fakeR2({ 'a.mp4': data }))) =>
    createUploadServer({
      storage,
      secret: 'p'.repeat(32),
      router: t.router({
        file: t.file.handler({
          onDownloadRequested: ({ input }) => ({ key: input.key, fileName: 'a.mp4', delivery: 'proxy' }),
        }),
      }),
    });
  const link = `http://app.test/api/upload/file?input=${encodeURIComponent('{"key":"a.mp4"}')}`;

  it('streams the whole object from the stable link', async () => {
    const res = await make().fetch(new Request(link), {});
    expect(res.status).toBe(200);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-disposition')).toContain('a.mp4');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(data);
  });

  it('resumes with Range + If-Range (what browsers send)', async () => {
    const res = await make().fetch(
      new Request(link, { headers: { range: 'bytes=900-', 'if-range': '"etag-a.mp4"' } }),
      {},
    );
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 900-999/1000');
    expect((await res.arrayBuffer()).byteLength).toBe(100);
  });

  it('refuses proxy mode on storages without getObject', async () => {
    const res = await make(memoryStorage() as never).fetch(new Request(link), {});
    expect(res.status).toBe(500);
  });
});
