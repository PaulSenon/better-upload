# Existing "Better Upload" project and naming options

> Status: research notes, not a decision. Checked 2026-11-15.

Sources: GitHub API, the npm registry and downloads API, and a shallow read of the repo's source and docs (`main` at commit "Version Packages (#136)", 2026-10-19).

## Part 1: the existing Better Upload

### Identity and activity

| Item | Value | Source |
|---|---|---|
| Tagline | "Simple and easy file uploads for React. Upload directly to any S3-compatible service with minimal setup." | https://github.com/Nic13Gamer/better-upload |
| Maintainer | Single maintainer, `Nic13Gamer` (sole npm maintainer `nic13gamer`). About 10 contributors on GitHub. | npm registry, GitHub contributors API |
| License | MIT | GitHub API |
| Stars / forks | 1,290 / 42; 6 open issues and PRs | GitHub API |
| Created | Repo 2024-09-08; npm `better-upload` 2024-09-23 | GitHub, https://registry.npmjs.org/better-upload |
| Packages | `@better-upload/server` and `@better-upload/client` at **3.0.20**, released 2026-10-19. v3.0.0 came out 2025-11-09, and 22 versions have shipped since. Unscoped `better-upload` stopped at 2.0.3 (2025-10-20) and is deprecated with the message "use @better-upload/server and @better-upload/client". | https://registry.npmjs.org/@better-upload/server |
| Weekly downloads (2026-11-08 to 11-14) | client 54,205; server 49,662; legacy `better-upload` 27,982 | https://api.npmjs.org/downloads/point/last-week/@better-upload/client |
| Activity | Active but bursty. Latest commits are 2026-10-19 (new Neon Object Storage client, #135) and before that 2026-05-12. Open PRs include presigned POST (#79) and Range header in `getObject` (#86/#87). | GitHub commits and issues API |
| Site | https://better-upload.com (docs plus shadcn registry, and `llms-full.txt`) | repo `apps/docs` |

### Architecture and API shape

- **Server (`@better-upload/server`)**
  - You write `const router: Router = { client, bucketName, routes: { images: route({...}) } }`.
  - It exposes one POST endpoint (default `/api/upload`) through `handleRequest(request, router)`, which takes a Web `Request`.
  - Adapters: `adapters/next` (`toRouteHandler`) and `adapters/node`. The docs show Next.js, TanStack Start, Remix, Hono, Elysia, Express and Fastify.
  - Dependencies: `aws4fetch`, `fast-xml-parser`, `zod`. It does not use the AWS SDK.
- **Route options**
  - `multipleFiles`, `maxFiles`, `fileTypes` (MIME wildcards), `maxFileSize` (default 5 MB) and `signedUrlExpiresIn` (default 120 s).
  - `clientMetadataSchema` takes any Standard Schema validator, such as Zod.
  - `onBeforeUpload` handles auth and rate limits. It can throw `RejectUpload`, and it returns `generateObjectInfo` (key, metadata, ACL, storageClass, cacheControl, tagging, `skip: 'ignore' | 'completed'`) or `bucketName`.
  - `onAfterSignedUrl` is also available.
  - Source: `apps/docs/content/docs/routes-multiple.mdx`.
- **Storage clients:** aws, cloudflare (R2), backblaze, digitalocean, linode, minio, neon, tigris, wasabi, plus a custom option (`packages/server/src/clients/`). S3-compatible storage only.
- **Server helpers:** typed wrappers for S3 operations (put, get, head, copy, move, delete, list, tagging, multipart create/uploadPart/complete/abort) and a presigned GET (`presignGetObject`) for downloads (`helpers-server.mdx`).
- **Client (`@better-upload/client`)**
  - React hooks `useUploadFile` and `useUploadFiles`, plus non-React `uploadFile` and `uploadFiles`.
  - Hook options: `route: string`, `api`, `uploadBatchSize` (files in parallel), `multipartBatchSize` (parts in parallel; default is all at once), `signal`, `headers`, `credentials`, `retry` (default 0) and `retryDelay` (default 0, fixed).
  - Events: `onBeforeUpload`, `onUploadBegin`, `onUploadProgress`, `onUploadComplete`, `onUploadFail`, `onUploadSettle`.
- **shadcn registry:** `npx shadcn@latest add @better-upload/upload-dropzone`. Components are upload-button, upload-dropzone, upload-progress and paste-upload-area (`apps/docs/public/r/registry.json`). There are guides for TanStack Query, react-hook-form and TanStack Form.

### Feature checks

| Capability | Better Upload (v3.0.20) | Evidence |
|---|---|---|
| Multipart | Yes, opt-in per route (`multipart: true`, `partSize` default 50 MB). The server creates the upload and presigns **every** part URL in one request. Part URLs expire in 25 min (default) and complete/abort URLs in 30 min. Empty files fail. | `multipart-handler.ts`, `routes-multiple.mdx` |
| Resumable across sessions or days | **No.** No persisted upload state, no ListParts, no re-sign of parts, and no resume API. The lifetime is bounded by URL expiry. | No `listParts` and no resume code in `packages/` |
| Retries | Fixed count and fixed delay, both default 0. No backoff or jitter. | `hooks-multiple.mdx` |
| Concurrency | Static batch sizes for files and parts. Not adaptive. | same |
| Checksums / integrity | None on the client (no MD5, SHA or CRC). | grep of `packages/client/src` |
| File identity on resume | N/A | |
| Downloads | Only a server helper that presigns a GET. No stable link, redirect endpoint or proxy. | `helpers-server.mdx` |
| Type-safe input / metadata | Metadata is validated on the server (Standard Schema). On the client, `route` is a plain `string` and metadata is `Record<string, unknown>`, so no route or metadata types are inferred end-to-end. | `client/src/types/internal.ts` |
| DB requirement | None | |
| UI | Yes, a shadcn registry (its main selling point) | |
| Non-React clients | Vanilla `uploadFiles` exists. The docs and positioning are React-only. | `client/src/index.ts` |
| Host integrations (CMS, Convex) | None found | |

### Philosophy

From the docs intro (`apps/docs/content/docs/index.mdx`):

> "easy to use, fast to set up, and not bloated with features I didn't need"

Other stated goals are "Own your data" (your own bucket) and copy-paste shadcn UI. Its niche is **DX-first, React-first: a self-hosted UploadThing alternative.**

Our design is **reliability-first and infra-agnostic.** It aims at long-lived resumable multipart with integrity checks, adaptive transport, a typed contract that drives a derived client, downloads as a first-class feature, and host integrations.

### Comparison with our design

| Dimension | Better Upload | Our design |
|---|---|---|
| Primary audience | React apps, quick setup | Any TS host (React optional), apps with large or long uploads |
| Contract and types | Server route map; client `route: string` | Shared contract → router → derived typed client (oRPC-style) |
| Multipart | Yes, all parts presigned upfront, short TTL | Yes, parts signed lazily or refreshed from the sealed ticket |
| Resume after days / re-select file | No | Core feature (sealed ticket plus sampled part checksums for identity) |
| Integrity | None | Per-part checksums |
| Retries / concurrency | Fixed retry count; static batch size | Adaptive concurrency, backoff retries |
| State | Stateless (no DB) | Stateless (sealed ticket, no DB) |
| Downloads | Presign helper only | Stable per-user link → 302 to fresh presigned URL; optional Cloudflare edge proxy with Range |
| Storage | S3-compatible (10 named presets) | S3-compatible first, adapter seam for others |
| UI kit | shadcn registry | Not core (could be added later) |
| Host integrations | Framework adapters (Next, Node) | Payload CMS plugin, Convex component |
| License | MIT | OSS (TBD) |

**Verdict:** the two products *overlap* at the surface (S3 presigned uploads, route definitions, no DB, Standard Schema metadata) but take *a different angle*. Our differentiators are resume-across-days with file identity, integrity, an adaptive transport, an end-to-end typed contract, a download tier and host integrations. None of these exist in Better Upload, and its "not bloated" philosophy works against most of them. The name, however, is a direct collision: the same name in the same category, with roughly 100k weekly downloads and an owned domain. **We must not ship as "Better Upload".**

### Could we contribute instead?

- **Plausible pieces to upstream:** retry backoff, adaptive part concurrency, lazy or refreshed part signing, and per-part checksums. These are additive client and server changes. Note that the repo's contributing guide asks for an issue discussion before PRs that change major behavior.
- **Hard to upstream:**
  - The sealed ticket plus cross-session resume with file re-selection and identity check. This is a new protocol and a new endpoint surface.
  - The typed contract → derived client model. This would break the `route: string` API.
  - The download tier, the edge proxy, and Payload and Convex integrations. These are out of scope for a React upload helper.
- **Implications:** we would depend on one maintainer's roadmap and release cadence, accept React-first positioning, and probably land a major-version redesign. The realistic path is to **build separately under another name**. Optionally, open an issue upstream proposing resumable multipart, and/or ship a compatibility note ("coming from Better Upload") later. **[unverified]** whether the maintainer is open to a large redesign; no such discussion was found.

## Part 2: name shortlist

Method:

- **npm:** `GET https://registry.npmjs.org/<name>`, where 404 means free.
- **Scope:** `GET https://registry.npmjs.org/-/org/<name>/package`, where 404 means no org or user scope exists. This was checked against `@better-upload` (200) and a random name (404).
- **GitHub:** `search/repositories?q=<name>+in:name`, showing the top repo by stars.
- Some scope checks were rate-limited and are marked **[unverified]**.

| Name | npm unscoped | `@scope` | Notable GitHub use | Notes |
|---|---|---|---|---|
| steadyload | free | free | none (0 repos) | Conveys reliability; covers up and down |
| cargohold | free | free | 15 repos, none notable (top has 1★) | "Safe storage in transit" metaphor |
| upferry | free | free | 1 repo (0★) | Ferry = carries across; short |
| fileferry | free | taken (scope exists) | 29 repos, top 18★ | Weaker because of the scope |
| filewire | free | free | 5 repos, top 3★ | Short; "wire" hints at transport |
| durable-upload | free | free | 2 repos (0★) | Descriptive and SEO-friendly; upload-only connotation |
| sturdy-upload | free | **[unverified]** | 0 repos | Descriptive |
| typed-upload | free | **[unverified]** | 0 repos | Descriptive; misses reliability |
| upstay | free | free | 12 repos (top 1★) | Pun on "upload that stays"; ambiguous |
| relaykit | free | taken | 25 repos (top 3★) | Generic |
| uploadkit | **taken** (v0.1.1, 2026-11-03) | taken | 32 repos | Avoid |
| stowage | **taken** (active S3/R2 storage lib, 2026-09) | taken | 196 repos | Avoid, same domain |
| haul / hoist / ferry / tether / uplift | **taken** | taken | big projects (e.g. callstack/haul 3.7k★, shipshapecode/tether 8.5k★) | Avoid |
| keelson / bucketline / resumable-uploads | **taken** | **[unverified]** / n/a | small | Avoid |

**Top 3 recommendation**

1. **steadyload**: npm name, scope and GitHub are all clear. It says "reliable" and works for both uploads and downloads (`@steadyload/server`, `@steadyload/client`, `@steadyload/convex`).
2. **cargohold**: everything is clear and the name is memorable. The storage-and-transport metaphor fits the sealed ticket and integrity checks.
3. **upferry**: everything is clear and the name is short. It suggests carrying files across sessions and infrastructure.

Not checked: domain availability, trademarks, and PyPI or crates names. Check all of these before deciding.
