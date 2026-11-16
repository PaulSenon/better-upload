# Site deploy: previews and production on Cloudflare

How the docs + shadcn registry site (`apps/web`) reaches Cloudflare. This is the common delivery standard shared with
WebMCP SDK (`webmcp-sdk-docs*`, same Cloudflare account). The code is vendored from it: `infra/site` is WebMCP's
`infra/docs`, adapted to a site that has a Worker script.

**Status (2026-11-16):** implemented and tested without credentials. It has never deployed to Cloudflare, because no
account is connected yet. Section 7 lists what is tested and what is not.

## 1. The two workflows

```
pull_request (opened, synchronize, reopened, ready_for_review, converted_to_draft, closed) / push main
        │
        ▼
 site.yml  ── job `site-build`: NO secret, contents: read, no cache
        │     pnpm build:worker  → apps/web/dist/deploy = assets/ + server/ (Worker modules)
        │     check-site · local workerd smoke test (alchemy dev) · artifact site-<stage> + manifest.json
        ▼  (run completed)
 site-deploy.yml  ── definition always from main (workflow_run / schedule / dispatch)
        plan      PR resolved from the API (head SHA + same repo), open / not draft / head == SHA,
                  gate: every required check of that exact SHA green
        deploy    environment site-preview / site-production (branch policy: main only)
                  validated artifact → `alchemy deploy` of the PREBUILT files (bundle: false)
                  smoke test, then re-check the PR (destroy if closed/drafted meanwhile)
        teardown  PR closed, merged or converted to draft → destroy pr-<n> (idempotent)
        report    one stable PR comment (<!-- better-upload-site-preview -->) + commit status
        sweep     Mondays 04:17 UTC (+ dispatch): destroy pr-<n> stages whose PR is closed/draft/gone
```

**Why two workflows.** `alchemy deploy` with `Cloudflare.Website.Vite` runs `vite build` itself, so a deploy job
would execute PR code with the Cloudflare token. Here the build runs in `site.yml`, with no secret.
`site-deploy.yml` only uploads the result, through `Cloudflare.Worker({ main, bundle: false, assets })`: the files
are uploaded byte for byte, and no code of the site runs. `workflow_run`, `schedule` and `workflow_dispatch` always
use the default branch's definition, so a PR cannot edit what runs with secrets. On top of that, both environments
only release secrets to `refs/heads/main`.

**Untrusted data.**
- The deploy job takes only the run id from the event. It reads the run, the PR and the head of main back from the
  API.
- It extracts the artifact with a validating unzip: no symlink, no `..` or absolute path, bounded size and count.
- The manifest must equal the recomputed values.
- `check-site` refuses unexpected files, credentials-looking names, and a Worker over the 3 MiB (gzip) Free limit.
- Only `infra/site`'s dependencies are installed, from main's frozen lockfile, without cache.

| Stage | Worker | State store | When |
|---|---|---|---|
| `production` | `better-upload-site` | `better-upload-site-state` | push to main (only if the SHA is still the head of main), or rollback |
| `pr-<n>` | `better-upload-site-pr-<n>` | `better-upload-site-preview-state` | `SITE_PREVIEW_MODE=dynamic` |
| `staging` | `better-upload-site-staging` | `better-upload-site-preview-state` | `SITE_PREVIEW_MODE=staging` (default): one shared preview, last PR wins |

Previews are never created for:
- **forks**;
- **Dependabot** PRs, which are built only, unless `SITE_PREVIEW_DEPENDABOT=true`.

The registry follows the preview at `<preview URL>/r/<item>.json`, so `npx shadcn add` can be tried from any PR.

## 2. GitHub settings (to apply once the PR is merged)

**Environments** (Settings → Environments → New environment):

| Environment | Deployment branches and tags | Reviewers | Secrets |
|---|---|---|---|
| `site-production` | *Selected branches and tags* → add branch rule `main` (nothing else) | optional | `CLOUDFLARE_API_TOKEN` (production token), `CLOUDFLARE_ACCOUNT_ID`, `SITE_STATE_TOKEN` (`better-upload-site-state.token`) |
| `site-preview` | same: branch `main` only | optional (see §5) | `CLOUDFLARE_API_TOKEN` (preview token), `CLOUDFLARE_ACCOUNT_ID`, `SITE_STATE_TOKEN` (`better-upload-site-preview-state.token`) |
| `npm-release` | branches `main` and `next` | none | none (OIDC) |
| `release-finalize` | branches `main` and `next` | **required: the owner** | none |
| `integration-providers` | branch `main` only | none | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (keys scoped to one test bucket) |

`preflight` (run before every Alchemy call with a token) refuses a preview token that can reach production, unless
the environment is main-only or has a reviewer. It reads the policy through the API.

**Repository variables:**
- `SITE_DEPLOY_ENABLED=true` (kill switch);
- `SITE_WORKERS_SUBDOMAIN=<account subdomain>`;
- `SITE_PREVIEW_MODE=staging|dynamic`;
- optional: `SITE_PREVIEW_DEPENDABOT`, `PROVIDER_TESTS_ENABLED=true` (plus `R2_ACCOUNT_ID`, `R2_BUCKET`, `AWS_REGION`,
  `AWS_BUCKET`), `NPM_RELEASE_ENABLED=true` (docs/RELEASING.md).

**Branch ruleset on `main`:**
- require a PR;
- require these status checks: `check`, `integration`, `convex`, `e2e (chromium)`, `e2e (firefox)`, `e2e (webkit)`,
  `e2e (mobile-safari)`, `workflow-lint`, `site-build`;
- block force pushes.

The deploy gate uses the same list (`infra/site/src/gate.ts`). Only check runs created by GitHub Actions count.

## 3. Tokens (one Cloudflare account, shared with WebMCP)

All tokens are account-owned (*Manage Account → API Tokens*), custom, with an expiration. CI needs no zone
permission and no Secrets Store permission: state goes over HTTPS with the store's bearer token.

| Token | Permissions | Lifetime |
|---|---|---|
| `site-bootstrap-temp` | Workers: Admin (All Workers) + Account Secrets Store: Edit | 1 day, deleted right after §4 |
| `github-site-production` | Workers · Specified Workers: `better-upload-site` · Editor | 1 year |
| `github-site-staging` (mode `staging`) | Workers · Specified Workers: `better-upload-site-staging` · Editor | 1 year |
| `github-site-preview-dynamic` (mode `dynamic`) | Workers: Admin (All Workers) | 1 year |

**Residual risk (single account).**
- A dynamic-mode preview token can modify or delete every Worker of the account. That includes this production,
  its state stores, and WebMCP's `webmcp-sdk-docs*` Workers; WebMCP's dynamic token can do the same here. Worker
  names are conventions, not an access boundary.
- Mitigations:
  - the token is reachable only from main-defined jobs, through a main-only environment;
  - each repository has its own token, so each can be revoked separately;
  - the token expires after one year;
  - a reviewer can be required on `site-preview`.
- Mode `staging` has no such risk: its token is Editor on one Worker.

## 4. One-time bootstrap (owner + agent, about 20 min)

1. In Cloudflare, enable the workers.dev subdomain once: *Workers & Pages → Overview*.
2. Create `site-bootstrap-temp` (§3), save it to a file (`chmod 600`), and note the account ID.
3. Run:

   ```bash
   pnpm install
   node infra/site/scripts/bootstrap.ts --account-id <id> --token-file <file> --out-dir <private dir> [--subdomain <name>]
   ```

   The script:
   - verifies the token;
   - creates the two state stores if absent, and writes their bearer tokens to `<private dir>/*.token` (mode 0600);
   - creates `better-upload-site` and `better-upload-site-staging` with a placeholder page, only if they are absent;
   - prints the remaining commands.

   `--check` only reads.
4. Create the CI tokens of §3, then set the secrets of §2 with `gh secret set … --env … < file`, then the variables.
5. Delete `site-bootstrap-temp` and every token file.
6. `gh variable set SITE_DEPLOY_ENABLED --body true`. The next push to main deploys production.

## 5. Owner decision: approval on previews

With `site-preview` restricted to `main`, PR code cannot read its secrets, so a required reviewer is optional.

- **Recommended:** no reviewer, for the "Vercel" experience: a preview appears once the checks are green.
- **Alternative:** keep a reviewer as an extra human lock. Each preview then waits for a click in Actions.

## 6. Operations

- **Rollback.** Actions → `site-deploy` → *Run workflow* → `rollback_run_id` = an older successful `site` run on main.
  That run's artifacts are kept 90 days, and the rollback passes the gate again. Alternatively, use the Cloudflare
  dashboard → Workers → `better-upload-site` → Deployments → Rollback.
- **Manual teardown:** `destroy_preview = <PR number>`.
- **Sweep now:** `sweep_previews = true`.
- **Local:**
  - build: `pnpm --filter @open-upload/web build:worker`;
  - check: `SITE_DIST_DIR=$PWD/apps/web/dist/deploy pnpm --filter @open-upload/site-infra check:local`, which serves
    the prebuilt Worker in workerd and runs the smoke test;
  - dev: `pnpm --filter @open-upload/web dev`, or `dev:workerd` (local state only; `apps/web/alchemy.run.ts`
    refuses non-local stages).

## 7. Tested vs not tested

**Tested locally (2026-11-16, no credentials):**
- the real site built by `build:worker` (5 s; 80 modules, about 0.95 MB gzip of the 3 MiB limit);
- served from `dist/deploy` by `alchemy dev` (workerd, `bundle: false`), where the smoke test passes:
  - home byte-identical, with the security headers;
  - 404;
  - `/r/*.json` served as JSON;
  - `/llms.txt` answered by the Worker script;
  - `/docs/` redirected to `/docs`;
  - hashed asset immutable;
- 76 unit tests of plan, gate, PR resolution, stage, isolation, unzip, comment, sweep and smoke, plus 8 release
  tests;
- actionlint 1.7.12 and zizmor 1.32.0 pedantic: clean.

**Not tested** (needs the account, §4):
- a real `alchemy deploy` / `destroy`;
- per-Worker Editor tokens on a Worker *with a script*. WebMCP verified the endpoints for assets-only Workers; the
  script upload endpoint documents the same roles;
- the HTTP state stores;
- PR comments and statuses on a real PR;
- the sweep against real state.

**Known limit:** the `_headers` rules (CSP, HSTS, noindex on previews) apply to static responses only. Responses
the Worker script renders itself (`/llms.txt`, search, non-prerendered pages) do not get them.
