/**
 * Scale tests without materialising the volume: a virtual 1 TiB file (no byte is ever allocated or read), the real
 * client engine and the real upload server, over a "ledger" storage that checks every part against its signed length
 * and checksum and keeps only metadata. Proves the engine plans, schedules, persists, resumes and completes ~10,000
 * parts; it does NOT prove anything about real bytes or a real S3 (see tests/e2e/heavy for that).
 */
import {
  checksumHeader,
  createChecksum,
  type SignedRequest,
  type StorageAdapter,
  type StorageCapabilities,
  type StoredPart,
  uc,
} from '@open-upload/core';
import { createUploadServer, implement } from '@open-upload/server';
import { describe, expect, it } from 'vitest';
import { createUploadClient, type Hasher, memoryStore, type Transport, type UploadTask } from './index.js';

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const TiB = 1024 ** 4;

/** A File-like object of any size whose slices know their range and hold no bytes. */
function virtualFile(size: number, name = 'huge.bin', lastModified = 1_700_000_000_000): File {
  const slice = (start: number, end: number): Blob =>
    ({
      size: end - start,
      type: '',
      start,
      slice: (a = 0, b = end - start) => slice(start + a, start + Math.min(b, end - start)),
      arrayBuffer: () => Promise.reject(new Error('virtual file: bytes must not be read')),
      stream: () => {
        throw new Error('virtual file: bytes must not be read');
      },
    }) as unknown as Blob;
  return Object.assign(slice(0, size), { name, lastModified, type: 'application/octet-stream' }) as unknown as File;
}

/** Deterministic CRC32C-shaped checksum of a range: what a real hasher would return for that part. */
function rangeChecksum(start: number, size: number): string {
  const state = createChecksum('crc32c');
  const b = new Uint8Array(16);
  const v = new DataView(b.buffer);
  v.setFloat64(0, start);
  v.setFloat64(8, size);
  state.update(b);
  return state.digest();
}

const virtualHasher: Hasher & { calls: number } = {
  calls: 0,
  async checksum(blob) {
    virtualHasher.calls++;
    return rangeChecksum((blob as unknown as { start: number }).start, blob.size);
  },
};

function ledgerStorage() {
  const capabilities: StorageCapabilities = {
    maxParts: 10_000,
    minPartSize: 5 * MiB,
    maxPartSize: 5 * GiB,
    maxObjectSize: 5 * TiB,
    maxSinglePutSize: 5 * GiB,
    maxPresignExpiry: 7 * 86_400,
    checksums: ['crc32c'],
    incompleteUploadExpiry: null,
    conditionalWrites: true,
  };
  const uploads = new Map<string, { key: string; parts: Map<number, StoredPart> }>();
  const objects = new Map<string, { size: number; etag: string; metadata: Record<string, string> }>();
  const metadataOf = new Map<string, Record<string, string>>();
  let n = 0;
  const sign = (url: string, headers: Record<string, string>, expiresIn: number): SignedRequest => ({
    method: 'PUT',
    url,
    headers,
    expiresAt: Date.now() + expiresIn * 1000,
  });
  const stats = { listPartsCalls: 0, completedParts: 0, rejected: 0 };
  const storage: StorageAdapter = {
    name: 'ledger',
    capabilities,
    async signPutObject(a) {
      return sign(`ledger://${a.key}?length=${a.contentLength}`, {}, a.expiresIn);
    },
    async createMultipartUpload(a) {
      const uploadId = `u${++n}`;
      uploads.set(uploadId, { key: a.key, parts: new Map() });
      metadataOf.set(uploadId, a.metadata ?? {});
      return { key: a.key, uploadId };
    },
    async signUploadPart(a) {
      const headers = a.checksum ? { [checksumHeader('crc32c')]: a.checksum.value } : {};
      return sign(
        `ledger://${a.key}?uploadId=${a.uploadId}&partNumber=${a.partNumber}&length=${a.contentLength}`,
        headers,
        a.expiresIn,
      );
    },
    async listParts(a) {
      stats.listPartsCalls++;
      const u = uploads.get(a.uploadId);
      return u ? [...u.parts.values()].sort((x, y) => x.partNumber - y.partNumber) : null;
    },
    async completeMultipartUpload(a) {
      const u = uploads.get(a.uploadId);
      if (!u) return null;
      a.parts.forEach((p, i) => {
        if (p.partNumber !== i + 1 || !u.parts.has(p.partNumber)) throw new Error(`bad part list at ${i}`);
      });
      const size = a.parts.reduce((s, p) => s + u.parts.get(p.partNumber)!.size, 0);
      stats.completedParts = a.parts.length;
      objects.set(u.key, { size, etag: `"ledger-${a.parts.length}"`, metadata: metadataOf.get(a.uploadId)! });
      uploads.delete(a.uploadId);
      return { etag: `"ledger-${a.parts.length}"` };
    },
    async abortMultipartUpload(a) {
      uploads.delete(a.uploadId);
    },
    async headObject(a) {
      const o = objects.get(a.key);
      return o ? { key: a.key, ...o } : null;
    },
    async signGetObject(a) {
      return { method: 'GET', url: `ledger://${a.key}`, headers: {}, expiresAt: Date.now() + a.expiresIn * 1000 };
    },
  };
  /** Accepts a PUT only if the body matches the signed length and checksum, like S3. */
  const transport = (failFrom = Number.POSITIVE_INFINITY): Transport & { sent: number[]; bytes: number } => {
    const t = {
      sent: [] as number[],
      bytes: 0,
      async send({ request, body }: Parameters<Transport['send']>[0]) {
        const url = new URL(request.url);
        const partNumber = Number(url.searchParams.get('partNumber'));
        if (partNumber >= failFrom) throw Object.assign(new Error('cut'), { name: 'NetworkError' });
        const start = (body as unknown as { start: number }).start;
        const ok =
          body.size === Number(url.searchParams.get('length')) &&
          request.headers[checksumHeader('crc32c')] === rangeChecksum(start, body.size);
        if (!ok) {
          stats.rejected++;
          return { status: 400, headers: {}, body: '<Error><Code>BadDigest</Code></Error>' };
        }
        const u = uploads.get(url.searchParams.get('uploadId')!)!;
        u.parts.set(partNumber, {
          partNumber,
          size: body.size,
          etag: `"e${partNumber}"`,
          checksum: request.headers[checksumHeader('crc32c')]!,
        });
        t.sent.push(partNumber);
        t.bytes += body.size;
        return { status: 200, headers: { etag: `"e${partNumber}"` }, body: '' };
      },
    };
    return t;
  };
  return { storage, transport, stats };
}

const contract = uc.router({ big: uc.upload().files({ maxFileSize: '5TiB' }) });

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

describe('scale (virtual 1 TiB file, nothing materialised)', () => {
  it('uploads 9,987 parts, cut at part 6,000, resumes sending only the missing parts', async () => {
    const ledger = ledgerStorage();
    const t = implement(contract);
    const server = createUploadServer({
      storage: ledger.storage,
      secret: 's'.repeat(32),
      router: t.router({ big: t.big.handler({ onUploadRequested: ({ sessionId }) => ({ key: `big/${sessionId}` }) }) }),
    });
    const control: Record<string, number> = {};
    const persistence = memoryStore();
    const client = (transport: Transport) =>
      createUploadClient<typeof contract>({
        baseUrl: 'http://app.test/api/upload',
        contract,
        fetch: (input, init) => {
          const op = new URL(String(input)).pathname.split('/').pop()!;
          control[op] = (control[op] ?? 0) + 1;
          return server.fetch(new Request(input, init), {});
        },
        transport,
        hasher: virtualHasher,
        persistence,
        retry: { baseDelayMs: 1, maxDelayMs: 2, maxAttempts: 2 },
        concurrency: { initial: 6, max: 6, mode: 'fixed' },
      });
    const file = virtualFile(1 * TiB + 12_345);
    const started = performance.now();

    const first = ledger.transport(6000);
    const task = client(first).big.upload(file);
    await settle(task, ['failed']);
    const cut = task.getSnapshot();
    expect(cut.progress.partsTotal).toBe(9987);
    expect(cut.progress.partsConfirmed).toBe(5999);
    expect(new Set(first.sent).size).toBe(5999);

    // "Reload": a fresh client over the same persisted record; the same (virtual) file re-selected.
    const second = ledger.transport();
    const again = client(second).big.upload(file);
    await again.result;
    const snap = again.getSnapshot();
    expect(snap).toMatchObject({ status: 'completed', resumed: true, progress: { fraction: 1, partsTotal: 9987 } });
    // Only the missing parts went out again, each once.
    expect(second.sent.length).toBe(9987 - 5999);
    expect(Math.min(...second.sent)).toBe(6000);
    expect(new Set(second.sent).size).toBe(second.sent.length);
    expect(first.bytes + second.bytes).toBe(file.size);
    expect(ledger.stats).toMatchObject({ completedParts: 9987, rejected: 0 });
    const elapsed = performance.now() - started;
    // Control traffic stays small: URLs are signed in batches of 10 (parallel parts share a batch in flight).
    // Before the fix this was one sign round-trip per part (9,989 requests).
    console.info(
      `[scale] 9,987 parts (1 TiB virtual): ${Math.round(elapsed)} ms, control requests ${JSON.stringify(control)}, ` +
        `hasher calls ${virtualHasher.calls}`,
    );
    expect(control.sign).toBeLessThanOrEqual(Math.ceil(9987 / 10) + 12);
    expect(elapsed).toBeLessThan(60_000);
  }, 120_000);
});
