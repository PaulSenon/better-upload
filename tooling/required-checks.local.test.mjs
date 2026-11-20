// local: matrix expansion for required checks (Better Upload's e2e matrix); reported to the kit.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { expandMatrixName, missingChecks, requiredChecks, workflowCheckNames } from "./required-checks.mjs";

test("local: matrix legs are expanded; dynamic names stay excluded", () => {
  assert.deepEqual(expandMatrixName("e2e (${{ matrix.browser }})", { browser: ["chromium", "webkit"] }), ["e2e (chromium)", "e2e (webkit)"]);
  assert.deepEqual(expandMatrixName("t (${{ matrix.os }}, ${{ matrix.node }})", { os: ["a"], node: [1, 2] }), ["t (a, 1)", "t (a, 2)"]);
  assert.deepEqual(expandMatrixName("t ${{ matrix.v }}", { v: ["x"], include: [{ v: "y" }] }), ["t x", "t y"]);
  assert.deepEqual(expandMatrixName("t ${{ matrix.v }}", "${{ fromJSON(needs.a.outputs.m) }}"), []);
  assert.deepEqual(expandMatrixName("t ${{ github.ref }}", { v: ["x"] }), []);
});

test("local: every required check of this repository is produced by a workflow job", () => {
  const config = JSON.parse(readFileSync(new URL("../delivery.config.json", import.meta.url), "utf8"));
  const dir = new URL("../.github/workflows/", import.meta.url).pathname;
  assert.deepEqual(missingChecks(requiredChecks(config), workflowCheckNames(dir)), []);
});
