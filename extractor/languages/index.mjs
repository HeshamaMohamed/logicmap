// The language packs, tried in order, and the adapter a codebase gets. A new
// language is a new folder here whose pack.mjs meets contract.mjs.

import { existsSync } from "node:fs";
import ruby from "./ruby/pack.mjs";
import { checkPack } from "./contract.mjs";
import { coded } from "../errors.mjs";

export const LANGUAGES = [ruby];

export function pickLanguage(root) {
  for (const pack of LANGUAGES) {
    const problems = checkPack(pack);
    if (problems.length) throw coded("PACK_INVALID", `the ${pack?.name || "unnamed"} language pack breaks the pack contract: ${problems.join("; ")}`, "Fix the pack to match extractor/languages/contract.mjs.", pack?.name);
  }
  if (!existsSync(root)) throw coded("BAD_ARGUMENT", `${root} does not exist`, "Pass --repo PATH to the root of an existing codebase.", root);
  const match = LANGUAGES.find((pack) => pack.detect(root));
  if (!match) {
    throw coded("UNSUPPORTED_LANGUAGE", `no language pack recognises the codebase at ${root} (packs: ${LANGUAGES.map((p) => p.name).join(", ")})`, "Point --repo at the root of a codebase in one of those languages, or add a language pack (CONTRIBUTING.md).", root);
  }
  return match;
}

export function pickAdapter(language, { index, resolver, source, config }) {
  const match = language.adapters.find((a) => a.detect(index, resolver));
  if (!match) {
    throw coded("UNSUPPORTED_CODEBASE", `no adapter recognises this codebase (tried: ${language.adapters.map((a) => a.NAME).join(", ")})`, "Add an adapter for this kind of codebase (skills/logicmap/EVOLVE.md).");
  }
  const adapter = match.createAdapter({ index, resolver, source, config });
  const entryPoints = adapter.entryPoints;
  adapter.entryPoints = (options) => markDuplicates(entryPoints(options));
  return adapter;
}

// Two entry points with one id can't both be named: both are marked, the rest of the codebase still extracts.
function markDuplicates({ found, skipped }) {
  const byId = new Map();
  for (const ep of found) byId.set(ep.id, [...(byId.get(ep.id) || []), ep]);
  for (const [id, eps] of byId) {
    if (eps.length < 2) continue;
    for (const ep of eps) {
      ep.unsupported = [...(ep.unsupported || []), {
        code: "DUPLICATE_ENTRY_POINT",
        message: `${eps.length} entry points share the id ${id}: ${eps.map((e) => e.className).join(", ")}`,
        remedy: "Name one of them as a method instead (--entries Class#method), or make the adapter's ids unique (skills/logicmap/EVOLVE.md).",
      }];
    }
  }
  return { found, skipped };
}

// The error for an entry point the adapter marked as one it cannot read.
export function unsupportedError(ep) {
  const first = ep.unsupported[0];
  return coded(first.code, `${ep.name}: ${first.message}`, first.remedy, ep.id);
}
