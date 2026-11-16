// local: Better Upload-specific checks on top of the kit's tests.
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { renderHeaders } from "../src/stage.ts";

test("local: site.headers (CSP with demo workers, HSTS, immutable chunks) reach every stage's _headers", () => {
  const config = loadConfig();
  const csp = config.site.headers?.["/*"]?.["Content-Security-Policy"] ?? "";
  assert.match(csp, /worker-src 'self' blob:/); // the live demo hashes in Web Workers created from a Blob URL
  assert.match(csp, /frame-ancestors 'none'/);
  for (const stage of ["production", "pr-12"]) {
    const file = renderHeaders(stage, stage === "production" ? undefined : "pr-12@abcdef1", config.site.headers);
    for (const [name, value] of Object.entries(config.site.headers?.["/*"] ?? {})) assert.ok(file.includes(`  ${name}: ${value}\n`), `${stage}: ${name}`);
    assert.match(file, /\n\/assets\/\*\n {2}Cache-Control: public, max-age=31536000, immutable\n/);
    assert.match(file, /\n\/r\/\*\n {2}Access-Control-Allow-Origin: \*\n/);
    for (const line of file.split("\n")) assert.ok(line.length <= 2000);
  }
});
