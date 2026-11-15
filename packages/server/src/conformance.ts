import { checksumBytes, partRange, planParts, type StorageAdapter } from '@open-upload/core';

/**
 * Conformance kit for storage adapters. Runs the exact sequence the upload server and client rely on against a real
 * bucket (or a fake) and reports what works. Use it to validate a new adapter or a new S3-compatible provider:
 *
 * ```ts
 * const results = await checkStorageConformance(myAdapter);
 * for (const r of results) expect(r.ok, `${r.name}: ${r.error}`).toBe(true);
 * ```
 *
 * It writes a few small objects under `prefix` (default `conformance/<random>/`) and cleans up what it can.
 */
export interface ConformanceResult {
  readonly name: string;
  readonly ok: boolean;
  readonly skipped?: boolean;
  readonly error?: string;
}

export interface ConformanceOptions {
  /** fetch used to send presigned requests (browser-equivalent). Default: global fetch. */
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly prefix?: string;
}

const MiB = 1024 * 1024;

function bytes(size: number, seed: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(size);
  let x = seed >>> 0;
  for (let i = 0; i < size; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

export async function checkStorageConformance(
  storage: StorageAdapter,
  options: ConformanceOptions = {},
): Promise<ConformanceResult[]> {
  const send = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const prefix = options.prefix ?? `conformance/${Math.random().toString(36).slice(2, 10)}/`;
  const algorithm = storage.capabilities.checksums[0];
  const results: ConformanceResult[] = [];
  const check = async (name: string, fn: () => Promise<void>, skip?: string) => {
    if (skip) return void results.push({ name, ok: true, skipped: true, error: skip });
    try {
      await fn();
      results.push({ name, ok: true });
    } catch (error) {
      results.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };
  const assert = (cond: unknown, message: string) => {
    if (!cond) throw new Error(message);
  };
  const put = (
    req: { url: string; method: string; headers: Readonly<Record<string, string>> },
    body: Uint8Array<ArrayBuffer>,
  ) => send(req.url, { method: req.method, headers: req.headers, body });

  const single = bytes(1000, 1);
  await check('single PUT with signed metadata, then HEAD', async () => {
    const req = await storage.signPutObject({
      key: `${prefix}single.bin`,
      contentLength: single.length,
      contentType: 'application/octet-stream',
      metadata: { 'upload-session': 'conformance' },
      ...(algorithm && algorithm !== 'none'
        ? { checksum: { algorithm, value: await checksumBytes(algorithm, single) } }
        : {}),
      expiresIn: 300,
    });
    const res = await put(req, single);
    assert(res.ok, `PUT returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const head = await storage.headObject({ key: `${prefix}single.bin` });
    assert(head?.size === single.length, `HEAD size ${head?.size}`);
    assert(head?.metadata['upload-session'] === 'conformance', 'metadata not returned by HEAD');
  });

  await check(
    'rejects bytes that do not match the signed checksum',
    async () => {
      const req = await storage.signPutObject({
        key: `${prefix}bad-checksum.bin`,
        contentLength: 100,
        checksum: { algorithm: algorithm!, value: await checksumBytes(algorithm as 'crc32c', bytes(100, 9)) },
        expiresIn: 300,
      });
      const res = await put(req, bytes(100, 10));
      assert(!res.ok, 'a wrong body was accepted');
    },
    algorithm ? undefined : 'no checksum support declared',
  );

  await check('rejects a body whose size differs from the signed length', async () => {
    const req = await storage.signPutObject({ key: `${prefix}bad-length.bin`, contentLength: 100, expiresIn: 300 });
    const res = await put(req, bytes(99, 3));
    assert(!res.ok, 'a shorter body was accepted (content-length is not enforced)');
  });

  const data = bytes(11 * MiB + 5, 4);
  const plan = planParts(data.length, storage.capabilities, algorithm ?? 'none', {
    preferred: Math.max(5 * MiB, storage.capabilities.minPartSize),
    singlePutThreshold: 0,
  });
  let ref: { key: string; uploadId: string } | undefined;
  await check('multipart: create, presigned parts, list with sizes and checksums', async () => {
    ref = await storage.createMultipartUpload({
      key: `${prefix}multi.bin`,
      checksumAlgorithm: algorithm ?? 'none',
      metadata: { 'upload-session': 'multi' },
    });
    for (let n = 1; n <= plan.partCount; n++) {
      const { start, end } = partRange(plan, n);
      const body = data.slice(start, end);
      const req = await storage.signUploadPart({
        ...ref,
        partNumber: n,
        contentLength: body.length,
        ...(algorithm ? { checksum: { algorithm, value: await checksumBytes(algorithm as 'crc32c', body) } } : {}),
        expiresIn: 300,
      });
      const res = await put(req, body);
      assert(res.ok, `part ${n}: ${res.status}`);
    }
    const parts = await storage.listParts({ ...ref, ...(algorithm ? { checksumAlgorithm: algorithm } : {}) });
    assert(parts?.length === plan.partCount, `listed ${parts?.length} parts`);
    assert(
      parts?.every((p) => p.size === partRange(plan, p.partNumber).end - partRange(plan, p.partNumber).start),
      'part sizes',
    );
    if (algorithm)
      assert(
        parts?.every((p) => p.checksum),
        'part checksums are not returned by ListParts',
      );
  });

  await check('multipart: complete, object visible with metadata, re-complete returns null', async () => {
    assert(ref, 'previous step failed');
    const parts = (await storage.listParts({ ...ref!, ...(algorithm ? { checksumAlgorithm: algorithm } : {}) }))!;
    const done = await storage.completeMultipartUpload({
      ...ref!,
      parts,
      ...(algorithm ? { checksumAlgorithm: algorithm } : {}),
    });
    assert(done, 'complete returned null');
    const head = await storage.headObject({ key: `${prefix}multi.bin` });
    assert(head?.size === data.length, `object size ${head?.size}`);
    assert(head?.metadata['upload-session'] === 'multi', 'multipart metadata lost');
    assert((await storage.listParts(ref!)) === null, 'ListParts on a completed upload should return null');
    assert(
      (await storage.completeMultipartUpload({
        ...ref!,
        parts,
        ...(algorithm ? { checksumAlgorithm: algorithm } : {}),
      })) === null,
      'a second complete should return null (NoSuchUpload)',
    );
  });

  await check('abort makes an upload unknown; aborting twice succeeds', async () => {
    const r = await storage.createMultipartUpload({ key: `${prefix}aborted.bin` });
    await storage.abortMultipartUpload(r);
    await storage.abortMultipartUpload(r);
    assert((await storage.listParts(r)) === null, 'aborted upload still listed');
  });

  await check('presigned GET serves ranges (resumable downloads) and Content-Disposition', async () => {
    const req = await storage.signGetObject({
      key: `${prefix}multi.bin`,
      expiresIn: 300,
      responseContentDisposition: 'attachment; filename="x.bin"',
    });
    const res = await send(req.url, { headers: { range: 'bytes=10-19' } });
    assert(res.status === 206, `range status ${res.status}`);
    assert((await res.arrayBuffer()).byteLength === 10, 'range length');
    const full = await send(req.url);
    assert(full.headers.get('content-disposition')?.includes('x.bin'), 'content-disposition not applied');
    await full.body?.cancel();
  });

  await check('HEAD of a missing object returns null', async () => {
    assert((await storage.headObject({ key: `${prefix}missing.bin` })) === null, 'expected null');
  });

  for (const key of ['single.bin', 'multi.bin'])
    await storage.deleteObject?.({ key: `${prefix}${key}` }).catch(() => {});
  return results;
}
