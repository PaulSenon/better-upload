# Decisions log

> Statuses:
> - **GIVEN**: constraint from the brief; not ours to change.
> - **PROPOSED**: Claude's first proposal, awaiting the owner's validation. **Not a decision.**
> - **OPEN**: needs the owner's input; options listed, recommendation marked ★.
> - **DEFERRED**: decided later, during the implementation phase.
> - **AGREED**: owner expressed a preference; direction kept, nothing frozen yet.
> - **ACCEPTED** / **REJECTED**: frozen after explicit validation of README + types. *None yet.*
>
> Last updated 2026-11-15 (owner feedback round 1, see "Feedback log" below).

| ID | Topic | Status | Proposal / options |
|---|---|---|---|
| D-001 | Project & package name | OPEN (leaning rename) | "Better Upload" kept provisionally (P2). The `@better-upload` npm scope, domain and shadcn namespace are **taken** by an active project with the same scope ([NAMING.md](./NAMING.md)). Code uses placeholder `@bu-draft/*`. |
| D-002 | Contract authoring style | AGREED | oRPC-like immutable builder chain `uc.upload().files().input().output().errors()`. Alt: a single config object (`upload({ files, input, output })`), closer to UploadThing / better-upload. The builder makes inference order explicit and errors composable. |
| D-003 | Wire protocol shape | PROPOSED | `POST {base}/{endpointPath}/{op}` JSON, `bu-protocol: 1` header. Alt: a single RPC endpoint (`POST {base}` with `{ endpoint, op }`), or embedding inside oRPC. Path-based routing makes per-endpoint logging, rate limits and WAF rules easy. |
| D-004 | Server session state | AGREED (no DB) + PROPOSED (ticket format) | **Stateless, no DB, ever, in the SDK**: session facts in a server-minted token. ★ JWE (`dir`/A256GCM) via a vetted lib (e.g. `jose`), opaque to the client. Alt: JWS (readable `meta`), or a mandatory DB. Storage is the source of truth for parts. |
| D-005 | ~~Optional `SessionStore` port~~ → portable ticket | AGREED (revised) | Dropped the `SessionStore` port. The session ticket is self-contained and portable; the **host app** may persist it in its own DB via the server `onInit` hook and resume with `endpoint.resume(file, { ticket })`. If neither the browser nor the host kept the ticket, the upload is lost (accepted). |
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
| D-021 | Download strategy | PROPOSED | Tier 0 (default): stable per-user link → native download manager; `delivery: 'redirect'` (302 to fresh presigned, zero infra) or `'proxy'` (edge Range pass-through, resumes everywhere). Tier 1 (opt-in): managed ranged download with capability-picked sink (FS Access → OPFS → SW stream → memory); mandatory for E2EE. See SPEC §14, [research/downloads.md](./research/downloads.md). Open: is Tier 1 in v0 or v1? |
| D-022 | Server adapters in v0 | PROPOSED | Fetch (`server.fetch`) + Node (`toNodeHandler`, covers Express). Hono/Next/Workers use Fetch directly. |
| D-023 | Encryption | PROPOSED (perspective) | No home-made crypto. Reserve deterministic part-transform extension points. Candidate for a later demonstrator: Tink AES-GCM-HKDF streaming format on Web Crypto (alt: age/typage). See [E2EE-PERSPECTIVE.md](./E2EE-PERSPECTIVE.md). |
| D-030 | Relationship with oRPC | PROPOSED | Standalone core with oRPC-flavoured API + seams (pure op service, client `ControlTransport`), optional `orpc` adapter once oRPC v2 is stable. Not an oRPC-only plugin: oRPC has no extension point for a new procedure kind, and v2 is still beta. See [research/orpc-extension.md](./research/orpc-extension.md). |
| D-031 | Host integration model | PROPOSED | SDK owns bytes, host owns meaning: context factory, `authorize`, `key`, optional `onInit` (host stores portable ticket), record creation **inline** (`onComplete`) or via sealed **receipt** + `verifyReceipt()` (Payload/ConvexFS commit pattern). Official Payload plugin then Convex helper after v0. See [INTEGRATIONS.md](./INTEGRATIONS.md). |
| D-029 | Phase-2 CI provider matrix | DEFERRED | Owner: later (Q9). |
| D-024 | Monorepo tooling, build, tests | DEFERRED | Implementation phase (pnpm workspaces, tsdown/tsup, vitest + MinIO/R2 integration tests, browser tests). |
| D-025 | Small files | PROPOSED | Single presigned PUT under the threshold (no multipart overhead; restart on failure). |
| D-026 | iOS background | GIVEN | Out of the main discussion; no OS bypass. Design = foreground-only, cheap stop, exact resume. |
| D-027 | Infra | GIVEN | S3-compatible first; no mandatory hosted service; no cloud or DB imposed without justification. |
| D-028 | Phase-1 deliverables only | GIVEN | No runtime, site, demo, deploy or npm publish. All `package.json` files are `private`. |

## Feedback log

### 2026-11-15 — owner round 1

- Q1 name: likes "Better Upload" but will pick another name if an established player already uses it. It does (active project, same scope, ~1.3k stars) → leaning rename before phase 2.
- Q2: no DB in the SDK. If the client lost its state, the upload is lost — unless the *host app* recorded it itself; the SDK may expose an API for that without owning storage → D-005 revised (portable ticket + `onInit`).
- Q3: oRPC style preferred → D-002 AGREED.
- Q4–Q7: needed plain-language explanations → added in [OUTLINE.md](./OUTLINE.md#plain-language-explanations-q4q7); Claude proposes to treat Q4, Q5, Q6 as internal defaults unless the owner objects.
- Q8: download UX — wants a unique presigned link per user, retryable by the user in the browser; asked for the best perf/UX/cost/resilience solution → research + proposal (D-021).
- Q9: later → D-029 DEFERRED.
- README API shape: good basis, nothing frozen.
- New requirement: smooth integration with existing systems (Payload CMS, Convex…) where auth, storage and ID/link/DB records live in different places; official adapters/plugins/components later → [INTEGRATIONS.md](./INTEGRATIONS.md).
- Side question: could this be an oRPC (v2) plugin/extension? → [research/orpc-extension.md](./research/orpc-extension.md).
