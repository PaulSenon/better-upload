// Post-deploy smoke test. Checks that the deployed origin serves exactly the files that were
// uploaded, with the headers this package defines, that the Worker script answers its own routes,
// and that unknown paths get a 404. Runs against Cloudflare after a deploy, and against
// `alchemy dev` (local workerd) in PR checks.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { IMMUTABLE_CACHE_CONTROL, securityHeaders } from "./headers.ts";

export interface SmokeOptions {
  /** Origin to test, e.g. https://better-upload-site.example.workers.dev/ */
  url: string;
  /** The dist that was deployed (assets/ + optional server/). assets/index.html is compared byte for byte. */
  distDir: string;
  indexable: boolean;
  /** Expected X-Site-Revision on non-production stages (`pr-6@abc1234`). */
  revision?: string;
  /** How long to wait for the new version to be served (propagation). */
  timeoutMs?: number;
  intervalMs?: number;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

export interface SmokeResult {
  ok: boolean;
  failures: string[];
  warnings: string[];
  checks: string[];
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function parseOrigin(url: string): URL {
  const u = new URL(url);
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) {
    throw new Error(`smoke test URL must be https (or http on localhost): ${url}`);
  }
  if (u.username || u.password || u.search || u.hash) throw new Error(`unexpected URL parts: ${url}`);
  u.pathname = u.pathname.endsWith("/") ? u.pathname : `${u.pathname}/`;
  return u;
}

export async function runSmoke(options: SmokeOptions): Promise<SmokeResult> {
  const origin = parseOrigin(options.url);
  const doFetch = options.fetch ?? fetch;
  const log = options.log ?? (() => {});
  const failures: string[] = [];
  const warnings: string[] = [];
  const checks: string[] = [];
  const assets = join(options.distDir, "assets");
  const hasServer = existsSync(join(options.distDir, "server"));
  const expectedIndex = sha256(readFileSync(join(assets, "index.html")));
  const get = (path: string) =>
    doFetch(new URL(path, origin), { redirect: "manual", headers: { "user-agent": "better-upload-site-smoke" } });

  // 1. The new version is live: "/" returns the uploaded (prerendered) index.html, byte for byte.
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  let home: Response | undefined;
  let last = "";
  for (;;) {
    try {
      const res = await get("./");
      const body = new Uint8Array(await res.arrayBuffer());
      if (res.status === 200 && sha256(body) === expectedIndex) {
        home = res;
        break;
      }
      last = `status ${res.status}, body sha256 ${sha256(body).slice(0, 12)} (want ${expectedIndex.slice(0, 12)})`;
    } catch (error) {
      last = String(error);
    }
    if (Date.now() >= deadline) break;
    log(`waiting for the new version: ${last}`);
    await new Promise((r) => setTimeout(r, options.intervalMs ?? 5_000));
  }
  if (!home) {
    failures.push(`/ never served the deployed index.html: ${last}`);
    return { ok: false, failures, warnings, checks };
  }
  checks.push("/ → 200, body = deployed index.html");
  if (!home.headers.get("content-type")?.startsWith("text/html")) failures.push("/ is not served as text/html");
  checkHeaders("/", home.headers, options, failures, checks);

  // 2. Unknown paths: status 404 (rendered by the Worker when there is one, else the asset layer).
  const missingPath = `__smoke-missing-${Date.now().toString(36)}`;
  const missing = await get(missingPath);
  await missing.arrayBuffer();
  if (missing.status !== 404) failures.push(`/${missingPath} → ${missing.status}, want 404`);
  else checks.push("unknown path → 404");

  // 3. Routing config files are never served.
  for (const path of ["_headers", "_redirects"]) {
    const res = await get(path);
    await res.arrayBuffer();
    if (res.status === 200) failures.push(`/${path} is publicly served`);
  }
  checks.push("_headers and _redirects are not served");

  // 4. A content-hashed asset referenced by the home page is cached as immutable.
  const html = readFileSync(join(assets, "index.html"), "utf8");
  const asset = /["'](\/assets\/[^"'?#]+)["']/.exec(html)?.[1];
  if (!asset) {
    warnings.push("index.html references no /assets/ asset; immutable caching not checked");
  } else {
    const res = await get(`.${asset}`);
    await res.arrayBuffer();
    if (res.status !== 200) failures.push(`${asset} → ${res.status}, want 200`);
    else if (res.headers.get("cache-control") !== IMMUTABLE_CACHE_CONTROL) {
      failures.push(`${asset} cache-control is ${JSON.stringify(res.headers.get("cache-control"))}`);
    } else checks.push(`${asset} → 200, immutable`);
  }

  // 5. The shadcn registry: the first /r/*.json item is served byte for byte, as JSON.
  const registryDir = join(assets, "r");
  const item = existsSync(registryDir) ? readdirSync(registryDir).filter((f) => f.endsWith(".json")).sort()[0] : undefined;
  if (!item) {
    warnings.push("no /r/*.json registry item in the build; registry not checked");
  } else {
    const res = await get(`r/${item}`);
    const body = new Uint8Array(await res.arrayBuffer());
    if (res.status !== 200) failures.push(`/r/${item} → ${res.status}, want 200`);
    else if (sha256(body) !== sha256(readFileSync(join(registryDir, item)))) failures.push(`/r/${item} differs from the build`);
    else if (!res.headers.get("content-type")?.includes("json")) failures.push(`/r/${item} is not served as JSON`);
    else checks.push(`/r/${item} → 200 JSON, body = build`);
  }

  // 6. The Worker script runs: /llms.txt is not prerendered, only the server answers it.
  if (hasServer) {
    const res = await get("llms.txt");
    const text = await res.text();
    if (res.status !== 200 || !text.includes("/docs")) failures.push(`/llms.txt → ${res.status} (the Worker script did not answer)`);
    else checks.push("/llms.txt → 200 from the Worker script");
  }

  // 7. Clean URLs (html_handling "drop-trailing-slash"): a prerendered page directory is served
  //    without a trailing slash and the slashed form redirects to it.
  const page = firstPageDir(assets);
  if (!page) {
    warnings.push("the site has no <dir>/index.html page; trailing-slash handling not checked");
  } else {
    const clean = await get(page);
    await clean.arrayBuffer();
    const slashed = await get(`${page}/`);
    await slashed.arrayBuffer();
    const location = slashed.headers.get("location");
    const target = location ? new URL(location, new URL(`${page}/`, origin)).pathname : undefined;
    const before = failures.length;
    if (clean.status !== 200) failures.push(`/${page} → ${clean.status}, want 200 (html_handling drop-trailing-slash)`);
    if (slashed.status < 300 || slashed.status > 399 || target !== new URL(page, origin).pathname) {
      failures.push(`/${page}/ → ${slashed.status} ${location ?? ""}, want a redirect to /${page}`);
    }
    if (failures.length === before) checks.push(`/${page} → 200, /${page}/ → redirect to /${page}`);
  }

  return { ok: failures.length === 0, failures, warnings, checks };
}

/** First top-level directory of the assets with an index.html (a prerendered page), if any. */
function firstPageDir(assets: string): string | undefined {
  return readdirSync(assets)
    .sort()
    .find((name) => {
      const index = join(assets, name, "index.html");
      return statSync(join(assets, name)).isDirectory() && existsSync(index) && statSync(index).isFile();
    });
}

function checkHeaders(
  where: string,
  headers: Headers,
  { indexable, revision }: { indexable: boolean; revision?: string },
  failures: string[],
  checks: string[],
) {
  const before = failures.length;
  for (const [name, value] of securityHeaders({ indexable, ...(revision ? { revision } : {}) })) {
    const actual = headers.get(name);
    if (actual !== value) failures.push(`${where}: ${name} is ${JSON.stringify(actual)}, want ${JSON.stringify(value)}`);
  }
  if (indexable && headers.get("x-robots-tag")) failures.push(`${where}: production must not send X-Robots-Tag`);
  if (failures.length === before) checks.push(`${where}: security headers as defined in src/headers.ts`);
}
