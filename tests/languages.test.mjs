// The language packs: which pack a codebase gets, and the contracts every pack
// and its index meet (extractor/languages/contract.mjs).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HOME, loadCodebase } from "../extractor/load.mjs";
import { LANGUAGES, pickLanguage } from "../extractor/languages/index.mjs";
import { checkIndex, checkPack } from "../extractor/languages/contract.mjs";

// A temporary folder holding the given files.
function folder(files) {
  const dir = mkdtempSync(join(tmpdir(), "logicmap-lang-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

test("languages: every pack meets the pack contract, and a broken pack is named", () => {
  for (const pack of LANGUAGES) assert.deepEqual(checkPack(pack), [], pack.name);
  const problems = checkPack({ name: "Go!", label: "Go", adapters: [] });
  assert.ok(problems.includes("name must be a lowercase id"));
  assert.ok(problems.includes("adapters must be a non-empty list"));
  assert.ok(problems.includes("prompt.exceptionName must be a RegExp"));
});

test("languages: every fixture's index meets the index contract, and a broken index is named", () => {
  for (const [name, language] of [["graphql-standard", "ruby"], ["rails-graphql", "ruby"], ["plain-ruby", "ruby"], ["typescript-express", "typescript"], ["javascript-plain", "typescript"]]) {
    const codebase = loadCodebase(join(HOME, "tests", "fixtures", name));
    assert.equal(codebase.language.name, language, name);
    assert.deepEqual(checkIndex(codebase.index), [], name);
  }
  const broken = { files_read: ["a.rb"], methods: { "A#b": { id: "A#c", name: "b", owner: "A", file: "a.rb", start: 3, end: 2 } }, modules: {}, constant_defs: [] };
  assert.deepEqual(checkIndex(broken), ['methods[A#b].id is "A#c"', "methods[A#b] needs lines start <= end"]);
});

test("languages: the strongest sign picks the pack, a project file at the root first", () => {
  assert.equal(pickLanguage(folder({ Gemfile: "" })).name, "ruby");
  assert.equal(pickLanguage(folder({ "tool.gemspec": "" })).name, "ruby");
  assert.equal(pickLanguage(folder({ "src/deep/tool.rb": "" })).name, "ruby");
  assert.equal(pickLanguage(folder({ "package.json": "{}" })).name, "typescript");
  assert.equal(pickLanguage(folder({ "lib/deep/tool.js": "" })).name, "typescript");
  assert.equal(pickLanguage(folder({ "package.json": "{}", "scripts/release.rb": "" })).name, "typescript", "a stray Ruby script does not make a JavaScript repo Ruby");
  assert.equal(pickLanguage(folder({ Gemfile: "", "package.json": "{}" })).name, "ruby", "a Rails app with a package.json stays Ruby: a tie goes to the first pack");
});

test("languages: a codebase no pack recognises is UNSUPPORTED_LANGUAGE, with a remedy and a run report", () => {
  const go = folder({ "go.mod": "module shop\n", "main.go": "package main\n", "node_modules/tool/build.rb": "", "vendor/tool/x.js": "" });
  assert.throws(() => loadCodebase(go), (e) => e.code === "UNSUPPORTED_LANGUAGE" && /packs: ruby, typescript/.test(e.message), "files inside node_modules and vendor do not count");

  const cache = mkdtempSync(join(tmpdir(), "logicmap-cache-"));
  const run = spawnSync("node", [join(HOME, "extractor", "cli.mjs"), "--repo", go, "--list"], { env: { ...process.env, LOGICMAP_CACHE: cache } });
  assert.equal(run.status, 1);
  assert.match(run.stderr.toString(), /^error\[UNSUPPORTED_LANGUAGE\]: no language pack recognises the codebase at .*\n {2}remedy: /);
  assert.equal(JSON.parse(readFileSync(join(cache, "last-run.json"), "utf8")).error.code, "UNSUPPORTED_LANGUAGE");

  assert.throws(() => pickLanguage(join(go, "missing")), (e) => e.code === "BAD_ARGUMENT");
});
