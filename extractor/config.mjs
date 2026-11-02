// A codebase's own conventions, in `.logicmap.json` at its root. The
// framework covers what many codebases of a language share; this file covers
// what only this one does (a custom guard DSL, its own result helpers, where its
// code lives). The language pack adds its defaults and its own keys.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { coded } from "./errors.mjs";

export const CONFIG_FILE = ".logicmap.json";

const DEFAULTS = {
  context: [],
  skipCalls: [],
  entryPoints: [],
};

// Every key the file may hold in any language, with what it means. The pack
// adds its own; anything else is refused.
const KEYS = {
  sourcePaths: "paths the index reads, relative to the codebase root",
  context: "lines about this codebase's own conventions, added to every prompt",
  skipCalls: "regular expressions: a method id that matches is never offered for opening",
  entryPoints: "method id patterns (Class#method, Class.method, * as a wildcard) that are the entry points when no framework adapter applies",
  fieldDepth: "default for --field-depth",
  maxEntries: "default for --max-entries",
  model: "default for --model",
  effort: "default for --effort",
};

const LISTS = ["sourcePaths", "context", "skipCalls", "entryPoints"];

// language: the codebase's language pack (extractor/languages/), for its defaults and keys.
export function loadConfig(repo, explicit, language) {
  if (!language) throw new Error("loadConfig: the language pack is required");
  const own = Object.fromEntries(Object.entries(language.configKeys).map(([k, spec]) => [k, spec.default]));
  const defaults = { ...DEFAULTS, ...language.defaults, ...own };
  const keys = { ...KEYS, ...Object.fromEntries(Object.entries(language.configKeys).map(([k, spec]) => [k, spec.doc])) };
  const lists = [...LISTS, ...Object.keys(language.configKeys)];
  const file = explicit ? resolve(explicit) : join(repo, CONFIG_FILE);
  if (!existsSync(file)) {
    if (explicit) throw coded("CONFIG_INVALID", `--config ${explicit}: no such file`, "Pass the path of a JSON config file.", explicit);
    return { ...defaults, file: null };
  }
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw coded("CONFIG_INVALID", `${file}: not valid JSON (${e.message})`, "Fix the JSON syntax.", file);
  }
  const problems = [];
  if (!data || typeof data !== "object" || Array.isArray(data)) problems.push("the file must hold one JSON object");
  for (const key of Object.keys(data || {})) {
    if (key === "$comment") continue;
    if (!keys[key]) problems.push(`unknown key "${key}"; known keys: ${Object.keys(keys).join(", ")}`);
  }
  for (const key of lists) {
    if (data[key] !== undefined && (!Array.isArray(data[key]) || data[key].some((v) => typeof v !== "string"))) problems.push(`${key} must be a list of strings (${keys[key]})`);
  }
  for (const key of ["fieldDepth", "maxEntries"]) {
    if (data[key] !== undefined && !(Number.isInteger(data[key]) && data[key] >= 0)) problems.push(`${key} must be a whole number`);
  }
  for (const pattern of data.skipCalls || []) {
    try {
      new RegExp(pattern);
    } catch {
      problems.push(`skipCalls: "${pattern}" is not a valid regular expression`);
    }
  }
  if (problems.length) {
    throw coded("CONFIG_INVALID", `${file}: ${problems.join("; ")}`, "Fix the file; README.md lists every key.", file);
  }
  return { ...defaults, ...data, file };
}

// "Tally::*#add" → a regular expression over method ids.
export function methodPattern(glob) {
  return new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
}
