import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  checkFiles,
  checksumBlob,
  checksumBytes,
  createChecksum,
  flattenRouter,
  isChecksumValue,
  matchesAccept,
  parseBytes,
  parseDuration,
  partLength,
  planParts,
  type StorageCapabilities,
  toBase64,
  UploadError,
  uc,
} from './index.js';

const enc = new TextEncoder();
const hex = (b64: string) => [...atob(b64)].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
const nativeB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

describe('checksums (standard check values for "123456789")', () => {
  const data = enc.encode('123456789');
  it('crc32', async () => expect(hex(await checksumBytes('crc32', data))).toBe('cbf43926'));
  it('crc32c', async () => expect(hex(await checksumBytes('crc32c', data))).toBe('e3069283'));
  it('crc64nvme', async () => expect(hex(await checksumBytes('crc64nvme', data))).toBe('ae8b14860a799888'));
  it('sha256', async () =>
    expect(hex(await checksumBytes('sha256', data))).toBe(
      '15e2b0d3c33891ebb0f1ef609ec419420c20e320ce94c65fbc8c3312448eb225',
    ));
  it('is incremental and chunk-size independent', async () => {
    const big = new Uint8Array(3_000_003).map((_, i) => (i * 31) & 0xff);
    const whole = await checksumBytes('crc32c', big);
    const state = createChecksum('crc32c');
    for (let i = 0; i < big.length; i += 777_777) state.update(big.subarray(i, i + 777_777));
    expect(state.digest()).toBe(whole);
    expect(await checksumBlob('crc32c', new Blob([big]), { chunkSize: 65_536 })).toBe(whole);
    expect(await checksumBlob('crc64nvme', new Blob([big]))).toBe(await checksumBytes('crc64nvme', big));
  });
  it('base64 matches Buffer', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 31]) {
      const b = new Uint8Array(n).map((_, i) => i * 7);
      expect(toBase64(b)).toBe(nativeB64(b));
    }
  });
  it('validates checksum shapes', () => {
    expect(isChecksumValue('crc32c', '4waSgw==')).toBe(true);
    expect(isChecksumValue('crc32c', 'nope')).toBe(false);
  });
});

describe('units', () => {
  it('parses sizes and durations', () => {
    expect(parseBytes('10MiB')).toBe(10 * 1024 * 1024);
    expect(parseBytes('1.5GB')).toBe(1.5e9);
    expect(parseBytes(42)).toBe(42);
    expect(parseDuration('7d')).toBe(7 * 86400e3);
    expect(parseDuration('90s')).toBe(90_000);
    expect(() => parseBytes('10 parsecs' as never)).toThrow();
  });
});

const caps: StorageCapabilities = {
  maxParts: 10_000,
  minPartSize: 5 * 1024 ** 2,
  maxPartSize: 5 * 1024 ** 3,
  maxObjectSize: 5 * 1024 ** 4,
  maxSinglePutSize: 5 * 1024 ** 3,
  maxPresignExpiry: 7 * 86400,
  checksums: ['crc32c'],
  incompleteUploadExpiry: null,
  conditionalWrites: true,
};

describe('part planning', () => {
  it('uses a single PUT for small files', () => {
    expect(planParts(1000, caps, 'crc32c')).toMatchObject({ strategy: 'single', partCount: 1, partSize: 1000 });
    expect(planParts(0, caps, 'none').strategy).toBe('single');
  });
  it('uses equal 8 MiB parts by default', () => {
    const plan = planParts(100 * 1024 ** 2 + 5, caps, 'crc32c');
    expect(plan).toMatchObject({ strategy: 'multipart', partSize: 8 * 1024 ** 2, partCount: 13 });
    expect(partLength(plan, 13)).toBe(100 * 1024 ** 2 + 5 - 12 * 8 * 1024 ** 2);
  });
  it('grows parts to stay under maxParts', () => {
    const size = 200 * 1024 ** 3;
    const plan = planParts(size, caps, 'crc32c');
    expect(plan.partCount).toBeLessThanOrEqual(10_000);
    expect(plan.partSize % (1024 * 1024)).toBe(0);
  });
  it('rejects files above provider limits', () => {
    expect(() => planParts(6 * 1024 ** 4, caps, 'none')).toThrow(UploadError);
  });
});

describe('file rules', () => {
  const file = { name: 'IMG_0001.HEIC', size: 2_000, type: '', lastModified: 0 };
  it('matches MIME wildcards and extensions', () => {
    expect(matchesAccept({ name: 'a.png', type: 'image/png' }, ['image/*'])).toBe(true);
    expect(matchesAccept(file, ['image/*'])).toBe(false);
    expect(matchesAccept(file, ['image/*', '.heic'])).toBe(true);
    expect(matchesAccept({ name: 'a.mp4', type: 'video/mp4' }, ['video/mp4'])).toBe(true);
  });
  it('checks count, size and type', () => {
    expect(checkFiles([file, file], { maxFiles: 1 })?.code).toBe('TOO_MANY_FILES');
    expect(checkFiles([file], { maxFileSize: '1KB' })?.code).toBe('FILE_TOO_LARGE');
    expect(checkFiles([file], { minFileSize: '1MB' })?.code).toBe('FILE_TOO_SMALL');
    expect(checkFiles([file], { accept: ['video/*'] })?.code).toBe('FILE_TYPE_NOT_ALLOWED');
    expect(checkFiles([file, file], { maxFiles: 2, maxTotalSize: '3KB' })?.code).toBe('FILE_TOO_LARGE');
    expect(checkFiles([file], { accept: ['.heic'], maxFileSize: '1MB' })).toBeUndefined();
  });
});

describe('contract builder', () => {
  it('is immutable and flattens nested routers', () => {
    const base = uc.upload();
    const withInput = base.input(z.object({ a: z.string() }));
    expect(base['~def'].input).toBeUndefined();
    expect(withInput['~def'].input).toBeDefined();
    const router = uc.router({ avatar: base, media: { video: withInput.files({ maxFiles: 3 }), dl: uc.download() } });
    expect([...flattenRouter(router).keys()]).toEqual(['avatar', 'media/video', 'media/dl']);
    expect(router.media.video['~def'].files.maxFiles).toBe(3);
  });
  it('merges errors and disables resume', () => {
    const c = uc
      .upload()
      .errors({ A: { status: 403 } })
      .errors({ B: {} })
      .resume(false);
    expect(Object.keys(c['~def'].errors)).toEqual(['A', 'B']);
    expect(c['~def'].resume.enabled).toBe(false);
  });
  it('rejects bad endpoint names', () => {
    expect(() => flattenRouter({ 'a/b': uc.upload() })).toThrow();
  });
});

describe('UploadError', () => {
  it('applies built-in defaults and serializes', () => {
    const e = UploadError.builtin('SESSION_EXPIRED');
    expect(e.userAction).toBe('restart');
    expect(e.toJSON()).toMatchObject({ code: 'SESSION_EXPIRED', status: 410, retryable: false });
    expect(UploadError.from(new DOMException('x', 'AbortError')).code).toBe('CANCELED');
  });
});
