# Proposal: contributing to oRPC issue #482 (direct-to-bucket resumable uploads)

> Status: DRAFT, not posted. Owner must approve before posting.

Checked 2026-11-15 against `middleapi/orpc` on GitHub and the published `.d.ts` of `@orpc/{server,contract,client}@2.0.0-beta.50`.
Background: [`../research/orpc-extension.md`](../research/orpc-extension.md). Priority: low.

## 1. Findings from the thread and the repo

**Issue [#482](https://github.com/middleapi/orpc/issues/482).** Title: "Better File Upload/Download operations in oRPC thanks to builtin integration of TUS". State: open, label `enhancement`. Opened 2025-05-09 by theoludwig, 11 comments.

- **Original ask:** a typed "tus route" callable from the oRPC client, with progress and resume like `tus-js-client`. The author says they "haven't thought about how it will work".
- **Maintainer, 2025-05-10** ([comment](https://github.com/middleapi/orpc/issues/482#issuecomment-2868233087)): no Base64; oRPC sends raw binary or multipart. "This feature could be implemented as a plugin. I'll make a note of it and evaluate the approach soon."
- **Community follow-ups:**
  - Docs should explain *why* files over 10 MB are "not recommended" and point to tus ([comment](https://github.com/middleapi/orpc/issues/482#issuecomment-2869681469)).
  - Questions about multi-file uploads and mixing JSON with files on one endpoint.
  - One user runs tus with Uppy next to tRPC/Fastify.
- **Maintainer, 2025-06-26:** points to "extend body parser" ([comment](https://github.com/middleapi/orpc/issues/482#issuecomment-3007814012)).
- **2026-07-22:** an off-topic OpenAPI multipart question. The maintainer asks for a separate issue.
- **Maintainer, 2026-08-15** ([comment](https://github.com/middleapi/orpc/issues/482#issuecomment-5301186079)): "In v2 we can use `TmpFileUploadHandlerPlugin` from `@orpc/node` to increase upload ability". So the current upstream answer is still **bytes through the server**, spooled to disk ([docs](https://orpc.dev/docs/plugins/tmp-file-upload)).
- **Gap:** nobody in the thread mentions **direct-to-storage**, presigned URLs or S3 multipart. Searching the repo for "presigned" returns 0 issues or PRs.

**Related issues**
- [#915](https://github.com/middleapi/orpc/issues/915) (open): an upload-progress plugin. A user works around it by hand-rolling XHR plus the RPC wire format.
- [#1397](https://github.com/middleapi/orpc/issues/1397): React Native `FormData` uploads (closed).
- [#1058](https://github.com/middleapi/orpc/issues/1058): returning `ReadableStream` (closed).

**Precedent that sets expectations: [#1892](https://github.com/middleapi/orpc/issues/1892) `@orpc/better-auth`**
- A contributor posted a full RFC in the issue after talking with the maintainer on Discord, then opened a PR.
- It was closed as *not planned* on 2026-11-01. The maintainer instead shipped a docs page, ["build your own integration with some lines of code"](https://orpc.dev/docs/integrations/better-auth).
- Signal: **docs recipes are preferred over new first-party packages** for integrations that compose public APIs.

**Process**
- There is no RFC process. Feature ideas go in issues (`2-feature-request.yml`), GitHub Discussions ("Ideas" category) or [Discord](https://discord.gg/TXEbwRBvQn).
- [CONTRIBUTING](https://github.com/middleapi/orpc/blob/main/CONTRIBUTING.md) asks for:
  - Conventional Commit PR titles, scoped by package, e.g. `docs(server): ...`;
  - every documented public API to carry a JSDoc `@see` backlink, enforced by `pnpm docs:validate`.
- The [Ecosystem page](https://orpc.dev/docs/ecosystem) takes PRs listing community packages (today: `orpc-mcp`, `orpc-angular`, `orpc-file-router`).
- v2 is gathering pre-stable feedback in Discussion [#2446](https://github.com/middleapi/orpc/discussions/2446). That makes now the window for small API asks.

**v2 beta.50 APIs, verified in the `.d.ts`**

| API | Where | Relevance |
|---|---|---|
| `RouterContract = AnyProcedureContract \| { [k]: RouterContract }` | `contract/router.d.ts` | There is no new procedure kind, but a nested sub-router works fine. |
| `oc.meta(...plugins: MetaPlugin[])`, `defineMeta(name, merge)` → `[plugin, getter]` | `contract/builder.d.ts`, `meta-utils.d.ts` | Typed upload rules on `init`. A `MetaPlugin` can also "infer or restrict procedure types" through `'~orpc'`. |
| `implement()`, exported types `Implementer`, `ImplementerWithMiddlewares` | `server/implementer*.d.ts` | Lets a library write a generic `uploadRouter(impl, opts)`. Whether these types are stable is **not documented**. |
| `.router(r)` → `AugmentedRouter` (merges errors/middleware) | `server/builder.d.ts` | Reuses the host's auth middleware. |
| `meta.path`, `createContractClientFactory(link)` | `contract/meta-built-in.d.ts`, `client-factory.d.ts` | Per-sub-router clients. |
| Prototype patch + `declare module '@orpc/server' { interface DecoratedProcedure … }` | `server/extensions/callable.*` | Only first-party code uses this. The docs only document augmenting `Registry` / `DefaultInitialContext`. |
| `TmpFileUploadHandlerPlugin` | `@orpc/node` | Through-server only. Complements our approach; doesn't replace it. |

## 2. Contribution options, ranked

1. **Docs recipe PR: "Direct-to-storage resumable uploads"** (highest chance of acceptance, about 1 day of work).
   - Where: a new `apps/content/docs/recipes/direct-to-storage-uploads.mdx`, plus one line in `binary-data.mdx` that answers the "why >10MB" question from #482.
   - Content:
     - when to bypass the server;
     - an S3 multipart sketch as a nested router;
     - idempotent `complete`/`abort`;
     - Retry plugin compatibility.
   - Uses public APIs only and adds no dependency. This matches the better-auth precedent.
2. **Community package plus an Ecosystem-page PR** (our optional `orpc` adapter, once v2 is stable).
   - No upstream approval needed.
   - Listing is one PR to `ecosystem.mdx`.
3. **Small generic core asks**, only if the maintainer shows interest:
   - (a) Document and stabilise the "reusable sub-router factory" pattern: contract fragment + implementation function generic over `ImplementerWithMiddlewares`. This would serve any multi-procedure capability: uploads, auth flows, webhooks, sagas.
   - (b) Say whether third-party builder extensions (`declare module` + prototype) are supported or discouraged.
   - (c) Clarify whether meta survives `minifyRouterContract` for client use, so a client can read `accept`/`maxSize` without a server round-trip. **[unverified]**
4. **First-party `@orpc/upload` package.** Least likely: it needs storage adapters and a client state engine, which is outside oRPC's scope, and #1892 suggests "not planned".

Recommended sequence:
1. Post the comment below.
2. If the maintainer approves, open PR 1.
3. Later, list the adapter (option 2).
4. Raise 3(a) in #2446 only if it's still relevant.

## 3. Draft comment for #482

````markdown
Hi! A data point and a concrete proposal for one slice of this issue: **large/resumable uploads that go straight to object storage**.

**Why through-server (even with `TmpFileUploadHandlerPlugin`) isn't always enough**
For multi-GB files from mobile (flaky networks, app backgrounding), you usually want:
- bytes to go browser → S3/R2/GCS directly (no server bandwidth/timeouts, works on serverless),
- resume after a drop without re-sending finished parts,
- progress per part.

tus solves resume, but bytes still flow through your server. S3-style **presigned multipart** gives both: the server only signs and finalizes, and the client PUTs parts directly.

**This already works with oRPC v2 today, with no new primitives**
An "upload" is just a nested router of small, plain-JSON procedures:

```ts
const uploadContract = {
  init:     oc.meta(uploadRules({ maxSize: '5GB', accept: ['video/*'] }))
              .input(z.object({ name: z.string(), size: z.number(), type: z.string() }))
              .output(z.object({ uploadId: z.string(), partSize: z.number() })),
  sign:     oc.input(z.object({ uploadId: z.string(), parts: z.array(z.number()) }))
              .output(z.object({ urls: z.record(z.string(), z.url()) })),
  status:   oc.input(z.object({ uploadId: z.string() }))
              .output(z.object({ done: z.array(z.object({ part: z.number(), etag: z.string() })) })),
  complete: oc.input(z.object({ uploadId: z.string(), parts: z.array(z.object({ part: z.number(), etag: z.string() })) }))
              .output(z.object({ key: z.string() })),   // idempotent
  abort:    oc.input(z.object({ uploadId: z.string() })).output(z.void()), // idempotent
}

// server: reuse your normal middleware for auth
const router = { media: { video: uploadRouter(os.media.video.use(requireSession), { storage: s3 }) } }

// client: a small state machine drives the control calls over the oRPC client
// and PUTs bytes to the presigned URLs with XHR/fetch (for progress), persisting state for resume.
const upload = createUploader(client.media.video)
```

Because each step is plain JSON, Retry, Batch, OpenAPI, typed errors and meta all work as-is. So I agree with your earlier note that this belongs *outside* core: it's a pattern, plus a library on top.

**Small upstream things that would make this first-class (all optional)**
1. **Docs:** a recipe "Direct-to-storage resumable uploads", plus a sentence in *Binary Data* saying when to bypass the server (this also answers the "why >10MB" question above). Happy to write the PR.
2. **Reusable sub-router factories:** confirm, and ideally document, that writing a function generic over `ImplementerWithMiddlewares` (contract fragment + implementation) is a supported pattern for libraries. This helps any multi-procedure feature, not just uploads.
3. **Third-party builder extensions:** a one-line policy on whether `declare module '@orpc/server'` plus prototype methods (like `.callable()`) are OK for community packages, or whether factories are preferred.

Which would you prefer: (a) just the docs recipe, (b) a recipe plus a community package listed on the Ecosystem page, or (c) something else you had in mind for the "plugin" approach? I'm glad to adapt to whatever fits oRPC best.

<!-- optional placeholder, owner decides: "We're prototyping this as a standalone library: <LINK>" -->
````

Notes before posting:
- Keep it to one comment.
- Don't tag the maintainer: they're subscribed as a commenter.
- Replace `uploadRules` with a real `defineMeta` plugin, or drop the `.meta()` call.
- Check that the code sketch still type-checks against the then-current v2 beta.
