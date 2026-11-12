# E2EE perspective: separate, not built now

> Status: **perspective only** (brief F1–F3, D-023). No code, no crypto in this phase. Research details and sources are in
> [research/e2ee.md](./research/e2ee.md).

## The future demonstrator

A public, free transfer service, in the spirit of SwissTransfer or GrosFichiers. Neither of those is E2EE today according to their public pages (see the research notes). It would add:
- encryption in the browser before upload
- resumable multipart upload
- a link carrying the key in the URL `#fragment`
- resumable ranged download with decryption in the browser

## What it implies for the SDK core (to keep possible now)

| Topic | Implication | Core hook |
|---|---|---|
| Chunking | Ciphertext segments must tile parts exactly. Parts are ≥ 5 MiB, and R2 needs equal parts. | Part plan computed from `storedSize(plainSize)`; part size = k × segment size |
| Resume | Re-encrypting part *i* must give identical bytes. Re-encrypting **different** plaintext under the same key and nonce is catastrophic. | Deterministic transform `(partIndex, isLast, plain) → bytes`; identity check before any re-encryption |
| Keys over days | The key must survive reloads without leaking. | Resume store able to hold non-extractable `CryptoKey` (structured clone) |
| Identity | The server must never see plaintext hashes, which would allow confirmation-of-file attacks. | Opaque or keyed fingerprints; checksums computed over ciphertext |
| Metadata | Name, type and true size are sensitive; the object size leaks length. | Encrypted metadata sidecar; object keys never derived from names; optional padding |
| Ranges | Plaintext ranges must map to whole ciphertext segments; a short read is a retry, never EOF. | Range mapper in the download engine; `DownloadSink` after a decrypt transform |
| Validation | The server cannot check content type or size semantics. | Server validates only stored sizes; content checks move to the client or are dropped |
| Abuse | Firefox Send was shut down after malware and phishing abuse. | Demonstrator concerns (expiry, caps, report-with-link), not core |

## Candidate constructions (no home-made crypto)

- **A.** The Tink AES-GCM-HKDF streaming wire format, implemented on Web Crypto with 1 MiB segments. Segments are uniform, so 5 segments make exactly a 5 MiB part. Random access is supported. It needs cross-tests against Tink Go/Java and an external review.
- **B.** age v1 (typage). A vetted envelope that interoperates with the CLI. But it uses JS ChaCha20, the header is variable, and typage has no seek or chunk API today.
- **Avoid:** libsodium secretstream (sequential), RFC 8188 as Firefox Send used it, and ad-hoc random-IV AES-GCM.

Universal caveat for web E2EE: the server ships the JavaScript that does the encrypting.
