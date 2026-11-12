# Research — prior art & DX inspirations

> Status: research notes, **not decisions**. Checked 2026-11-12. Versions come from `npm view <pkg> version time.modified` unless noted.
> **[unverified]** marks claims that could not be fully confirmed from the source.

## Summary table

| Project | Version (2026-11-12) | What to borrow | What to avoid |
|---|---|---|---|
| oRPC | `@orpc/*` 1.16.2 (latest), 2.0.0-beta.50 (beta, docs now describe v2) | contract = data + Standard Schema; `implement(contract)`; type-only client import; typed `.errors()`; one core `handle(request)` + per-runtime adapters | deep builder generics; shipping the full router to the client; coupling our wire format to theirs |
| UploadThing | `uploadthing` 7.7.4, `@uploadthing/react` 7.3.3 | `typeof router` typed client; middleware return → typed metadata; typed data returned from completion; progress granularity | hosted ingest + callback webhook; mandatory token/service; file-type keys mixed with config |
| better-upload (Nic13Gamer) | `@better-upload/server` & `/client` 3.0.20; legacy `better-upload` 2.0.3 | S3-direct BYO bucket; provider presets; shadcn registry `@better-upload` with headless `control` prop | **name collision**; no documented pause/resume/persistence |
| uploadcn | `@uploadcn/core` 0.1.5 (created 2026-10-09) | claims multipart resume after pause/drop/reload; shadcn `@uploadcn` (67 items) | storage location of resume state undocumented **[unverified]** |
| Alchemy | `alchemy` 2.0.0-beta.86 (v2 = rewrite on Effect 4.1.4) | small capability interfaces per provider; capability-scoped bindings; adopt/read semantics ≈ re-attach to existing multipart | Effect as a hard dependency of our core |
| TanStack | query 5.107.1, store 0.11.2, pacer 0.23.1, devtools 0.16.0 | framework-free core; `get/subscribe` store; `useSyncExternalStore` adapters ~50 lines; identity `queryOptions()` helper; devtools via event client | — |
| shadcn | CLI 4.23.0 | logic in npm, markup copied from a namespaced registry (`registry:ui`), headless control prop | — |
| Uppy | `@uppy/aws-s3` 6.3.1, golden-retriever 6.0.1 | ListParts reconciliation; "ghost" files needing reselection; IndexedDB metadata | Service-Worker file refs don't survive browser restart; 24 h default expiry |
| tus-js-client | 4.3.1 | `fingerprint()`, `urlStorage`, `findPreviousUploads()` / `resumeFromPreviousUpload()` | — |
| IETF resumable upload | draft-ietf-httpbis-resumable-upload-15 (2026-11-02) | offset-based resume protocol; possible future transport adapter | not S3-compatible; does not apply to presigned multipart |

## 1. oRPC — <https://orpc.dev> (was orpc.unnoq.com), <https://github.com/unnoq/orpc>

```ts
// shared/contract.ts
import { oc } from '@orpc/contract'
export const contract = { planet: { find: oc.input(z.object({ id: z.number() })).output(PlanetSchema) } }
// server
const os = implement(contract)              // .$context<{...}>()
export const router = os.router({ planet: { find: os.planet.find.use(requireAuth).handler(async ({ input }) => ...) } })
const handler = new RPCHandler(router)      // '@orpc/server/node', fetch, hono, express, ...
await handler.handle(req, res, { prefix: '/rpc' })
// client — type-only import
const link = new RPCLink({ url: 'http://127.0.0.1:3000/rpc' })
export const orpc: RouterContractClient<typeof contract> = createORPCClient(link)
```

- Naming differs between v1 (`ContractRouterClient`, `minifyContractRouter`, `.route()`) and v2 docs (`RouterContractClient`, `minifyRouterContract`, `.meta(openapi(...))`).
- Typed errors: `.errors({ RATE_LIMITED: { data: schema } })`, throw `errors.RATE_LIMITED({...})`, client `safe()` + `isDefinedError()` (<https://orpc.dev/docs/error-handling>).
- Routing without server code: the RPC protocol encodes the procedure path in the URL, so a type-only import is enough. Only `OpenAPILink` needs a (minified) runtime contract.
- Adapters: Node, Fetch, Express, Fastify, Hono, Elysia, H3, Next, Nuxt, SvelteKit, SolidStart, TanStack Start, Astro, Workers, Lambda, WebSocket, message-port.
- TanStack Query: `createTanstackQueryUtils(client)` → `.queryOptions({ input })`. Effect: optional `@orpc/effect`.

## 2. UploadThing — <https://docs.uploadthing.com>, <https://github.com/pingdotgg/uploadthing> (MIT)

```ts
const f = createUploadthing()
export const uploadRouter = {
  avatar: f({ image: { maxFileSize: '2MB', maxFileCount: 1 } }, { awaitServerData: true })
    .input(z.object({ foo: z.string() }))
    .middleware(({ req }) => auth(req))                 // return → metadata
    .onUploadComplete(({ metadata, file }) => ({ foo: 'bar' as const })), // typed to client
} satisfies FileRouter
export const { GET, POST } = createRouteHandler({ router: uploadRouter })   // needs UPLOADTHING_TOKEN
export const { useUploadThing } = generateReactHelpers<typeof uploadRouter>()
```

- Resume: `createUpload` exposes `pauseUpload` / `resumeUpload` while the presigned URL is valid; protocol HEAD `x-ut-range-start` + ranged PUT. **No documented cross-reload persistence.**
- Vendor lock: dashboard token, UploadThing ingest URLs, UploadThing calls back your server to run `onUploadComplete`. BYO bucket not documented.

## 3. better-upload (Nic13Gamer) — **name collision**

- Repo <https://github.com/Nic13Gamer/better-upload> (MIT, ~1.3k stars, active 2026-10-19), site better-upload.com, docs <https://better-upload.com/llms-full.txt>.
- npm: `better-upload` 2.0.3 (legacy), `@better-upload/server` & `@better-upload/client` 3.0.20 → **the `@better-upload` npm scope is occupied.** shadcn namespace `@better-upload` is registered in the official index (upload-button, upload-dropzone, upload-progress, paste-upload-area).

```ts
const router: Router = {
  client: aws(), bucketName: 'my-bucket',   // presets: cloudflare, tigris, backblaze, digitalOcean, wasabi, minio, custom
  routes: { images: route({
    fileTypes: ['image/*'], multipleFiles: true, maxFiles: 4, maxFileSize: 4 * 1024 * 1024,
    clientMetadataSchema, signedUrlExpiresIn: 120, multipart: true, partSize: 20 * 1024 * 1024,
    onBeforeUpload: async ({ req, files, clientMetadata }) => ({ generateObjectInfo: ({ file }) => ({ key: ... }) }),
  }) },
}
export const { POST } = toRouteHandler(router)
// React
const { upload, progresses, isPending, control } = useUploadFiles({ route: 'images', api: '/api/upload', retry })
```

- Multipart: yes (`multipart: true`). Pause / resume / persistence: **none documented** (searched docs for pause, resum, persist, indexeddb, localStorage). Route name typed as `string` in docs **[source types not checked]**. React only.
- Other uses of the name: Drupal module "BetterUpload". Trademarks and domains not checked.

### npm name probes (404 = not published; does not prove scope/org is free)

| free (404) | taken |
|---|---|
| `@upkit/core`, `relay-upload`, `ferry-upload`, `uplift-upload`, `betterupload`, `better-uploads` (too close anyway), `@bu-draft/core` (placeholder used in this repo) | `resumable`, `upkit`, `haul`, `carryall`, `chunkwise`, `@better-upload/*` |

## 4. Alchemy v2 — <https://alchemy.run>, <https://github.com/alchemy-run/alchemy>

- v2 is a rewrite on Effect ("Infrastructure as Effects"): `Alchemy.Stack('app', { providers, state }, ...)`, resources declared without `await`, `bindings` → `env` with `InferEnv`. The v1 repo is now `alchemy-run/alchemy-async`.
- Provider = Effect Layer implementing `reconcile` + `delete` (+ optional `diff`, `read`). Bindings grant permission + config + typed client in one call (`Cloudflare.R2.ReadWriteBucket(Uploads)`).
- Takeaway: small capability interfaces per provider package, capability-scoped clients, "adopt/read" as model for re-attaching to an existing upload. Effect stays optional (plain Promise core, optional Effect package — oRPC precedent).

## 5. TanStack — core + thin adapters

- React Query: `new Observer(client, options)` once, `useSyncExternalStore(cb => observer.subscribe(...), () => observer.getCurrentResult())`, property tracking to limit re-renders. `queryOptions()` is identity (inference only).
- `@tanstack/react-store` `useSelector(source, selector)` accepts any `{ get(); subscribe() }`.
- Pacer: core + adapters for React/Preact/Solid/Angular/Vue/Svelte/Lit; devtools through `@tanstack/devtools-event-client`.

## 6. shadcn registry — <https://ui.shadcn.com/docs/registry>

- `registry.json` (name, homepage, items), `registry-item.json` (type `registry:ui|block|component|hook|lib|...`, dependencies, registryDependencies, files, cssVars, ...). `shadcn build` → `public/r/<name>.json`.
- Namespaces in `components.json`: `"registries": { "@acme": "https://…/{name}.json" }` → `npx shadcn add @acme/upload-dropzone`. Official index lists upload namespaces `@better-upload`, `@uploadcn`, `@elements`, `@utilcn`, `@mediadrop`, `@kinematic`.
- Pattern: headless logic in npm, stylable markup copied via registry, components take a `control`/`task` object from the hook.

## 7. Resume references

- **Uppy `@uppy/aws-s3`** (<https://uppy.io/docs/aws-s3/>): multipart above 100 MiB, `getChunkSize`, `limit` 6, one `signRequest` for every op; resume via ListParts (needs `s3:ListMultipartUploadParts`). **Golden Retriever**: IndexedDB metadata (+ small files ≤ 10 MiB), optional Service Worker file refs (survive refresh, not browser restart), `expires` 24 h, "ghost" files to reselect.
- **tus-js-client** (<https://github.com/tus/tus-js-client/blob/main/docs/api.md>): `fingerprint`, `urlStorage`, `findPreviousUploads()` / `resumeFromPreviousUpload()`, `retryDelays [0,1000,3000,5000]`, experimental `protocol: 'ietf-draft-05'`.
- **IETF draft-ietf-httpbis-resumable-upload-15** (<https://datatracker.ietf.org/doc/draft-ietf-httpbis-resumable-upload/>): `Upload-Complete`, `104 Upload Resumption Supported`, `Upload-Limit`, HEAD → `Upload-Offset`, PATCH `application/partial-upload`, 409 on wrong offset. Not usable directly with S3 presigned multipart; a possible future transport.
