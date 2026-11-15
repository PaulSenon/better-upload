# Specification — DESIGN DRAFT v0.1

> **Status: proposal for discussion. Nothing here is implemented or decided.** Decisions and their status live in
> [DECISIONS.md](./DECISIONS.md); open questions in [OUTLINE.md](./OUTLINE.md). TypeScript interfaces in `packages/*/src`
> are the normative shape of this draft and compile (`npm run typecheck`), but contain **no runtime code**.
> Package scope `@bu-draft/*` is a placeholder (see [NAMING.md](./NAMING.md)).
> Requirement IDs (G1, U2, …) refer to [BRIEF.md](./BRIEF.md).

## 1. Goals and non-goals

**Goals:** a contract-first, type-safe SDK for resumable uploads and downloads to storage the developer owns,
S3-compatible first (G1). A few connections: bucket + contract + router + client (G2). Survives network loss,
reloads and multi-day pauses (U2), never mixes two files (U3), honest about limits (U9).

**Non-goals (v0):** hosted service; mandatory database; bypassing iOS background limits (U10); non-React bindings
(I4, later); built-in encryption (F*, later via extension points); image/video processing; virus scanning.

## 2. Packages

| Package | Runs on | Contains | Depends on |
|---|---|---|---|
| `core` | anywhere | contract builder, wire protocol types, error model, storage/client ports, task model | — (Standard Schema interface vendored) |
| `server` | server | `implement()`, middleware, hooks, `createUploadServer()` → Fetch handler, session tickets | core |
| `server/node` (subpath) | Node | `toNodeHandler()` for `http` / Express / Connect | server |
| `s3` | server | S3-compatible `StorageAdapter` + provider presets | core |
| `client` | browser (+ RN later) | upload/download engines, IndexedDB store, worker hasher, XHR transport | core |
| `react` | browser | hooks over client stores | client |
| registry (not npm) | — | shadcn items: dropzone, progress, upload list, resume banner | react |

Rationale: TanStack-style framework-free core with thin bindings (I4); oRPC-style contract/implementation split (I1);
Alchemy-style small provider capability interface (I3). Effect is **not** a dependency (D-008).

## 3. Contract (A1, A3)

```ts
const contract = uc.router({
  travelVideos: uc.upload()
    .files({ accept: ['video/*'], maxFiles: 20 })
    .input(z.object({ albumId: z.string() }))      // any Standard Schema
    .output(z.object({ mediaId: z.string() }))
    .errors({ QUOTA_EXCEEDED: { status: 403, data: z.object({ remainingBytes: z.number() }) } })
    .resume({ ttl: '7d', verify: 'sample' })
    .integrity({ partChecksum: 'auto' }),
  media: { download: uc.download().input(z.object({ mediaId: z.string() })) },
});
```

- A contract is **isomorphic and secret-free**. It may be imported on the client as a type only, or as a value to
  enable client-side pre-validation (`accept`, sizes). Shipping it is safe by construction.
- One `upload()` = one *logical* endpoint. It hides the operations `init`, `sign`, `status`, `complete`, `abort`
  (§5). "Refresh URLs" is `sign` again; "refresh session" is `status` (sliding renewal).
- Nested objects namespace endpoints; the wire path is the key path joined with `/` (`media/download`).
- No default size limit (U9). Provider limits are enforced by the storage adapter (§12).

## 4. Server (A2, A5, A6)

```ts
const t = implement(contract).$context<{ user: User | null }>();
const router = t.router({
  travelVideos: t.travelVideos.use(requireUser).handler({
    authorize: ({ context, input, files, errors }) => ({ ownerId: context.user.id }),   // → session meta
    key: ({ meta, sessionId, input }) => `albums/${input.albumId}/${meta.ownerId}/${sessionId}`,
    onComplete: async ({ session, object }) => ({ mediaId: await save(session.id, object) }),
  }),
  media: { download: t.media.download.handler({ resolve: async ({ input }) => ({ key, versionId }) }) },
});
const uploads = createUploadServer({ router, storage: s3Storage({...}), secret: env.UPLOAD_TOKEN_SECRET });
// Fetch runtimes: uploads.fetch(request, ctx) · Node/Express: toNodeHandler(uploads, { context })
```

- **Context** is declared with `$context<T>()` and built by the adapter (`context: (req) => …`). Middleware extends it
  (`next({ user })`), typed end to end. Auth is therefore whatever the app already uses (cookie session, JWT,
  Better Auth, Clerk, …) — the SDK has no auth system of its own (A6).
- **`authorize`** runs once per `init` batch after schema + file-rule validation. Its return value (`meta`) is server-only
  and bound to each session. Later ops verify the session ticket; `reauthorize` can re-check on every op.
- **`key`** decides the object key. Never derive paths from `file.name` (path traversal, collisions, privacy).
- **`onComplete`** is called after the storage confirms the object; its return is validated against `output` and sent to
  the client. Delivery is **at-least-once** (§9). Use `session.id` as idempotency key.
- **Errors**: `errors(code, { data })` throws a contract-declared error (typed `data`), or `UNAUTHORIZED`/`FORBIDDEN`.
  Anything else thrown becomes `INTERNAL_ERROR` with no details leaked (`onError` sees the original).
- **Bucket credentials** exist only in the storage adapter (A5). The browser receives presigned requests only.
- The Fetch handler is the single core; adapters (Node, Express, Hono, Next, Workers…) are thin (A2).

## 5. Wire protocol

`POST {baseUrl}/{endpointPath}/{op}`, JSON bodies, header `bu-protocol: 1`. Types in `core/src/protocol.ts`.

| Op | Request | Server work | Response |
|---|---|---|---|
| `init` | `input`, `files[]` (descriptors only), optional `resume` | validate input + rules, `authorize`, plan parts, `CreateMultipartUpload` (or prepare single PUT), mint session ticket(s); optionally sign the first batch | `sessions[]` (ticket, plan, expiresAt, uploadedParts, first signed parts) |
| `sign` | `ticket`, `parts[]` (+ checksum per part) | verify ticket, sign `UploadPart` (checksum header signed) | signed requests, each with `expiresAt` |
| `status` | `ticket` | `ListParts` (paginated) | storage-truth parts, state, **renewed ticket** |
| `complete` | `ticket`, optional client ETags, full-object checksum, content hash | `ListParts`, verify count/sizes/checksums, `CompleteMultipartUpload` (with `x-amz-mp-object-size` / `If-None-Match` where supported), `HeadObject`, `onComplete` | typed `output`, `alreadyCompleted` |
| `abort` | `ticket` | `AbortMultipartUpload` (+ verify via ListParts), `onAbort` | 204 |
| `download` | `input` | `resolve`, `HeadObject`, sign `GetObject` (versionId, content-disposition) | signed request + size/etag/versionId |

Errors: `{ error: { code, message, retryable, userAction, status, data } }` with the matching HTTP status. The protocol
is documented so non-JS clients (Swift, Kotlin, CLI) can exist; the TS client is the reference.

## 6. Session state (G4)

### 6.1 Default: stateless server

The server keeps **no database**. Each session's facts — `sessionId, endpoint, key, uploadId, plan, file descriptor,
meta, issuedAt, expiresAt, protocol version` — travel in a **session ticket** minted by the server. The storage is the
source of truth for progress (`ListParts`) and completion (`HeadObject`).

- Proposed ticket format: a standard compact **JWE (`dir` + `A256GCM`) or JWS** produced by a vetted library (e.g. `jose`),
  not a custom format. JWE keeps `meta` and the key opaque to the client; JWS is simpler but readable (D-004).
- Secret rotation: `secret: [current, ...previous]` — first signs, all verify.
- Expiry: `min(resume.ttl, provider cleanup window, lifecycle rule)`. `status` renews the ticket (sliding) up to the
  absolute `resume.ttl`.
- **Limits of stateless:** no revocation before expiry (mitigated by `reauthorize`, short sliding expiry, and `abort`
  making the uploadId void); cross-device listing and recovery only if the host app stored the ticket (§6.2).

### 6.2 No `SessionStore`: the ticket is portable (owner decision, Q2)

The SDK ships **no database port**. The ticket is self-contained, so whoever holds it can resume:

- **The browser** keeps it in IndexedDB, which is the default and covers reloads and multi-day pauses on the same device.
- **The host app** may also keep it. The server hook `onInit({ ticket, session, context, input })` fires once per session, so the app can
  write a "pending upload" row in *its* DB: a CMS draft document, a Convex table, whatever it already has. Later, on any device,
  the app hands the ticket back: `client.endpoint.resume(file, { ticket })`. The same identity checks apply (§10).
- **Nobody** kept it: the upload is lost. Its parts are reclaimed by the bucket lifecycle rule. This is accepted.

What a host DB would add (revocation, admin lists, quotas across sessions, exactly-once bookkeeping) is the host's business,
done with the hooks (`onInit`, `reauthorize`, `onComplete`, `onAbort`). The SDK does not abstract it.

### 6.3 Client persistence

`ResumeStore` port, default IndexedDB. Record = `PersistedUpload` (`core/src/task.ts`): endpoint, baseUrl, file
descriptor, ticket, plan, confirmed parts with checksums, optional hash state, input. **No file bytes, no presigned URLs,
no secrets.** Calls `navigator.storage.persist()` when available.

Cross-tab safety: a task takes a Web Lock (`navigator.locks`) named after its session id so two tabs never drive the
same session.

## 7. Part planning

```
if size ≤ singlePutThreshold and size ≤ caps.maxSinglePutSize → strategy 'single' (one PUT, restart-on-failure)
partSize = roundUp(max(preferred, ceil(size / caps.maxParts), caps.minPartSize), 1 MiB)
if partSize > caps.maxPartSize or size > caps.maxObjectSize → PROVIDER_LIMIT_EXCEEDED (with limit/actual)
partCount = ceil(size / partSize)          // all parts equal except the last (satisfies R2)
```

Proposed defaults: `preferred = 8 MiB`, `singlePutThreshold = 8 MiB`. Rationale for the iPhone case: a lost part costs at
most 8 MiB of re-upload; 10,000 × 8 MiB ≈ 78 GiB before part size grows automatically. The plan is **fixed for the
life of the session** (resume needs identical part boundaries) and is part of the signed ticket.

## 8. Upload engine (U1, U4, U5)

### 8.1 States

```
needs-file ──attachFile──► preparing ──► initializing ──► uploading ──► completing ──► completed
                              │                             │  ▲   │
                              │                       pause │  │ resume
                              │                             ▼  │   └─► retrying ─┐
                              │                           paused    waiting-network ◄─ offline / hidden
                              └──────────────► failed (retryable → retry()) · canceled
```

### 8.2 Pipeline per part

1. `slice(part)` → hash in a worker (stream reader, 1 MiB chunks, incremental hasher ⇒ memory per worker ≈ 1 MiB,
   independent of part size) → checksum.
2. `sign` in batches (window ahead of the upload cursor, default up to 50 parts / call, URL TTL 15 min).
3. PUT via XHR (`upload.onprogress`; fetch has no upload progress, Safari has no streaming request bodies).
   Always send `File.slice()` (works around WebKit 319985 empty-body bug).
4. Confirm: part counted as `confirmed` only when the PUT returned 2xx; final truth comes from `status`/`complete`.

Memory bound ≈ `hashWorkers × 1 MiB + transport buffers` (the browser streams Blob slices from disk for XHR). No
whole-file reads.

### 8.3 Concurrency

Adaptive AIMD over parallel parts: start 3, min 1, max 6 (HTTP/1.1 ≈ 6 connections per host). +1 after a window of
healthy parts with stable throughput; ×½ on timeouts, `503 SlowDown`, or throughput collapse. Mobile/cellular-friendly
default; `mode: 'fixed'` available.

### 8.4 Retries and error classification

| Signal | Classification | Action |
|---|---|---|
| network error / timeout | transient | backoff (full jitter, base 1 s, cap 60 s); offline time doesn't consume attempts |
| `navigator.onLine === false`, `offline` event, failing probe | `waiting-network` | wait for `online` / visibility / periodic probe |
| 403 `AccessDenied` "Request has expired" / URL past `expiresAt` | `SIGNED_URL_EXPIRED` | re-`sign` immediately, does not consume an attempt |
| 400 `BadDigest` / `InvalidDigest` | data changed or read error | re-read + re-hash once; then `FILE_MISMATCH` |
| `NotReadableError` reading the Blob | `FILE_UNREADABLE` | pause; `userAction: 'reselect-file'` |
| 404 `NoSuchUpload` | session gone | `status` → completed? finish : `SESSION_NOT_FOUND` (restart policy, D-010) |
| 429 / 503 `SlowDown` | `STORAGE_THROTTLED` | honour `Retry-After`, halve concurrency |
| 5xx | transient | backoff |
| 401 from app server | `UNAUTHORIZED` | pause task (not fail), `userAction: 'sign-in'`, `retry()` after re-auth |
| contract error | as declared | `retryable` / `userAction` from the declaration |
| attempts exhausted | `failed`, retryable | `retry()` resets the budget |

### 8.5 Lifecycle signals

`online`/`offline`, `visibilitychange` (+ `pagehide`) trigger reconciliation and resume when visible. The SDK does not
try to keep running in the background on iOS (U10); it makes stopping cheap and resuming exact. Optional Screen Wake
Lock helper (iOS 18.4+) is left to the app.

## 9. Idempotency (U5)

| Op | Idempotent how |
|---|---|
| `init` | Each call creates a new session unless `resume` matches an existing one. Retrying a lost `init` response leaks one empty multipart upload, reclaimed by lifecycle (§11). |
| part PUT | Same part number overwrites; last write wins (S3, R2). Deterministic bytes ⇒ same checksum. |
| `sign`, `status` | Pure. |
| `complete` | If storage says `NoSuchUpload`, server `HeadObject(key)`; when size + session metadata (`x-amz-meta-bu-session`) match, returns `alreadyCompleted: true`. `onComplete` may run again ⇒ at-least-once; exactly-once bookkeeping is the host's (e.g. unique constraint on `session.id`). `If-None-Match: *` prevents overwriting a different existing object where supported. |
| `abort` | Repeatable; verifies with ListParts (in-flight parts may land after abort). |

## 10. File identity and resume (U2, U3)

A re-selected `File` is a new object with no path or inode. iOS photo-library picks can be **transcoded**, changing
bytes between picks. Identity is therefore layered (`core/src/identity.ts`):

1. **Descriptor match** — name + size + lastModified + type → candidate persisted sessions (cheap, may collide or miss).
2. **Plan match** — size must equal `plan.fileSize`.
3. **Content proof** — re-checksum already-uploaded parts and compare with checksums **reported by the storage**
   (`status` → ListParts), per `resume.verify`:
   - `metadata`: skip (fastest; unsafe if bytes may differ);
   - `sample` *(proposed default)*: first, last uploaded, and k random uploaded parts (k = 3);
   - `full`: all uploaded parts (bounded memory, O(uploaded bytes) CPU).

If any check fails → `FILE_MISMATCH` (`userAction: 'reselect-file'`), the session is not touched. Because the proof is
against storage-side checksums, "same file" means exactly what is needed: **every byte already stored equals the
re-selected file's bytes at the same offsets**. No full-file hash is required. Optional `contentHash` (dedupe) uses an
incremental hasher whose state is persisted per part boundary (hash-wasm `save()/load()`), so resume doesn't re-hash.

Without checksums (providers that don't support them, e.g. Supabase S3), `sample`/`full` fall back to a locally stored
per-part digest — weaker (proves consistency with what *this client* sent, not what storage holds). Documented.

## 11. Signed URLs, credentials, reconciliation, lifecycle (U6, U7, U8)

- **URLs** are signed lazily per batch with short TTL (15 min default), capped by `caps.maxPresignExpiry` and by the
  expiry of temporary credentials (STS: often 1 h). Never presign a multi-day upload up front. 403-expired ⇒ re-sign.
- **Credentials** are a provider function on the adapter (`() => Promise<S3Credentials>`), refreshed before expiry.
- **Session expiry** ≠ URL expiry: sessions last days (ticket, sliding), URLs minutes.
- **Reconciliation:** `status` returns storage truth; client merges (storage wins). `complete` re-lists parts server-side
  (does not need CORS `ExposeHeaders: ETag`), checks part count = plan, each non-last part size = `partSize`, checksums
  match those signed, then completes. AWS warns not to build Complete from ListParts because in-flight parts are not
  listed; by the time the client calls `complete` all its PUTs have returned, and client ETags are cross-checked when
  available.
- **Lifecycle & cost:** incomplete parts are **billed** on AWS/GCS until aborted. `server.check()` warns when no
  `AbortIncompleteMultipartUpload` rule exists or when `resume.ttl` exceeds the provider cleanup window (R2 7 d, MinIO
  AIStor 24 h, Spaces 30 d). `recommendedBucketConfig()` outputs CORS + lifecycle JSON; the SDK never mutates bucket
  config itself. A janitor (`listMultipartUploads` by prefix, abort older than TTL) is a documented recipe for providers
  without lifecycle support.
- **Orphan objects** (completed in storage, `onComplete` failed): the client retries `complete` (idempotent). For
  stronger guarantees, apps can key under a `staging/` prefix and promote, or reconcile from the pending rows written in `onInit` (D-012).

## 12. Limits (U9) — documented, not promised

| Layer | Limit |
|---|---|
| AWS S3 | 10,000 parts; 5 MiB–5 GiB parts; 48.8 TiB object; single PUT ≤ 5 GiB; presign ≤ 7 d |
| Cloudflare R2 | same parts; **equal part sizes**; 4.995 TiB object; incomplete uploads aborted after 7 d by default |
| Others | see [research/storage-and-browser.md](./research/storage-and-browser.md) (B2 10 TB, Spaces 5 TB, MinIO 24 h cleanup, Scaleway possibly 1,000 parts…) |
| Browser | no SDK limit; `File.slice` is lazy. iOS: the picker may copy large files into temp storage; device free space matters; screen lock stops uploads. |
| SDK | none arbitrary. Planner raises `PROVIDER_LIMIT_EXCEEDED` with the provider limit when a file can't fit. |

## 13. Target scenario walkthrough — iPhone, travelling, several days (U10)

1. Day 1, hotel Wi-Fi: user selects 12 GB of videos. `init` (one call, 12 sessions), parts signed in batches; 30 %
   uploaded. Phone locks → uploads stop (expected, not fought).
2. Day 1, later: Safari reopened, tab possibly reloaded. `$restore()` finds IndexedDB records. If the tab still holds
   the `File` objects, tasks continue after `status`; after reload they are `needs-file`.
3. Day 3, train, flaky 4G: user re-selects the same videos (**from Files, not the Photos picker** — documented UX tip
   because of transcoding). Descriptor match → `status` → sample verification → upload continues from the first missing
   part. Concurrency adapts down; expired URLs re-signed transparently; offline periods don't burn retries.
4. Day 5: `complete` → `onComplete` → typed output.

Risks: (a) Safari ITP deletes IndexedDB after 7 days of Safari use **without visiting the site** — recovery then needs the
host app to have stored the ticket (§6.2), otherwise restart; (b) provider cleanup windows (R2 7 d) must exceed `resume.ttl`; (c) transcoded
re-picks are detected (FILE_MISMATCH), not silently mixed.

## 14. Downloads (D1, D2, D3)

Owner requirement (D3): **one link per user**, and if it fails the user just presses "retry" in the browser. Research:
[research/downloads.md](./research/downloads.md). The proposal has three tiers.

**Tier 0: native download manager (default).** `client.media.download.link({ input })` returns a **stable** URL,
`GET {base}/media/download?mediaId=…`. It is per-user because each hit re-runs `resolve` with the app's own session/cookie.
For links shared without a session, the server can mint a sealed, expiring link instead (`/l/{linkTicket}`).
- `delivery: 'redirect'` (default, zero infra): the server replies 302 to a fresh presigned GET (`versionId` pinned,
  `response-content-disposition`, **`Range` never signed**).
  - Retry always works, because a re-click hits the stable link again.
  - Resume of an interrupted download works only until the presigned URL expires, because Chromium resumes against the final URL
    (commit 6ac869d). So `expiresIn` defaults to a generous value, capped at 7 d, and capped further by temporary credentials.
- `delivery: 'proxy'` (opt-in): the stable link itself streams the bytes with `Range`/`If-Range` pass-through and a strong ETag.
  Resume works in every browser's manager, including iOS Safari.
  - It is meant for edge runtimes next to the bucket: Cloudflare Worker + R2 means zero egress and cheap compute.
  - It needs `StorageAdapter.getObject`.

**Tier 1: managed download (opt-in).** `client.media.download.download({ input, sink: 'auto' })`:
- fetches `Range` chunks in parallel in a worker, with an `If-Match`/`If-Range` validator. A `200` received where `206` was
  expected means the object changed, so the download restarts and never appends;
- re-resolves on 403 and persists progress per chunk;
- picks the sink by capability:
  - **File System Access** (Chromium desktop and Android 132+): writes directly to the user's file, with no double disk and resume via a stored handle;
  - **OPFS + export** (Safari 15.2+, Firefox 111+): checks `estimate()` and calls `persist()`. Export temporarily doubles disk use, and Safari may evict after 7 d idle;
  - **service-worker stream**: constant memory, **not resumable**;
  - **memory**: small files only.

**When to use which:** Tier 0 for normal downloads, including tens of GB on iPhone, where the native manager is the most robust option.
Tier 1 when the app needs progress UI, parallel speed, integrity checks, or client-side **decryption** (E2EE makes Tier 1 mandatory).

**Multiple files:** one link per file by default. A client-side streamed zip (STORE + Zip64, exact length) is possible later, but it is not resumable.

| | Multipart upload | Ranged download |
|---|---|---|
| Server state | multipart upload id in storage (billed while incomplete) | none |
| Unit | numbered parts, fixed plan, ≥ 5 MiB (except last) | arbitrary byte ranges |
| Consistency | uploadId + per-part checksums + plan in ticket | ETag / versionId validators |
| Finish | explicit `complete` (atomic object creation) | nothing to complete |
| Cancel | `abort` needed (cost) | just stop |
| Resume state | storage (ListParts) + client record | client sink only |
| Integrity | per-part checksums verified by storage | object checksum (`x-amz-checksum-mode`) / per-part GET optional |

## 15. Security considerations

- Contract and client hold no secrets; the ticket secret and bucket credentials are server-only.
- Presigned requests are scoped to one key + part + method + checksum, short-lived.
- Object keys come from `key()`, never from client file names. `keyPrefix` in the adapter as defence in depth.
- `accept`/sizes are re-checked server-side at `init`; the declared size is enforced by the signed `Content-Length` per
  part and by the size check at `complete`. Content-type sniffing is the app's job (post-upload).
- Fingerprints sent to the server are opaque (hash of descriptor + sampled bytes); a privacy mode can avoid sending names.
- Rate-limit `init` per user (middleware); cap concurrent sessions per user in the host DB via `onInit`/`authorize` if needed.

## 16. Extension points reserved for E2EE (F1–F3)

Not in v0 scope. The core must not preclude them: deterministic, size-predictable per-part transform
(`core/src/transform.ts`), plaintext vs stored sizes, opaque fingerprints, checksums over transformed bytes, sidecar
objects for headers/metadata, range mapper for downloads, CryptoKey-capable resume store. See
[E2EE-PERSPECTIVE.md](./E2EE-PERSPECTIVE.md).
