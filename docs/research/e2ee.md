# Research — E2EE for a future transfer demonstrator

> Status: research notes, **not a decision**. Gathered 2026-11-12 from primary sources (links inline).
> Items marked **[unverified]** are inferences or weakly sourced. Scope: perspective only — nothing here is to be built in phase 1.

## 1. Streaming / chunked AEAD constructions

| Construction | Random-access decrypt (Range resume) | Truncation / reorder protection | Chunk constraints | Browser |
|---|---|---|---|---|
| **STREAM** (Hoang, Reyhanitabar, Rogaway, Vizár, CRYPTO 2015, [ePrint 2015/189](https://eprint.iacr.org/2015/189)) | Yes — nonce = prefix ‖ segment counter ‖ last-segment flag, so each segment decrypts independently | Yes (counter + final flag) | Generic pattern underneath age and Tink | Pattern, not a library |
| **libsodium `crypto_secretstream_xchacha20poly1305`** ([docs](https://doc.libsodium.org/secret-key_cryptography/secretstream)) | **No** — internal nonce updated from each message MAC → sequential decryption only; no deterministic re-encryption of chunk *i*, no parallel encryption; state must be serialised to resume | Yes (truncation, removal, reorder, duplication; FINAL/REKEY tags) | 24-byte header; per-message overhead (17 B **[unverified]**) | WASM/JS via [libsodium.js](https://github.com/jedisct1/libsodium.js) (`libsodium-wrappers` 0.8.4, 2026-04-19, ~290 KB gz; Argon2id only in "sumo") |
| **age v1** ([C2SP spec](https://github.com/C2SP/C2SP/blob/main/age.md)) | Yes, in whole chunks (seek from end requires verifying final chunk) | Yes (EOF without valid final chunk = error) | 64 KiB plaintext chunks, ChaCha20-Poly1305; nonce = 11-byte BE counter ‖ final flag; payload key = HKDF-SHA-256(16-byte random nonce); **variable-length header** | [typage](https://github.com/FiloSottile/typage) = npm `age-encryption` 0.3.1 (2026-08-28); noble + Web Crypto; ReadableStream in/out, **no chunk/seek API** (README). Web Crypto has no ChaCha20 ([W3C ED 2026-10-22](https://w3c.github.io/webcrypto/)) |
| **Tink Streaming AEAD AES-GCM-HKDF** ([overview](https://developers.google.com/tink/streaming-aead), [wire format](https://developers.google.com/tink/streaming-aead/aes_gcm_hkdf_streaming)) | **Yes, explicitly** ("decrypt M_i from C_i alone") | Yes (position-bound segments, last flag) | Header (24 or 40 B) absorbed in segment 0 → every ciphertext segment except last is exactly `CiphertextSegmentSize`; 16 B tag; ≤ 2^32 segments; templates `AES256_GCM_HKDF_1MB` | **No maintained official JS** (npm `tink-crypto` 0.1.1, 2023-05-02, alpha, no streaming). Building blocks (HKDF, AES-GCM) are native Web Crypto → implement spec + cross-test vs Tink Go/Java |
| **RFC 8188 Encrypted Content-Encoding** ([RFC](https://www.rfc-editor.org/rfc/rfc8188)) | Possible per record (nonce = base XOR seq), but Firefox Send's [`ece.js`](https://raw.githubusercontent.com/mozilla/send/master/app/ece.js) decrypts sequentially | Yes (0x01/0x02 delimiter) | Header salt+rs+keyid in front misaligns parts; `rs` ≥ 18 | Pure Web Crypto |
| **Ad-hoc Web Crypto AES-GCM per chunk** | Only if built as STREAM | **None** with naive random IVs | 16 B tag | Native — but this is "inventing crypto": avoid unless implementing a published format exactly |

**Bottom line:** sequential/state-chained formats (secretstream, Send's ECE code) fit parallel multipart and Range resume poorly; STREAM-shaped published formats (Tink, age) fit.

## 2. Prior art (brief)

- **Firefox Send** — AES-128-GCM + RFC 8188 (64 KiB records); HKDF → content / auth / metadata keys; secret in URL `#fragment`; PBKDF2 for password ([encryption.md](https://github.com/mozilla/send/blob/master/docs/encryption.md)). Suspended 2020-07-07 for **malware & phishing abuse**, shut down 2020-09-17 ([Wikipedia](https://en.wikipedia.org/wiki/Firefox_Send)); repo archived 2021-05-22.
- **Wormhole.app** — same pattern (AES-128-GCM / RFC 8188, HKDF keys, key in fragment, encrypted metadata), WebRTC or Backblaze storage ([security](https://wormhole.app/security)).
- **SwissTransfer (Infomaniak)** — **not E2EE** per Infomaniak's FAQ: TLS in transit, LUKS/AES-256 at rest ([FAQ 1755](https://www.infomaniak.com/en/support/faq/1755/understanding-swisstransfer-data-security)).
- **GrosFichiers** — free, no account, GrosFichiers Sàrl (CH), hosted in France, 10 GB / 30 recipients / 14 days; **no encryption claim found** on the homepage ([grosfichiers.com](https://www.grosfichiers.com/)) **[privacy policy not checked]**.
- **Proton Drive** — per-node keys + session key (OpenPGP), ≤ 4 MB blocks, signed chained block hashes, encrypted names ([blog](https://proton.me/blog/protondrive-security)).
- **Bitwarden Send** — 128-bit secret → HKDF → AES-256, key in fragment; **password is server-side access control only** ([docs](https://bitwarden.com/help/send-encryption/)).
- **Tresorit Send** — client-side AES-256, key in fragment ([FAQ](https://support.tresorit.com/hc/en-us/articles/360012183493-Tresorit-Send-FAQ)).

Common pattern: random secret in `#fragment` → HKDF into separate content & metadata keys; encrypted metadata; optional password KDF. Universal web-E2EE caveat: the server ships the JS.

## 3. Implications for the SDK

- **Size alignment.** S3 parts 5 MiB–5 GiB, ≤ 10,000 parts ([AWS](https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html)); R2: all parts except last **equal size** ([Cloudflare](https://developers.cloudflare.com/r2/objects/multipart-objects/)). ⇒ stored part size = k × ciphertext segment size; header must not break uniformity. Tink 1 MiB segments: part of 5 segments = exactly 5 MiB; overhead 16 B/MiB + header. age: 65,552 B/chunk, min part = 80 chunks; variable header must be stored separately (sidecar object or DB) to keep R2 uniformity.
- **`plaintextSize` ≠ `storedSize`** everywhere: plan, presign Content-Length, progress, padding.
- **Nonce safety on resume.** STREAM nonces from (random salt, index, last flag) ⇒ re-encrypting segment *i* of the **same** plaintext is byte-identical (retries and checksums stay valid). Re-encrypting **different** plaintext under the same key/index is catastrophic for GCM/ChaCha-Poly **[standard knowledge]**. ⇒ verify the re-selected file is identical (size, lastModified, locally stored **keyed** per-part digests) before continuing; on mismatch restart with a fresh salt.
- **Key persistence for multi-day resume.** `CryptoKey` is structured-cloneable into IndexedDB; `extractable:false` blocks export ([W3C](https://w3c.github.io/webcrypto/)). Pattern: show link immediately; persist only the non-extractable derived content key + salt + nonce prefix; raw link secret only on opt-in.
- **Identity.** Server sees only ciphertext (S3 checksums over ciphertext are fine). Never send a plaintext hash (confirmation-of-file attack); fingerprints must be opaque (local HMAC or random id).
- **Metadata.** Encrypt name/MIME/true size in a separate small AEAD blob (HKDF-separated key). Object size leaks plaintext size unless padded (Padmé/PURBs, PETS 2019 **[not fetched]**). Object keys must not encode names.
- **Keys.** 128–256-bit secret in fragment (risks: history, sync, extensions). Password mode = real KDF: Argon2id (OWASP min m=19 MiB, t=2, p=1; `hash-wasm` 4.13.0 or libsodium sumo) or PBKDF2-SHA256 ≥ 600k ([OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)).
- **Ranged download mapping (Tink).** S segment size, H header, P₀ = S−H−16, P = S−16: plaintext offset p → segment i = (p < P₀ ? 0 : 1 + ⌊(p−P₀)/P⌋); ciphertext start = H if i = 0 else i·S. Fetch whole segments, decrypt, trim; short read = retry, never EOF.
- **Abuse.** Send shows the failure mode (E2EE + free + anonymous ⇒ malware host ⇒ shutdown). Levers: short expiry, size/download caps, rate limits, sender verification, report-with-full-link flow, takedown by id, never render content on the service origin. Legal obligations (EU DSA notice-and-action) **[unverified — needs legal advice]**.

## 4. Candidate options (to discuss later)

- **A — Tink AES-GCM-HKDF-Streaming wire format on Web Crypto, 1 MiB segments.** Published/analysed STREAM instance, random access, native crypto, uniform segments fit R2. Risk: no maintained JS Tink → spec implementation + cross-tests vs Tink Go/Java + external review.
- **B — age v1 via typage.** Vetted envelope (scrypt, X25519, interoperable with `age` CLI). Costs: JS ChaCha20, separate header, no chunk/seek API in typage (would need a STREAM layer on `@noble/ciphers` validated against age test vectors).
- **Avoid:** libsodium secretstream (sequential), RFC 8188 as Send used it, ad-hoc random-IV AES-GCM.

### Extension points the core must not preclude

1. Deterministic, parallel-safe per-segment transform (+ inverse for downloads).
2. Layout descriptor: segment plain/stored sizes, header placement (inline segment 0 or sidecar), `storedSize(plainSize)`.
3. `plaintextSize` vs `storedSize` throughout.
4. Range mapper plaintext → stored ranges (+ trim), whole segments only.
5. Opaque fingerprint hook (never plaintext hashes on the wire).
6. Resume-validation hook (keyed local digests before re-encrypting).
7. Resume store able to hold `CryptoKey` (structured clone) + opaque blobs.
8. Encrypted metadata blob alongside object; core treats names/MIME as opaque; optional padding.
9. Sidecar objects.
10. Checksums computed over transformed (ciphertext) bytes.
11. Key-material callbacks outside the core (fragment link building, password KDF).
12. Server-side abuse hooks (expiry, download caps, report endpoint) in the demonstrator, not in the SDK core.
