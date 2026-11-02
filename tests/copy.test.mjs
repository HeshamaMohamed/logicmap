// Every fixed text a reader sees, and the text linter itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { COPY as VIEWER } from "../viewer/copy.mjs";
import { COPY as EXTRACTOR } from "../extractor/copy.mjs";
import { describeFinding, lintTexts } from "../extractor/text-lint.mjs";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "../extractor/paths.mjs";

// Every language pack's own texts, from extractor/languages/<name>/copy.mjs.
const LANGUAGES_DIR = join(HOME, "extractor", "languages");
const PACKS = await Promise.all(readdirSync(LANGUAGES_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(LANGUAGES_DIR, e.name, "copy.mjs")))
  .map(async (e) => ({ name: e.name, copy: (await import(join(LANGUAGES_DIR, e.name, "copy.mjs"))).COPY })));

// Flattens a copy module into texts, calling templates with sample values.
function texts(copy, prefix) {
  const out = [];
  for (const [key, value] of Object.entries(copy)) {
    const where = `${prefix}.${key}`;
    if (typeof value === "string") out.push({ where, text: value });
    else if (typeof value === "function") out.push({ where, text: value(...Array(value.length).fill("sample")) });
    else out.push(...texts(value, where));
  }
  return out;
}

test("copy: every viewer, extractor and language pack text passes STE and the humanizer patterns", () => {
  assert.ok(PACKS.length, "at least one language pack has a copy.mjs");
  const findings = lintTexts([...texts(VIEWER, "viewer"), ...texts(EXTRACTOR, "extractor"), ...PACKS.flatMap((p) => texts(p.copy, p.name))]);
  assert.deepEqual(findings.map(describeFinding), []);
});

test("text lint: catches STE and humanizer violations, passes plain labels", () => {
  const findings = lintTexts([
    { where: "a", text: "Check the date; then save it" },
    { where: "b", text: "This is crucial — the owner must spin up a worker" },
    { where: "c", text: "Is the caller signed in?" },
    { where: "d", text: "Lock the account on the 5th failed attempt" },
  ]);
  const rules = findings.map((f) => `${f.where} ${f.rule}`);
  assert.ok(rules.includes("a STE semicolon"));
  assert.ok(rules.includes("b humanizer §8 dash"));
  assert.ok(rules.includes("b humanizer §12 stock AI word"));
  assert.ok(rules.includes("b STE phrasal-verb"));
  assert.ok(!rules.some((r) => r.startsWith("c ") || r.startsWith("d ")), rules.join(", "));
});
