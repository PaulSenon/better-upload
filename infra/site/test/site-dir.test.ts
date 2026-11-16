import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { checkSiteDir } from "../src/site-dir.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A dist: `assets/...` and `server/...` paths, relative to the dist root. */
function dist(files: Record<string, string | Buffer> = {}, { server = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "site-"));
  dirs.push(root);
  const base: Record<string, string | Buffer> = { "assets/index.html": "<h1>hi</h1>" };
  if (server) base["server/server.js"] = "export default {}";
  for (const [path, content] of Object.entries({ ...base, ...files })) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

test("accepts a Worker build (assets + server modules)", () => {
  const report = checkSiteDir(dist({ "assets/assets/entry-a1b2.js": "1", "assets/docs/index.html": "g", "server/assets/chunk.js": "x", "server/server.js.map": "{}" }));
  assert.equal(report.files, 6);
  assert.equal(report.server?.modules, 2);
  assert.deepEqual(report.warnings, []);
});

test("accepts assets only (bootstrap placeholder)", () => {
  const report = checkSiteDir(dist({}, { server: false }));
  assert.equal(report.server, undefined);
});

test("requires assets/index.html and the Worker entry", () => {
  const root = dist();
  rmSync(join(root, "server/server.js"));
  assert.throws(() => checkSiteDir(root), /missing server\/server\.js/);
  const noIndex = dist();
  rmSync(join(noIndex, "assets/index.html"));
  assert.throws(() => checkSiteDir(noIndex), /missing index\.html/);
  assert.throws(() => checkSiteDir(join(root, "nope")), /not found/);
});

test("refuses unexpected top-level entries and unexpected server files", () => {
  assert.throws(() => checkSiteDir(dist({ "manifest.json": "{}" })), /unexpected entry/);
  assert.throws(() => checkSiteDir(dist({ "server/run.sh": "rm -rf /" })), /unexpected file in server/);
  assert.throws(() => checkSiteDir(dist({ "server/mod.wasm": "x" })), /unexpected file in server/);
});

test("refuses a Worker over the 3 MiB (gzip) Free plan limit", () => {
  assert.throws(() => checkSiteDir(dist({ "server/assets/big.js": randomBytes(3.5 * 1024 * 1024) })), /Free plan limit/);
});

test("refuses symlinks (their target would be uploaded)", () => {
  const root = dist();
  symlinkSync("/etc/hosts", join(root, "assets/hosts.txt"));
  assert.throws(() => checkSiteDir(root), /symlink/);
  const server = dist();
  symlinkSync("/etc/hosts", join(server, "server/hosts.js"));
  assert.throws(() => checkSiteDir(server), /symlink/);
});

test("refuses credential-looking files anywhere", () => {
  for (const name of ["assets/.env", "assets/.env.production", "assets/sub/.npmrc", "assets/.git/config", "assets/key.pem", "server/.env"]) {
    assert.throws(() => checkSiteDir(dist({ [name]: "x" })), /refusing to publish/, name);
  }
});

test("refuses control characters in names (log command forgery)", () => {
  assert.throws(() => checkSiteDir(dist({ "assets/a\n::error::x.html": "x" })), /control character/);
});

test("warns about routing files it overrides", () => {
  const report = checkSiteDir(dist({ "assets/_headers": "/*\n  X: y", "assets/_redirects": "/a /b 301" }));
  assert.equal(report.warnings.length, 2);
});
