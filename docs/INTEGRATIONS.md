# Host integrations (CMS, Convex, …): DESIGN DRAFT

> Status: **proposal**. Nothing is decided and nothing is implemented. Requirements G5, H1, H2 (BRIEF addenda, 2026-11-15).
> Research and sources: [research/hosts.md](./research/hosts.md).

## The problem

In a real app the pieces live in different places:

| Concern                           | Payload example                        | Convex example               |
| --------------------------------- | -------------------------------------- | ---------------------------- |
| Auth                              | Payload `req.user`                     | `ctx.auth.getUserIdentity()` |
| Bytes                             | S3 / R2 bucket                         | R2 / Bunny / S3              |
| IDs, file names, URLs, DB records | Payload collection docs, `generateURL` | Convex tables                |
| "Upload in progress" tracking     | optional draft doc                     | optional table               |

The SDK must **move the bytes reliably and own nothing else**.

## Principle: the SDK owns the bytes, the host owns the meaning

Each host concern maps onto an existing SDK seam. None of them needs a DB port.

| Host concern              | SDK seam                                                                                                               | Note                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Who is the user           | adapter `context(req)` → typed context, middleware                                                                     | Whatever the host uses (Payload `req.user`, Convex identity, Better Auth…)                                  |
| May they upload this      | `authorize({ context, input, files })`                                                                                 | Throw a typed error, or return server-only `meta`                                                           |
| Object key / ID           | `key({ meta, file, sessionId, input })`                                                                                | Host-generated (e.g. Payload's `{prefix}/{uuid}/{filename}` scheme)                                         |
| Track in-progress uploads | `onInit({ ticket, session, context })`                                                                                 | Optional. The host stores the **portable ticket**. Resume anywhere with `endpoint.resume(file, { ticket })` |
| Create the record         | **inline**: `onComplete` creates it and returns typed `output`; **or commit**: the host verifies the **receipt** later | Both modes are available. See below                                                                         |
| Serve                     | download `resolve` → key, versionId, delivery mode                                                                     | The host decides the URL scheme and access                                                                  |
| Delete / GC               | host deletes via its own flow; `onAbort`; bucket lifecycle rule                                                        | No SDK janitor state                                                                                        |

### Two ways to create the host record

1. **Inline** (simplest, like UploadThing): `onComplete` writes the DB record inside the `complete` request and returns `{ mediaId }`.
   Delivery is at-least-once, so use `session.id` as the idempotency key.
2. **Receipt / commit** (the Payload `signedReceipt` and ConvexFS `commitFiles` pattern):
   - `complete` returns a sealed **receipt** proving "object K of size S exists for endpoint E, session X, meta M".
   - The client forwards it to the host's normal create path (a Payload form submit, a Convex mutation).
   - The host calls `uploads.verifyReceipt(receipt)` instead of trusting client claims.

   This fits hosts whose record pipeline must stay in charge: validation, hooks, versioning, drafts.

## Sketches (illustrative only, not typed in this repo yet)

### Payload CMS: compatible, with a docs page (D-033)

**Status check (2026-11-15).** The owner remembered native support landing. It hasn't shipped yet, but it is close:

- Payload team PR [#19325](https://github.com/payloadcms/payload/pull/19325) "feat(storage-s3): resumable upload sessions" was
  **approved** on 2026-11-12. It targets `main`, which is the v4 line (v4.0.0-beta.9, 2026-11-13). The latest stable is 3.93.0,
  which does not include it.
- Its design (from the PR description):
  - a **hidden `payload-upload-sessions` collection**, i.e. DB-backed: the opposite of our stateless ticket;
  - S3 multipart for files ≥ 64 MB, with `ListParts` deciding which parts are missing;
  - resume after a reload by re-selecting the file;
  - an `@experimental` `uploadInstructions.segmented` adapter contract, implemented only by `@payloadcms/storage-s3`;
  - completion through the existing receipt + create path;
  - opportunistic cleanup of expired sessions.
- The admin follow-up (start uploading on pick, finish saving in the background) is a separate PR. An older draft is
  [#19076](https://github.com/payloadcms/payload/pull/19076).

**Our stance.** Don't build a competing admin plugin. Instead:

1. **v0: a docs page, "Use with Payload".** Mount the SDK router as Payload custom endpoints:
   - the context comes from `req.user`;
   - `authorize` reuses the collection's `create` access;
   - `key` follows Payload's scheme;
   - **receipt mode**: the client submits `{ filename, mimeType, filesize, receipt }` to the normal create, and a `beforeChange`
     hook verifies it with `uploads.verifyReceipt()`.

   This is for front-end apps (user uploads outside the admin), on Payload 3.x as well as 4.x.
2. **Contribute where we add value** (owner approval needed before posting anything):
   - Feedback on #19325 about **re-selected file identity**. Does it prove the re-picked file is the same, e.g. after an iOS
     re-encode? Also per-part checksums, and R2's equal-part rule.
   - Support for **non-S3 providers** through the `segmented` contract.
3. **Revisit after Payload v4 is stable.** At that point the admin UI already has resumable uploads natively, and a plugin would
   only make sense for providers or features that Payload lacks.

Caveats for the docs page:

- Large-file collections must avoid `imageSizes` and mime sniffing, otherwise Payload re-downloads the object.
- Payload's own receipt helpers are in `payload/internal`, which is not public, so we mint our own.

### Convex: an official multi-provider component (D-032)

Owner goal: "like ConvexFS, but not tied to Bunny.net: multi-provider, with multipart upload and resilience."

**Convex constraints that shape the design** (see [research/hosts.md](./research/hosts.md)):

- Mutations can't make network calls; actions and HTTP actions can.
- Components have sandboxed tables and **can't read environment variables**.
- Documents are capped at 1 MiB.

Hence:

- The **storage credentials and S3 calls stay in app code.** An app-level HTTP action runs our Fetch handler.
- The **component holds only data and functions**: tables plus queries and mutations.
- Bytes never touch Convex.

```ts
// convex/convex.config.ts
import uploads from '@x/convex/convex.config';
app.use(uploads);

// convex/uploads.ts: app code, so it can read env and owns the credentials
export const uploads = new Uploads(components.uploads, {
  router, // the same contract + router as on any other host
  storage: s3Storage({ preset: 'r2', bucket: 'media' /* keys from process.env */ }),
  context: async (ctx) => ({ user: await ctx.auth.getUserIdentity() }),
});

// convex/http.ts
uploads.registerRoutes(http, { pathPrefix: '/api/upload/' }); // init/sign/status/complete/abort + download links

// reactive queries for the UI, across devices
export const myPending = query({ handler: (ctx) => uploads.listPending(ctx, { owner: '…' }) });
```

**Component tables (like ConvexFS):**

- `uploads`: `sessionId`, `endpoint`, `owner`, sealed `ticket`, file descriptor, `status`
  (`pending | completed | aborted | expired`), `expiresAt`.
  - Written only at init, complete and abort: never per part, so writes stay cheap.
  - Upload progress stays on the client.
  - This is exactly the "host persists the ticket" path of D-005, which gives **cross-device resume and pending lists out of the box**.
  - The core SDK still has no DB. In a Convex app, Convex _is_ the host's DB.
- `files` (optional): `key`, `size`, `contentType`, `checksum`, `owner`, `sessionId`. For apps that want a ConvexFS-like file
  table instead of their own `onComplete` record.

**Compared with ConvexFS:**

|             | ConvexFS 0.3                         | Our component (proposal)                                                                                                        |
| ----------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Providers   | Bunny.net only                       | Any S3-compatible (R2, AWS, B2, Tigris, MinIO…). Bunny later if its S3 API fits **[unverified]**                                |
| Upload path | proxied through an HTTP action       | direct browser → bucket, presigned multipart                                                                                    |
| Resume      | ✗                                    | ✓ over days, re-selected file verified (D-007), cross-device through the `uploads` table                                        |
| Commit      | `commitFiles` within a 4 h TTL       | inline `onComplete` (mutation), or receipt + `verifyReceipt` inside the host's mutation                                         |
| Auth hook   | `uploadAuth → { allowed, maxBytes }` | `authorize` (typed `input`, typed errors, server `meta`)                                                                        |
| Downloads   | 302 to a 1 h signed CDN URL          | stable link → 302 to a fresh presigned URL; Cloudflare proxy optional                                                           |
| GC          | soft delete, ref-counted blobs, cron | app cron → `uploads.sweep(ctx)` action (abort expired multipart, optional orphan delete). Ref-counted dedup out of scope for v0 |

Inspiration to study before implementing: ConvexFS, the Better Auth component, the Stripe component, `@convex-dev/r2`
and other well-made components (table layout, `registerRoutes`, client class wrapping `components.x`, testing).

Open points:

- Is ConvexFS-style path/ref-count file management in scope (later)?
- Can components register crons **[unverified]**, or does the sweep stay app-side?

### Others

- **Strapi, Medusa, Keystone:** their providers expect the bytes on the server. Integration = an SDK endpoint plus a call into the host's "create file record" service in `onComplete` or on receipt.
- **Sanity:** hosted assets only; at most, store our URL in a field.
- **Supabase:** already ships tus resumable uploads. Our added value there would be the typed contract and one client, not resumability.

## What this changes in the core (already reflected in the types)

- `onInit` hook + portable `ticket` (no SDK DB) → `packages/server/src/index.ts`.
- `endpoint.resume(file, { ticket })` → `packages/client/src/index.ts`.
- `complete` returns a sealed `receipt`, and `server.verifyReceipt()` exists → server, protocol and task types.
- The context factory is the only auth seam. Hooks may be async and call into the host (Payload `req.payload`, Convex `runMutation`).

## Open questions

- **I1.** Which mode should the docs lead with: inline `onComplete`, or receipt/commit? Proposal: inline for apps; receipt for the Payload page.
- ~~I2~~ **Resolved (round 3):** Convex component first, Payload docs page.
- ~~I3. Payload admin UI takeover~~: dropped, see D-033.
- ~~I4~~ **Resolved (round 3):** follow ConvexFS, i.e. the component has its own tables.
