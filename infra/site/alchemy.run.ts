// Site infrastructure (Alchemy v2): one Cloudflare Worker per stage, all in one Cloudflare account
// (shared with webmcp-sdk-docs*: names are conventions, not a security boundary).
//
//   production -> Worker "better-upload-site"          state store better-upload-site-state          (CI, main)
//   staging    -> Worker "better-upload-site-staging"  state store better-upload-site-preview-state  (CI, PRs, mode staging)
//   pr-<n>     -> Worker "better-upload-site-pr-<n>"   state store better-upload-site-preview-state  (CI, PRs, mode dynamic)
//   anything else (default live_$USER / dev_$USER) -> local stages, local state in .alchemy/
//
// The Worker is deployed PREBUILT: apps/web `pnpm build:worker` (an unprivileged CI job, no
// credential) produces dist/ = assets/ (static, prerendered) + server/ (ES modules, entry
// server.js). This stack only uploads those files (`bundle: false`); it never runs `vite build` or
// any code of the site. Runbook: docs/SITE-DEPLOY.md.
//
// State (SITE_STATE):
//   local       (default) local files. A local deploy can never touch remote state.
//   http        CI: the stage's state-store Worker over HTTPS with its bearer token
//               (SITE_STATE_TOKEN, one GitHub environment secret per store). No Cloudflare API
//               permission at all is needed for state, in particular no Secrets Store access.
//   cloudflare  bootstrap/admin only: Alchemy's own Cloudflare.state(), which deploys/upgrades the
//               store and reads its token through the account's Secrets Store.
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import { State, localState, makeHttpStateStore } from "alchemy/State";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { HttpClient } from "effect/http/HttpClient";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderHeadersFile } from "./src/headers.ts";
import { SERVER_ENTRY, checkSiteDir } from "./src/site-dir.ts";
import {
  STATE_STORES,
  assertRevision,
  isIndexable,
  isRemoteStage,
  stateStoreFor,
  stateStoreUrl,
  workerName,
  type StateStoreName,
} from "./src/stage.ts";

const mode = process.env.SITE_STATE || "local";
if (mode !== "local" && mode !== "http" && mode !== "cloudflare") {
  throw new Error(`SITE_STATE must be local, http or cloudflare, not ${JSON.stringify(mode)}`);
}
const remote = mode !== "local";
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || undefined;

// Remote state outside GitHub Actions is for the one-time bootstrap (scripts/bootstrap.ts) and
// inspection. `destroy` skips the stack program below, so its stage checks do not run: without
// this guard, `alchemy destroy --stage production` from a laptop would go through.
if (remote && !process.env.GITHUB_ACTIONS && process.env.SITE_ALLOW_LOCAL_REMOTE !== "1") {
  throw new Error(
    `SITE_STATE=${mode} is reserved for CI. For a deliberate local operation on remote state ` +
      "(bootstrap, state list, emergency), also set SITE_ALLOW_LOCAL_REMOTE=1.",
  );
}

// Which store: named explicitly, and checked against the stage in the program below.
const store = (process.env.SITE_STATE_STORE || undefined) as StateStoreName | undefined;
if (remote && !Object.values<string>(STATE_STORES).includes(store ?? "")) {
  throw new Error(`SITE_STATE_STORE must be one of ${Object.values(STATE_STORES).join(", ")}`);
}

function httpState(name: StateStoreName) {
  const token = process.env.SITE_STATE_TOKEN;
  const subdomain = process.env.CLOUDFLARE_WORKERS_SUBDOMAIN;
  if (!token) throw new Error("SITE_STATE_TOKEN is required with SITE_STATE=http");
  if (!subdomain) throw new Error("CLOUDFLARE_WORKERS_SUBDOMAIN is required with SITE_STATE=http");
  // Same shape as Alchemy's own localState(): capture the HttpClient from the stack's services.
  return Layer.effect(
    State,
    Effect.gen(function* () {
      const context = yield* Effect.context<HttpClient>();
      const make = makeHttpStateStore({ url: stateStoreUrl(name, subdomain), authToken: token, id: "cloudflare-http" });
      return yield* Effect.cached(make.pipe(Effect.provideContext(context)));
    }),
  );
}

// The built site: apps/web `pnpm build:worker` output (dist/deploy) by default; CI passes the downloaded artifact.
const distDir = process.env.SITE_DIST_DIR || fileURLToPath(new URL("../../apps/web/dist/deploy", import.meta.url));

/** Keep in sync with apps/web/scripts/build-worker.ts (the date the modules were built for). */
export const COMPATIBILITY_DATE = "2026-11-01";

export default Alchemy.Stack(
  "better-upload-site",
  {
    providers: Cloudflare.providers(),
    state:
      mode === "http"
        ? httpState(store!)
        : mode === "cloudflare"
          ? // accountId pins the store: credentials for another account fail instead of using it.
            Cloudflare.state({ workerName: store!, accountId })
          : localState(),
  },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    if (isRemoteStage(stage) !== remote) {
      return yield* Effect.die(
        new Error(
          remote
            ? `stage ${stage} is local-only; remote state is for "production", "staging" and "pr-<n>"`
            : `stage ${stage} must be deployed by CI (remote state); use a personal stage locally`,
        ),
      );
    }
    if (remote && stateStoreFor(stage) !== store) {
      return yield* Effect.die(
        new Error(`stage ${stage} must use state store ${stateStoreFor(stage)}, not ${store}`),
      );
    }
    if (remote && !accountId) {
      return yield* Effect.die(new Error("CLOUDFLARE_ACCOUNT_ID is required with remote state"));
    }

    const report = checkSiteDir(distDir);
    for (const warning of report.warnings) yield* Effect.logWarning(warning);

    const indexable = isIndexable(stage);
    const revision = !indexable && process.env.SITE_REVISION ? assertRevision(process.env.SITE_REVISION) : undefined;
    const main = join(distDir, "server", SERVER_ENTRY);
    const hasServer = existsSync(main);

    const site = yield* Cloudflare.Worker("Site", {
      name: workerName(stage),
      // Uploaded byte for byte: every .js module under server/ (entry server.js). No bundling, no
      // build, no code of the site executed here. Without server/ (bootstrap placeholder): assets only.
      ...(hasServer ? { main, bundle: false } : {}),
      assets: {
        directory: join(distDir, "assets"),
        // /docs/storage serves docs/storage/index.html, and /docs/storage/ redirects to it: the
        // site's links never end with a slash.
        htmlHandling: "drop-trailing-slash",
        // Unmatched paths go to the Worker (which renders its 404); assets-only: plain 404.
        ...(hasServer ? {} : { notFoundHandling: "none" as const }),
        // Owned here; overrides any _headers / _redirects in the build output.
        headers: renderHeadersFile({ indexable, ...(revision ? { revision } : {}) }),
        redirects: "",
      },
      // Stable workers.dev URL only: per-version preview URLs would keep every old build public.
      workersDev: { enabled: true, previewsEnabled: false },
      observability: { enabled: true },
      logpush: false,
      // nodejs_compat is on by default from 2026-08-04 (the modules were built for it).
      compatibility: { date: COMPATIBILITY_DATE },
    });

    return { stage, worker: workerName(stage), url: site.url, files: report.files, server: hasServer };
  }),
);
