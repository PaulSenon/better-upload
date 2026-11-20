// Packs every package of the release ONCE and describes each tarball (build job of release.yml).
//   node tooling/release/pack.mjs <out-dir>
// Env: PACKAGES (JSON [{dir, name}] from the plan job), VERSION, SHA,
//      GITHUB_SERVER_URL/GITHUB_REPOSITORY/GITHUB_RUN_ID (run URL)
// For each package: <out-dir>/<slug>/pkg.tgz (`pnpm pack` rewrites workspace: dependencies to real
// versions) and <out-dir>/<slug>/release-manifest.json; prints the contents to the step summary
// and outputs integrities=<JSON {slug: npm dist.integrity}>.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { packageSlug, tarballIntegrity } from "./lib.mjs";

const fail = (message) => { console.error(`::error::${message}`); process.exit(1); };
const outDir = resolve(process.argv[2] ?? fail("usage: pack.mjs <out-dir>"));
const { PACKAGES, VERSION, SHA, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY, GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
const packages = JSON.parse(PACKAGES ?? "[]");
if (!packages.length) fail("PACKAGES is empty");

const integrities = {};
const summary = [`### Built ${packages.length} packages at \`${VERSION}\` from \`${SHA}\``, ""];
for (const { dir, name } of packages) {
  const slug = packageSlug(name);
  const target = join(outDir, slug);
  mkdirSync(target, { recursive: true });
  execFileSync("pnpm", ["pack", "--pack-destination", target], { cwd: dir, stdio: ["ignore", "inherit", "inherit"] });
  const [file, ...extra] = readdirSync(target).filter((f) => f.endsWith(".tgz"));
  if (!file || extra.length) fail(`expected exactly one tarball for ${name}`);
  const tgz = join(target, "pkg.tgz");
  renameSync(join(target, file), tgz);
  const bytes = readFileSync(tgz);
  const packed = JSON.parse(execFileSync("tar", ["-xOzf", tgz, "package/package.json"], { encoding: "utf8" }));
  if (packed.name !== name || packed.version !== VERSION) fail(`tarball is ${packed.name}@${packed.version}, plan expected ${name}@${VERSION}`);
  const deps = { ...packed.dependencies, ...packed.peerDependencies, ...packed.optionalDependencies };
  const unresolved = Object.entries(deps).filter(([, range]) => String(range).startsWith("workspace:") || String(range).startsWith("catalog:"));
  if (unresolved.length) fail(`${name}: unresolved workspace/catalog ranges in the tarball: ${unresolved.map(([d]) => d).join(", ")}`);
  const files = execFileSync("tar", ["-tzf", tgz], { encoding: "utf8" }).trim().split("\n").filter((f) => !f.endsWith("/")).map((path) => ({
    path,
    sha256: createHash("sha256").update(execFileSync("tar", ["-xOzf", tgz, path])).digest("hex"),
  }));
  const integrity = await tarballIntegrity(bytes);
  integrities[slug] = integrity;
  const manifest = {
    name, version: VERSION, sha: SHA, integrity, size: bytes.length,
    run: GITHUB_RUN_ID ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}` : undefined,
    files,
  };
  writeFileSync(join(target, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  summary.push(`- \`${name}@${VERSION}\`: \`${integrity}\` (${bytes.length} bytes, ${files.length} files)`);
  console.log(`${name}@${VERSION} ${integrity} ${files.length} files`);
}
if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `integrities=${JSON.stringify(integrities)}\n`);
if (GITHUB_STEP_SUMMARY) appendFileSync(GITHUB_STEP_SUMMARY, `${summary.join("\n")}\n`);
