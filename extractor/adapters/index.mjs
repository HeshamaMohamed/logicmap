// Every adapter, tried in order. A new kind of codebase is a new adapter
// file listed here (skills/logicmap/EVOLVE.md).

import * as railsGraphql from "./rails-graphql.mjs";
import * as rails from "./rails.mjs";
import * as ruby from "./ruby.mjs";
import { coded } from "../errors.mjs";

const ADAPTERS = [railsGraphql, rails, ruby];

export function pickAdapter({ index, resolver, source, config }) {
  const match = ADAPTERS.find((a) => a.detect(index, resolver));
  if (!match) {
    throw coded("UNSUPPORTED_CODEBASE", `no adapter recognises this codebase (tried: ${ADAPTERS.map((a) => a.NAME).join(", ")})`, "Add an adapter for this kind of codebase (skills/logicmap/EVOLVE.md).");
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
