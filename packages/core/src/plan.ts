import type { PartChecksumAlgorithm } from './contract.js';
import { UploadError } from './errors.js';
import type { PartPlan } from './protocol.js';
import type { StorageCapabilities } from './storage.js';
import { formatBytes } from './units.js';

export interface PartSizePolicy {
  /** Preferred part size in bytes. Clamped to provider min/max and grown so the file fits in `maxParts`. */
  readonly preferred: number;
  /** Files up to this size use a single presigned PUT instead of multipart. */
  readonly singlePutThreshold: number;
}

const MiB = 1024 * 1024;

/**
 * 8 MiB: small enough that a lost part on a phone costs little, big enough that a 50 GiB file stays far
 * below 10,000 parts. Equal-sized parts by construction (Cloudflare R2 requirement).
 */
export const DEFAULT_PART_SIZE_POLICY: PartSizePolicy = { preferred: 8 * MiB, singlePutThreshold: 8 * MiB };

/** Computes the fixed part plan of a session. Throws `PROVIDER_LIMIT_EXCEEDED` when the provider can't store the file. */
export function planParts(
  fileSize: number,
  capabilities: StorageCapabilities,
  checksum: PartChecksumAlgorithm,
  policy: Partial<PartSizePolicy> = {},
): PartPlan {
  const { preferred, singlePutThreshold } = { ...DEFAULT_PART_SIZE_POLICY, ...policy };
  if (!Number.isSafeInteger(fileSize) || fileSize < 0)
    throw UploadError.builtin('BAD_REQUEST', { message: 'Invalid file size' });
  // The real ceiling is the smaller of the stated object limit and what multipart can express
  // (e.g. 10,000 × 5 GiB ≈ 48.8 TiB under a 50 TiB object limit): reject up front, never at 99 %.
  const limit = maxUploadSize(capabilities);
  if (fileSize > limit) {
    throw UploadError.builtin('PROVIDER_LIMIT_EXCEEDED', {
      message: `The storage accepts objects up to ${formatBytes(limit)}`,
      data: { limit, actual: fileSize },
    });
  }
  if (fileSize <= Math.min(singlePutThreshold, capabilities.maxSinglePutSize)) {
    return { strategy: 'single', fileSize, partSize: fileSize, partCount: 1, checksum };
  }
  let partSize = Math.max(preferred, capabilities.minPartSize, Math.ceil(fileSize / capabilities.maxParts));
  partSize = Math.ceil(partSize / MiB) * MiB;
  if (partSize > capabilities.maxPartSize) {
    throw UploadError.builtin('PROVIDER_LIMIT_EXCEEDED', {
      message: `The file needs parts above the provider maximum of ${formatBytes(capabilities.maxPartSize)}`,
      data: { limit: capabilities.maxPartSize, actual: partSize },
    });
  }
  const partCount = Math.ceil(fileSize / partSize);
  return { strategy: 'multipart', fileSize, partSize, partCount, checksum };
}

/** Byte range `[start, end)` of a 1-based part number. */
export function partRange(plan: PartPlan, partNumber: number): { start: number; end: number } {
  const start = (partNumber - 1) * plan.partSize;
  return { start, end: Math.min(start + plan.partSize, plan.fileSize) };
}

export function partLength(plan: PartPlan, partNumber: number): number {
  const { start, end } = partRange(plan, partNumber);
  return end - start;
}

export function isValidPartNumber(plan: PartPlan, partNumber: number): boolean {
  return Number.isInteger(partNumber) && partNumber >= 1 && partNumber <= plan.partCount;
}

/** Largest file the storage can take: its object limit, capped by `maxParts × maxPartSize` (multipart). */
export function maxUploadSize(capabilities: StorageCapabilities): number {
  const multipart = capabilities.maxParts * capabilities.maxPartSize;
  return Math.floor(Math.min(capabilities.maxObjectSize, Math.max(multipart, capabilities.maxSinglePutSize)));
}
