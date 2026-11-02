#!/usr/bin/env node
// Runs Claude on single fixture units and checks the answers. Costs a few
// cents per case; answers are cached by prompt, so a rerun with an unchanged
// prompt is free.
//
//   npm run eval                 every case
//   npm run eval -- refund-fork  one case

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadCodebase } from "../extractor/load.mjs";
import { CACHE, HOME } from "../extractor/paths.mjs";
import { extractUnits } from "../extractor/extract.mjs";

const CASES = join(HOME, "evals", "cases");
const only = process.argv[2];
const cases = readdirSync(CASES).filter((f) => f.endsWith(".json")).map((f) => ({ name: f.replace(/\.json$/, ""), ...JSON.parse(readFileSync(join(CASES, f), "utf8")) }))
  .filter((c) => !only || c.name === only);
if (!cases.length) {
  console.error(`error[BAD_ARGUMENT]: no eval case named ${only}\n  remedy: pass a file name from evals/cases/ without .json`);
  process.exit(1);
}

function walk(steps, visit) {
  for (const s of steps) {
    visit(s);
    walk(s.steps || [], visit);
    (s.branches || []).forEach((b) => walk(b.steps, visit));
  }
}

// Each expectation names one property of a faithful answer.
const CHECKS = {
  exitsInclude: (all, codes) => codes.filter((c) => !all.some((s) => s.exits.some((e) => e.outcome === c))).map((c) => `no exit with outcome ${c}`),
  callsInclude: (all, ids) => ids.filter((id) => !all.some((s) => s.calls.includes(id))).map((id) => `no step calls ${id}`),
  raisesInclude: (all, names) => names.filter((n) => !all.some((s) => s.exits.some((e) => e.raises === n))).map((n) => `no exit raises ${n}`),
  minExits: (all, n) => (all.reduce((k, s) => k + s.exits.length, 0) < n ? [`fewer than ${n} exits`] : []),
  minReturns: (all, n) => (all.reduce((k, s) => k + s.returns.length, 0) < n ? [`fewer than ${n} returns`] : []),
  minQuestions: (all, n) => (all.filter((s) => s.question.trim()).length < n ? [`fewer than ${n} questions`] : []),
  minForks: (all, n) => (all.filter((s) => (s.branches || []).length).length < n ? [`fewer than ${n} forks`] : []),
  notesAvoid: (all, patterns) => patterns.flatMap((p) => all.flatMap((s) => s.notes.filter((note) => new RegExp(p, "i").test(note)).map((note) => `a note matches /${p}/: ${note}`))),
  notesMatch: (all, patterns) => patterns.filter((p) => !all.some((s) => s.notes.some((note) => new RegExp(p, "i").test(note)))).map((p) => `no note matches /${p}/`),
};

let failed = 0;
for (const c of cases) {
  const repo = join(HOME, c.fixture);
  const codebase = loadCodebase(repo);
  const { units, failures } = await extractUnits({
    roots: [c.unit], ...codebase,
    options: { model: c.model || "claude-opus-5-5", effort: c.effort || "medium", concurrency: 1, maxDepth: 0 },
    cacheDir: join(CACHE, "units"),
    workDir: join(CACHE, "claude-cwd"),
    log: () => {},
  });
  const problems = failures.map((f) => `${f.code}: ${f.errors.join("; ")}`);
  const answer = units.get(c.unit)?.output;
  if (answer) {
    const all = [];
    walk(answer.steps, (s) => all.push(s));
    for (const [name, arg] of Object.entries(c.expect)) {
      if (!CHECKS[name]) problems.push(`unknown expectation "${name}"; add it to CHECKS in evals/run.mjs`);
      else problems.push(...CHECKS[name](all, arg));
    }
  }
  if (problems.length) failed++;
  console.log(`${problems.length ? "✗" : "✓"} ${c.name}: ${c.why}${problems.map((p) => `\n    ${p}`).join("")}`);
}
console.log(`\n${cases.length - failed}/${cases.length} cases pass`);
process.exit(failed ? 1 : 0);
