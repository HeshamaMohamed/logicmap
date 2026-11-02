// The prompt and output schema for one unit (a method, or a model's declarations).

import { OUTCOME_KINDS } from "../lib/validate.mjs";

export const PROMPT_VERSION = "unit-v7";

const system = (language) => `You turn one unit of ${language.label} code into a decision flow that reviewers read in place of the code. The flow is faithful: each step states, in plain domain English and with the code's own values, what the code at its lines decides or does.

The flow is done when every branch point in the source (${language.prompt.branchPoints}) belongs to a step that states it.

Reader text: every string a reader sees (summary, question, pass, text, detail, notes, each when and value, each outcome text) is Simplified Technical English written by a careful engineer:
- One fact per sentence, at most 25 words, in active voice and a simple tense.
- The plain verb for an action ("check the date", "analyze the log"), and one name for each thing and one verb for each action across the whole unit.
- Clauses join with a comma, a colon or parentheses, or split into two sentences.
- The fact carries its own weight: the plain word in place of an intensifier, and a hedge only where the code itself is uncertain.
- Straight quotes.

Decision fields, for the unit as a whole and for any step that decides (it has exits, returns or branches, or its calls can end the request):
- question: the decision as a question, at most 8 words ("Is the caller signed in?", "Which kind of invitation?").
- pass: the answer that lets the flow carry on, at most 6 words ("Signed in").
A unit or step that decides nothing carries "" in both.

Unit fields:
- summary: what the unit decides or does, at most 12 words of domain language, worded for a box in a diagram ("Check the caller may act on this project").
- question, pass: the decision fields.
- steps: the unit's behaviour in execution order, one step per decision or meaningful action. Plumbing (reading params, building hashes, logging) folds into the step it serves.
- outcomes: each outcome code the steps use beyond "Outcome codes already defined": code in UPPER_SNAKE_CASE (a success code names the result, "PAYMENT_RECORDED"), kind (${OUTCOME_KINDS.join(", ")}), and a 2 to 5 word text.

Step fields:
- text: the rule with its concrete values, at most 16 words of domain language ("Lock the account on the 5th failed attempt"). For a check: what it requires, or what happens when it fails.
- detail: a sentence or two for a nuance the text cannot hold; else "".
- lines: [first, last] lines of the numbered source this step states.
- exits: each way the unit's own code ends the request here: an exception that escapes (its code from the exception table), a returned mutation result, a rendered response. when = the condition, outcome = the code, raises = the exception class when the ending is an escaping exception ("${language.prompt.exceptionExample}"), else "". An ending inside a called method belongs to that method: list the method in calls, and its exit shows there. Exits cover what real input can trigger; infrastructure faults (a database outage, saving data already validated) stay out.
- returns: each early result a helper hands back to its caller while the request carries on: when = the condition, value = the result in 1 to 4 words ("Deny", "No project"). Includes the final result when it depends on this step.
- question, pass: the decision fields.
- branches: a fork, where the code takes different paths that each do different work (if/else, case/when), rejoining afterwards or not. One branch per path: when = its condition, steps = its work ([] for a path that does nothing). A guard that ends the request on one side is a decision with exits and pass; paths that differ only in a value form one step.
- steps: sub-steps grouped under this step. A step carries steps and calls, or branches.
- calls: offered ids whose code holds further decisions behind this step, for the reader to open. A short wrapper that hands off to real decisions is listed; an offered method whose whole logic the step text already states (a one-line predicate, a getter) stays unlisted, as do logging, analytics and formatting.
- notes: a decision a careful reviewer would question: a swallowed error, a silent fallback, a partial write outside a transaction, a security gap, behaviour contradicting the code's own comments. One or two sentences naming what happens and why it matters, grounded in the code shown. Most steps carry [].`;

// language: the codebase's language pack, which names its branch points and exceptions.
export function systemPrompt(language, adapter) {
  return `${system(language)}\n\n${adapter.context}`;
}

function stepSchema(depth) {
  const properties = {
    text: { type: "string" },
    detail: { type: "string" },
    lines: { type: "array", items: { type: "integer" } },
    exits: {
      type: "array",
      items: {
        type: "object",
        properties: { when: { type: "string" }, outcome: { type: "string" }, raises: { type: "string" } },
        required: ["when", "outcome", "raises"],
        additionalProperties: false,
      },
    },
    calls: { type: "array", items: { type: "string" } },
    notes: { type: "array", items: { type: "string" } },
    returns: {
      type: "array",
      items: {
        type: "object",
        properties: { when: { type: "string" }, value: { type: "string" } },
        required: ["when", "value"],
        additionalProperties: false,
      },
    },
    question: { type: "string" },
    pass: { type: "string" },
  };
  const required = ["text", "detail", "lines", "exits", "returns", "calls", "notes", "question", "pass"];
  if (depth > 0) {
    const child = stepSchema(depth - 1);
    properties.steps = { type: "array", items: child };
    properties.branches = {
      type: "array",
      items: {
        type: "object",
        properties: { when: { type: "string" }, steps: { type: "array", items: child } },
        required: ["when", "steps"],
        additionalProperties: false,
      },
    };
    required.push("steps", "branches");
  }
  return { type: "object", properties, required, additionalProperties: false };
}

export const UNIT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    question: { type: "string" },
    pass: { type: "string" },
    steps: { type: "array", items: stepSchema(2) },
    outcomes: {
      type: "array",
      items: {
        type: "object",
        properties: { code: { type: "string" }, kind: { type: "string", enum: OUTCOME_KINDS }, text: { type: "string" } },
        required: ["code", "kind", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "question", "pass", "steps", "outcomes"],
  additionalProperties: false,
};

function numbered(lines, from, to) {
  const out = [];
  for (let n = from; n <= to; n++) out.push(`${String(n).padStart(4)}| ${lines[n - 1] ?? ""}`);
  return out.join("\n");
}

export function unitPrompt({ unit, fileLines, owner, targets, adapter, seedOutcomes }) {
  const parts = [];
  if (unit.kind === "method") {
    parts.push(`Method: ${unit.id}`, `File: ${unit.file}, lines ${unit.start}-${unit.end}`);
    const decls = (owner?.declarations || []).filter((d) => d.file === unit.file).slice(0, 40);
    if (decls.length) {
      parts.push("", `Declarations in the body of ${unit.owner} (context only):`);
      decls.forEach((d) => parts.push(`${String(d.start).padStart(4)}| ${d.source.split("\n")[0]}`));
    }
    if (unit.doc) parts.push("", `Comment above the method: ${unit.doc}`);
    parts.push("", "Source:", numbered(fileLines, unit.start, unit.end));
  } else {
    parts.push(
      `Declarations: ${unit.title}`,
      `File: ${unit.file}`,
      "",
      unit.hint,
      "",
      "Source:",
      unit.ranges.map(([a, b]) => numbered(fileLines, a, b)).join("\n"),
    );
  }

  if (adapter.hints[unit.id]) parts.push("", `Note: ${adapter.hints[unit.id]}`);

  parts.push("", "Methods this code may call (ids for \"calls\"):");
  if (targets.length) {
    for (const t of targets) {
      const where = t.lines.filter(Boolean).length ? ` (called on line ${t.lines.filter(Boolean).join(", ")})` : "";
      parts.push(`- ${t.id}${where}: ${t.describe}`);
    }
  } else {
    parts.push("None.");
  }

  parts.push("", "Outcome codes already defined:");
  for (const [code, o] of Object.entries(seedOutcomes)) parts.push(`- ${code} (${o.kind}): ${o.text}`);
  return parts.join("\n");
}

export function retryPrompt(prompt, previous, errors) {
  return `${prompt}\n\nYour previous answer was refused for these reasons:\n${errors.map((e) => `- ${e}`).join("\n")}\n\nPrevious answer:\n${JSON.stringify(previous)}\n\nReturn a corrected answer.`;
}
