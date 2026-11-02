// Loads a codebase the same way for the CLI, the tests and the evals: picks its
// language pack, reads its .logicmap.json, indexes it, and picks its adapter.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "./paths.mjs";
import { pickAdapter, pickLanguage } from "./languages/index.mjs";
import { checkIndex } from "./languages/contract.mjs";
import { loadConfig } from "./config.mjs";
import { coded } from "./errors.mjs";

export { HOME };

// cwd: where to run the language's tools, so the repo's version manager picks them.
// configRepo: where .logicmap.json lives (the working tree when root is a checked-out commit).
export function loadCodebase(root, cwd = root, { configRepo = cwd, configFile } = {}) {
  const language = pickLanguage(configRepo);
  const config = loadConfig(configRepo, configFile, language);
  const index = language.index({ root, cwd, paths: config.sourcePaths });
  const problems = checkIndex(index);
  if (problems.length) {
    throw coded("INDEX_FAILED", `the ${language.name} index of ${root} breaks the index contract: ${problems.join("; ")}`, "Fix the pack's indexer to match extractor/languages/contract.mjs.", root);
  }
  const resolver = language.createResolver(index);
  const files = new Map();
  const source = (file) => {
    if (!files.has(file)) files.set(file, readFileSync(join(root, file), "utf8").split("\n"));
    return files.get(file);
  };
  const adapter = pickAdapter(language, { index, resolver, source, config });
  return { language, index, resolver, adapter, source, config };
}
