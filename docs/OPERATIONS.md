# Operations: CI, releases, deployments

> **Step-by-step go-live guide (French): [RUNBOOK.fr.md](./RUNBOOK.fr.md).** This page is the reference.

Everything automated is already in `.github/workflows/`. What is left needs accounts and secrets only the owner can
create. Each part is **off by default** and switches on with a repository variable.

## CI (`ci.yml`): active

On every PR and push to `main`, with no secret (`permissions: {}` by default, read-only per job):

| Check (job name) | What |
|---|---|
| `check` | `biome ci`, `tsc` everywhere, unit tests (packages, `infra/site` deploy logic, `tooling/release` release logic), tsdown builds, `publint` + `attw`, change-note rule on PRs |
| `integration` | MinIO (Docker): adapter, full stack, conformance kit |
| `convex` | Convex component against an anonymous local backend + MinIO |
| `e2e (chromium\|firefox\|webkit\|mobile-safari)` | Playwright with the fault-injecting S3 proxy |
| `workflow-lint` | zizmor (pedantic) + actionlint |
| `dependency-review` | PR only: new vulnerable runtime dependencies (delivery kit) |
| `site-build` (`site.yml`) | Credential-free Workers build of `apps/web`, output checks, local workerd smoke test, artifact |

These names are the required checks of the branch ruleset and of the production deploy gate (`previews.requiredChecks`
in `delivery.config.json`); previews only wait for `site-build` (`previews.gateChecks`).

`cloud-tests.yml` (real R2 / AWS) runs on main only, on every push, on Tuesdays and on dispatch, when
`CLOUD_TESTS_ENABLED=true`. It is never triggered by a PR. Its keys live in the `cloud-tests` environment, restricted
to `main`. Use a dedicated test bucket with the CORS and lifecycle rule from `recommendedBucketConfig()`.

## npm releases (`release.yml`, `version-pr.yml`): off until `NPM_RELEASE_ENABLED=true`

Explicit, staged releases: dispatch → build and pack once (no identity) → `npm stage publish` via OIDC (no checkout,
pinned npm) → **your 2FA approval on npm** → `release-finalize` approval → tags and immutable GitHub releases.
Runbook and bootstrap: [RELEASING.md](./RELEASING.md).

## Docs + registry site (`site.yml`, `site-deploy.yml`): off until `SITE_DEPLOY_ENABLED=true`

Delivery kit (`.delivery-kit-version`, `delivery.config.json`). Unprivileged build, main-defined deploy of the
prebuilt Worker. Automatic previews (kit D13): one per open PR, drafts included, as soon as `site-build` is green on
the exact commit; stable PR comment; teardown on close or merge; hourly reconciliation sweep. Production from `main`
after every required check is green; rollback by run id. Settings, tokens, bootstrap, residual risk:
[SITE-DEPLOY.md](./SITE-DEPLOY.md).

Docs and registry are one site, like ui.shadcn.com: pages under `/docs`, registry JSON under `/r/*.json`
(`npx shadcn add https://<site>/r/upload.json`).

## Supply-chain hygiene

- Actions are pinned by commit SHA; workflows pass `actionlint` and `zizmor --persona=pedantic` (CI job `workflow-lint`).
- Dependabot (npm + actions) with a cooldown longer than the pnpm release-age policy.
- `pnpm-workspace.yaml` sets `minimumReleaseAge: 4320`: no dependency version younger than 3 days is installed.
- Packages publish with npm provenance through staged publishing; no long-lived npm token exists.
- No job holding a secret runs PR code or restores a cache.
