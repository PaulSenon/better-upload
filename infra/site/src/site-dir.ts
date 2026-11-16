// Validation of the built site before it is uploaded. In CI the directory comes from a build
// artifact produced by a job that ran untrusted code (the site build), so it is treated as data:
// no symlinks (Alchemy would upload a symlink's target, which could publish runner files), only
// regular files, within Cloudflare's limits, with the files the Worker and routing rely on.
//
// Layout (apps/web `pnpm build:worker`, copied as is into the artifact):
//   <dist>/assets/   static assets served by Cloudflare's asset layer (prerendered pages, /r/*.json, chunks)
//   <dist>/server/   the Worker's ES modules, uploaded byte for byte (`bundle: false`), entry server.js
// A dist without server/ deploys an assets-only Worker (bootstrap placeholder, fixtures).
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { gzipSync } from "node:zlib";

// Workers limits (Free plan): https://developers.cloudflare.com/workers/platform/limits/
export const MAX_FILES = 20_000;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Free plan: 3 MiB per Worker after compression. */
export const MAX_SCRIPT_GZIP_BYTES = 3 * 1024 * 1024;
export const SERVER_ENTRY = "server.js";

const REQUIRED_ASSETS = ["index.html"];
// Never publish credentials or VCS data, whatever the build produced.
const FORBIDDEN = [/^\.env(\..*)?$/, /^\.npmrc$/, /^\.git$/, /^\.alchemy$/, /^id_[a-z0-9]+$/, /\.pem$/];
// Read by Cloudflare as routing config, not served. This package sets headers and redirects
// explicitly, so a copy in the build output has no effect; it is reported so nobody relies on it.
const IGNORED_CONFIG = ["_headers", "_redirects", ".assetsignore", "_routes.json", "_worker.js"];
/** Files the server directory may contain. Only .js/.mjs are uploaded as modules. */
const SERVER_FILES = /\.(m?js|map|json|css)$/;

export interface SiteReport {
  files: number;
  bytes: number;
  /** Worker modules (.js/.mjs) and their gzip size, when the site has a server. */
  server?: { modules: number; bytes: number; gzipBytes: number };
  warnings: string[];
}

export class SiteDirError extends Error {}

interface WalkStats {
  files: string[];
  bytes: number;
}

function walk(root: string, onFile: (rel: string, size: number, name: string, dir: string) => void): void {
  const visit = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const rel = relative(root, path).split(sep).join("/");
      // Names end up in CI logs: control characters could forge workflow commands.
      if (/[\u0000-\u001f\u007f]/.test(name)) throw new SiteDirError(`control character in file name ${JSON.stringify(rel)}`);
      if (FORBIDDEN.some((re) => re.test(name))) throw new SiteDirError(`refusing to publish ${JSON.stringify(rel)}`);
      const st = lstatSync(path);
      if (st.isSymbolicLink()) throw new SiteDirError(`symlink in site output: ${JSON.stringify(rel)}`);
      if (st.isDirectory()) {
        visit(path);
        continue;
      }
      if (!st.isFile()) throw new SiteDirError(`not a regular file: ${JSON.stringify(rel)}`);
      if (st.size > MAX_FILE_BYTES) throw new SiteDirError(`${JSON.stringify(rel)} is over 25 MiB (Cloudflare limit)`);
      onFile(rel, st.size, name, dir);
    }
  };
  visit(root);
}

export function checkSiteDir(dist: string): SiteReport {
  if (!lstatSafe(dist)?.isDirectory()) throw new SiteDirError(`site directory not found: ${dist}`);
  for (const name of readdirSync(dist)) {
    if (name !== "assets" && name !== "server") throw new SiteDirError(`unexpected entry ${JSON.stringify(name)} (expected assets/ and server/ only)`);
  }
  const assetsDir = join(dist, "assets");
  if (!lstatSafe(assetsDir)?.isDirectory()) throw new SiteDirError(`missing assets/ in ${dist}`);
  const warnings: string[] = [];
  const assets: WalkStats = { files: [], bytes: 0 };
  walk(assetsDir, (rel, size, name, dir) => {
    if (dir === assetsDir && IGNORED_CONFIG.includes(name)) {
      warnings.push(`${rel} in the build output is ignored (headers/redirects are set by infra/site)`);
    }
    assets.files.push(rel);
    assets.bytes += size;
    if (assets.files.length > MAX_FILES) throw new SiteDirError(`more than ${MAX_FILES} assets (Cloudflare Free limit)`);
  });
  for (const name of REQUIRED_ASSETS) {
    if (!lstatSafe(join(assetsDir, name))?.isFile()) throw new SiteDirError(`missing ${name} at the assets root`);
  }

  const serverDir = join(dist, "server");
  if (!lstatSafe(serverDir)) return { files: assets.files.length, bytes: assets.bytes, warnings };
  if (!lstatSafe(serverDir)?.isDirectory()) throw new SiteDirError("server is not a directory");
  if (!lstatSafe(join(serverDir, SERVER_ENTRY))?.isFile()) throw new SiteDirError(`missing server/${SERVER_ENTRY} (the Worker entry)`);
  const modules: Buffer[] = [];
  let serverFiles = 0;
  let serverBytes = 0;
  walk(serverDir, (rel, size, name, dir) => {
    if (!SERVER_FILES.test(name)) throw new SiteDirError(`unexpected file in server/: ${JSON.stringify(rel)}`);
    serverFiles += 1;
    serverBytes += size;
    if (/\.m?js$/.test(name)) modules.push(readFileSync(join(dir, name)));
  });
  const moduleBytes = modules.reduce((n, b) => n + b.length, 0);
  const gzipBytes = gzipSync(Buffer.concat(modules), { level: 9 }).length;
  if (gzipBytes > MAX_SCRIPT_GZIP_BYTES) {
    throw new SiteDirError(`Worker modules are ${(gzipBytes / 1024 / 1024).toFixed(2)} MiB gzipped (Free plan limit 3 MiB)`);
  }
  if (gzipBytes > MAX_SCRIPT_GZIP_BYTES * 0.8) warnings.push(`Worker modules use ${Math.round((gzipBytes / MAX_SCRIPT_GZIP_BYTES) * 100)} % of the 3 MiB Free plan limit`);
  return {
    files: assets.files.length + serverFiles,
    bytes: assets.bytes + serverBytes,
    server: { modules: modules.length, bytes: moduleBytes, gzipBytes },
    warnings,
  };
}

function lstatSafe(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}
