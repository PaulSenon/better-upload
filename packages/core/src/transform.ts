/**
 * DESIGN DRAFT — not implemented. Reserved extension point, NOT part of v0 scope.
 *
 * A part transform lets a future layer (end-to-end encryption, compression) change the bytes
 * sent for each part while keeping resumability. Constraints the core must respect:
 *  - deterministic: same (session, partNumber, plaintext) → same output bytes, so a retried part
 *    is byte-identical and its checksum stays valid;
 *  - size-predictable: `storedSize(plainSize)` is known before upload so the PartPlan, the provider
 *    min/equal part size rules and progress can be computed;
 *  - position-aware: receives the part index (e.g. to derive per-chunk nonces of a STREAM-like construction);
 *  - the fingerprint/identity layer must hash *plaintext* locally but only ever reveal keyed/opaque values.
 * The SDK will not ship its own cryptography; an E2EE layer would wrap a vetted construction.
 */
export interface PartTransform {
  readonly id: string;
  storedSize(plainSize: number, partIndex: number, isLast: boolean): number;
  apply(plain: Blob, ctx: { readonly partIndex: number; readonly isLast: boolean; readonly sessionId: string }): Promise<Blob>;
}
