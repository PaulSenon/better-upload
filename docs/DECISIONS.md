# Decisions log

> Statuses:
> - **GIVEN**: constraint from the brief; not ours to change.
> - **PROPOSED**: Claude's first proposal, awaiting the owner's validation. **Not a decision.**
> - **OPEN**: needs the owner's input; options listed, recommendation marked ★.
> - **DEFERRED**: decided later, during the implementation phase.
> - **ACCEPTED** / **REJECTED**: only after explicit validation. *None yet.*
>
> Last updated 2026-11-12.

| ID | Topic | Status | Proposal / options |
|---|---|---|---|
| D-001 | Project & package name | OPEN | "Better Upload" kept provisionally (P2). The `@better-upload` npm scope, domain and shadcn namespace are **taken** by an active project with the same scope ([NAMING.md](./NAMING.md)). Code uses placeholder `@bu-draft/*`. |
| D-002 | Contract authoring style | PROPOSED | oRPC-like immutable builder chain `uc.upload().files().input().output().errors()`. Alt: a single config object (`upload({ files, input, output })`), closer to UploadThing / better-upload. The builder makes inference order explicit and errors composable. |
| D-003 | Wire protocol shape | PROPOSED | `POST {base}/{endpointPath}/{op}` JSON, `bu-protocol: 1` header. Alt: a single RPC endpoint (`POST {base}` with `{ endpoint, op }`), or embedding inside oRPC. Path-based routing makes per-endpoint logging, rate limits and WAF rules easy. |
| D-004 | Server session state | PROPOSED | **Stateless by default**: session facts in a server-minted token. ★ JWE (`dir`/A256GCM) via a vetted lib (e.g. `jose`), opaque to the client. Alt: JWS (readable `meta`), or a mandatory DB. Storage is the source of truth for parts. |
| D-005 | Optional `SessionStore` port | PROPOSED | Interface in v0 + `memorySessionStore()`; recipes for SQL/Redis/KV in docs, no DB dependency. Unlocks revocation, cross-device resume, recovery after Safari ITP eviction, exactly-once bookkeeping. |
| D-006 | Client persistence | PROPOSED | `ResumeStore` port, IndexedDB default, memory fallback, `persist()` requested. No bytes, no URLs stored. |
| D-007 | File identity | PROPOSED | Layered: descriptor → plan → **re-checksum uploaded parts vs storage-reported checksums**. Default `verify: 'sample'` (first + last + 3 random uploaded parts). No mandatory full-file hash. |
| D-008 | Effect | PROPOSED | Not a dependency. Plain Promise/AbortSignal core; possible optional `effect` integration package later (oRPC precedent). |
| D-009 | S3 signing implementation | OPEN | ★ small SigV4 signer (aws4fetch-like) + minimal XML parsing → edge-runtime friendly, small. Alt: AWS SDK v3 (`@aws-sdk/client-s3` + presigner), which is heavy but battle-tested and covers credential chains. |
| D-010 | Session lost (`NoSuchUpload`, cleaned by lifecycle) | OPEN | ★ surface `SESSION_NOT_FOUND` with `userAction: 'retry'`, and `retry()` restarts from zero. Alt: restart automatically (surprising on metered data). |
| D-011 | Default checksum | PROPOSED | `'auto'` → CRC32C composite (supported by AWS + R2, cheap in WASM). Opt-in CRC64NVME full-object (AWS + R2). `none` for providers without support (Supabase S3). |
| D-012 | Orphan objects (stored but app not notified) | OPEN | ★ rely on idempotent `complete` retries + at-least-once `onComplete`. Alt: `staging/` prefix + promotion (CopyObject cost on huge files), or reconciliation from `SessionStore`. |
| D-013 | Part size defaults | PROPOSED | preferred 8 MiB, single-PUT threshold 8 MiB, grows automatically beyond ~78 GiB (10k parts). Fixed per session. |
| D-014 | Transport | PROPOSED | XHR default (upload progress; Safari lacks fetch streaming uploads); fetch transport for Node/RN/tests. |
| D-015 | `onComplete` semantics | PROPOSED | At-least-once, `alreadyCompleted` flag, `session.id` = idempotency key. Runs inside the `complete` request (no webhook). |
| D-016 | Multi-file | PROPOSED | One `init` per batch (one `authorize`), **one session per file** (independent resume/complete). Batch-level completion hook: not in v0. |
| D-017 | Frameworks | GIVEN + PROPOSED | GIVEN: React only in v0, others later. PROPOSED: headless hooks (`useUpload`, `useUploadTask`, `usePendingUploads`) + shadcn registry items taking a `control`/task prop. |
| D-018 | License | PROPOSED | MIT (ecosystem norm: oRPC, TanStack, UploadThing, better-upload). The repo carries MIT now so the public docs are reusable; easy to change before any release. |
| D-019 | Docs language | PROPOSED | English for README/spec/types (OSS audience); brief kept verbatim in French. |
| D-020 | Package split | PROPOSED | `core`, `server` (+`/node`), `s3`, `client`, `react`. Alt: fewer packages (`server` including `s3`). |
| D-021 | Managed ranged download in v0 | OPEN | ★ v0 ships `url()` + managed `download()` into OPFS/memory sinks. Alt: v0 = `url()` only, managed download in v1. |
| D-022 | Server adapters in v0 | PROPOSED | Fetch (`server.fetch`) + Node (`toNodeHandler`, covers Express). Hono/Next/Workers use Fetch directly. |
| D-023 | Encryption | PROPOSED (perspective) | No home-made crypto. Reserve deterministic part-transform extension points. Candidate for a later demonstrator: Tink AES-GCM-HKDF streaming format on Web Crypto (alt: age/typage). See [E2EE-PERSPECTIVE.md](./E2EE-PERSPECTIVE.md). |
| D-024 | Monorepo tooling, build, tests | DEFERRED | Implementation phase (pnpm workspaces, tsdown/tsup, vitest + MinIO/R2 integration tests, browser tests). |
| D-025 | Small files | PROPOSED | Single presigned PUT under the threshold (no multipart overhead; restart on failure). |
| D-026 | iOS background | GIVEN | Out of the main discussion; no OS bypass. Design = foreground-only, cheap stop, exact resume. |
| D-027 | Infra | GIVEN | S3-compatible first; no mandatory hosted service; no cloud or DB imposed without justification. |
| D-028 | Phase-1 deliverables only | GIVEN | No runtime, site, demo, deploy or npm publish. All `package.json` files are `private`. |
