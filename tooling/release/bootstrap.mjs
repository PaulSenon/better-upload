#!/usr/bin/env node
// One-time npm bootstrap for every public package (@open-upload/*), run by the maintainer on their
// own machine. npm only lets a trusted publisher be configured on a package that already exists,
// so each package is created once by staging a code-free placeholder (generated here: package.json
// + README.md, no code), which is then rejected: no bytes of ours are ever published outside CI.
//
//   node tooling/release/bootstrap.mjs check               read-only: npm CLI, login, org role, package states
//   node tooling/release/bootstrap.mjs stage               stage a placeholder for each package that does not exist yet
//   node tooling/release/bootstrap.mjs reject <id>...      reject those stages (2FA); the packages stay created
//   node tooling/release/bootstrap.mjs trust               configure the stage-only trusted publisher of each package (2FA)
//   node tooling/release/bootstrap.mjs status              read-only: versions, dist-tags, trust, pending stages
//
// Every npm call goes through one pinned npm CLI (npx), independent of the npm bundled with your
// Node. No token is read or printed; npm prompts for 2FA itself. Runbook: docs/RELEASING.md §8.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseGroup } from "./lib.mjs";

const NPM = "npm@11.21.2"; // >= 11.15.0 for `npm stage` and `npm trust`; released 2026-11-04
const ORG = "open-upload"; // provisional name (docs/NAMING.md)
const TRUST = { file: "release.yml", repo: "PaulSenon/better-upload", env: "npm-release" };

const group = releaseGroup(
  readdirSync("packages", { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join("packages", d.name, "package.json")))
    .map((d) => ({ dir: join("packages", d.name), manifest: JSON.parse(readFileSync(join("packages", d.name, "package.json"), "utf8")) })),
);
if (!group.ok) { console.error(`STOP  ${group.reason}`); process.exit(1); }
const PKGS = group.packages.map((p) => p.name);

function npm(args, { capture = false } = {}) {
  const r = spawnSync("npx", ["--yes", NPM, ...args], { encoding: "utf8", stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit" });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
function ok(msg) { console.log(`OK    ${msg}`); }
function fail(msg) { console.error(`STOP  ${msg}`); process.exit(1); }

function packageState(name) {
  const r = npm(["view", name, "versions", "dist-tags", "--json"], { capture: true });
  if (r.status === 0) return { exists: true, data: JSON.parse(r.stdout || "{}") };
  if (/E404/.test(r.stderr + r.stdout)) return { exists: false };
  fail(`could not query the registry for ${name}:\n${r.stderr}`);
}

function check() {
  const v = npm(["--version"], { capture: true });
  if (v.status !== 0) fail(`cannot run ${NPM} through npx:\n${v.stderr}`);
  ok(`npm CLI ${v.stdout.trim()} (pinned ${NPM})`);
  const who = npm(["whoami"], { capture: true });
  if (who.status !== 0) fail(`not logged in. Run: npx --yes ${NPM} login`);
  const user = who.stdout.trim();
  ok(`logged in as ${user}`);
  const org = npm(["org", "ls", ORG, user, "--json"], { capture: true });
  const role = org.status === 0 ? JSON.parse(org.stdout || "{}")[user] : undefined;
  if (!role) fail(`${user} is not a member of the npm org "${ORG}" (create it: https://www.npmjs.com/org/create).`);
  if (role === "developer") console.warn(`WARN  role "${role}" in org ${ORG}: you can publish, but only an owner/admin can manage the org.`);
  ok(`org ${ORG}: role "${role}"`);
  const states = new Map(PKGS.map((name) => [name, packageState(name)]));
  for (const [name, state] of states) {
    ok(state.exists ? `${name} exists: versions ${JSON.stringify(state.data.versions)}` : `${name} does not exist yet`);
  }
  return { user, states };
}

function placeholder(name) {
  const dir = mkdtempSync(join(tmpdir(), "open-upload-bootstrap-"));
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({
    name,
    version: "0.0.0-bootstrap.0",
    description: "One-time placeholder used to create the npm package so its trusted publisher can be configured. Never approved; install a real version instead.",
    license: "MIT",
    repository: { type: "git", url: `git+https://github.com/${TRUST.repo}.git` },
    files: [],
  }, null, 2)}\n`);
  writeFileSync(join(dir, "README.md"), `# ${name} (bootstrap placeholder)\n\nNo code. Staged once to create the package, then rejected. See docs/RELEASING.md §8.\n`);
  return dir;
}

function stage() {
  const { states } = check();
  const todo = PKGS.filter((name) => !states.get(name).exists);
  if (!todo.length) fail(`every package already exists: skip "stage", go to "trust" (or "status").`);
  for (const name of todo) {
    const out = mkdtempSync(join(tmpdir(), "open-upload-bootstrap-out-"));
    const pack = npm(["pack", placeholder(name), "--pack-destination", out, "--json"], { capture: true });
    if (pack.status !== 0) fail(`npm pack failed for ${name}:\n${pack.stderr}`);
    const [info] = JSON.parse(pack.stdout);
    const files = info.files.map((f) => f.path).sort();
    if (info.name !== name || info.version !== "0.0.0-bootstrap.0" || JSON.stringify(files) !== JSON.stringify(["README.md", "package.json"])) {
      fail(`unexpected placeholder tarball: ${info.name}@${info.version} ${JSON.stringify(files)}`);
    }
    const tgz = join(out, readdirSync(out).find((f) => f.endsWith(".tgz")));
    ok(`placeholder ${info.name}@${info.version}, files ${files.join(", ")}, ${info.integrity}`);
    const r = npm(["stage", "publish", tgz, "--tag", "bootstrap", "--access", "public", "--ignore-scripts"]);
    if (r.status !== 0) fail(`npm stage publish failed for ${name} (see above). Fallback: docs/RELEASING.md §8.`);
  }
  console.log(`\nNext: copy the stage IDs printed above, then run:\n  node tooling/release/bootstrap.mjs reject <stage-id> [<stage-id>...]`);
}

function reject(ids) {
  if (!ids.length || ids.some((id) => !/^[\w-]+$/.test(id))) fail("usage: bootstrap.mjs reject <stage-id> [<stage-id>...]");
  for (const id of ids) if (npm(["stage", "reject", id]).status !== 0) fail(`npm stage reject ${id} failed (see above)`);
  for (const name of PKGS) {
    const state = packageState(name);
    if (!state.exists) fail(`${name} does not exist after the rejection: follow the fallback in docs/RELEASING.md §8.`);
  }
  ok(`stages rejected; every package exists. Next: "trust" (only when ready to release within 2 days).`);
}

function trust() {
  const { states } = check();
  const missing = PKGS.filter((name) => !states.get(name).exists);
  if (missing.length) fail(`not created yet: ${missing.join(", ")}. Run "stage" then "reject" first.`);
  for (const name of PKGS) {
    const r = npm(["trust", "github", name, "--file", TRUST.file, "--repo", TRUST.repo, "--env", TRUST.env, "--allow-stage-publish"]);
    if (r.status !== 0) fail(`npm trust github failed for ${name} (see above)`);
  }
  status();
}

function status() {
  for (const name of PKGS) {
    const state = packageState(name);
    console.log(`\n== ${name}`);
    console.log(state.exists ? JSON.stringify(state.data, null, 2) : "not on the registry");
    if (!state.exists) continue;
    console.log(`Trusted publisher (expect GitHub, ${TRUST.repo}, ${TRUST.file}, ${TRUST.env}, stage publish only):`);
    npm(["trust", "list", name]);
    console.log("Pending stages:");
    npm(["stage", "list", name]);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const commands = { check, stage, reject: () => reject(rest), trust, status };
if (!commands[cmd]) { console.error("usage: bootstrap.mjs check|stage|reject <stage-id>...|trust|status"); process.exit(2); }
commands[cmd]();
