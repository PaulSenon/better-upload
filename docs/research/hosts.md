# Research: host integration (Payload, other CMSes, Convex)

> Status: research notes, **not a decision**. Checked 2026-11-15 against official docs and published package sources.
> **[unverified]** = could not be confirmed. Requirement G5 in the BRIEF addendum.
>
> Versions: `payload` and `@payloadcms/storage-*` 3.93.0 (the source was read from 3.91.0 tarballs) · `convex` 1.50.0 · `@convex-dev/r2` 0.10.4 ·
> `convex-fs` 0.3.0 · `@strapi/strapi` 5.62.0 · `@directus/api` 41.0.1 · `@medusajs/medusa` 2.22.7 · `@keystone-6/core` 8.3.0 · `@supabase/storage-js` 2.119.0.

## Payload CMS v3

- **Upload collections:** `upload: true | {...}` adds `filename`, `mimeType`, `filesize` and `sizes`. The default request limits are 20 MiB per file and 50 MiB per request. The collection's `read` access also guards the files. <https://payloadcms.com/docs/upload/overview>
- **Storage adapters** (S3, Azure, GCS, Vercel Blob, Uploadthing, R2-on-Workers beta) plug in through `cloudStoragePlugin`. Their `GeneratedAdapter` has:
  - `handleUpload`, `handleDelete`, `staticHandler` (serving) and `generateURL`;
  - `clientUploads?`, `requiresClientUploadReceipt?`, `fields?` and `onInit?`.

  <https://payloadcms.com/docs/upload/storage-adapters>
- **`clientUploads` flow** (read from the source):
  1. The admin provider calls `useUploadHandlers().setUploadHandler({ collectionSlug, handler })`.
  2. The server endpoint checks access, mime type and size, dedupes the filename, generates `_objectKey = randomUUID()` and signs **one** `PutObject` with `If-None-Match: *`. That URL lasts 600 s.
  3. The server returns `clientUploadContext` together with an **HMAC `signedReceipt`**. The receipt covers collection, context, filename, user and expiry, is keyed with `payload.secret`, and expires after **6 h**.
  4. The browser PUTs the file, then submits the form with `file` set to `{filename, mimeType, size, clientUploadContext}`.
  5. Payload verifies the receipt, then **reads the object back**: the full object for image sizes or mime checks, a 1 MiB probe, or nothing.
  6. The normal create pipeline builds the document.
- **Who generates what:**
  - Document ID: the DB adapter.
  - Filename: Payload.
  - Key: `{prefix}/{docPrefix}/{_objectKey}/{filename}`.
  - URL: `generateURL`, or `/api/{slug}/file/{filename}` served through the `staticHandler` with `read` access.
- **Large-file gaps:**
  - S3, GCS and Vercel Blob client uploads are single-request, so S3 caps them at 5 GiB.
  - Azure gained `chunkLargeFiles` in 3.87.
  - S3 multipart client uploads are in **open PR #17005**, targeting v4, with no resume (<https://github.com/payloadcms/payload/pull/17005>).
  - There are community reports of a 17 GB video failing.
- **Update (2026-11-15, round 2):** the Payload team's PR [#19325](https://github.com/payloadcms/payload/pull/19325), "feat(storage-s3): resumable upload sessions", was **approved** on 2026-11-12. It targets `main`, the v4 line, and is not in stable 3.93.0.
  - It adds a hidden `payload-upload-sessions` collection, so it is DB-backed.
  - Resume works through `ListParts` after a reload, by re-selecting the file.
  - It defines an `@experimental` `uploadInstructions.segmented` adapter contract, implemented by S3 only, with a 64 MB default threshold.
  - It supersedes #17005 in practice. The admin "upload on pick" UI is a follow-up PR (draft #19076).
- **Seam for a third party:** register an admin provider with `setUploadHandler`, run our resumable upload, and return a `clientUploadContext`. The catch is that the receipt helpers come from `payload/internal`, which is "not part of the public API". The 6 h receipt TTL also limits resumed uploads that go through the admin form.

## Other hosts

| Host | Surface | Bytes go… | Notes |
|---|---|---|---|
| Strapi v5 | Provider `init(config) → { upload, uploadStream, delete, getSignedUrl?, isPrivate? }` | through Strapi | Presigned uploads only via community guides (<https://docs.strapi.io/cms/configurations/media-library-providers>) |
| Directus | Storage drivers; tus (`TUS_ENABLED`, 10 MB chunks, 10 min inactivity expiry) | through the API **[unverified]** | <https://directus.com/docs/configuration/files> |
| Sanity | `POST /assets/{images,files}/{dataset}`, hosted only | Sanity | We can't own the storage; integration = store our URL in a field (<https://www.sanity.io/docs/http-reference/assets>) |
| Medusa v2 | File Module Provider: `upload`, `delete`, `getPresignedUploadUrl` / `getPresignedDownloadUrl`, `getDownloadStream` | one presigned PUT at most | <https://docs.medusajs.com/resources/references/file-provider-module> |
| Keystone 6 | file/image `storage` config, `maxFileSize` 200 MiB | through the server **[unverified]** | <https://keystonejs.com/docs/config/config> |
| Supabase Storage | tus endpoint, **6 MB chunks**, 24 h URLs, JWT + RLS | Supabase | Already resumable; we would only add a unified contract (<https://supabase.com/docs/guides/storage/uploads/resumable-uploads>) |

## Convex

- **Built-in storage:**
  - Flow: a mutation calls `ctx.storage.generateUploadUrl()`, which is where authorization happens. The browser POSTs the file and gets a `storageId`, and a second mutation records that ID.
  - The upload URL lasts 1 h, the POST has a **2 min timeout**, and there is no multipart or resume. <https://docs.convex.dev/file-storage/upload-files>
- **Limits** (<https://docs.convex.dev/production/state/limits>):
  - Mutations: 1 s of user-code time, deterministic, so no network calls.
  - Actions: 30 min (10 min on Node).
  - Documents: 1 MiB, and arrays are capped at 8192 elements.
  - HTTP actions: responses are capped at 100 MiB.
- **Components:**
  - Registered with `app.use(component)` in `convex.config.ts`, and each one gets sandboxed tables and functions.
  - Component mutations join the caller's transaction.
  - Components can't read environment variables.

  <https://docs.convex.dev/components/using>
- **`@convex-dev/r2`:**
  - `r2.clientApi({ checkUpload, onUpload, checkReadKey, checkDelete, onDelete, callbacks })` returns `generateUploadUrl` and `syncMetadata`. `generateUploadUrl` signs a single PUT, keyed by UUID by default or by a custom key.
  - On the client, `useUploadFile` sends the file by XHR PUT, then calls `syncMetadata`, which schedules a HEAD request and writes a `metadata` table.
  - `getUrl(key, { expiresIn })` defaults to 900 s and accepts up to 7 d. The README notes that signed URLs bypass the Cloudflare cache, so use a custom domain for CDN delivery.
  - No multipart, no resume.

  <https://cdn.jsdelivr.net/npm/@convex-dev/r2@0.10.4/README.md>
- **ConvexFS** (`convex-fs`, by Convex cofounder Jamie Turner; <https://github.com/jamwt/convex-fs>, <https://convexfs.dev>). This is the component the owner remembered. It hosts files on **Bunny.net** Edge Storage + CDN, which is cheaper than the usual CDNs.
  - Tables: `uploads` (pending, with a TTL), `blobs` (ref-counted), `files` (path → blob, with expiry) and `config`.
  - **Uploads are proxied, not presigned.** `registerRoutes(http, …, { uploadAuth, downloadAuth })` creates `POST /fs/upload`. That route:
    - runs `uploadAuth`, which returns `{ allowed, maxBytes }`;
    - streams the bytes to Bunny while **counting the real size** rather than trusting the client's claim;
    - creates a `blobId` and records the upload as pending with a **4 h commit TTL**.
  - The host then calls `fs.commitFiles(ctx, [{ path, blobId, basis? }])`, which performs a compare-and-swap.
  - Downloads go through `GET /fs/blobs/{id}` → `downloadAuth` → a 302 to a signed CDN URL valid for 1 h.
  - Cleanup and dedup: soft deletes with a 24 h grace period, ref-counted dedup, and cron GC with a `freezeGc` switch.
  - No multipart or resume. The project is labelled "Alpha".

## Shared patterns across hosts

1. **The host owns auth:** Payload `req.user`, Convex `ctx.auth`, Supabase JWT/RLS.
2. **The record is created after the bytes land,** tied to them by a server-signed artefact: Payload's `signedReceipt`, Convex's `storageId`, ConvexFS's `blobId` + `commitFiles`.
3. **Orphans are reclaimed by TTL:** ConvexFS pending uploads after 4 h, Payload receipts after 6 h, Directus tus uploads after 10 min idle.
4. **Hosts that process files read them back** (Payload image sizes). Large-file collections should avoid that.
5. **Serverless body limits don't matter** when bytes go straight to the bucket. Only small JSON control calls go through the host.

The research agent suggested a host-provided `StateStore`. The owner rejected an SDK DB (Q2), so the proposal in [INTEGRATIONS.md](../INTEGRATIONS.md)
reaches the same goal with the portable ticket, the `onInit` hook and a completion **receipt**, and no store port.
