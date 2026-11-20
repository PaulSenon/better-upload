/**
 * Deterministic synthetic files of any size, shared by the browser (to build the file) and Node (to verify what the
 * storage received), so a 10 GiB upload needs neither 10 GiB of disk for the source nor 10 GiB of RAM.
 *
 * Layout: the file is a sequence of 1 MiB segments. Segment k = a 32-byte header that encodes k (unique per segment)
 * followed by one of 61 pseudo-random bodies, picked by k. So:
 * - no two segments are equal (the header differs): a part sent twice, swapped or shifted is detected;
 * - bytes are pseudo-random, not zeros: CRC/byte comparisons are meaningful, nothing is trivially compressible;
 * - but bodies repeat (61 distinct ones): a storage that deduplicates at 1 MiB granularity would see far less data
 *   than a real file. S3/MinIO do not deduplicate, so the transfer and the stored bytes are real.
 *
 * In the browser the file is a Blob composed of references to 61 body Blobs plus small headers (~61 MiB total):
 * slicing and uploading it reads memory, not disk. Disk-backed File reads are covered by the regular 512 MiB test.
 */
export const SEGMENT = 1024 * 1024;
export const HEADER = 32;
export const POOL = 61;
const BODY = SEGMENT - HEADER;

export interface SyntheticSpec {
  readonly size: number;
  readonly seed: number;
}

export function poolBody(seed: number, index: number): Uint8Array<ArrayBuffer> {
  const words = new Uint32Array(BODY / 4);
  let x = (seed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0 || 1;
  for (let i = 0; i < words.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    words[i] = x >>> 0;
  }
  return new Uint8Array(words.buffer);
}

export function poolIndex(k: number): number {
  return (k * 17 + Math.floor(k / 64)) % POOL;
}

export function segmentHeader(spec: SyntheticSpec, k: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(HEADER);
  const v = new DataView(b.buffer);
  b.set([0x4f, 0x50, 0x45, 0x4e, 0x55, 0x50, 0x4c, 0x44]); // "OPENUPLD"
  v.setUint32(8, spec.seed >>> 0);
  v.setFloat64(12, k);
  v.setFloat64(20, spec.size);
  v.setUint32(28, Math.imul(k + 1, 0x85ebca6b) >>> 0);
  return b;
}

export function segmentCount(size: number): number {
  return Math.ceil(size / SEGMENT);
}

/** Expected bytes at any offset, with the 61 bodies computed once (~61 MiB). */
export class SyntheticReader {
  readonly #bodies: Uint8Array[] = [];
  constructor(readonly spec: SyntheticSpec) {
    for (let i = 0; i < POOL; i++) this.#bodies.push(poolBody(spec.seed, i));
  }
  /** Fills `dst` with the file's bytes starting at `offset`. */
  fill(dst: Uint8Array, offset: number): void {
    let written = 0;
    while (written < dst.length) {
      const pos = offset + written;
      const k = Math.floor(pos / SEGMENT);
      const within = pos - k * SEGMENT;
      const segEnd = Math.min(SEGMENT, this.spec.size - k * SEGMENT);
      const take = Math.min(dst.length - written, segEnd - within);
      if (take <= 0) throw new RangeError(`offset ${pos} is past the end (${this.spec.size})`);
      if (within < HEADER) {
        const h = segmentHeader(this.spec, k);
        const n = Math.min(take, HEADER - within);
        dst.set(h.subarray(within, within + n), written);
        written += n;
        continue;
      }
      const body = this.#bodies[poolIndex(k)]!;
      dst.set(body.subarray(within - HEADER, within - HEADER + take), written);
      written += take;
    }
  }
}

/** Browser: the synthetic file as a File, composed of Blob references (no 10 GiB allocation). */
export function syntheticFile(spec: SyntheticSpec, name: string, lastModified = 1_700_000_000_000): File {
  const bodies: Blob[] = [];
  for (let i = 0; i < POOL; i++) bodies.push(new Blob([poolBody(spec.seed, i)]));
  const groups: Blob[] = [];
  const count = segmentCount(spec.size);
  let group: BlobPart[] = [];
  for (let k = 0; k < count; k++) {
    const len = Math.min(SEGMENT, spec.size - k * SEGMENT);
    group.push(segmentHeader(spec, k).subarray(0, Math.min(HEADER, len)));
    if (len > HEADER) group.push(bodies[poolIndex(k)]!.slice(0, len - HEADER));
    if (group.length >= 1024) {
      groups.push(new Blob(group));
      group = [];
    }
  }
  if (group.length) groups.push(new Blob(group));
  return new File(groups, name, { type: 'application/octet-stream', lastModified });
}
