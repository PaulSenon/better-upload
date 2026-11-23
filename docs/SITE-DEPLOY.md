# Site deploy: previews and production on Cloudflare

This page covers how the docs + shadcn registry site (`apps/web`) reaches Cloudflare. The pipeline is the
**Monorepo Delivery Kit**, vendored at the version in [`.delivery-kit-version`](../.delivery-kit-version) (site name
`site`), and configured in [`delivery.config.json`](../delivery.config.json). It is the standard shared with WebMCP
SDK, on the same Cloudflare account.

- **Kit documentation (reference):** in the kit repository at that tag: `docs/contract.md`, `docs/bootstrap.md`,
  `docs/limits.md`, `docs/updating.md`.
- **Updating:** diff against a newer kit tag, re-run `scripts/vendor.mjs`, and keep the lines marked `local:`
  (§7).

**Status (2026-11-16):** vendored and tested without credentials. It has never deployed to Cloudflare, because no
account is connected yet (§8).

## 1. The pipeline

```
pull_request (opened, synchronize, reopened, closed) / push main
        │
        ▼
 site.yml  ── job `site-build`: no secret, contents: read
        │     pnpm site:build (SITE_URL = this stage's URL) → apps/web/dist/deploy = assets/ + server/server.js
        │     write-manifest · check-artifact · local workerd smoke test (smokePaths) · artifact `site`
        │     (on `closed`: only the no-op `lifecycle` job)
        ▼  (run requested / completed)
 site-deploy.yml  ── definition always from main (workflow_run / schedule / dispatch)
        deploy-plan        no secret: run read back by id, PR resolved from the API (exact head, same repo)
        deploy-notify      PR comment progress states (waiting for the build, deploying, build failed, fork/bot)
        deploy-preview     open PR, drafts included, gate = previews.gateChecks (`site-build`) green on the SHA;
                           environment site-preview (no reviewer): hardened unzip, manifest == recomputed target,
                           Cloudflare.Worker({ main: server/server.js, bundle: false, assets }), smoke,
                           re-check the PR after deploying (destroy if closed meanwhile)
        deploy-teardown    PR closed (merged or not) → destroy pr-<n> (idempotent)
        deploy-comment     one PR comment <!-- delivery-kit:better-upload:preview --> + status `site-preview`
        deploy-production  gate = previews.requiredChecks green on the SHA; environment site-production,
                           only if the SHA is still the head of main; rollback
        deploy-sweep       HOURLY + dispatch: removes previews whose PR is no longer eligible, reports
                           eligible PRs without one
```

**Why a build job and a separate deploy workflow.**
- PR code runs only in `site.yml`, which holds no secret.
- The deploy uploads the prebuilt files byte for byte (`bundle: false`) and never runs them.
- `workflow_run`, `schedule` and `workflow_dispatch` always use the default branch's definition, and the two
  environments release secrets to `main` only, so a PR cannot change what runs with the token.

**Names (kit, site `site`).**

| Stage | Worker | State store |
|---|---|---|
| `production` | `better-upload-site` | `better-upload-site-state` |
| `pr-<n>` | `better-upload-site-pr-<n>` | `better-upload-site-preview-state` |
| `staging` | `better-upload-site-staging` (optional) | `better-upload-site-preview-state` |

- **Previews (automatic, kit D13, decided 2026-11-22):**
  - one Worker per open PR, drafts included (`SITE_PREVIEW_MODE` = `dynamic`), deployed as soon as `site-build`
    is green on its head, without waiting for e2e/integration (those gate the merge and production);
  - no reviewer on `site-preview`;
  - forks never get one; Dependabot PRs are built only, unless `SITE_PREVIEW_DEPENDABOT=true`.
- **Headers:**
  - every static response carries `X-Delivery-Revision: main@<sha7>` or `pr-<n>@<sha7>`;
  - previews are `noindex`;
  - `/r/*` (the shadcn registry) is served with `Access-Control-Allow-Origin: *`: `no-cache` on previews, 5 min in
    production.

**This site specifically.**
- **`worker` kind:** search, `llms.txt` and `*.md` are server routes, so `server/server.js` is the prebuilt
  TanStack Start Worker, built by `apps/web/scripts/build-worker.ts`.
- **Registry URL per preview:** the preview's own origin is baked into the prerendered install commands
  (`SITE_URL`), so `npx shadcn add <preview>/r/<item>.json` works per PR.
- **Smoke paths:** `/`, `/docs`, `/docs/quick-start`, `/r/registry.json`, `/llms.txt` and `/api/search`.
- **Free plan limits:** 3 MiB of gzipped script; the site uses about 0.95 MB, and `check-artifact` warns near the
  limit. Static assets do not count against the 100,000 requests per day.
- **No bindings or secrets** on preview Workers.

## 2. GitHub settings

`node tooling/setup-github.mjs --repo PaulSenon/better-upload --reviewer <login> …` prints every call; add
`--apply` to run them. It creates the following:

| Kind | Name | Settings |
|---|---|---|
| Environment | `site-preview`, `site-production` | default branch only; no reviewer (previews are automatic; production reviewer only with `--production-reviewer`) |
| Environment | `npm-release` | `main`, `next`; no reviewer (stage mode: npm 2FA approval is the gate) |
| Environment | `release-finalize` | `main`, `next`; **required reviewer: the owner** |
| Env secrets | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `SITE_STATE_TOKEN` | in each site environment, with different values |
| Variables | `SITE_WORKERS_SUBDOMAIN`, `SITE_PREVIEW_MODE` | repository |
| Ruleset | `delivery-kit` | PR required; required checks `previews.requiredChecks` + `dependency-review`; no force push or deletion |

**By hand:**
- Dependency graph + Dependabot alerts (Settings → Code security): required by `dependency-review`. Already
  enabled on this repository (2026-11-16); `setup-github.mjs` also enables it (kit v0.1.5).
- `SITE_DEPLOY_ENABLED=true`: the owner's decision to turn deploys on.
- `NPM_RELEASE_ENABLED=true`: see RELEASING.md.
- The `cloud-tests` environment (main only; R2/AWS keys scoped to a test bucket) and `CLOUD_TESTS_ENABLED=true`.

Required checks (`previews.requiredChecks`: merge ruleset and production gate): `check`, `integration`, `convex`,
`e2e (chromium)`, `e2e (firefox)`, `e2e (webkit)`, `e2e (mobile-safari)`, `workflow-lint` and `site-build`. All of
them run on both PR and push, as the kit's gate rule requires. Preview gate (`previews.gateChecks`): `site-build`
only.

## 3. Tokens (one account, shared with WebMCP)

All tokens are account-owned and custom, with an expiration. CI needs no Secrets Store or zone permission: state
goes over HTTPS with each store's bearer token.

| Token | Permissions |
|---|---|
| temporary bootstrap token | Workers: Admin (All Workers) + Account Secrets Store: Edit. Lifetime 1 day; delete it after §4 |
| production | Workers · Specified Workers: `better-upload-site` · Editor |
| preview (`dynamic`) | Workers edit, account-wide |

**Residual risk** (kit `limits.md` L1). The dynamic preview token can modify or delete every Worker of the account,
including WebMCP's `webmcp-sdk-docs*`. It is reachable only from main-defined jobs, through a main-only environment;
each repository has its own token, and it expires within a year. `SITE_PREVIEW_MODE=staging`, with a token scoped
to `better-upload-site-staging`, avoids that risk.

## 4. One-time bootstrap

1. Enable the account's workers.dev subdomain once. Create the temporary token and save it to a file
   (`chmod 600`).
2. Run:

   ```bash
   node infra/site/scripts/bootstrap.ts --account-id <id> --token-file <file> --out-dir <private dir>
   ```

   It creates the state stores, writes their tokens to `<private dir>`, and creates `better-upload-site` with a
   placeholder page if it is absent. `--check` only reads.
3. Create the two CI tokens of §3.
4. Run `tooling/setup-github.mjs … --apply` with the token files and the state directory.
5. Delete the temporary token and every token file.
6. `gh variable set SITE_DEPLOY_ENABLED --body true`.

## 5. Previews are automatic

Decided 2026-11-22 (kit D13): no reviewer on `site-preview`. Its secrets are main-only, so PR code never sees
them; the remaining risk is the account-wide preview token (§3).

## 6. Operations

Actions → `site-deploy` → *Run workflow*, with one of these inputs:
- **`rollback_run_id`:** an older successful `site` run of a push to main;
- **`destroy_pr`:** tear down the preview of a PR number;
- **`sweep`:** run the reconciliation sweep now (it also runs hourly).

**Locally:**
- `pnpm site:build`;
- `pnpm --filter ./infra/site run check:local`: the real artifact served by workerd, then the smoke paths;
- `pnpm check:workflows`.

## 7. Divergences from the kit (kit v0.4.0)

**Project configuration (the kit's documented extension points, not patches):**
- `delivery.config.json`:
  - Worker `better-upload-site` and `serverEntry: server.js`;
  - `htmlHandling: drop-trailing-slash`, because the site's links have no trailing slash;
  - smoke paths, including `/api/search`, which replaces a static bare-import check;
  - `previews.requiredChecks` (merge ruleset + production gate) and `previews.gateChecks: ["site-build"]`
    (preview gate, written out although it is the default);
  - `site.headers`: CSP with `worker-src blob:` for the demo's hashing workers, HSTS, X-Frame-Options,
    Permissions-Policy, COOP, and immutable `/assets/*`.
- `ci.yml` is project-owned: `check`, `integration`, `convex`, the 4 `e2e`, `workflow-lint`, plus the kit's
  `dependency-review`.
- `cloud-tests.yml` is a project workflow for the R2/AWS tests:
  - it runs on push to main, weekly and on dispatch;
  - the job is gated off PR events, in the `cloud-tests` environment (main only), with `cache-mode: none`.
- `infra/site/test/local.test.ts` checks that the project's headers reach every stage.

**Divergences:**

| Where | What | Why | Status |
|---|---|---|---|
| `release.yml`, `tooling/release/` | WebMCP-model release, kept (`vendor.mjs` keeps an existing release); `cache-mode: none` added on `finalize` (kit W10) | the kit's release converges on WebMCP's | until kit v0.2.0 |
| `apps/web/scripts/build-worker.ts` | kept instead of the kit's `template/recipes/build-worker.ts` (derived from it). Same build and `browser`-condition fix; differs by passing `SITE_URL` to the site as `VITE_SITE_URL` (trailing slash removed) and a fixed `dist/deploy` instead of `SITE_OUT_DIR`; plugin name and quote style | the prerendered `npx shadcn add <origin>/r/…` commands must show each preview's own origin | permanent (project build) |

No vendored kit file carries a `local:` patch. Kit versions v0.1.4–v0.3.3 fixed every earlier one (v0.3.3: matrix job names in required checks, placeholder `serverEntry`):
- production `steps.fresh`;
- `local-check` scope and default artifact;
- `--ssr-fixture` values;
- comment concurrency;
- headers hook;
- portable tests;
- W4 for main-only environment jobs;
- the dependency graph in `setup-github`.

## 8. Tested vs not tested

**Tested locally (2026-11-16, kit v0.4.0 (1435531), no credentials):**
- `pnpm site:build` with a preview `SITE_URL`;
- `check-artifact` (180 files, server about 977 KiB gzip);
- `check:local`: the real artifact in workerd, with every smoke path 2xx including `/api/search`, `noindex`, and
  404 on an unknown path; then the kit's SSR fixture (`/api/hello`);
- 55 infra tests (kit + local) and 39 tooling tests (release + workflow invariants with mutations);
- actionlint 1.7.12, zizmor 1.32.0 pedantic, and `check-workflows` W1–W11: all clean.

**Not tested** (needs the account):
- a real deploy, destroy or sweep;
- the HTTP state stores;
- per-Worker Editor tokens on a Worker with a script;
- the comment and status on a real PR;
- `setup-github.mjs --apply`.
