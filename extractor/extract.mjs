// Walks from the entry points through the calls Claude chooses to expand,
// extracting each unit once. Results are cached by the exact prompt, so an
// unchanged method is never sent twice.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PROMPT_VERSION, UNIT_SCHEMA, retryPrompt, systemPrompt, unitPrompt } from "./prompt.mjs";
import { runClaude } from "./llm.mjs";
import { coded } from "./errors.mjs";
import { COPY } from "./copy.mjs";
import { describeFinding, lintTexts } from "./text-lint.mjs";

const CODE = /^[A-Z][A-Z0-9_]*$/;
const MAX_ATTEMPTS = 3;

export async function extractUnits({ roots, index, resolver, adapter, source, options, cacheDir, workDir, log }) {
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  const system = systemPrompt(adapter);
  const units = new Map();
  const depthOf = new Map();
  const stubs = new Map();
  const failures = [];
  const stats = { calls: 0, cached: 0, cost: 0 };
  const queue = [];
  const enqueue = (id, depth) => {
    if (depthOf.has(id)) return;
    depthOf.set(id, depth);
    queue.push(id);
  };
  roots.forEach((id) => enqueue(id, 0));

  const work = async (id) => {
    const depth = depthOf.get(id);
    const unit = resolver.unit(id);
    if (!unit) throw new Error(`no method or declaration unit named ${id}`);
    const fileLines = source(unit.file);
    const sourceText = unit.ranges.map(([a, b]) => fileLines.slice(a - 1, b).join("\n")).join("\n");
    const targets = unit.kind === "method"
      ? describeTargets(resolver.callTargets(unit, sourceText).filter((t) => !adapter.skipTarget(t.id)), index, resolver, source)
      : [];
    const prompt = unitPrompt({ unit, fileLines, owner: index.modules[unit.owner], targets, adapter, seedOutcomes: adapter.seedOutcomes });

    const key = createHash("sha256").update([PROMPT_VERSION, options.model, options.effort, system, prompt].join("\u0000")).digest("hex");
    const cachePath = join(cacheDir, `${key}.json`);
    let output;
    if (existsSync(cachePath)) {
      output = JSON.parse(readFileSync(cachePath, "utf8")).output;
      stats.cached++;
    } else {
      let ask = prompt;
      let errors = [];
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const started = Date.now();
        let result;
        try {
          result = await runClaude({ system, prompt: ask, schema: UNIT_SCHEMA, model: options.model, effort: options.effort, cwd: workDir });
        } catch (e) {
          throw coded("CLAUDE_FAILED", `${id}: ${e.message}`, "Check that `claude -p` works in a terminal, then rerun; finished units come from the cache.", id);
        }
        stats.calls++;
        stats.cost += result.cost;
        errors = checkUnit(result.output, unit, targets, adapter.seedOutcomes);
        log(`  ${errors.length ? "✗" : "✓"} ${id} (${((Date.now() - started) / 1000).toFixed(0)}s${attempt > 1 ? `, attempt ${attempt}` : ""})${errors.length ? `: ${errors.slice(0, 2).join("; ")}${errors.length > 2 ? ` (+${errors.length - 2} more)` : ""}` : ""}`);
        if (!errors.length) {
          output = result.output;
          break;
        }
        ask = retryPrompt(prompt, result.output, errors);
      }
      if (!output) {
        failures.push({ id, code: "UNIT_REJECTED", errors });
        return;
      }
      writeFileSync(cachePath, JSON.stringify({ id, prompt, output }, null, 1));
    }
    units.set(id, { unit, output });

    for (const callee of calledIds(output.steps)) {
      if (depth + 1 > options.maxDepth) stubs.set(callee, COPY.stubDetail(options.maxDepth));
      else enqueue(callee, depth + 1);
    }
  };

  // A small pool: up to `concurrency` units in flight, picking up new callees as they appear.
  const running = new Set();
  while (queue.length || running.size) {
    while (queue.length && running.size < options.concurrency) {
      const id = queue.shift();
      const p = work(id)
        .catch((e) => failures.push({ id, code: e.code || "CLAUDE_FAILED", errors: [e.message] }))
        .finally(() => running.delete(p));
      running.add(p);
    }
    if (running.size) await Promise.race(running);
  }
  for (const id of units.keys()) stubs.delete(id);
  return { units, stubs, failures, stats };
}

// Short methods show their whole body, so Claude can tell a plain predicate
// (not worth opening) from a wrapper that hands off to real decisions.
function describeTargets(targets, index, resolver, source) {
  return targets.map((t) => {
    const m = index.methods[t.id];
    if (m) {
      const size = m.end - m.start + 1;
      const body = size <= 5
        ? ` body: ${source(m.file).slice(m.start - 1, m.end).map((l) => l.trim()).join(" ; ")}`
        : ` (${size} lines)`;
      const doc = m.doc ? ` — ${m.doc.slice(0, 160)}` : "";
      return { ...t, describe: `${m.file}:${m.start}${body}${doc}${t.how === "same name" ? " (matched by name only)" : ""}` };
    }
    const decl = resolver.declarationUnits[t.id];
    return { ...t, describe: decl?.error ? decl.error : `${decl.title} (${decl.declarations.length} declarations in ${decl.file})` };
  });
}

export function calledIds(steps, out = new Set()) {
  for (const s of steps || []) {
    (s.calls || []).forEach((c) => out.add(c));
    calledIds(s.steps, out);
    (s.branches || []).forEach((b) => calledIds(b.steps, out));
  }
  return out;
}

// Deterministic checks on one unit's answer. Anything that fails is sent back
// to Claude with the reasons; nothing is repaired by guessing.
function checkUnit(output, unit, targets, seedOutcomes) {
  const errors = [];
  const allowedCalls = new Set(targets.map((t) => t.id));
  const declared = new Map();
  if (!output.summary || !output.summary.trim()) errors.push("summary is empty");
  for (const o of output.outcomes || []) {
    if (!CODE.test(o.code)) errors.push(`outcome code "${o.code}" is not UPPER_SNAKE_CASE`);
    if (seedOutcomes[o.code] && seedOutcomes[o.code].kind !== o.kind) {
      errors.push(`outcome ${o.code} is already defined as ${seedOutcomes[o.code].kind}; do not redeclare it as ${o.kind}`);
    }
    declared.set(o.code, o);
  }
  const inRanges = (n) => unit.ranges.some(([a, b]) => n >= a && n <= b);

  const checkSteps = (steps, where) => {
    (steps || []).forEach((s, i) => {
      const at = `${where}${i + 1}`;
      if (!s.text || !s.text.trim()) errors.push(`step ${at}: text is empty`);
      if (!Array.isArray(s.lines) || s.lines.length !== 2 || s.lines[0] > s.lines[1]) {
        errors.push(`step ${at}: lines must be [first, last]`);
      } else if (!inRanges(s.lines[0]) || !inRanges(s.lines[1])) {
        errors.push(`step ${at}: lines ${s.lines.join("-")} are outside the source shown (${unit.ranges.map((r) => r.join("-")).join(", ")})`);
      }
      for (const c of s.calls || []) {
        if (!allowedCalls.has(c)) errors.push(`step ${at}: call "${c}" is not one of the offered ids`);
      }
      for (const e of s.exits || []) {
        if (!e.when || !e.when.trim()) errors.push(`step ${at}: an exit has no condition`);
        if (!seedOutcomes[e.outcome] && !declared.has(e.outcome)) errors.push(`step ${at}: outcome ${e.outcome} is neither predefined nor declared in outcomes`);
        if (e.raises && !/^(::)?[A-Z][A-Za-z0-9_]*(::[A-Z][A-Za-z0-9_]*)*$/.test(e.raises)) errors.push(`step ${at}: raises "${e.raises}" is not an exception class name; use "" when the exit raises nothing`);
      }
      if (unit.kind === "declarations" && !unit.allowExits && (s.exits || []).length) errors.push(`step ${at}: these declarations end no request, so their steps take exits []`);
      const decides = [s.exits, s.returns, s.branches, s.calls, s.steps].some((list) => (list || []).length);
      for (const r of s.returns || []) {
        if (!r.when || !r.when.trim() || !r.value || !r.value.trim()) errors.push(`step ${at}: a return needs both when and value`);
      }
      for (const [field, maxWords] of [["question", 12], ["pass", 8]]) {
        const value = (s[field] || "").trim();
        if (!value) continue;
        if (!decides) errors.push(`step ${at}: has a ${field} but no exits, returns, branches, calls or steps, so it decides nothing; use ""`);
        if (value.split(/\s+/).length > maxWords) errors.push(`step ${at}: ${field} is longer than ${maxWords} words`);
      }
      if ((s.branches || []).length === 1) errors.push(`step ${at}: a fork needs at least two branches`);
      const hasBranches = (s.branches || []).length > 0;
      if (hasBranches && ((s.steps || []).length || (s.calls || []).length)) {
        errors.push(`step ${at}: has branches and also steps or calls; move the calls into the branches`);
      }
      checkSteps(s.steps, `${at}.`);
      (s.branches || []).forEach((b, bi) => {
        if (!b.when || !b.when.trim()) errors.push(`step ${at} branch ${bi + 1}: when is empty`);
        checkSteps(b.steps, `${at}.b${bi + 1}.`);
      });
    });
  };
  if (!(output.steps || []).length) errors.push("steps is empty");
  checkSteps(output.steps, "");
  errors.push(...lintTexts(readerTexts(output)).map(describeFinding));
  return errors;
}

// Every string of an answer that the diagram shows a reader, with where it sits.
export function readerTexts(output) {
  const items = [];
  const add = (where, text) => {
    if (typeof text === "string" && text.trim()) items.push({ where, text });
  };
  add("summary", output.summary);
  add("question", output.question);
  add("pass", output.pass);
  (output.outcomes || []).forEach((o) => add(`outcome ${o.code} text`, o.text));
  const walk = (steps, prefix) => (steps || []).forEach((s, i) => {
    const at = `step ${prefix}${i + 1}`;
    for (const field of ["text", "detail", "question", "pass"]) add(`${at} ${field}`, s[field]);
    (s.notes || []).forEach((note, n) => add(`${at} note ${n + 1}`, note));
    (s.exits || []).forEach((e, n) => add(`${at} exit ${n + 1} when`, e.when));
    (s.returns || []).forEach((r, n) => {
      add(`${at} return ${n + 1} when`, r.when);
      add(`${at} return ${n + 1} value`, r.value);
    });
    walk(s.steps, `${prefix}${i + 1}.`);
    (s.branches || []).forEach((b, bi) => {
      add(`${at} branch ${bi + 1} when`, b.when);
      walk(b.steps, `${prefix}${i + 1}.b${bi + 1}.`);
    });
  });
  walk(output.steps, "");
  return items;
}
