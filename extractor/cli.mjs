#!/usr/bin/env node
// logicmap: a Ruby codebase's decisions as a decision-graph/0.1 JSON file.
//
//   bin/logicmap --repo PATH --list
//   bin/logicmap --repo PATH --base main [--head REF] [--plan]   a PR: the entry points it reaches
//   bin/logicmap --repo PATH --change SHA [--plan]               one commit
//   bin/logicmap --repo PATH --entries a,b                       a feature: entry points by name or id
//   bin/logicmap --repo PATH --all
//   bin/logicmap view [--port 8765]                               serve the viewer for the graphs written
//
// Options: --config FILE (default: the repo's .logicmap.json), --out FILE, --max-entries (12),
// --model (claude-opus-5-5), --effort (medium),
// --concurrency (4), --max-depth (6), --field-depth (1: the result type's fields and the
// types one level under it). Every run writes .cache/last-run.json
// (LOGICMAP_CACHE moves the cache).

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCodebase } from "./load.mjs";
import { CACHE, GRAPHS, HOME, REPORT } from "./paths.mjs";
import { serve } from "./view.mjs";
import { loadConfig } from "./config.mjs";
import { extractUnits } from "./extract.mjs";
import { assemble } from "./assemble.mjs";
import { checkoutTree, markChanges, readChange, resolveChange } from "./change.mjs";
import { affectedEntries, changedUnits, markIndirect, staticCalls, stepRoots, uncoveredChanges } from "./affected.mjs";
import { coded } from "./errors.mjs";
import { unsupportedError } from "./adapters/rails.mjs";
import { validate } from "../lib/validate.mjs";


const OPTIONS = {
  repo: { value: true }, entries: { value: true }, all: {}, list: {}, plan: {}, help: {},
  change: { value: true }, base: { value: true }, head: { value: true }, out: { value: true },
  "max-entries": { value: true }, model: { value: true }, effort: { value: true },
  concurrency: { value: true, default: "4" }, "max-depth": { value: true, default: "6" },
  "field-depth": { value: true }, config: { value: true },
};
// Used when neither the flag nor the codebase's .logicmap.json sets one.
const FALLBACK = { "max-entries": "12", model: "claude-opus-5-5", effort: "medium", "field-depth": "1" };

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].replace(/^--/, "");
    const spec = OPTIONS[name];
    if (!argv[i].startsWith("--") || !spec) {
      throw coded("BAD_ARGUMENT", `unknown argument "${argv[i]}"`, `Use one of: ${Object.keys(OPTIONS).map((o) => `--${o}`).join(" ")}.`, argv[i]);
    }
    if (spec.value) {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) throw coded("BAD_ARGUMENT", `--${name} needs a value`, `Pass --${name} VALUE.`, `--${name}`);
      args[name] = argv[++i];
    } else {
      args[name] = true;
    }
  }
  for (const [name, spec] of Object.entries(OPTIONS)) if (spec.default && args[name] === undefined) args[name] = spec.default;
  return args;
}

function positiveInt(name, value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || (n === 0 && !["max-depth", "field-depth"].includes(name))) {
    throw coded("BAD_ARGUMENT", `--${name} must be a whole number above 0, got "${value}"`, `Pass --${name} N.`, `--${name}`);
  }
  return n;
}

const report = { status: "running", started: new Date().toISOString(), argv: process.argv.slice(2) };
function writeReport(fields) {
  Object.assign(report, fields, { finished: new Date().toISOString() });
  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
}

async function main() {
  if (process.argv[2] === "view") {
    const port = process.argv[3] === "--port" ? Number(process.argv[4]) : 8765;
    if (!Number.isInteger(port) || port < 1 || process.argv.length > (process.argv[3] ? 5 : 3)) {
      throw coded("BAD_ARGUMENT", `view takes only --port N, got: ${process.argv.slice(3).join(" ")}`, "Run: bin/logicmap view [--port 8765]");
    }
    await serve(port);
    console.log(`Viewer: http://localhost:${port}/viewer/?graph=NAME  (graphs in ${GRAPHS})`);
    return;
  }
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.repo) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 12).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    if (!args.help) throw coded("BAD_ARGUMENT", "--repo is required", "Pass --repo PATH to the codebase root.", "--repo");
    return;
  }
  const repo = resolve(args.repo);
  // Flags win, then the codebase's .logicmap.json, then FALLBACK.
  const config = loadConfig(repo, args.config);
  const fromConfig = { "max-entries": config.maxEntries, model: config.model, effort: config.effort, "field-depth": config.fieldDepth };
  for (const [name, value] of Object.entries(FALLBACK)) args[name] ??= fromConfig[name] !== undefined ? String(fromConfig[name]) : value;
  if (config.file) report.config = config.file;
  const options = {
    model: args.model,
    effort: args.effort,
    concurrency: positiveInt("concurrency", args.concurrency),
    maxDepth: positiveInt("max-depth", args["max-depth"]),
  };
  const maxEntries = positiveInt("max-entries", args["max-entries"]);
  if (!["low", "medium", "high", "xhigh", "max"].includes(options.effort)) {
    throw coded("BAD_ARGUMENT", `--effort must be low, medium, high, xhigh or max, got "${options.effort}"`, "Pass a supported --effort.", "--effort");
  }

  // The code to read: the working tree, or the head of the change under review.
  const range = resolveChange(repo, args);
  const change = range ? readChange(repo, range) : null;
  const root = range ? checkoutTree(repo, range.headSha, join(CACHE, "trees", range.headSha), [...config.sourcePaths, "config"]) : repo;
  if (change) report.change = { label: change.label, title: change.title, hunks: change.hunks.length };

  const { index, resolver, adapter, source } = loadCodebase(root, repo, { configRepo: repo, configFile: args.config });
  const fieldDepth = positiveInt("field-depth", args["field-depth"]);
  const { found, skipped } = adapter.entryPoints({ fieldDepth });

  if (args.list) {
    for (const ep of found) console.log(`${ep.kind.padEnd(17)} ${ep.name.padEnd(44)} ${ep.className}${ep.unsupported?.length ? `  [${ep.unsupported[0].code}]` : ""}`);
    const marked = found.filter((ep) => ep.unsupported?.length).length;
    console.log(`\n${found.length} entry points${marked ? `, ${marked} marked [CODE] until the adapter reads them` : ""}; ${skipped.length} skipped (abstract bases, routes to gem code, missing controllers), listed in .cache/last-run.json`);
    writeReport({ status: "ok", mode: "list", entryPoints: found.map((ep) => ep.name), unsupported: found.filter((ep) => ep.unsupported?.length).map((ep) => ({ entry: ep.name, ...ep.unsupported[0] })), skipped });
    return;
  }

  // Which entry points: named, all, or every one the change reaches.
  let entries;
  let changed = null;
  let unreached = [];
  if (change) changed = changedUnits(index, resolver, change);
  if (args.entries) {
    const byName = new Map(found.flatMap((ep) => [[ep.id, ep], [ep.name, ep]]));
    const wanted = args.entries.split(",").map((s) => s.trim()).filter(Boolean);
    // Any method of the codebase works as an entry point too: Class#method or Class.method.
    const adHoc = (id) => {
      const m = index.methods[id];
      return m && { id, kind: "method", name: id, className: m.owner, method: id, trigger: `${m.file}:${m.start}`, summary: m.doc || undefined, steps: [{ inline: id }], unsupported: [] };
    };
    const unknown = wanted.filter((n) => !byName.has(n) && !index.methods[n]);
    if (unknown.length) throw coded("UNKNOWN_ENTRY", `no entry point or method named ${unknown.join(", ")}`, "Run with --list for entry points, or name a method as Class#method or Class.method.", unknown.join(","));
    entries = wanted.map((n) => byName.get(n) || adHoc(n));
  } else if (args.all) {
    entries = found;
  } else if (change) {
    // Reach is checked through deeper field levels; a changed field method found there joins the entry's fields.
    const deep = adapter.entryPoints({ fieldDepth: Math.max(fieldDepth, 3) }).found;
    ({ affected: entries, unreached } = affectedEntries(deep, staticCalls(index, resolver, source), changed));
    const shallow = new Map(found.map((ep) => [ep.id, ep]));
    entries = entries.map((ep) => {
      const kept = shallow.get(ep.id);
      const deepFields = ep.steps.find((s) => s.fields)?.fields || [];
      const extra = deepFields.filter((f) => changed.has(f.method) && !(kept.steps.find((s) => s.fields)?.fields || []).some((k) => k.method === f.method));
      if (!extra.length) return { ...kept, distance: ep.distance, reaches: ep.reaches };
      const steps = kept.steps.filter((s) => !s.fields);
      const fields = [...(kept.steps.find((s) => s.fields)?.fields || []), ...extra];
      return { ...kept, steps: [...steps, { fields }], distance: ep.distance, reaches: ep.reaches };
    });
    if (entries.length > maxEntries && !args.plan) {
      throw coded("TOO_MANY_AFFECTED", `the change reaches ${entries.length} entry points, more than --max-entries ${maxEntries}; nearest: ${entries.slice(0, maxEntries).map((ep) => `${ep.name} (${ep.distance})`).join(", ")}`, "Run with --plan to see them all, then pick with --entries a,b,c or raise --max-entries.", String(entries.length));
    }
  } else {
    throw coded("BAD_ARGUMENT", "no entry points chosen", "Pass --entries a,b,c, --all, or a change (--change SHA, --base REF).");
  }
  const blocked = entries.find((ep) => ep.unsupported?.length);
  if (blocked && !args.plan) throw unsupportedError(blocked);
  if (!entries.length) {
    throw coded("NO_ENTRIES", "the change reaches no entry point", "Name entry points with --entries; the changed units are in .cache/last-run.json.", change?.label);
  }

  const plan = {
    entries: entries.map((ep) => ep.name),
    reach: entries.filter((ep) => ep.reaches).map((ep) => ({ entry: ep.name, distance: ep.distance, reaches: ep.reaches })),
    changedUnits: changed ? [...changed.keys()] : [],
    changedUnitsNoEntryReaches: unreached,
  };
  if (args.plan) {
    console.log(`Plan: ${plan.entries.length} entry point(s)${plan.entries.length > maxEntries ? `, more than --max-entries ${maxEntries}` : ""}`);
    for (const r of plan.reach) console.log(`  ${r.entry.padEnd(36)} ${r.distance} call(s) from ${r.reaches.slice(0, 3).join(", ")}${r.reaches.length > 3 ? ", …" : ""}`);
    if (!plan.reach.length) console.log(`  ${plan.entries.join(", ")}`);
    if (change) console.log(`Change ${change.label} "${change.title}": ${change.hunks.length} hunk(s), ${plan.changedUnits.length} changed unit(s), ${unreached.length} no entry point reaches`);
    writeReport({ status: "ok", mode: "plan", plan });
    return;
  }

  console.log(`Extracting ${entries.length} entry point(s) from ${root} with ${options.model} (effort ${options.effort})`);
  const roots = [...new Set(entries.flatMap(stepRoots))];
  const { units, stubs, failures, stats } = await extractUnits({
    roots, index, resolver, adapter, source, options,
    cacheDir: join(CACHE, "units"),
    workDir: join(CACHE, "claude-cwd"),
    log: (line) => console.log(line),
  });
  console.log(`Units: ${units.size} (${stats.cached} from cache, ${stats.calls} Claude calls, $${stats.cost.toFixed(2)})`);
  report.stats = { units: units.size, ...stats };
  if (failures.length) {
    report.failures = failures;
    const first = failures[0];
    throw coded(first.code, `${failures.length} unit(s) could not be extracted, first ${first.id}: ${first.errors.join("; ")}`, first.code === "UNIT_REJECTED" ? "Read the reasons in .cache/last-run.json; a prompt or check change belongs in the evolve loop (skills/logicmap/EVOLVE.md)." : "Fix the cause and rerun; finished units come from the cache.", first.id);
  }

  const codebase = { name: basename(repo), path: repo, commit: change ? change.label : gitHead(repo), language: "ruby" };
  const { graph, ranges, problems, extracted, folded } = assemble({ codebase, adapter, entries, units, stubs, index });
  if (problems.length) {
    report.problems = problems;
    throw coded(problems[0].code, `the units do not fit together: ${problems.map((p) => p.message).join("; ")}`, "Read the problems in .cache/last-run.json and follow skills/logicmap/EVOLVE.md.");
  }
  if (change) {
    const direct = markChanges(graph, ranges, change);
    const indirect = markIndirect({ graph, ranges, unmatched: direct.unmatched, index, resolver, source });
    const uncovered = uncoveredChanges({ unmatched: indirect.unmatched, index, resolver, extracted, folded, sourceDirs: config.sourcePaths, source, explainConstant: adapter.explainConstant });
    if (uncovered.length) graph.coverage = { uncovered };
    console.log(`Change ${change.label} "${change.title}": ${direct.marked + indirect.marked} node(s) marked (${indirect.marked} through constants or unopened methods); ${uncovered.length} changed hunk(s) not in the graph`);
  }
  const errors = validate(graph);
  if (errors.length) {
    report.problems = errors.map((message) => ({ code: "GRAPH_INVALID", message }));
    throw coded("GRAPH_INVALID", `the assembled graph is invalid: ${errors.slice(0, 3).join("; ")}`, "Fix assemble.mjs or the extractor checks so they agree with lib/validate.mjs (skills/logicmap/EVOLVE.md).");
  }

  const name = change ? `${basename(repo)}--${change.label}` : basename(repo);
  const out = resolve(args.out || join(GRAPHS, `${name}.json`));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(graph, null, 2)}\n`);
  const graphName = basename(out, ".json");
  console.log(`Wrote ${out}: ${graph.entryPoints.length} entry points, ${Object.keys(graph.nodes).length} nodes${stubs.size ? `, ${stubs.size} cut at --max-depth` : ""}`);
  console.log(`View: http://localhost:8765/viewer/?graph=${encodeURIComponent(graphName)}  (start the viewer with: bin/logicmap view)`);
  writeReport({
    status: "ok",
    mode: change ? "change" : "entries",
    graph: out,
    graphName,
    plan,
    notes: Object.values(graph.nodes).reduce((n, node) => n + (node.notes || []).length, 0),
    changedNodes: Object.entries(graph.nodes).filter(([, node]) => node.change).map(([id]) => id),
    coverage: graph.coverage || { uncovered: [] },
  });
}

function gitHead(repo) {
  try {
    return execFileSync("git", ["-C", repo, "rev-parse", "--short", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return undefined;
  }
}

main().catch((e) => {
  const error = { code: e.code || "INTERNAL", message: e.message, remedy: e.remedy, subject: e.subject };
  console.error(`error[${error.code}]: ${error.message}${error.remedy ? `\n  remedy: ${error.remedy}` : ""}`);
  if (!e.code) console.error(e.stack);
  writeReport({ status: "error", error });
  process.exit(1);
});
