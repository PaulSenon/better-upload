# Outline & targeted questions (phase 1)

> Purpose: to reach a common understanding before any implementation. Every answer updates [DECISIONS.md](./DECISIONS.md).
> Question statuses: **OPEN** (unanswered) · **ANSWERED** (owner replied; decision updated). All questions are OPEN as of 2026-11-12.

## Phase plan

1. **Phase 1, this repo now:** research, README draft, spec, types, type tests. → owner review.
2. **Phase 1b:** iterate on README and types until validated (at that point decisions move to ACCEPTED).
3. **Phase 2, not authorized yet:**
   - Implement core, server and s3 against MinIO and R2 in CI.
   - Then the client engine, with browser tests (Playwright WebKit plus a real iPhone checklist).
   - Then React.
4. **Phase 3, not authorized yet:** the shadcn registry, docs site, and npm publish under the final name.
5. **Later perspective:** the E2EE transfer demonstrator ([E2EE-PERSPECTIVE.md](./E2EE-PERSPECTIVE.md)).

## Intentions as understood (please correct)

- **The developer owns the bucket.** The SDK is "UploadThing-like DX without UploadThing". A hosted service is never required.
- **The hard requirement is the iPhone, multi-day, intermittent case.** It is what drives part size, resume, identity and limits. Desktop is the easy case.
- **"Type-safe" means four things.** Endpoint names, `input`, `output` and typed errors are inferred end to end from one contract. A missing server implementation is a compile error.
- **Minimal infra by default.** The default is stateless: a signed token plus storage as the truth. A DB is optional and only needed for explicit capabilities.
- **UI is copy-in components, not a styled npm package.**

## Targeted questions

| # | Question | Why it matters | Recommendation | Status |
|---|---|---|---|---|
| Q1 | **Name:** keep "Better Upload" until release, or pick a new name now? Candidates whose npm name is free: `relay-upload`, `ferry-upload`, `uplift-upload`, `@upkit/*` scope (unverified). | The `@better-upload` scope and brand are taken by an active project with the same scope. Renaming late is costly. | Pick before phase 2. | OPEN |
| Q2 | **Server recovery when the browser has lost its local state** (Safari ITP deletes storage after 7 days without visiting the site; also another device): is this a v0 must? | If yes, `SessionStore` stops being optional for that feature, and we need a recipe (SQL/KV) and a lookup by fingerprint. | v0 ships the port and a memory store. The README explains how to add a DB for this. | OPEN |
| Q3 | **Builder chain or config object** for the contract (D-002)? | DX taste. It affects every README example. | Builder (oRPC-like). | OPEN |
| Q4 | **Token: JWE (opaque) or JWS (readable)** (D-004)? Is a DB-reference token acceptable as the default instead? | Privacy of `meta`/keys versus simplicity and debuggability. | JWE through `jose`. | OPEN |
| Q5 | **Default file-identity verification** on resume: `sample` or `full` (D-007)? | `full` re-reads everything already uploaded, which on a phone means battery and time. `sample` could in theory miss a localized difference. | `sample`, with `full` per endpoint for high-value data. | OPEN |
| Q6 | **AWS SDK v3 or a lightweight signer** (D-009)? | Edge compatibility and bundle size versus maturity and credential chains. | Lightweight signer, with credential providers pluggable. | OPEN |
| Q7 | **Lost session behaviour** (D-010): restart automatically or ask the user? | Metered mobile data while travelling. | Ask. | OPEN |
| Q8 | **Downloads in v0:** a managed ranged download into OPFS, or signed URLs only (D-021)? | Scope and effort. The upload side is the priority of the brief. | Both, but managed download is minimal (single file, OPFS or memory). | OPEN |
| Q9 | **Target providers for CI** in phase 2 (AWS, R2, MinIO, B2, GCS XML, others)? | Each one has quirks: R2 needs equal parts, MinIO cleans up after 24h, GCS has no preconditions. | MinIO in CI, plus R2 and AWS in a manual or nightly matrix. | OPEN |
| Q10 | **Batch semantics:** is a batch-level "all files done" hook (an album) needed in v0 (D-016)? | It changes server state needs: you must know when every file of the batch has completed. | Not in v0. The app tracks it. | OPEN |
| Q11 | **Runtime targets** besides the browser: React Native, Node CLI, Electron? | Transport and file abstraction (`UploadableFile`). | Keep the abstraction; test only the browser in v0. | OPEN |
| Q12 | **License and docs language** (D-018, D-019). | Public repo. | MIT; English. | OPEN |
| Q13 | **E2EE demonstrator:** should v0 already validate the transform hook with a toy (non-crypto) transform in tests? | It proves the extension point without shipping crypto. | Yes, as a test-only fixture. | OPEN |

## Things deliberately not proposed

- A hosted relay, a mandatory database, or webhooks.
- Bypassing iOS background limits (Background Fetch is not available on Safari anyway).
- Content-addressed deduplication by default. It costs a full-file hash and leaks content equality. It stays available as `contentHash`, opt-in.
- Our own cryptography.
