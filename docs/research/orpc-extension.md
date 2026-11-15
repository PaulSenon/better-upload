# Research: could the SDK be an oRPC (v2) extension or plugin?

> Status: research notes, **not a decision**. Checked 2026-11-15. Sources: <https://orpc.dev/llms-full.txt>, the published `.d.ts` of
> `@orpc/{server,contract,client,openapi}@2.0.0-beta.50`, and `npm view`. **[unverified]** = could not be confirmed.
> This answers the owner's side question R1 (BRIEF addendum).

## Versions

- `@orpc/server`: `latest` = 1.16.2 (2026-11-06); `beta` = **2.0.0-beta.50** (2026-11-09). Betas began 2026-06-21, which makes about 50 betas in 5 months.
- The repo has moved to `github.com/middleapi/orpc`.
- v2 changes the wire format, so v1 links and v2 servers can't talk to each other (<https://orpc.dev/docs/migrations/from-v1>).

## oRPC v2 extension mechanisms

| Mechanism | Allows | Source |
|---|---|---|
| Handler plugins (`StandardHandlerPlugin`) | Server request handling: CORS, Batch, headers, limits, timeout | <https://orpc.dev/docs/plugins> |
| Link plugins and interceptors | Client-side retry, dedupe, batch, timeout | <https://orpc.dev/docs/client/client-side> |
| Middleware | Typed context, with access to `procedure` and `path` | <https://orpc.dev/docs/middleware> |
| Meta plugins (`defineMeta`) | Typed per-procedure metadata. Our file rules and resume policy could travel this way. | <https://orpc.dev/docs/metadata> |
| "Extensions" (side-effect import patching a prototype, plus `declare module`) | Add builder methods (`.route()`, `.effect()`). Only used by first-party packages; not documented for third parties **[unverified]**. | <https://orpc.dev/docs/openapi/routing#route-extension> |
| Integration packages wrapping the user's client | e.g. `createTanstackQueryUtils(client)` | <https://orpc.dev/docs/integrations/tanstack-query> |

- **No new procedure *kind*.** `RouterContract = AnyProcedureContract | { [k]: RouterContract }`, so `oc.upload()` can't exist as a first-class kind.
- **One entry → several procedures.** Possible as a plain nested router `{ init, sign, status, complete, abort }`.
- **Native `File` / `Blob` support** sends the bytes **through your server** in a single request, with `TmpFileUploadHandlerPlugin` spooling them to disk. That is the opposite of resumable direct-to-bucket multipart (<https://orpc.dev/docs/binary-data>).
- **Upstream:** issue #482 ("Better File Upload… TUS") is still open. The maintainer has said "could be implemented as a plugin" (<https://github.com/middleapi/orpc/issues/482>).
- **Precedents:**
  - There is no third-party oRPC upload library (npm search, 2026-11-15).
  - tRPC accepts `FormData` and `File` through the server, with no resume (<https://trpc.io/docs/server/non-json-content-types>).
  - UploadThing looks like an RPC framework but depends on none (<https://docs.uploadthing.com/file-routes>).

## Options

| | A. Standalone (current draft) | B. oRPC-native only | C. Standalone core + optional `orpc` adapter |
|---|---|---|---|
| Users who don't use oRPC | ✅ | ❌ excluded | ✅ |
| DX for oRPC users | Two routers and two middleware stacks | ✅ one router, reuse auth middleware, OpenAPI and plugins | ✅ same as B |
| Coupling and version risk | None | High (v2 is still beta, wire format changed) | Contained to the adapter |
| Typing | Full control | Generic over oRPC implementer internals **[stability unverified]** | Full control in the core; adapter is a thin mapping |
| Stateful client engine | Ours | Ours (oRPC only carries the small JSON control calls; bytes go XHR → bucket) | Ours, through a `ControlTransport` interface |

Sketch for B/C, using only public oRPC APIs:

```ts
export const uploadContract = (d) => ({
  init:     oc.meta(uploadMeta(d.files, d.resume)).input(InitIn(d.input)).output(InitOut).errors(d.errors),
  sign:     oc.input(SignIn).output(SignOut),
  status:   oc.input(StatusIn).output(StatusOut),
  complete: oc.input(CompleteIn).output(d.output).errors(d.errors),
  abort:    oc.input(AbortIn).output(z.void()),
})
const os = implement({ media: { avatar: uploadContract({...}) } }).$context<Ctx>()
os.router({ media: { avatar: uploadRouter(os.media.avatar.use(requireSession), { storage, authorize, key, onComplete }) } })
const up = createUploader(orpcClient.media.avatar, { store: indexedDBStore() })
```

## Recommendation (proposal): C, in two steps

1. **Keep the standalone core,** with oRPC-flavoured naming (owner likes the style, Q3). Design two seams now:
   - a pure **op service** `{ init, sign, status, complete, abort }`;
   - a client **`ControlTransport`** interface.

   Keep every op's input and output as plain JSON, and make `complete` and `abort` idempotent, so oRPC Retry, Batch and OpenAPI work unchanged.
2. **Ship an `orpc` adapter (~200 LOC) once oRPC v2 is stable,** with peer dependency `^2`. Until then, provide a docs recipe.
3. **Don't patch oRPC prototypes** to get `oc.upload()`. A plain `uploadContract({...})` function gives the same result.

A reviewer's note to weigh: if oRPC users get real middleware through the adapter, the standalone core could ship a *smaller* middleware/context system than the draft. This is a trade-off between core size and standalone DX, and it is still open.
