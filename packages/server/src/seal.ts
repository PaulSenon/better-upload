import { CompactEncrypt, compactDecrypt } from 'jose';

/**
 * Sealing = authenticated encryption of a small JSON payload into an opaque, URL-safe string
 * (compact JWE, `dir` + `A256GCM`, via `jose`). Used for session tickets and completion receipts.
 * Keys are derived from the server secret with HKDF-SHA-256, one key per purpose, so a receipt can
 * never be replayed as a ticket. Rotation: the first secret seals, every secret opens.
 */
export interface Sealer {
  seal(purpose: SealPurpose, payload: object): Promise<string>;
  open<T>(purpose: SealPurpose, sealed: string): Promise<T | null>;
}

export type SealPurpose = 'ticket' | 'receipt';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function deriveKey(secret: string, purpose: SealPurpose): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('upload-sdk/v1'), info: encoder.encode(purpose) },
    material,
    256,
  );
  return new Uint8Array(bits);
}

export function createSealer(secret: string | readonly string[]): Sealer {
  const secrets = typeof secret === 'string' ? [secret] : [...secret];
  if (secrets.length === 0) throw new TypeError('createUploadServer: `secret` is required');
  for (const s of secrets) {
    if (s.length < 32)
      throw new TypeError('createUploadServer: `secret` must be at least 32 characters (use 32+ random bytes)');
  }
  const cache = new Map<string, Promise<Uint8Array>>();
  const key = (s: string, purpose: SealPurpose) => {
    const id = `${purpose}\n${s}`;
    let k = cache.get(id);
    if (!k) {
      k = deriveKey(s, purpose);
      cache.set(id, k);
    }
    return k;
  };
  return {
    async seal(purpose, payload) {
      return new CompactEncrypt(encoder.encode(JSON.stringify(payload)))
        .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', typ: purpose })
        .encrypt(await key(secrets[0]!, purpose));
    },
    async open<T>(purpose: SealPurpose, sealed: string) {
      if (typeof sealed !== 'string' || sealed.length > 16_384) return null;
      for (const s of secrets) {
        try {
          const { plaintext, protectedHeader } = await compactDecrypt(sealed, await key(s, purpose));
          if (protectedHeader.typ !== purpose) return null;
          return JSON.parse(decoder.decode(plaintext)) as T;
        } catch {
          // try the next secret
        }
      }
      return null;
    },
  };
}
