# Operations: CI, releases, deployments

Everything automated is already in `.github/workflows/`. What is left needs accounts and secrets only the owner can
create. Each part is **off by default** and switches on with a repository variable.

## CI (`ci.yml`): active

On every PR and push to `main`:

| Job | What |
|---|---|
| Lint, types, unit tests, build | `biome ci`, `tsc` everywhere, vitest, tsdown builds, `publint` + `attw` on every package |
| Integration | Starts MinIO (Docker) and runs the adapter and full-stack tests. Also runs against R2 and AWS when configured (below). |
| E2E | Playwright on Chromium, WebKit, Firefox and iPhone 15 (WebKit), with the fault-injecting S3 proxy |
| Docs & registry build | Typecheck + prerendered build of `apps/web`, including `shadcn build` |

Optional real-provider integration tests (repository **variables** + **secrets**):

| Provider | Variables | Secrets |
|---|---|---|
| Cloudflare R2 | `R2_ACCOUNT_ID`, `R2_BUCKET` | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` |
| AWS S3 | `AWS_REGION`, `AWS_BUCKET` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` |

Use a dedicated test bucket with the CORS and lifecycle rule from `recommendedBucketConfig()`; tests write under a
unique `it-<run>/` prefix.

## npm releases (`release.yml`): off until `NPM_RELEASE_ENABLED=true`

Model: continuous integration on `main`, **controlled** releases.

1. A PR that changes a package includes a changeset (`pnpm changeset`).
2. On `main`, the workflow opens or updates a "Version Packages" PR (versions + changelogs).
3. Merging that PR publishes to npm from the protected `npm` environment, with provenance.

To enable:

1. Choose the final name and scope; replace `@open-upload/` everywhere (one search-and-replace), and the
   `changelog.repo` in `.changeset/config.json` if the repo moves.
2. Create the npm organization (scope).
3. For each package on npmjs.com, add a **Trusted Publisher**: GitHub Actions, this repository, workflow `release.yml`,
   environment `npm`. No npm token is stored anywhere. (First publish of a new package name may need a one-time manual
   publish or npm's "pending publisher" flow.)
4. GitHub → Settings → Environments → `npm`: add yourself as **required reviewer**, restrict to branch `main`.
5. Set the repository variable `NPM_RELEASE_ENABLED=true`.

## Docs + registry site (`deploy-site.yml`): off until `SITE_DEPLOY_ENABLED=true`

Cloudflare Workers via Alchemy v2 (`apps/web/alchemy.run.ts`). `main` deploys stage `prod`; each PR deploys
`pr-<number>` and destroys it when the PR closes.

To enable:

1. Cloudflare API token with Workers Scripts:Edit, Account Settings:Read, and Secrets Store:Edit (Alchemy keeps its
   state in Cloudflare so CI and laptops share it). Add secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
2. First deploy from a laptop to bootstrap the state store: `pnpm --filter @open-upload/web exec alchemy login` (or export
   the token), then `pnpm --filter @open-upload/web deploy -- --stage prod`.
3. GitHub environments `site-prod` (optionally with reviewers) and `site-preview`.
4. Optional: a custom domain (one line in `alchemy.run.ts`), then replace `<site>` in the docs install commands.
5. Set `SITE_DEPLOY_ENABLED=true`.

Docs and registry are one site, like ui.shadcn.com: pages under `/docs`, registry JSON under `/r/*.json`
(`npx shadcn add https://<site>/r/upload.json`). Splitting them later is a routing change, not a rewrite.

## Supply-chain hygiene

- Actions are pinned by commit SHA; workflows pass `actionlint` and `zizmor`.
- `pnpm-workspace.yaml` sets `minimumReleaseAge: 4320`: no dependency version younger than 3 days is installed.
- Packages publish with npm provenance; no long-lived npm token exists.
