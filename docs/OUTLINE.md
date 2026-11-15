# Outline & targeted questions (phase 1)

> Purpose: to reach a common understanding before any implementation. Every answer updates [DECISIONS.md](./DECISIONS.md).
> Question statuses: **OPEN** (unanswered) · **ANSWERED** (owner replied; decision updated). Round 1 answers received 2026-11-15 (see DECISIONS feedback log).

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
| Q1 | **Name:** keep "Better Upload" until release, or pick a new name now? Candidates whose npm name is free: `relay-upload`, `ferry-upload`, `uplift-upload`, `@upkit/*` scope (unverified). | The `@better-upload` scope and brand are taken by an active project with the same scope. Renaming late is costly. | Pick before phase 2. | ANSWERED (rename if established player — it is) |
| Q2 | **Server recovery when the browser has lost its local state** (Safari ITP deletes storage after 7 days without visiting the site; also another device): is this a v0 must? | If yes, `SessionStore` stops being optional for that feature, and we need a recipe (SQL/KV) and a lookup by fingerprint. | v0 ships the port and a memory store. The README explains how to add a DB for this. | ANSWERED (no DB; host may persist ticket) |
| Q3 | **Builder chain or config object** for the contract (D-002)? | DX taste. It affects every README example. | Builder (oRPC-like). | ANSWERED (oRPC style) |
| Q4 | **Token: JWE (opaque) or JWS (readable)** (D-004)? Is a DB-reference token acceptable as the default instead? | Privacy of `meta`/keys versus simplicity and debuggability. | JWE through `jose`. | EXPLAINED → internal default proposed |
| Q5 | **Default file-identity verification** on resume: `sample` or `full` (D-007)? | `full` re-reads everything already uploaded, which on a phone means battery and time. `sample` could in theory miss a localized difference. | `sample`, with `full` per endpoint for high-value data. | EXPLAINED → internal default proposed |
| Q6 | **AWS SDK v3 or a lightweight signer** (D-009)? | Edge compatibility and bundle size versus maturity and credential chains. | Lightweight signer, with credential providers pluggable. | EXPLAINED → internal default proposed |
| Q7 | **Lost session behaviour** (D-010): restart automatically or ask the user? | Metered mobile data while travelling. | Ask. | EXPLAINED → re-ask |
| Q8 | **Downloads in v0:** a managed ranged download into OPFS, or signed URLs only (D-021)? | Scope and effort. The upload side is the priority of the brief. | Both, but managed download is minimal (single file, OPFS or memory). | RESEARCHED → proposal in SPEC §14 |
| Q9 | **Target providers for CI** in phase 2 (AWS, R2, MinIO, B2, GCS XML, others)? | Each one has quirks: R2 needs equal parts, MinIO cleans up after 24h, GCS has no preconditions. | MinIO in CI, plus R2 and AWS in a manual or nightly matrix. | DEFERRED |
| Q10 | **Batch semantics:** is a batch-level "all files done" hook (an album) needed in v0 (D-016)? | It changes server state needs: you must know when every file of the batch has completed. | Not in v0. The app tracks it. | OPEN |
| Q11 | **Runtime targets** besides the browser: React Native, Node CLI, Electron? | Transport and file abstraction (`UploadableFile`). | Keep the abstraction; test only the browser in v0. | OPEN |
| Q12 | **License and docs language** (D-018, D-019). | Public repo. | MIT; English. | OPEN |
| Q13 | **E2EE demonstrator:** should v0 already validate the transform hook with a toy (non-crypto) transform in tests? | It proves the extension point without shipping crypto. | Yes, as a test-only fixture. | OPEN |

## Things deliberately not proposed

- A hosted relay, a mandatory database, or webhooks.
- Bypassing iOS background limits (Background Fetch is not available on Safari anyway).
- Content-addressed deduplication by default. It costs a full-file hash and leaks content equality. It stays available as `contentHash`, opt-in.
- Our own cryptography.

## Plain-language explanations (Q4–Q7)

**Q4: why a "token" (now called *ticket*) at all?**
An upload is a conversation between the browser and your server that lasts minutes to days. At the start (`init`) your server
checks who the user is and creates the multipart upload in the bucket. Later the browser comes back many times, saying
"sign part 37 of upload X", and finally "finish upload X". Each time, the server must know three things:
- which bucket key and upload id "X" means;
- that this user was allowed to create it;
- the agreed file size and part size, so a client can't change them halfway.

There are three ways to remember that:
- **a database row** — rejected (Q2);
- **re-checking everything on every call** — fragile, and the sizes aren't protected;
- **a ticket**: at `init` the server writes those facts on a ticket, seals it with a server-only secret, and hands it to the browser.
  The browser returns it with every call. The server accepts only tickets it sealed itself, and needs no memory.

That is the whole reason. The ticket also makes Q2 work: the host app can store it anywhere and resume from it later.
Whether the ticket is *signed* (the browser can read it) or *encrypted* (opaque) is an internal detail. Proposed: encrypted, using
a standard library, not a home-made format. No action needed unless you object.

**Q5: how do we know a re-selected file is the same one?**
Days later the user picks "the same" video again. The browser gives us only its name, size and date, which can collide, and on
iPhone the Photos picker may hand back a re-encoded copy with different bytes. Before appending the remaining pieces, we
re-read some pieces already sent and compare their fingerprints with what the bucket stored. There are three levels:
- `metadata`: trust name, size and date;
- `sample` (proposed default): re-read about five already-uploaded pieces;
- `full`: re-read every uploaded piece. That is safest, but costs time and battery on a phone: 6 GB already sent means 6 GB re-read.

Proposed: `sample` by default, and each endpoint can choose `full`.

**Q6: AWS SDK or a small signer?**
Your server never sends file bytes; it only produces *signed URLs* (a cryptographic signature computed with the bucket keys).
You can compute those with Amazon's official SDK, which is big, Node-oriented and heavy on edge runtimes like Cloudflare Workers, or with
a ~10 KB library that does only the signature math (`aws4fetch`; the existing better-upload v3 made the same move).
The only practical difference for users is install size and whether it runs on edge runtimes. Proposed: the small signer,
internal detail. No action needed.

**Q7: what if the bucket already threw the half-upload away?**
Buckets delete abandoned half-uploads after a while: R2 after 7 days by default, or whatever your cleanup rule says. If the
user comes back after that, there is nothing left to resume. Two options:
- (a) silently restart from 0%;
- (b) show "this upload expired, restart?" first.

Proposed: (b), because restarting a 10 GB upload on roaming mobile data without asking is hostile. **Your call**: (a) or (b)?
