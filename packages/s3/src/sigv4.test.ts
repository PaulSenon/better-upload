import { describe, expect, it } from 'vitest';
import { xmlBlocks, xmlUnescape, xmlValue } from './client.js';
import { s3Storage } from './index.js';
import { encodeKeyPath, presignUrl, signHeaders } from './sigv4.js';

const credentials = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};
const now = new Date('2013-05-24T00:00:00Z');

describe('SigV4 (AWS documentation examples)', () => {
  it('presigned GET', async () => {
    const { url } = await presignUrl({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      region: 'us-east-1',
      credentials,
      expiresIn: 86400,
      now,
    });
    expect(new URL(url).searchParams.get('X-Amz-Signature')).toBe(
      'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
  });
  it('header-signed GET with Range', async () => {
    const headers = await signHeaders({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { range: 'bytes=0-9' },
      region: 'us-east-1',
      credentials,
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      now,
    });
    expect(headers.authorization).toContain(
      'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });
  it('encodes keys segment by segment', () => {
    expect(encodeKeyPath('a b/c+d/é(1)!.txt')).toBe('a%20b/c%2Bd/%C3%A9%281%29%21.txt');
  });
});

describe('S3 adapter', () => {
  it('builds URLs for both styles', () => {
    const aws = s3Storage({ preset: 'aws', region: 'eu-west-3', bucket: 'b', credentials });
    expect(aws.client.url('k/x.bin').toString()).toBe('https://b.s3.eu-west-3.amazonaws.com/k/x.bin');
    const r2 = s3Storage({ preset: 'cloudflare-r2', accountId: 'acc', bucket: 'b', credentials });
    expect(r2.client.url('k').toString()).toBe('https://acc.r2.cloudflarestorage.com/b/k');
    expect(() => s3Storage({ bucket: 'b', credentials })).toThrow();
  });
  it('signs part uploads with checksum and content-length', async () => {
    const s = s3Storage({ preset: 'minio', endpoint: 'http://localhost:9000', bucket: 'b', credentials });
    const req = await s.signUploadPart({
      key: 'k',
      uploadId: 'u',
      partNumber: 3,
      contentLength: 10,
      checksum: { algorithm: 'crc32c', value: '4waSgw==' },
      expiresIn: 60,
    });
    const url = new URL(req.url);
    expect(url.searchParams.get('partNumber')).toBe('3');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;host;x-amz-checksum-crc32c');
    expect(req.headers).toEqual({ 'x-amz-checksum-crc32c': '4waSgw==' });
  });
});

describe('xml', () => {
  it('extracts values and blocks', () => {
    const xml =
      '<R><Part><PartNumber>1</PartNumber><ETag>&quot;a&quot;</ETag></Part><Part><PartNumber>2</PartNumber></Part></R>';
    expect(xmlBlocks(xml, 'Part')).toHaveLength(2);
    expect(xmlValue(xml, 'ETag')).toBe('"a"');
    expect(xmlUnescape('&#x41;&#66;&amp;')).toBe('AB&');
  });
});
