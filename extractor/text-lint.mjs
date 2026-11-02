// Checks every text a reader sees against Simplified Technical English (the
// vendored asd-ste100 linter) and the mechanical tells of the vendored
// humanizer. Only hard findings count; the STE linter's advisory ones (passive
// voice, compound tenses) need judgement and stay with the writer.

import { execFileSync } from "node:child_process";
import { coded } from "./errors.mjs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = join(HOME, "skills", "logicmap", "vendor");
const STE_LINT = join(VENDOR, "asd-ste100", "scripts", "ste-lint.py");

// Humanizer patterns a regex can see, by section of vendor/humanizer/SKILL.md.
const HUMANIZER = [
  { rule: "humanizer §1 not X but Y", re: /\bnot (?:just|only|merely)\b[^.]*\bbut\b/i, message: "State the point directly." },
  { rule: "humanizer §4 staged opener", re: /^(?:let's|here's|heads up|quick note|honestly|the thing is)\b/i, message: "Start with the point itself." },
  { rule: "humanizer §8 dash", re: /[—–]|\s--\s/, message: "Join the clauses with a period, comma, colon or parentheses." },
  { rule: "humanizer §12 stock AI word", re: /\b(?:actually|additionally|align(?:s|ed)? with|bolstered|crucial|deep dive|delve[sd]?|enduring|enhance[sd]?|garner(?:s|ed)?|interplay|intricate|intricacies|landscape|meticulous(?:ly)?|pivotal|quietly|showcase[sd]?|tapestry|testament|underscore[sd]?|valuable|vibrant)\b/i, message: "Use the plain word, or state the fact the word inflates." },
  { rule: "humanizer §18 serves as", re: /\b(?:serves|stands|functions|operates) as\b/i, message: "Use is, are or has." },
  { rule: "humanizer §21 curly quotes", re: /[“”‘’]/, message: "Use straight quotes." },
  { rule: "humanizer §22 chatbot residue", re: /\b(?:i hope this helps|great question|let me know)\b/i, message: "Remove the chat wrapper." },
];

// items: [{ where, text }]. Returns [{ where, rule, match, message }].
export function lintTexts(items) {
  const texts = items.map((item) => item.text.replace(/\s+/g, " ").trim());
  const findings = [];
  texts.forEach((text, i) => {
    for (const p of HUMANIZER) {
      const m = text.match(p.re);
      if (m) findings.push({ where: items[i].where, rule: p.rule, match: m[0], message: p.message });
    }
  });
  if (!texts.length) return findings;

  // One paragraph per text, closed with a period, so labels never merge into one sentence.
  const lineOf = [];
  const input = texts.map((text, i) => {
    lineOf.push(i, null);
    return /[.?!:]$/.test(text) ? text : `${text}.`;
  }).join("\n\n");
  let report;
  try {
    const python = process.env.LOGICMAP_PYTHON || "python3";
    report = JSON.parse(execFileSync(python, [STE_LINT, "--json", "--baseline", "1000000000"], { input, stdio: ["pipe", "pipe", "pipe"] }).toString());
  } catch (e) {
    if (e.code === "ENOENT") throw coded("PYTHON_MISSING", `${process.env.LOGICMAP_PYTHON || "python3"} was not found`, "Install Python 3, or set LOGICMAP_PYTHON to a Python 3 executable.");
    throw new Error(`the STE linter (${STE_LINT}) did not run: ${String(e.stderr || e.message).trim().split("\n")[0]}`);
  }
  for (const v of report.violations) {
    if (v.level !== "advisory-free") continue;
    const i = lineOf[v.line - 1];
    findings.push({ where: i == null ? "text" : items[i].where, rule: `STE ${v.rule}`, match: v.match, message: v.message });
  }
  return findings;
}

export function describeFinding(f) {
  return `${f.where}: ${f.rule} at "${f.match}". ${f.message}`;
}
