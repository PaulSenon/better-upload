/**
 * DESIGN DRAFT — not implemented.
 *
 * File identity. A browser `File` re-selected days later is a *new object*: there is no
 * stable path or inode. Identity is therefore established in layers, cheapest first:
 *
 *  1. descriptor match  : name + size + lastModified + type      → candidate sessions
 *  2. plan match        : the stored PartPlan must fit `size` exactly
 *  3. content proof     : re-checksum some/all already-uploaded parts and compare with
 *                         the checksums the *storage* returns from ListParts
 *
 * Step 3 makes "same file" mean "same bytes for everything already uploaded" — exactly the
 * property needed to safely append the remaining parts. No full-file hash is required.
 */

export interface FingerprintInput {
  readonly name: string;
  readonly size: number;
  readonly lastModified: number;
  readonly type: string;
}

/** Opaque string, e.g. base64url(SHA-256(JSON(descriptor) + sampled bytes)). Never the raw name if privacy mode is on. */
export type Fingerprint = string & { readonly __brand: 'Fingerprint' };

export interface FingerprintStrategy {
  readonly id: string;
  /** Must read a bounded number of bytes (e.g. first/last 64 KiB). */
  compute(file: Blob & FingerprintInput): Promise<Fingerprint>;
}

export interface VerificationPlan {
  /** Part numbers to re-checksum before resuming. */
  readonly partsToVerify: readonly number[];
  readonly reason: 'metadata' | 'sample' | 'full';
}

export type VerificationResult =
  | { readonly ok: true; readonly verifiedParts: number }
  | { readonly ok: false; readonly firstMismatch: number; readonly reason: 'size' | 'checksum' | 'descriptor' };
