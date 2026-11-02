// Loads a codebase the same way for the CLI, the tests and the evals.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "./paths.mjs";
import { createResolver } from "./resolve.mjs";
import { pickAdapter } from "./adapters/index.mjs";
import { DEFAULTS, loadConfig } from "./config.mjs";
import { coded } from "./errors.mjs";

export { HOME };
// What the index reads by default, relative to the codebase root (sourcePaths in .logicmap.json).
export const SOURCE_DIRS = DEFAULTS.sourcePaths;

// rubyCwd: where to start Ruby, so the repo's version manager picks its Ruby.
// configRepo: where .logicmap.json lives (the working tree when root is a checked-out commit).
export function loadCodebase(root, rubyCwd = root, { configRepo = rubyCwd, configFile } = {}) {
  const config = loadConfig(configRepo, configFile);
  const index = runIndex(root, rubyCwd, config.sourcePaths);
  const resolver = createResolver(index);
  const files = new Map();
  const source = (file) => {
    if (!files.has(file)) files.set(file, readFileSync(join(root, file), "utf8").split("\n"));
    return files.get(file);
  };
  const adapter = pickAdapter({ index, resolver, source, config });
  return { index, resolver, adapter, source, config };
}

// The index only parses files, so any Ruby with the prism parser will do: the
// codebase's own Ruby (its version manager picks it in the repo), then
// LOGICMAP_RUBY, then the Ruby the framework's folder gets.
function runIndex(root, rubyCwd, paths) {
  const script = join(HOME, "extractor", "ruby", "index.rb");
  const candidates = [["ruby", rubyCwd], ...(process.env.LOGICMAP_RUBY ? [[process.env.LOGICMAP_RUBY, rubyCwd]] : []), ["ruby", HOME]];
  const missing = [];
  for (const [ruby, cwd] of candidates) {
    try {
      const out = execFileSync(ruby, [script, root, ...paths], { cwd, maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "pipe"] });
      return JSON.parse(out.toString());
    } catch (e) {
      const why = String(e.stderr || e.message).trim().split("\n")[0];
      if (e.code === "ENOENT" || /cannot load such file -- prism|LoadError/.test(why)) {
        missing.push(`${ruby} in ${cwd}: ${e.code === "ENOENT" ? "not found" : why}`);
        continue;
      }
      throw coded("INDEX_FAILED", `indexing ${root} failed: ${why}`, "A parse error names the file to fix; run the same command by hand to see the full message.", root);
    }
  }
  throw coded("PRISM_MISSING", `no Ruby with prism: ${missing.join("; ")}`, "Use Ruby 3.3+ (prism ships with it), or run `gem install prism` on Ruby 2.7+, or set LOGICMAP_RUBY to such a Ruby.");
}
