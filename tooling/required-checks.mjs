// Ruleset required checks (tooling/setup-github.mjs). Pure + a workflow reader, unit-tested.
// = previews.requiredChecks (gate deploys too) + previews.prOnlyChecks (PR-only: required by the
// ruleset, never gate deploys; default ["dependency-review"]). Every one must be produced by a job
// of .github/workflows, or the ruleset would wait forever for a check that never reports and
// block every PR (found by WebMCP, which has no `changeset` job).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export const DEFAULT_PR_ONLY_CHECKS = ["dependency-review"];

export function requiredChecks(config) {
  const prOnly = config.previews.prOnlyChecks ?? DEFAULT_PR_ONLY_CHECKS;
  if (!Array.isArray(prOnly) || !prOnly.every((n) => typeof n === "string" && n.length > 0)) throw new Error("previews.prOnlyChecks must list check names");
  return [...new Set([...config.previews.requiredChecks, ...prOnly])];
}

/** Check names the workflows can report: each job's `name:` (or its id), expressions excluded. */
export function workflowCheckNames(dir) {
  const names = new Set();
  for (const f of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
    const wf = parse(readFileSync(join(dir, f), "utf8")) ?? {};
    for (const [id, job] of Object.entries(wf.jobs ?? {})) {
      const name = typeof job?.name === "string" ? job.name : id;
      if (!name.includes("${{")) names.add(name);
      // local: matrix legs (`e2e (${{ matrix.browser }})` → one check per value) — reported to the kit.
      else for (const expanded of expandMatrixName(name, job?.strategy?.matrix)) names.add(expanded);
    }
  }
  return names;
}

export function missingChecks(checks, available) {
  return checks.filter((c) => !available.has(c));
}

// local: names whose only expressions are `${{ matrix.<key> }}` over a static matrix (lists and
// `include` entries). Anything else (dynamic matrix, other expressions) stays excluded.
export function expandMatrixName(name, matrix) {
  if (!matrix || typeof matrix !== "object" || Array.isArray(matrix)) return [];
  const keys = [...name.matchAll(/\$\{\{\s*matrix\.([A-Za-z_][\w-]*)\s*\}\}/g)].map((m) => m[1]);
  if (!keys.length || name.replace(/\$\{\{\s*matrix\.[A-Za-z_][\w-]*\s*\}\}/g, "").includes("${{")) return [];
  const axes = Object.entries(matrix).filter(([k]) => k !== "include" && k !== "exclude");
  if (axes.some(([, v]) => !Array.isArray(v) || v.some((x) => typeof x === "object" || String(x).includes("${{")))) return [];
  let combos = [{}];
  for (const [k, values] of axes) combos = combos.flatMap((c) => values.map((v) => ({ ...c, [k]: String(v) })));
  for (const inc of Array.isArray(matrix.include) ? matrix.include : []) if (inc && typeof inc === "object") combos.push(Object.fromEntries(Object.entries(inc).map(([k, v]) => [k, String(v)])));
  const out = new Set();
  for (const c of combos) {
    if (!keys.every((k) => k in c)) continue;
    out.add(name.replace(/\$\{\{\s*matrix\.([A-Za-z_][\w-]*)\s*\}\}/g, (_, k) => c[k]));
  }
  return [...out];
}
