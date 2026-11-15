# Better Upload *(provisional name)*

> [!WARNING]
> **Design draft. Nothing is implemented.** This README documents a *proposed* API so it can be discussed and
> validated before any code is written. Packages are not published. The `@bu-draft/*` scope is a placeholder, because
> the `@better-upload` npm scope belongs to [another project](./docs/NAMING.md). The TypeScript files under `packages/` declare
> types only, and `npm run typecheck` checks that the examples below are type-correct.
> Every choice here is a proposal: see [docs/DECISIONS.md](./docs/DECISIONS.md) and [docs/OUTLINE.md](./docs/OUTLINE.md).

**Type-safe, resumable uploads and downloads to *your* storage.** S3-compatible first. No hosted service, and no database required.

- **One contract, end-to-end types.** Declare an upload endpoint once. The server implements it, and the client is derived
  from it: names, input, output and errors are all inferred.
- **Built for bad networks.** Presigned multipart uploads with:
  - pause and resume
  - adaptive concurrency, retries and backoff
  - transparent URL renewal
  - resume after a reload, days later, once the user re-selects the file
- **Never mixes files.** On resume, the SDK re-checksums the parts already uploaded and compares them with what the storage
  reports, before appending anything.
- **Bring your own everything.** Your bucket, your auth, your framework (Fetch or Node adapters), your UI (copy-in shadcn components).
- **Honest limits.** The SDK sets no arbitrary limit and documents the provider and browser limits.

```
 Browser                                  Your server                         Your bucket
 ───────                                  ───────────                         ───────────
 client (derived from contract) ──init──► router (implements contract) ──► CreateMultipartUpload
          ◄── session ticket + plan ───────                         
          ──sign(parts)──────────────────► presign UploadPart (short TTL)
          ─────────── PUT part (presigned, checksum signed) ────────────────► stores part
          ──status───────────────────────► ListParts (source of truth)
          ──complete─────────────────────► verify parts → CompleteMultipartUpload → onComplete()
          ◄── typed output ──────────────
```

---

## Packages (planned)

| Package | Purpose |
|---|---|
| `@bu-draft/core` | Contract builder (`uc`), error model, protocol and port types. Isomorphic, no dependencies. |
| `@bu-draft/server` | `implement(contract)`, middleware, hooks, `createUploadServer()` → Fetch handler; `/node` adapter |
| `@bu-draft/s3` | S3-compatible storage adapter with provider presets (AWS, R2, B2, MinIO, Wasabi, Tigris, GCS XML, …) |
| `@bu-draft/client` | Framework-agnostic upload and download engines, IndexedDB persistence, worker hashing |
| `@bu-draft/react` | Hooks (`useUpload`, `useUploadTask`, `usePendingUploads`, `useDownload`) |
| registry | shadcn items: dropzone, progress, upload list, "resume your uploads" banner |

React only in v0; other bindings later, on the same core.

## Quick start: four connections

### 1. Contract (shared, no secrets)

```ts
// contract.ts
import { uc } from '@bu-draft/core';
import { z } from 'zod'; // any Standard Schema library: Zod, Valibot, ArkType, Effect Schema…

export const contract = uc.router({
  avatar: uc.upload()
    .files({ accept: ['image/*'], maxFileSize: '10MiB' })
    .output(z.object({ url: z.string().url() })),

  travelVideos: uc.upload()
    .files({ accept: ['video/*', '.mov', '.mp4'], maxFiles: 20 })   // no size cap beyond provider limits
    .input(z.object({ albumId: z.string().uuid() }))
    .output(z.object({ mediaId: z.string() }))
    .errors({ QUOTA_EXCEEDED: { status: 403, data: z.object({ remainingBytes: z.number() }) } })
    .resume({ ttl: '7d', verify: 'sample' })
    .integrity({ partChecksum: 'auto' }),

  media: {
    download: uc.download().input(z.object({ mediaId: z.string() })).errors({ NOT_FOUND: { status: 404 } }),
  },
});
```

The single `travelVideos` declaration stands for five protocol operations: `init`, `sign`, `status`, `complete` and `abort`. You never call them yourself.

### 2. Bucket (server only)

```ts
import { s3Storage } from '@bu-draft/s3';

const storage = s3Storage({
  preset: 'cloudflare-r2',              // fills provider capabilities: equal part sizes, checksum support, cleanup window…
  bucket: process.env.BUCKET!,
  region: 'auto',
  endpoint: process.env.S3_ENDPOINT!,
  credentials: { accessKeyId: process.env.S3_KEY_ID!, secretAccessKey: process.env.S3_SECRET! },
});
```

### 3. Router (server)

```ts
import { implement, createUploadServer } from '@bu-draft/server';

const t = implement(contract).$context<{ user: User | null }>();

const requireUser = t.travelVideos.use(({ context, next }) => {
  if (!context.user) throw new Error('UNAUTHORIZED');
  return next({ user: context.user });                 // narrows context.user for the handler
});

const router = t.router({
  avatar: t.avatar.handler({
    authorize: ({ context, errors }) => context.user ? { ownerId: context.user.id } : errors('UNAUTHORIZED'),
    key: ({ meta, sessionId }) => `avatars/${meta.ownerId}/${sessionId}`,
    onComplete: ({ object }) => ({ url: `https://cdn.example.com/${object.key}` }),
  }),
  travelVideos: requireUser.handler({
    authorize: ({ context, files, errors }) => {
      const total = files.reduce((n, f) => n + f.size, 0);
      if (total > context.user.quotaBytes) return errors('QUOTA_EXCEEDED', { data: { remainingBytes: context.user.quotaBytes } });
      return { ownerId: context.user.id };              // server-only metadata, bound to the session
    },
    key: ({ meta, sessionId, input }) => `albums/${input.albumId}/${meta.ownerId}/${sessionId}`,
    onComplete: async ({ session, object }) => ({ mediaId: await db.media.insert(session.id, object) }),
  }),
  media: {
    download: t.media.download.handler({
      resolve: async ({ context, input, errors }) => {
        const m = await db.media.find(input.mediaId);
        if (!m || m.ownerId !== context.user?.id) return errors('NOT_FOUND');
        return { key: m.key, versionId: m.versionId, fileName: m.name };
      },
    }),
  },
});
// Forgetting an endpoint, or returning the wrong output shape, is a compile error.

export const uploads = createUploadServer({
  router,
  storage,
  secret: process.env.UPLOAD_TOKEN_SECRET!,  // seals session tickets; not a bucket credential
  basePath: '/api/upload',
});
```

Mount it anywhere:

```ts
// Bun / Deno / Cloudflare Workers / Hono / Next.js route handlers: Fetch standard
export const POST = (req: Request) => uploads.fetch(req, { user: await getUser(req) });

// Node http / Express
import { toNodeHandler } from '@bu-draft/server/node';
app.use('/api/upload', toNodeHandler(uploads, { context: async (req) => ({ user: await getUser(req) }) }));
```

### 4. Client (browser)

```ts
import { createUploadClient, indexedDBStore } from '@bu-draft/client';
import { contract, type Contract } from './contract';

export const client = createUploadClient<Contract>({
  baseUrl: '/api/upload',
  contract,                      // optional: enables client-side validation (safe, no secrets)
  persistence: indexedDBStore(), // default; `false` disables resume-after-reload
});

const task = client.travelVideos.upload(file, { input: { albumId } });
task.subscribe(() => console.log(task.getSnapshot().progress));
const { mediaId } = await task.result;           // typed from the contract
```

That's the whole setup.

---

## Concepts

### Contract

The contract is a plain object tree of `upload()` and `download()` declarations. It holds rules, schemas and policies, and never
a bucket, a credential or a framework. Import it on the client as a **type**, or as a **value** if you want client-side
pre-validation; either is safe. Nested objects namespace endpoints, so `media.download` is served at `/media/download`.

| Builder | Meaning |
|---|---|
| `.files({ accept, maxFileSize, minFileSize, maxFiles })` | File rules. Checked on the client (if the value is given) and always enforced on the server. |
| `.input(schema)` | Client-supplied metadata, validated on the server. Makes `input` required on the client. |
| `.output(schema)` | What `onComplete` returns to the client. |
| `.errors({ CODE: { status, data, retryable, userAction } })` | Typed, declared errors. |
| `.resume({ ttl, verify })` or `.resume(false)` | How long a session stays resumable, and how a re-selected file is verified. |
| `.integrity({ partChecksum, checksumType, contentHash })` | Per-part checksums verified by the storage; an optional whole-file hash. |

### Server hooks

| Hook | When | Notes |
|---|---|---|
| `use(middleware)` | Every op | Extends the typed context (auth, rate limit, logging) |
| `authorize` | `init`, once per batch | Return server-only `meta`, or throw with `errors(...)` |
| `reauthorize` | `sign`, `status`, `complete`, `abort` | Optional. By default a valid session ticket is enough. |
| `key` | `init` | Object key. Never derive it from `file.name`. |
| `onComplete` | `complete` | **At-least-once.** Use `session.id` for idempotency. The return value is validated against `output`. |
| `onAbort` | `abort` / expiry / janitor | Optional |
| `resolve` (download) | `download` | Authorize and return `{ key, versionId?, fileName? }` |

### State: what lives where

| Where | What | Default |
|---|---|---|
| Storage | Parts, final object (the source of truth for progress) | always |
| Session ticket | key, uploadId, part plan, `meta`, expiry. Server-minted, opaque to the client. | always (stateless server) |
| Browser `ResumeStore` | ticket, plan, confirmed parts, file descriptor | IndexedDB |
| Your own DB (optional) | the ticket, stored from the `onInit` hook if you want cross-device resume or recovery after browser storage eviction | **never required** |

The SDK has no database and no DB adapter. The ticket is portable: store it wherever your app already keeps records, and resume with `client.endpoint.resume(file, { ticket })`.

## Uploads in depth

### Task lifecycle

```
needs-file → preparing → initializing → uploading ⇄ paused
                                          ⇅
                               retrying / waiting-network
                                          ↓
                                     completing → completed
                         (failed · canceled from anywhere)
```

```ts
task.pause();  task.resume();  task.retry();  await task.cancel();
const s = task.getSnapshot();
s.status;                         // 'uploading' | 'waiting-network' | …
s.progress.confirmedBytes;        // stored by the bucket: survives reloads
s.progress.inflightBytes;         // in flight right now
s.progress.bytesPerSecond; s.progress.etaMs;
s.error?.userAction;              // 'wait' | 'retry' | 'reselect-file' | 'sign-in' | 'change-file' | 'contact-support'
```

### Resume after reload, days later

```ts
await client.$restore();                          // on app start
const pending = await client.travelVideos.pending();
for (const task of pending) {                     // status: 'needs-file'
  const file = await askUserToPick(task.getSnapshot().file.name);
  await task.attachFile(file);                    // rejects with FILE_MISMATCH if the bytes differ
}
```

How "same file" is decided:
1. Name, size, `lastModified` and type select a candidate.
2. The size must match the session's part plan.
3. A sample of the parts already uploaded (or all of them, with `verify: 'full'`) is re-checksummed in a worker and compared
   with the checksums **the storage** reports.

Nothing is appended until the bytes are proven equal. This matters on iOS, where re-picking from the Photos library can
deliver a transcoded file.

### Reliability features

- **Parts.** 8 MiB by default. They grow automatically for very large files, to stay under 10,000 parts, and stay equal-sized for R2.
- **Hashing.** Runs in Web Workers on streamed 1 MiB chunks, so memory stays bounded whatever the file size.
- **Concurrency.** Adaptive (AIMD): starts at 3, drops on throttling or timeouts, climbs on healthy throughput.
- **Retries.** Full-jitter exponential backoff. Time spent offline doesn't consume attempts. `Retry-After` is honoured.
- **URL renewal.** URLs are signed lazily in short-lived batches, and expired URLs are re-signed transparently. Long sessions never depend on long-lived URLs.
- **Reconciliation.** `status` and `complete` re-list parts from storage. `complete` also verifies the part count, part sizes and checksums.
- **Idempotency.**
  - Re-uploading a part overwrites it.
  - Retrying `complete` after a lost response returns `alreadyCompleted: true`.
  - `abort` can be repeated.
- **Tabs.** A Web Lock per session prevents two tabs from uploading the same session.

### Errors

Every error has the same shape: `{ code, message, retryable, userAction, status?, data }`. `code` is a union of built-in codes and the codes declared in
your contract, and `data` is typed per code:

```ts
const err = task.getSnapshot().error;
if (err?.code === 'QUOTA_EXCEEDED') err.data.remainingBytes;  // number
```

Built-in codes include `NETWORK_ERROR`, `OFFLINE`, `SIGNED_URL_EXPIRED`, `SESSION_EXPIRED`, `SESSION_NOT_FOUND`,
`FILE_MISMATCH`, `FILE_UNREADABLE`, `INTEGRITY_MISMATCH`, `FILE_TOO_LARGE`, `FILE_TYPE_NOT_ALLOWED`,
`PROVIDER_LIMIT_EXCEEDED`, `STORAGE_THROTTLED`, `UNAUTHORIZED`, `CANCELED`…

## Downloads

```tsx
// Tier 0 (default): a stable, per-user link handed to the browser's own download manager.
<a href={client.media.download.link({ input: { mediaId } })} download>Download</a>
// Each hit re-authorizes with the user's session, then redirects to a fresh presigned URL (or streams it, in 'proxy' mode).
// If it fails, the user just clicks again or presses "retry" in the browser.

// Tier 1 (opt-in): managed, parallel, resumable download into the best local sink, e.g. for progress UI or decryption.
const dl = client.media.download.download({ input: { mediaId }, sink: 'auto' });
```

- In `'redirect'` mode (zero infra), resuming an interrupted download works while the presigned URL is valid. Browsers resume against the final URL.
- In `'proxy'` mode (an edge function next to the bucket, e.g. Worker + R2), resuming works in every browser.

A download is **not** a mirror of a multipart upload. There is no server-side session to complete or abort and nothing billed while
paused, but resume depends on validators (ETag or versionId) and on where the browser keeps the bytes. See [SPEC §14](./docs/SPEC.md#14-downloads-d1-d2-d3).

## React

```tsx
import { useUpload, usePendingUploads } from '@bu-draft/react';

function TripUploader({ albumId }: { albumId: string }) {
  const { upload, snapshots, progress, pauseAll, resumeAll, control } = useUpload(client.travelVideos, {
    onComplete: (output) => toast(`Saved ${output?.mediaId}`),
  });
  const pending = usePendingUploads(client);
  return (
    <>
      {pending.length > 0 && <ResumeBanner tasks={pending} />}       {/* registry component */}
      <UploadDropzone control={control} onFiles={(files) => upload(files, { input: { albumId } })} />
      <UploadList items={snapshots} />
      <progress value={progress} max={1} />
    </>
  );
}
```

The hooks are thin `useSyncExternalStore` bindings over the client stores, so they re-render only on change. The UI is **copy-in**:
`npx shadcn add <registry>/upload-dropzone` (planned). The components are yours to style, and they take a headless `control` or task prop.

## Plugging into a CMS or backend

The SDK moves bytes and owns nothing else. Auth comes from your context factory. Your hooks decide keys and IDs, write your
records, and optionally store the portable ticket. Records are created either inline in `onComplete`, or later from a sealed
**receipt** that your CMS verifies with `uploads.verifyReceipt()`. Sketches for Payload and Convex are in
[docs/INTEGRATIONS.md](./docs/INTEGRATIONS.md).

## Bucket setup

The SDK never changes your bucket configuration. `recommendedBucketConfig()` prints what is expected:

```jsonc
// CORS
[{ "AllowedOrigins": ["https://app.example.com"],
   "AllowedMethods": ["PUT", "GET", "HEAD"],
   "AllowedHeaders": ["content-type", "x-amz-checksum-crc32c", "range", "if-match"],
   "ExposeHeaders": ["ETag", "x-amz-checksum-crc32c", "content-range"],
   "MaxAgeSeconds": 3600 }]
// Lifecycle: incomplete parts are billed until aborted (AWS, GCS keep them forever)
{ "Rules": [{ "ID": "abort-incomplete-uploads", "Status": "Enabled", "Filter": {},
              "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 8 } }] }
```

`uploads.check()` warns at startup in two cases:
- the provider's own cleanup window is shorter than your `resume.ttl` (R2: 7 days by default, MinIO AIStor: 24 hours);
- no lifecycle rule exists.

## Limits (documented, not promised)

The SDK sets no arbitrary limit. The providers do:

| | Parts | Part size | Max object | Notes |
|---|---|---|---|---|
| AWS S3 | 10,000 | 5 MiB – 5 GiB | 48.8 TiB | Presigned URLs ≤ 7 days (less with STS credentials) |
| Cloudflare R2 | 10,000 | 5 MiB – 5 GiB, **equal** | 4.995 TiB | Incomplete uploads aborted after 7 days by default |
| Backblaze B2 | — | 5 MB – 5 GB | 10 TB | |
| DigitalOcean Spaces | 10,000 | 5 MiB – 5 GB | 5 TB | Incomplete uploads deleted after 30 days |

On the browser side:
- On iOS, uploads stop when the screen locks or Safari goes to the background. The SDK doesn't fight the OS; it makes resuming exact.
- Safari can delete site storage after 7 days of use **without visiting your site**. Recovering in that case requires your app to have stored the ticket (`onInit`).

Sources and the full provider table: [docs/research/storage-and-browser.md](./docs/research/storage-and-browser.md).

## How it compares

| | This SDK (proposed) | UploadThing | better-upload | Uppy + aws-s3 |
|---|---|---|---|---|
| Your own bucket | ✅ | ❌ (hosted) | ✅ | ✅ |
| Contract-first end-to-end types | ✅ | ✅ (router type) | partial | ❌ |
| Multipart + pause/resume | ✅ | pause/resume while the URL is valid | multipart, no documented resume | ✅ |
| Resume after reload / days | ✅ (re-select + content proof) | ❌ documented | ❌ documented | Golden Retriever (24 h default, metadata-only identity) |
| Database required | no | n/a | no | no |

Sources: [docs/research/prior-art.md](./docs/research/prior-art.md).

## Repository layout (design phase)

```
docs/BRIEF.md              original request, verbatim + requirement IDs
docs/OUTLINE.md            intentions, phase plan, targeted questions
docs/DECISIONS.md          decision log with statuses (all PROPOSED / OPEN)
docs/SPEC.md               protocol, state, engine, identity, limits, downloads
docs/NAMING.md             name collisions
docs/INTEGRATIONS.md       CMS / Convex integration model (Payload, Convex sketches)
docs/E2EE-PERSPECTIVE.md   future encrypted transfer demonstrator (not in scope)
docs/research/             sourced research notes (dated 2026-11-12)
packages/*/src             TypeScript interfaces only (declare-only, no runtime)
examples/basic             contract / server / client / React examples (type-checked)
type-tests                 inference and @ts-expect-error tests
```

```sh
npm install && npm run typecheck   # the only runnable thing in this repo
```

## License

MIT (proposed, D-018).
