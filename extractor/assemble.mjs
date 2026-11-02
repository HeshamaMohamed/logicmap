// Turns extracted units into a decision-graph/0.1 document. Deterministic:
// the same units always give the same graph.

import { FORMAT, childIds } from "../lib/validate.mjs";
import { COPY } from "./copy.mjs";

export function assemble({ codebase, adapter, entries, units, stubs, index }) {
  const nodes = {};
  const ranges = new Map();
  const problems = [];
  const where = (file, a, b) => (a === b ? `${file}:${a}` : `${file}:${a}-${b}`);

  // Outcome codes: the adapter's, then each unit's own. A code may not change kind.
  const outcomes = structuredClone(adapter.seedOutcomes);
  for (const [id, { output }] of units) {
    for (const o of output.outcomes) {
      const existing = outcomes[o.code];
      if (existing && existing.kind !== o.kind) problems.push({ code: "OUTCOME_CONFLICT", message: `outcome ${o.code}: ${id} declares it ${o.kind}, but it is already ${existing.kind}` });
      else if (!existing) outcomes[o.code] = { kind: o.kind, text: o.text };
    }
  }

  // A unit whose only step hands off to one other method adds a level and
  // says nothing new: it is drawn as the method it hands off to. Its returns,
  // if any, only repeat the answer of the method it hands off to.
  const handOff = new Map();
  for (const [uid, { output }] of units) {
    const [only, ...rest] = output.steps;
    const plain = only && !rest.length && only.calls.length === 1
      && !only.exits.length && !only.notes.length
      && !(only.steps || []).length && !(only.branches || []).length;
    if (plain) handOff.set(uid, only.calls[0]);
  }
  const drawnAs = (id) => {
    const seen = new Set();
    while (handOff.has(id) && !seen.has(id)) {
      seen.add(id);
      id = handOff.get(id);
    }
    return id;
  };

  // Every unit becomes a root node (its summary) whose steps are its own steps.
  const topSteps = new Map();
  for (const [uid, { unit, output }] of units) {
    const build = (steps, prefix) => steps.map((s, i) => {
      const nid = `${uid}~${prefix}${i + 1}`;
      const node = { text: s.text };
      if (s.question.trim()) node.question = s.question.trim();
      if (s.pass.trim()) node.pass = s.pass.trim();
      if (s.detail) node.detail = s.detail;
      node.source = [where(unit.file, s.lines[0], s.lines[1])];
      if (s.exits.length) node.exits = s.exits.map((e) => (e.raises ? { when: e.when, outcome: e.outcome, raises: e.raises } : { when: e.when, outcome: e.outcome }));
      if (s.returns.length) node.returns = s.returns.map((r) => ({ when: r.when, value: r.value }));
      if (s.notes.length) node.notes = s.notes;
      if ((s.branches || []).length) {
        node.branches = s.branches.map((b, bi) => ({ when: b.when, steps: build(b.steps, `${prefix}${i + 1}.b${bi + 1}.`) }));
      } else {
        const children = [...build(s.steps || [], `${prefix}${i + 1}.`), ...new Set(s.calls.map(drawnAs))];
        if (children.length) node.steps = children;
      }
      // Exceptions the method rescues around this step's lines stop at this step.
      const catches = catchesFor(index.methods[uid], s.lines);
      if (catches.length && (node.steps || node.branches)) node.catches = catches;
      nodes[nid] = node;
      ranges.set(nid, { file: unit.file, start: s.lines[0], end: s.lines[1] });
      return nid;
    });
    const steps = build(output.steps, "");
    topSteps.set(uid, steps);
    nodes[uid] = { text: output.summary, source: [where(unit.file, unit.start, unit.end)], steps };
    if (output.question.trim()) nodes[uid].question = output.question.trim();
    if (output.pass.trim()) nodes[uid].pass = output.pass.trim();
    ranges.set(uid, { file: unit.file, start: unit.start, end: unit.end });
  }

  // Calls past --max-depth are drawn as leaves that say so.
  for (const [id, reason] of stubs) {
    const m = index.methods[id];
    nodes[id] = {
      text: m?.doc ? m.doc.split(/(?<=\.)\s/)[0].slice(0, 120) : COPY.stubText(id),
      detail: reason,
      source: m ? [where(m.file, m.start, m.end)] : [],
    };
  }

  for (const [nid, node] of Object.entries(nodes)) {
    for (const child of childIds(node)) {
      if (!nodes[child]) problems.push({ code: "GRAPH_INVALID", message: `node ${nid}: calls ${child}, which was not extracted` });
    }
  }

  // A step whose code the codebase does not hold (a library's): drawn by the text the adapter gives.
  const externalNode = ({ id, text, detail }) => {
    nodes[id] = { text, detail };
    return id;
  };
  const entryPoints = entries.map((ep) => ({
    id: ep.id,
    kind: ep.kind,
    name: ep.name,
    trigger: ep.trigger,
    summary: ep.summary || units.get(ep.method)?.output.summary,
    steps: ep.steps.flatMap((s) => {
      if (s.node) return [drawnAs(s.node)];
      if (s.external) return [externalNode(s.external)];
      if (s.fork) {
        const id = `${ep.id}@if:${s.fork.name}`;
        const side = (steps) => steps.map((x) => (x.external ? externalNode(x.external) : drawnAs(x.node)));
        nodes[id] = {
          text: COPY.filterFork(s.fork.name),
          question: COPY.filterQuestion(s.fork.name),
          branches: [
            { when: COPY.conditionHolds(s.fork.when), steps: side(s.fork.then) },
            { when: COPY.otherwise, steps: side(s.fork.otherwise) },
          ],
        };
        return [id];
      }
      if (s.fields) {
        const id = `${ep.id}@fields`;
        nodes[id] = { text: s.text, detail: s.detail, steps: [...new Set(s.fields.map((f) => drawnAs(f.method)))] };
        for (const f of s.fields) if (!nodes[drawnAs(f.method)]) problems.push({ code: "GRAPH_INVALID", message: `entry point ${ep.id}: field method ${f.method} was not extracted` });
        return [id];
      }
      const inline = topSteps.get(s.inline);
      if (!inline) problems.push({ code: "GRAPH_INVALID", message: `entry point ${ep.id}: ${s.inline} was not extracted` });
      return inline || [];
    }),
  }));

  if (!problems.length) breakCycles(nodes, entryPoints);
  const reachable = prune(nodes, entryPoints);
  for (const id of ranges.keys()) if (!reachable.has(id)) ranges.delete(id);

  const used = new Set(Object.values(nodes).flatMap((n) => (n.exits || []).map((e) => e.outcome)));
  for (const code of Object.keys(outcomes)) if (!used.has(code)) delete outcomes[code];

  return { graph: { format: FORMAT, codebase, outcomes, entryPoints, nodes }, ranges, problems, extracted: new Set(units.keys()), folded: new Set(handOff.keys()) };
}

function catchesFor(method, [start, end]) {
  const caught = new Set();
  for (const r of method?.rescues || []) {
    if (r.protects && r.protects[0] <= start && end <= r.protects[1]) r.exceptions.forEach((e) => caught.add(e));
  }
  return [...caught];
}

// A method that calls back into one of its callers would make a node contain
// itself. The repeated call is dropped from the drawing and named in the detail.
function breakCycles(nodes, entryPoints) {
  const done = new Set();
  const visit = (id, stack) => {
    if (done.has(id)) return;
    stack.add(id);
    const node = nodes[id];
    const lists = [node.steps, ...(node.branches || []).map((b) => b.steps)].filter(Boolean);
    for (const list of lists) {
      for (let i = list.length - 1; i >= 0; i--) {
        const child = list[i];
        if (stack.has(child)) {
          list.splice(i, 1);
          const note = COPY.recursion(nodes[child].text);
          node.detail = node.detail ? `${node.detail} ${note}` : note;
        } else {
          visit(child, stack);
        }
      }
    }
    if (node.steps && !node.steps.length) delete node.steps;
    stack.delete(id);
    done.add(id);
  };
  entryPoints.forEach((ep) => ep.steps.forEach((id) => visit(id, new Set())));
}

function prune(nodes, entryPoints) {
  const reached = new Set();
  const reach = (id) => {
    if (reached.has(id) || !nodes[id]) return;
    reached.add(id);
    childIds(nodes[id]).forEach(reach);
  };
  entryPoints.forEach((ep) => ep.steps.forEach(reach));
  for (const id of Object.keys(nodes)) if (!reached.has(id)) delete nodes[id];
  return reached;
}
