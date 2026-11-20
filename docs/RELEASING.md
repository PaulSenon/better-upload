# Releasing `@open-upload/*`

This is the maintainer runbook, following the same model as WebMCP SDK (`tooling/release/` is vendored from it and
generalized to one fixed group of packages). The names are provisional.

Releases are **explicit**: nothing is published on push or merge. You start a release by hand, CI builds and
*stages* the tarballs, and a version only becomes installable when you approve it on npm with 2FA.

```
PRs with change notes ─► "Version packages" PR (version-pr.yml or pnpm changeset version) ─► merge
  ─► Actions › release › Run workflow (main, confirm_version)
  ─► plan → build (tests, pack each package once) → stage (OIDC, npm stage publish, no checkout)
  ─► YOU: approval checklist, then approve each staged package on npmjs.com (2FA)
  ─► YOU: approve the "release-finalize" environment in the run
  ─► finalize: npm bytes == built bytes → tag @open-upload/<pkg>@x.y.z + immutable GitHub release, per package
```

All public packages (`core`, `s3`, `server`, `client`, `react`, `convex`) share one version: they form a Changesets
`fixed` group. The `plan` job refuses a group whose versions differ.

## 1. Every pull request

A change to `packages/*` needs a change note: run `pnpm changeset`. Use `pnpm changeset --empty` for changes that
need no release. CI enforces this in the `check` job (step *Change note*,
`tooling/release/check-changeset.mjs`). While the version is `0.x`, breaking changes are `minor`.

## 2. Version PR

Two ways to open it:
- **`version-pr.yml`:** with `NPM_RELEASE_ENABLED=true`, it keeps a *Version packages* PR open on main. It has
  `contents` and `pull-requests` write, no npm identity, and installs with `--ignore-scripts`. A PR opened by
  `GITHUB_TOKEN` does not trigger CI, so close and reopen it before merging.
- **By hand:**

  ```sh
  git switch -c release/next main && git pull
  GITHUB_TOKEN=$(gh auth token) pnpm changeset version   # bumps all packages, writes CHANGELOG.md, deletes the notes
  git commit -am "Version packages x.y.z" && git push -u origin HEAD && gh pr create --fill
  ```

Review the CHANGELOG text: it becomes the GitHub release notes. CI checks that the version equals what the notes
compute and that the PR touches only manifests, CHANGELOGs and `.changeset/`. Then merge.

## 3. Release run

`gh workflow run release.yml --ref main -f confirm_version=x.y.z`, or from the Actions tab.

`plan` refuses any of these:
- another branch;
- a version mismatch;
- pending change notes;
- a missing CHANGELOG section;
- a version already on npm;
- an existing tag.

Dispatch **once**: a second dispatch replaces a pending one. To retry, use *Re-run failed jobs*.

## 4. Approval checklist (before approving on npm)

This is the step a compromised CI build cannot fake. For **each** package:

1. **The expected stage:** `npx --yes npm@11.21.2 stage list @open-upload/<pkg>` shows exactly the dispatched
   version and dist-tag.
2. **Same bytes as the run:** download it (`npm stage download <id>`), then run
   `openssl dgst -sha512 -binary <file> | base64`. With the `sha512-` prefix, it must equal the integrity shown in the
   `build` and `stage` summaries.
3. **Same contents as the source**, rebuilt independently on your machine:
   - check out the source SHA, then run `pnpm install --frozen-lockfile && pnpm build`;
   - pack the package with `(cd packages/<pkg> && pnpm pack --pack-destination /tmp/local)`;
   - compare with `node tooling/release/compare-tarballs.mjs <staged.tgz> /tmp/local/<file>.tgz`.

   Any difference: **reject** it (`npm stage reject <id>`).
4. **Approve:** `npm stage approve <id>` (2FA), or use the *Staged Packages* tab on npmjs.com.

Then, in the run: *Review deployments* → `release-finalize` → *Approve and deploy*.

## 5. Finalize

`finalize` runs `tooling/release/finalize.mjs` for each package. It checks that npm serves the same integrity, then
creates the tag `@open-upload/<pkg>@x.y.z` at the source SHA and an immutable GitHub release with `pkg.tgz` and
`release-manifest.json`. It is idempotent: when a package is not approved yet, it stops with a clear message, and
*Re-run failed jobs* continues once you have approved.

## 6. When things go wrong

Same table as WebMCP: [`webmcp-sdk/docs/releasing.md` §6](https://github.com/PaulSenon/webmcp-sdk/blob/main/docs/releasing.md).
In short:
- **Integrity mismatch:** this is an incident. Stop, and never retry blindly.
- **Rejected stage:** fix the problem and dispatch again (npm allows re-staging).
- **`finalize` failed:** re-run it.
- **Bad version published:** `npm deprecate` it, then move the dist-tag back and release a fix. Versions are
  immutable.
- **Unexpected tag or stage:** treat it as a compromise.

## 7. Prereleases

On a `next` branch, run `pnpm changeset pre enter next`, then dispatch on `next`: versions `x.y.z-next.N` go to the
dist-tag `next`. Run `pnpm changeset pre exit` before merging back.

## 8. One-time bootstrap (first publish)

npm only lets you configure a trusted publisher on a package that **exists**, and the config expires unless it
publishes within 2 days. So each package is created once by staging a code-free placeholder, which is then
**rejected**. None of our code is published outside CI, and the first real version has provenance.

| # | Step | Command | Expected |
|---|---|---|---|
| 0 | Create the npm org | https://www.npmjs.com/org/create → `open-upload` | you are owner |
| 1 | Log in | `npx --yes npm@11.21.2 login` | logged in |
| 2 | Preflight (read-only) | `node tooling/release/bootstrap.mjs check` | org role owner/admin, the 6 packages absent |
| 3 | Create the packages | `node tooling/release/bootstrap.mjs stage` | one stage ID per package |
| 4 | Reject the placeholders (2FA) | `node tooling/release/bootstrap.mjs reject <id> <id> …` | every package exists |
| — | *Steps 5–8 in one sitting (2-day expiry)* | | |
| 5 | Trusted publishers, stage-only (2FA) | `node tooling/release/bootstrap.mjs trust` | GitHub · `PaulSenon/better-upload` · `release.yml` · `npm-release`, stage publish only |
| 6 | First release | create the environments (docs/SITE-DEPLOY.md §2), set `NPM_RELEASE_ENABLED=true`, merge the version PR for `0.1.0`, then §3–5 | `0.1.0` with provenance, tags, releases |
| 7 | Lock down | npmjs.com → each package → *Settings → Publishing access* → *Require two-factor authentication and disallow tokens* | no token can publish |
| 8 | Log out | `npx --yes npm@11.21.2 logout` | session revoked |

Fallbacks:
- **`stage` refuses a package that does not exist yet:** publish the placeholder once by hand, then deprecate it
  after `0.1.0`.
- **The trust config expired:** run `npm trust revoke`, then step 5 again.
