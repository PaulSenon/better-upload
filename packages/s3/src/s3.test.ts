import { describe, expect, it } from 'vitest';
import { minio, s3Storage } from './index.js';

describe('s3Storage', () => {
  it('lists every part of a 10,000-part upload across ListParts pages', async () => {
    const markers: (string | null)[] = [];
    const fetch = (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const marker = url.searchParams.get('part-number-marker');
      markers.push(marker);
      const from = Number(marker ?? 0) + 1;
      const to = Math.min(from + 999, 10_000);
      const parts = [];
      for (let n = from; n <= to; n++)
        parts.push(
          `<Part><PartNumber>${n}</PartNumber><Size>8388608</Size><ETag>"e${n}"</ETag><ChecksumCRC32C>AAAAAA==</ChecksumCRC32C></Part>`,
        );
      const truncated = to < 10_000;
      return new Response(
        `<ListPartsResult><IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextPartNumberMarker>${to}</NextPartNumberMarker>` : ''}${parts.join('')}</ListPartsResult>`,
        { status: 200 },
      );
    }) as typeof globalThis.fetch;
    const storage = s3Storage({
      provider: minio({ endpoint: 'http://s3.test' }),
      bucket: 'b',
      credentials: { accessKeyId: 'a', secretAccessKey: 's' },
      fetch,
    });
    const parts = await storage.listParts({ key: 'k', uploadId: 'u', checksumAlgorithm: 'crc32c' });
    expect(parts).toHaveLength(10_000);
    expect(parts!.map((p) => p.partNumber)).toEqual(Array.from({ length: 10_000 }, (_, i) => i + 1));
    expect(parts!.every((p) => p.checksum === 'AAAAAA==' && p.size === 8388608)).toBe(true);
    expect(markers).toEqual([null, '1000', '2000', '3000', '4000', '5000', '6000', '7000', '8000', '9000']);
  });
});
