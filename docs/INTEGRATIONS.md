# Host integrations (CMS, Convex, …): DESIGN DRAFT

> Status: **proposal**. Nothing is decided and nothing is implemented. Requirement G5 (BRIEF addendum 2026-11-15).
> Research and sources: [research/hosts.md](./research/hosts.md).

## The problem

In a real app the pieces live in different places:

| Concern | Payload example | Convex example |
|---|---|---|
| Auth | Payload `req.user` | `ctx.auth.getUserIdentity()` |
| Bytes | S3 / R2 bucket | R2 / Bunny / S3 |
| IDs, file names, URLs, DB records | Payload collection docs, `generateURL` | Convex tables |
| "Upload in progress" tracking | optional draft doc | optional table |

The SDK must **move the bytes reliably and own nothing else**.

## Principle: the SDK owns the bytes, the host owns the meaning

Each host concern maps onto an existing SDK seam. None of them needs a DB port.

| Host concern | SDK seam | Note |
|---|---|---|
| Who is the user | adapter `context(req)` → typed context, middleware | Whatever the host uses (Payload `req.user`, Convex identity, Better Auth…) |
| May they upload this | `authorize({ context, input, files })` | Throw a typed error, or return server-only `meta` |
| Object key / ID | `key({ meta, file, sessionId, input })` | Host-generated (e.g. Payload's `{prefix}/{uuid}/{filename}` scheme) |
| Track in-progress uploads | `onInit({ ticket, session, context })` | Optional. The host stores the **portable ticket**. Resume anywhere with `endpoint.resume(file, { ticket })` |
| Create the record | **inline**: `onComplete` creates it and returns typed `output`; **or commit**: the host verifies the **receipt** later | Both modes are available. See below |
| Serve | download `resolve` → key, versionId, delivery mode | The host decides the URL scheme and access |
| Delete / GC | host deletes via its own flow; `onAbort`; bucket lifecycle rule | No SDK janitor state |

### Two ways to create the host record

1. **Inline** (simplest, like UploadThing): `onComplete` writes the DB record inside the `complete` request and returns `{ mediaId }`.
   Delivery is at-least-once, so use `session.id` as the idempotency key.
2. **Receipt / commit** (the Payload `signedReceipt` and ConvexFS `commitFiles` pattern):
   - `complete` returns a sealed **receipt** proving "object K of size S exists for endpoint E, session X, meta M".
   - The client forwards it to the host's normal create path (a Payload form submit, a Convex mutation).
   - The host calls `uploads.verifyReceipt(receipt)` instead of trusting client claims.

   This fits hosts whose record pipeline must stay in charge: validation, hooks, versioning, drafts.

## Sketches (illustrative only, not typed in this repo yet)

### Payload CMS (future `@x/payload` plugin)

```ts
// payload.config.ts
plugins: [
  resumableUploads({
    collections: { media: { endpoint: 'media' } },   // which upload collections get the resumable path
    storage: s3Storage({ ... }),
    contract,                                         // or generated per collection
  }),
]
```

What the plugin would do:
- **Server side:**
  - Mount the SDK router as a Payload endpoint (`/api/uploads/*`). The context is built from `req.user`, and `authorize` reuses the collection's `create` access.
  - `key` follows Payload's own key scheme.
  - Use the **receipt** mode: the admin form submits `{ filename, mimeType, size, receipt }`, and the plugin's `beforeChange` hook verifies it and fills `filename`, `filesize` and `mimeType`.
- **Admin UI:** an admin provider registers `setUploadHandler({ collectionSlug, handler })`, the seam the official storage adapters use. It swaps the single-PUT client upload for our resumable multipart, with progress, pause and resume.
- **Serving:** `generateURL` / `staticHandler` map to our stable download link.
- **Caveats:**
  - Payload's own receipt helpers live in `payload/internal`, which is not a public API, and expire after 6 h. Minting our own receipt avoids depending on them.
  - Large-file collections must avoid `imageSizes` and mime sniffing, otherwise Payload re-downloads the whole object.
  - Payload's open PR #17005 (S3 multipart client uploads, v4) is a coordination opportunity.

### Convex (future `@x/convex` component or helper)

```ts
// convex/http.ts: the SDK server is a Fetch handler, and Convex HTTP actions are (Request) => Response
http.route({ pathPrefix: '/api/upload/', method: 'POST',
  handler: httpAction((ctx, req) => uploads.fetch(req, { convex: ctx })) });

// hooks call into the host's own mutations; S3 calls stay in the HTTP action
authorize: async ({ context }) => {
  const id = await context.convex.auth.getUserIdentity();
  if (!id) throw ...;
  return { ownerId: id.subject };
},
onInit:     ({ context, ticket, session }) => context.convex.runMutation(internal.uploads.pending, { ticket, sessionId: session.id }),
onComplete: ({ context, session, object }) => context.convex.runMutation(internal.media.create, { sessionId: session.id, key: object.key, size: object.size }),
```

- **This fits Convex's constraints.** Network calls to S3 (create, sign, ListParts, complete) happen in the HTTP action. DB writes happen in mutations through `runMutation`. Bytes never touch Convex, so there is no 2-minute `generateUploadUrl` timeout, no proxying cost and no 1 MiB document worry: the part list stays in storage (`ListParts`), not in a document.
- **Comparison with ConvexFS** (Jamie Turner's Bunny.net component):
  - ConvexFS proxies bytes through an HTTP action (it counts real bytes, but has no multipart or resume) and uses a pending-upload table with a 4 h commit TTL.
  - We keep direct-to-bucket multipart with resume, and borrow its **commit** idea (= receipt mode) and its **"auth hook returns `{ allowed, maxBytes }`"** shape.
  - Its ref-counted blobs and GC are host features we would document, not own.
- **The Convex wrapper would be thin:** typed helpers for the HTTP route, a schema snippet for a `pendingUploads` table if the host wants one, and the React hooks unchanged.

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

- **I1.** Which mode should the docs lead with: inline `onComplete`, or receipt/commit? Proposal: inline for apps, receipt for CMS plugins.
- **I2.** Which official integrations come first after v0? Proposal: Payload first (concrete gap, active demand in PR #17005), then Convex.
- **I3.** Should the Payload plugin take over the admin upload UI from day one, or start API-only?
