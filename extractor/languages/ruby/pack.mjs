// Ruby: Prism indexes the code (index.rb), resolve.mjs follows Ruby's constant
// and method lookup, and three adapters read Rails with graphql-ruby, plain
// Rails and plain Ruby. The contract is ../contract.mjs.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOME } from "../../paths.mjs";
import { coded } from "../../errors.mjs";
import { createResolver } from "./resolve.mjs";
import { coverage } from "./coverage.mjs";
import * as railsGraphql from "./adapters/rails-graphql.mjs";
import * as rails from "./adapters/rails.mjs";
import * as plainRuby from "./adapters/ruby.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKIP_DIRS = new Set(["node_modules", "vendor", "tmp", "log"]);
const MAX_DEPTH = 6;

// A Gemfile or a gemspec at the root, else a Ruby file in the folders below it.
function detect(root) {
  if (existsSync(join(root, "Gemfile"))) return true;
  if (readdirSync(root).some((f) => f.endsWith(".gemspec"))) return true;
  return holdsRuby(root, 0);
}

function holdsRuby(dir, depth) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  if (entries.some((e) => e.isFile() && /\.(rb|rake)$/.test(e.name))) return true;
  if (depth >= MAX_DEPTH) return false;
  return entries.some((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name) && holdsRuby(join(dir, e.name), depth + 1));
}

// The index only parses files, so any Ruby with the prism parser will do: the
// codebase's own Ruby (its version manager picks it in the repo), then
// LOGICMAP_RUBY, then the Ruby the framework's folder gets.
function index({ root, cwd, paths }) {
  const script = join(HERE, "index.rb");
  const candidates = [["ruby", cwd], ...(process.env.LOGICMAP_RUBY ? [[process.env.LOGICMAP_RUBY, cwd]] : []), ["ruby", HOME]];
  const missing = [];
  for (const [ruby, at] of candidates) {
    try {
      const out = execFileSync(ruby, [script, root, ...paths], { cwd: at, maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "pipe"] });
      return JSON.parse(out.toString());
    } catch (e) {
      const why = String(e.stderr || e.message).trim().split("\n")[0];
      if (e.code === "ENOENT" || /cannot load such file -- prism|LoadError/.test(why)) {
        missing.push(`${ruby} in ${at}: ${e.code === "ENOENT" ? "not found" : why}`);
        continue;
      }
      throw coded("INDEX_FAILED", `indexing ${root} failed: ${why}`, "A parse error names the file to fix; run the same command by hand to see the full message.", root);
    }
  }
  throw coded("PRISM_MISSING", `no Ruby with prism: ${missing.join("; ")}`, "Use Ruby 3.3+ (prism ships with it), or run `gem install prism` on Ruby 2.7+, or set LOGICMAP_RUBY to such a Ruby.");
}

export default {
  name: "ruby",
  label: "Ruby",
  detect,
  defaults: { sourcePaths: ["app", "lib", "config/routes.rb", "config/initializers"] },
  configKeys: {
    guardDsl: { doc: "class-level methods whose symbol argument names a guard method (GraphQL operations)", default: ["guard"] },
  },
  treePaths: (config) => [...config.sourcePaths, "config"],
  index,
  createResolver,
  adapters: [railsGraphql, rails, plainRuby],
  prompt: {
    branchPoints: "if, unless, case, ternary, rescue, raise, early return, guard",
    exceptionExample: "ActiveRecord::RecordNotFound",
    exceptionName: /^(::)?[A-Z][A-Za-z0-9_]*(::[A-Z][A-Za-z0-9_]*)*$/,
  },
  coverage,
};
