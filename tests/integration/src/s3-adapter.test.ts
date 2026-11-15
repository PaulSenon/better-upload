import { checksumBytes, partRange, planParts } from '@bu-draft/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { runId, targets } from './env.js';

const MiB = 1024 * 1024;
function bytes(size: number, seed = 1): Uint8Array {
  const out = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

for (const target of targets) {
  describe(`S3 adapter against ${target.name}`, () => {
    const storage = target.create(`${runId}adapter/`);
    beforeAll(async () => target.setup?.());

    it('presigned single PUT with signed checksum and metadata, then HEAD and presigned GET', async () => {
      const data = bytes(1234);
      const checksum = await checksumBytes('crc32c', data);
      const signed = await storage.signPutObject({
        key: 'single.bin',
        contentLength: data.length,
        contentType: 'application/octet-stream',
        checksum: { algorithm: 'crc32c', value: checksum },
        metadata: { 'upload-session': 's1' },
        expiresIn: 60,
      });
      const put = await fetch(signed.url, { method: 'PUT', headers: signed.headers, body: data });
      expect(put.status, await put.clone().text()).toBe(200);
      const head = await storage.headObject({ key: 'single.bin' });
      expect(head).toMatchObject({ size: 1234, metadata: { 'upload-session': 's1' } });
      const get = await storage.signGetObject({
        key: 'single.bin',
        expiresIn: 60,
        responseContentDisposition: 'attachment; filename="a b.bin"',
      });
      const res = await fetch(get.url);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toBe('attachment; filename="a b.bin"');
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(data);
    });

    it('rejects a body whose checksum does not match the signed one', async () => {
      const data = bytes(100);
      const signed = await storage.signPutObject({
        key: 'bad.bin',
        contentLength: 100,
        checksum: { algorithm: 'crc32c', value: await checksumBytes('crc32c', bytes(100, 2)) },
        expiresIn: 60,
      });
      const put = await fetch(signed.url, { method: 'PUT', headers: signed.headers, body: data });
      expect(put.status).toBeGreaterThanOrEqual(400);
    });

    it('rejects a body whose length differs from the signed content-length', async () => {
      const signed = await storage.signPutObject({ key: 'len.bin', contentLength: 100, expiresIn: 60 });
      const put = await fetch(signed.url, { method: 'PUT', headers: signed.headers, body: bytes(99) });
      expect(put.status).toBeGreaterThanOrEqual(400);
    });

    it('multipart: create, presigned parts with checksums, list, complete, idempotent abort', async () => {
      const data = bytes(12 * MiB + 17);
      const plan = planParts(data.length, storage.capabilities, 'crc32c', {
        preferred: 5 * MiB,
        singlePutThreshold: 5 * MiB,
      });
      expect(plan.partCount).toBe(3);
      const ref = await storage.createMultipartUpload({
        key: 'multi.bin',
        checksumAlgorithm: 'crc32c',
        metadata: { 'upload-session': 'm1' },
      });
      for (let n = 1; n <= plan.partCount; n++) {
        const { start, end } = partRange(plan, n);
        const body = data.subarray(start, end);
        const signed = await storage.signUploadPart({
          ...ref,
          partNumber: n,
          contentLength: body.length,
          checksum: { algorithm: 'crc32c', value: await checksumBytes('crc32c', body) },
          expiresIn: 60,
        });
        const res = await fetch(signed.url, { method: 'PUT', headers: signed.headers, body });
        expect(res.status, await res.clone().text()).toBe(200);
      }
      const parts = await storage.listParts({ ...ref, checksumAlgorithm: 'crc32c' });
      expect(parts?.map((p) => p.partNumber)).toEqual([1, 2, 3]);
      expect(parts?.[0]?.checksum).toBe(await checksumBytes('crc32c', data.subarray(0, 5 * MiB)));
      const done = await storage.completeMultipartUpload({ ...ref, parts: parts!, checksumAlgorithm: 'crc32c' });
      expect(done?.etag).toMatch(/-3"?$/);
      expect(await storage.listParts(ref)).toBeNull();
      expect(await storage.completeMultipartUpload({ ...ref, parts: parts!, checksumAlgorithm: 'crc32c' })).toBeNull();
      await storage.abortMultipartUpload(ref);
      const head = await storage.headObject({ key: 'multi.bin' });
      expect(head?.size).toBe(data.length);
      expect(head?.metadata['upload-session']).toBe('m1');
    });

    it('abort makes the upload unknown', async () => {
      const ref = await storage.createMultipartUpload({ key: 'aborted.bin' });
      await storage.abortMultipartUpload(ref);
      expect(await storage.listParts(ref)).toBeNull();
    });

    it('serves Range requests on presigned GET (resumable downloads)', async () => {
      const get = await storage.signGetObject({ key: 'single.bin', expiresIn: 60 });
      const res = await fetch(get.url, { headers: { range: 'bytes=10-19' } });
      expect(res.status).toBe(206);
      expect((await res.arrayBuffer()).byteLength).toBe(10);
    });

    it('handles keys with spaces and unicode', async () => {
      const key = 'dir with space/été (1)+x.txt';
      const signed = await storage.signPutObject({ key, contentLength: 3, expiresIn: 60 });
      expect((await fetch(signed.url, { method: 'PUT', headers: signed.headers, body: 'abc' })).status).toBe(200);
      expect((await storage.headObject({ key }))?.size).toBe(3);
      await storage.deleteObject({ key });
      expect(await storage.headObject({ key })).toBeNull();
    });
  });
}
