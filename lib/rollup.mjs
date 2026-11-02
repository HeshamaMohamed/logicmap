// What each node contains (exits, notes, changes, forks) and who reaches it.
// Shared by the viewer and the tests. A node that catches an exception drops
// the exits raising it from what it rolls up: inside the callee the exception
// still ends the flow, past the catching step it does not.

import { childIds } from "./validate.mjs";

export function caught(raises, catches) {
  if (!raises || !catches || !catches.length) return false;
  const name = raises.replace(/^::/, "");
  return catches.some((c) => {
    const k = c.replace(/^::/, "");
    return k === "StandardError" || k === "Exception" || k === name || name.endsWith(`::${k}`) || k.endsWith(`::${name}`);
  });
}

function fresh() {
  return { exits: new Map(), list: [], seen: new Set(), noteIds: new Set(), changeIds: new Set(), forkIds: new Set() };
}

function addExit(into, code, when, raises) {
  const key = `${code}\u0000${when}\u0000${raises || ""}`;
  if (into.seen.has(key)) return;
  into.seen.add(key);
  into.list.push({ code, when, raises });
  if (!into.exits.has(code)) into.exits.set(code, []);
  if (!into.exits.get(code).includes(when)) into.exits.get(code).push(when);
}

function merge(into, from, catches) {
  for (const e of from.list) if (!caught(e.raises, catches)) addExit(into, e.code, e.when, e.raises);
  from.noteIds.forEach((x) => into.noteIds.add(x));
  from.changeIds.forEach((x) => into.changeIds.add(x));
  from.forkIds.forEach((x) => into.forkIds.add(x));
}

export function buildIndex(g) {
  const rollups = new Map();
  const rollup = (id) => {
    if (rollups.has(id)) return rollups.get(id);
    const node = g.nodes[id];
    const result = fresh();
    for (const exit of node.exits || []) addExit(result, exit.outcome, exit.when, exit.raises);
    if ((node.notes || []).length) result.noteIds.add(id);
    if ((node.branches || []).length) result.forkIds.add(id);
    if (node.change) result.changeIds.add(id);
    childIds(node).forEach((child) => merge(result, rollup(child), node.catches));
    rollups.set(id, result);
    return result;
  };

  const epRollup = (ep) => {
    const result = fresh();
    ep.steps.forEach((id) => merge(result, rollup(id)));
    return result;
  };

  const entryPointsByNode = new Map();
  for (const ep of g.entryPoints) {
    const seen = new Set();
    const collect = (id) => {
      if (seen.has(id)) return;
      seen.add(id);
      if (!entryPointsByNode.has(id)) entryPointsByNode.set(id, []);
      entryPointsByNode.get(id).push(ep);
      childIds(g.nodes[id]).forEach(collect);
    };
    ep.steps.forEach(collect);
  }

  const epById = Object.fromEntries(g.entryPoints.map((ep) => [ep.id, ep]));
  return { rollup, epRollup, entryPointsByNode, epById };
}
