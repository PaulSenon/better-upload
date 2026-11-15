# Naming & collisions

> Status: **OPEN** (D-001). "Better Upload" is a provisional working name (brief P2). It does not block the repo.
> Checked 2026-11-12. This is not legal advice. Trademarks were not searched.

## Existing project "better-upload" — direct collision

| Asset                      | Owner / state                                                                                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm `better-upload`        | 2.0.3 (legacy), repo `Nic13Gamer/better-upload`                                                                                                           |
| npm scope `@better-upload` | **taken**: `@better-upload/server`, `@better-upload/client` 3.0.20 (2026-10-19)                                                                           |
| Domain                     | better-upload.com (docs, shadcn registry `https://better-upload.com/r/{name}.json`)                                                                       |
| shadcn namespace           | `@better-upload` is in the official registry index                                                                                                        |
| GitHub                     | `Nic13Gamer/better-upload`, MIT, ~1.3k stars, active                                                                                                      |
| Scope                      | "Simple and easy file uploads for React. Upload directly to any S3-compatible service." It has multipart, but no documented pause, resume or persistence. |

**Consequences:**

- We cannot publish under `@better-upload/*`.
- Using the same brand for an overlapping library would confuse users and could look like impersonation.
- The design code therefore uses the placeholder scope **`@bu-draft/*`**, which is not published and must never be.

## Other nearby names

- Drupal module "BetterUpload" (drupal.org/project/betterupload).
- `@betterstack/upload-client`: nearby, not a collision.
- **uploadcn** (`@uploadcn/*` 0.1.5, Oct 2026) overlaps our _pitch_ (resumable multipart and shadcn), not our name.

## npm probes (404 = no package published; does not prove the scope or org is free, nor that the trademark or domain is free)

Free: `relay-upload`, `ferry-upload`, `uplift-upload`, `betterupload`, `@upkit/core`.
Taken: `resumable`, `upkit`, `haul`, `carryall`, `chunkwise`.

## Round 2 (2026-11-15): what the existing Better Upload is, and a shortlist

See [research/better-upload-and-naming.md](./research/better-upload-and-naming.md).

- **Verdict:** the overlap is on the surface only.
  - Both are React-first, S3-compatible and shadcn-flavoured, with no DB.
  - Theirs has no resume across sessions or days, no integrity checks, no typed client contract, and fixed retry and concurrency settings.
- **The name collision is direct,** though: same category, about 100k weekly downloads, and they own the domain.
- **Shortlist** (npm name, npm scope and GitHub all free at check time; domains and trademarks not checked yet):
  1. `steadyload`
  2. `cargohold`
  3. `upferry`

  Also free: `filewire`, `durable-upload`, `upstay`.

## Suggested process (when the owner wants it)

1. Shortlist 3–5 names.
2. For each, check the npm package and org, GitHub org, `.dev`/`.com` domains, the shadcn registry index, and a basic trademark search (EUIPO, USPTO, Swissreg).
3. Rename the placeholder scope everywhere with a single search-and-replace on `@bu-draft/`.
