// CI check for pull requests: a change to a published package needs a change note,
// except for a well-formed version PR (which consumes the notes).
//   node tooling/release/check-changeset.mjs <base-ref>     e.g. origin/main
// Rules (see lib.mjs classifyPullRequest):
//   - the PR adds a .changeset/*.md file                 -> ok
//   - the published version changed                      -> must be a valid version PR
//   - otherwise                                          -> `changeset status --since=<base>` decides
//     (it fails when files of the package changed without a change note)
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { changelogHasVersion, classifyPullRequest, pendingChangesets } from "./lib.mjs";

const base = process.argv[2];
if (!base || base.startsWith("-")) { console.error("usage: check-changeset.mjs <base-ref>"); process.exit(2); }
const repo = resolve(".");
const changesetBin = join(repo, "node_modules/@changesets/cli/bin.js");
const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const lines = (text) => text.split("\n").filter(Boolean);

const mergeBase = git("merge-base", base, "HEAD");
const nameStatus = lines(git("diff", "--name-status", "--no-renames", mergeBase, "HEAD"));
const byStatus = (s) => nameStatus.filter((l) => l.startsWith(s)).map((l) => l.split("\t")[1]);
// Every public package under packages/ (one fixed version group).
const packageDirs = readdirSync("packages", { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join("packages", d.name, "package.json")))
  .map((d) => `packages/${d.name}`)
  .filter((dir) => !JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).private);
const manifestPaths = packageDirs.map((dir) => `${dir}/package.json`);
const changelogPaths = packageDirs.map((dir) => `${dir}/CHANGELOG.md`);
const versionAt = (rev) => {
  const versions = new Set(manifestPaths.map((path) => { try { return JSON.parse(git("show", `${rev}:${path}`)).version; } catch { return undefined; } }));
  return versions.size === 1 ? [...versions][0] : [...versions].join("|");
};

const basePending = (() => {
  try { return pendingChangesets(lines(git("ls-tree", "--name-only", mergeBase, ".changeset/")).map((p) => p.replace(/^\.changeset\//, ""))).map((f) => `.changeset/${f}`); }
  catch { return []; }
})();

// Version the base in a throwaway worktree to learn which version the pending notes compute.
// `changeset version` is used (not `status`) because it does not depend on a local base branch,
// which CI checkouts do not have.
const expectedVersion = (() => {
  if (!basePending.length) return undefined;
  const dir = mkdtempSync(join(tmpdir(), "changeset-base-"));
  try {
    git("worktree", "add", "--detach", dir, mergeBase);
    symlinkSync(join(repo, "node_modules"), join(dir, "node_modules"), "dir");
    // Only the version is needed: no changelog generator (the GitHub one needs a token).
    const configPath = join(dir, ".changeset/config.json");
    writeFileSync(configPath, JSON.stringify({ ...JSON.parse(readFileSync(configPath, "utf8")), changelog: false }));
    try {
      execFileSync("node", [changesetBin, "version"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      console.error(`::error::could not compute the expected version on ${mergeBase}:\n${error.stdout ?? ""}${error.stderr ?? ""}`);
      process.exit(1);
    }
    return JSON.parse(readFileSync(join(dir, manifestPaths[0]), "utf8")).version;
  } finally {
    try { git("worktree", "remove", "--force", dir); } catch { rmSync(dir, { recursive: true, force: true }); }
  }
})();

const headVersion = versionAt("HEAD");
const allChangelogsHaveVersion = changelogPaths.every((path) => existsSync(path) && changelogHasVersion(readFileSync(path, "utf8"), headVersion ?? ""));
const verdict = classifyPullRequest({
  added: byStatus("A"), deleted: byStatus("D"), changed: nameStatus.map((l) => l.split("\t")[1]),
  manifestPaths, changelogPaths, baseVersion: versionAt(mergeBase), headVersion,
  basePending, expectedVersion, headChangelogHasVersion: allChangelogsHaveVersion,
});

switch (verdict.kind) {
  case "changeset": console.log("Change note present."); break;
  case "version-pr": console.log(`Valid version PR: ${headVersion}.`); break;
  case "invalid-version-pr": console.error(`::error::${verdict.reason}`); process.exit(1);
  case "needs-status-check":
    if (pendingChangesets(readdirSync(".changeset")).length === 0 && !nameStatus.some((l) => packageDirs.some((dir) => l.split("\t")[1].startsWith(`${dir}/`)))) {
      console.log("No package files changed; no change note needed.");
      break;
    }
    try { execFileSync("node", [changesetBin, "status", `--since=${base}`], { stdio: "inherit" }); }
    catch { console.error("::error::a package changed but this PR has no change note: run `pnpm changeset` (or `pnpm changeset --empty` if no release is needed)"); process.exit(1); }
    break;
}
