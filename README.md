# Open Upload

**Type-safe, resumable uploads and downloads to *your* storage.** AWS S3, Cloudflare R2, MinIO and any S3-compatible
service. No hosted service, no database.

> [!NOTE]
> Early preview. The code works and is tested (unit, MinIO integration, Playwright e2e on Chromium, WebKit, Firefox and
> iPhone emulation), but nothing is published to npm yet. Docs live in [`apps/web/content/docs`](./apps/web/content/docs).

- **One contract, end-to-end types.** Declare an endpoint once; the server implements it; the client is derived from it.
- **Resumable for days.** Presigned multipart, retries with backoff, adaptive concurrency, transparent URL renewal,
  offline waiting, pause/resume. After a reload, re-select the file and it continues.
- **Never mixes files.** A re-selected file is re-checksummed against what the bucket stores before anything is appended.
- **No database.** Sessions travel in a sealed ticket; the bucket is the source of truth.
- **Copy-in UI.** Headless React hooks plus shadcn registry components.

```ts
// contract.ts (shared)
export const contract = uc.router({
  videos: uc.upload()
    .files({ accept: ['video/*'], maxFiles: 20 })
    .input(z.object({ albumId: z.string() }))
    .output(z.object({ mediaId: z.string() })),
});

// server
const t = implement(contract).$context<{ user: User }>();
export const uploads = createUploadServer({
  storage: s3Storage({ provider: cloudflareR2({ accountId }), bucket: 'media', credentials }),
  secret: process.env.UPLOAD_SECRET!,
  router: t.router({
    videos: t.videos.handler({
      onUploadRequested: ({ input, sessionId }) => ({ key: `albums/${input.albumId}/${sessionId}` }),
      onUploadCompleted: async ({ session }) => ({ mediaId: await db.media.create(session) }),
    }),
  }),
});
// mount: (req) => uploads.fetch(req, { user })   or   toNodeHandler(uploads, { context })

// client
const client = createUploadClient<typeof contract>({ baseUrl: '/api/upload', contract });
const task = client.videos.upload(file, { input: { albumId } });
const { mediaId } = await task.result;
```

## Packages

| Package | |
|---|---|
| [`@open-upload/core`](./packages/core) | Contract builder, errors, file rules, part planning, checksums. Zero dependencies. |
| [`@open-upload/s3`](./packages/s3) | One S3 adapter for every S3-compatible provider (providers are data); minimal SigV4 on Web Crypto (no AWS SDK). |
| [`@open-upload/server`](./packages/server) | Typed hooks, sealed tickets and receipts, Fetch handler, Node adapter. |
| [`@open-upload/client`](./packages/client) | The upload engine and the typed client. |
| [`@open-upload/react`](./packages/react) | `useUpload`, `useUploadTask`, `usePendingUploads`, `useDownload`. |
| [`@open-upload/convex`](./packages/convex) | Convex component: tracked uploads, reactive pending list, cross-device resume. |
| [`apps/web`](./apps/web) | Docs site and shadcn registry (Fumadocs, TanStack Start, Cloudflare via Alchemy). |

## Development

```bash
pnpm install
pnpm test                 # unit tests (all packages)
pnpm minio:up             # local S3 (Docker)
pnpm test:integration     # adapter + full stack against MinIO (and R2 / AWS when configured)
pnpm test:e2e             # Playwright: Chromium, WebKit, Firefox, iPhone, with fault injection
pnpm --filter @open-upload/web dev   # docs + registry on http://localhost:3000
```

Releases use [changesets](https://github.com/changesets/changesets): `pnpm changeset` in a PR; merging the generated
"Version Packages" PR publishes from a protected environment with npm trusted publishing. Go-live steps:
[docs/RUNBOOK.fr.md](./docs/RUNBOOK.fr.md); reference: [docs/OPERATIONS.md](./docs/OPERATIONS.md).

## Design records

[docs/BRIEF.md](./docs/BRIEF.md) (original request), [docs/DECISIONS.md](./docs/DECISIONS.md),
[docs/SPEC.md](./docs/SPEC.md), [docs/research](./docs/research), and the
[original design README](./docs/DESIGN-README.md).

## License

MIT
