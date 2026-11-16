// local: Better Upload-specific checks on top of the kit's tests.
import assert from "node:assert/strict";
import { test } from "node:test";
import { LOCAL_SECURITY_HEADERS, renderHeaders } from "../src/stage.ts";

test("local: security headers and immutable chunks on every stage; demo workers allowed (blob:)", () => {
  for (const stage of ["production", "pr-12"]) {
    const file = renderHeaders(stage, stage === "production" ? undefined : "pr-12@abcdef1");
    for (const [name, value] of LOCAL_SECURITY_HEADERS) assert.ok(file.includes(`  ${name}: ${value}\n`), `${stage}: ${name}`);
    assert.match(file, /\n\/assets\/\*\n {2}Cache-Control: public, max-age=31536000, immutable\n/);
    assert.match(file, /\n\/r\/\*\n {2}Access-Control-Allow-Origin: \*\n/);
  }
  const csp = LOCAL_SECURITY_HEADERS.find(([n]) => n === "Content-Security-Policy")?.[1] ?? "";
  assert.match(csp, /worker-src 'self' blob:/);
  assert.match(csp, /frame-ancestors 'none'/);
  for (const line of renderHeaders("production").split("\n")) assert.ok(line.length <= 2000);
});
