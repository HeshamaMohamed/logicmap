import { COPY } from "./copy.mjs";

// Static reach, no Claude: which units a change touches, which entry points
// can reach them, and which changed lines the graph cannot show.

const where = (h) => `${h.file}:${h.start}${h.end > h.start ? `-${h.end}` : ""}`;

function unitsAt(index, resolver, hunk) {
  const ids = [];
  for (const m of Object.values(index.methods)) {
    if (m.file === hunk.file && m.start <= hunk.end && m.end >= hunk.start) ids.push(m.id);
  }
  for (const u of Object.values(resolver.declarationUnits)) {
    if (u.error) continue;
    if (u.file === hunk.file && u.ranges.some(([a, b]) => a <= hunk.end && b >= hunk.start)) ids.push(u.id);
  }
  return ids;
}

// A constant read inside a method refers to a definition when the full path
// matches, or when a bare name is defined in the method's class, an enclosing
// module, or an ancestor.
function readsConstant(method, def, resolver) {
  const full = `${def.owner}::${def.name}`;
  return (method.consts || []).filter((read) => {
    if (read.name.includes("::")) return full.endsWith(read.name.replace(/^::/, ""));
    if (read.name !== def.name) return false;
    return method.owner === def.owner || method.owner.startsWith(`${def.owner}::`) || resolver.ancestors(method.owner).includes(def.owner);
  }).map((read) => read.line);
}

function constantsAt(index, hunk) {
  return (index.constant_defs || []).filter((c) => c.file === hunk.file && c.start <= hunk.end && c.end >= hunk.start);
}

// A hunk changes the units it lies in, and every method that reads a constant it redefines.
export function changedUnits(index, resolver, change) {
  const units = new Map();
  const add = (id, hunk) => {
    if (!units.has(id)) units.set(id, []);
    units.get(id).push(hunk);
  };
  for (const hunk of change.hunks) {
    unitsAt(index, resolver, hunk).forEach((id) => add(id, hunk));
    for (const def of constantsAt(index, hunk)) {
      for (const m of Object.values(index.methods)) if (readsConstant(m, def, resolver).length) add(m.id, hunk);
    }
  }
  return units;
}

// Hunks the graph draws no node for can still change a drawn step: one that
// reads a changed constant, or calls a changed method the graph does not open.
// The most specific step holding that line is marked "modified".
const MAX_UNOPENED_HOPS = 4;

export function markIndirect({ graph, ranges, unmatched, index, resolver, source }) {
  const targets = new Map();
  const targetsOf = (id) => {
    if (!targets.has(id)) {
      const m = index.methods[id];
      // A mark is a claim to the reviewer: follow only calls the resolver resolved, never name matches.
      targets.set(id, m ? resolver.callTargets({ ...m, kind: "method" }, source(m.file).slice(m.start - 1, m.end).join("\n")).filter((t) => t.how !== "same name") : []);
    }
    return targets.get(id);
  };
  const stepsByUnit = new Map();
  for (const [nid, r] of ranges) {
    if (!nid.includes("~") || !graph.nodes[nid]) continue;
    const uid = nid.split("~")[0];
    if (!stepsByUnit.has(uid)) stepsByUnit.set(uid, []);
    stepsByUnit.get(uid).push([nid, r]);
  }
  const hits = new Set();
  const matched = new Set();
  for (const hunk of unmatched) {
    const defs = constantsAt(index, hunk);
    const unopened = new Set(Object.values(index.methods)
      .filter((m) => m.file === hunk.file && m.start <= hunk.end && m.end >= hunk.start && !graph.nodes[m.id])
      .map((m) => m.id));
    if (!defs.length && !unopened.size) continue;
    // A drawn step may reach the changed method through other methods the graph does not open.
    const reachesUnopened = (id, depth = 0, seen = new Set()) => {
      if (unopened.has(id)) return true;
      if (depth >= MAX_UNOPENED_HOPS || seen.has(id) || graph.nodes[id] || !index.methods[id]) return false;
      seen.add(id);
      return targetsOf(id).some((t) => reachesUnopened(t.id, depth + 1, seen));
    };
    for (const [uid, steps] of stepsByUnit) {
      const m = index.methods[uid];
      if (!m) continue;
      const lines = new Set(defs.flatMap((def) => readsConstant(m, def, resolver)));
      if (unopened.size) {
        for (const t of targetsOf(uid)) {
          if (reachesUnopened(t.id)) t.lines.filter(Boolean).forEach((l) => lines.add(l));
        }
      }
      for (const line of lines) {
        const holding = steps.filter(([, r]) => r.start <= line && r.end >= line);
        if (!holding.length) continue;
        holding.sort((a, b) => (a[1].end - a[1].start) - (b[1].end - b[1].start));
        hits.add(holding[0][0]);
        matched.add(hunk);
      }
    }
  }
  for (const nid of hits) graph.nodes[nid].change ||= "modified";
  return { marked: hits.size, unmatched: unmatched.filter((h) => !matched.has(h)) };
}

// Over-approximates calls (name matches included): it may select an entry
// point that does not really reach the change, and Claude's extraction then
// shows exactly what it does reach.
export function staticCalls(index, resolver, source) {
  const calls = new Map();
  for (const m of Object.values(index.methods)) {
    const lines = source(m.file);
    const text = lines.slice(m.start - 1, m.end).join("\n");
    calls.set(m.id, new Set(resolver.callTargets({ ...m, kind: "method" }, text).map((t) => t.id)));
  }
  return calls;
}

// The units an entry point's steps start from.
export function stepRoots(ep) {
  const ids = (s) => {
    if (s.fields) return s.fields.map((f) => f.method);
    if (s.fork) return [...s.fork.then, ...s.fork.otherwise].flatMap(ids);
    return s.gem ? [] : [s.node || s.inline];
  };
  return ep.steps.flatMap(ids);
}

// Nearest first: distance is the number of calls from the entry point's own
// code to the closest changed unit.
export function affectedEntries(entries, calls, changed) {
  const affected = [];
  const reachedChanged = new Set();
  for (const ep of entries) {
    const depth = new Map(stepRoots(ep).map((id) => [id, 0]));
    const queue = [...depth.keys()];
    let distance = Infinity;
    const reached = [];
    while (queue.length) {
      const id = queue.shift();
      const d = depth.get(id);
      if (changed.has(id)) {
        distance = Math.min(distance, d);
        reached.push(id);
        reachedChanged.add(id);
      }
      for (const callee of calls.get(id) || []) {
        if (!depth.has(callee)) {
          depth.set(callee, d + 1);
          queue.push(callee);
        }
      }
    }
    if (reached.length) affected.push({ ...ep, distance, reaches: reached });
  }
  affected.sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name));
  return { affected, unreached: [...changed.keys()].filter((id) => !reachedChanged.has(id)) };
}

const STRUCTURE = new Set(["include", "extend", "prepend", "private", "protected", "public", "module_function", "private_constant"]);

// Every changed hunk the graph leaves out, with the reason a reviewer needs.
export function uncoveredChanges({ unmatched, index, resolver, extracted, sourceDirs, source, folded = new Set(), explainConstant = () => null }) {
  return unmatched.map((hunk) => {
    const indexed = sourceDirs.some((p) => hunk.file === p || hunk.file.startsWith(`${p}/`)) && /\.(rb|rake)$/.test(hunk.file);
    if (/^(spec|test)\//.test(hunk.file)) return { where: where(hunk), reason: COPY.testCode };
    if (/^config\/locales\//.test(hunk.file)) return { where: where(hunk), reason: COPY.translations };
    if (/^db\/migrate\//.test(hunk.file)) return { where: where(hunk), reason: COPY.migration };
    if (/^db\/(schema\.rb|structure\.sql)$/.test(hunk.file)) return { where: where(hunk), reason: COPY.schemaDump };
    if (!indexed) return { where: where(hunk), reason: COPY.outsideIndex(sourceDirs.join(", ")) };
    if (/^config\/initializers\//.test(hunk.file) && !unitsAt(index, resolver, hunk).length) return { where: where(hunk), reason: COPY.startupSetting };
    const lines = source ? source(hunk.file).slice(hunk.start - 1, hunk.end) : [];
    if (lines.length && lines.every((l) => /^\s*(#.*)?$/.test(l))) return { where: where(hunk), reason: COPY.onlyComments };
    const ids = unitsAt(index, resolver, hunk);
    if (!ids.length) {
      const defs = constantsAt(index, hunk);
      if (defs.length) {
        const names = defs.map((d) => `${d.owner}::${d.name}`);
        const explained = names.map(explainConstant).find(Boolean);
        return { where: where(hunk), reason: explained || COPY.constantUnread(names.join(", ")) };
      }
      const owners = Object.values(index.modules);
      const decls = owners.flatMap((m) => m.declarations).filter((d) => d.file === hunk.file && d.start <= hunk.end && d.end >= hunk.start);
      const names = [...new Set(decls.map((d) => d.name))];
      if (names.length && names.every((n) => STRUCTURE.has(n))) return { where: where(hunk), reason: COPY.structure };
      return { where: where(hunk), reason: names.length ? COPY.classBody(names.join(", ")) : COPY.classBodyCode };
    }
    const foldedIds = ids.filter((id) => folded.has(id));
    if (foldedIds.length) return { where: where(hunk), reason: COPY.foldedInto(foldedIds.join(", ")) };
    const inGraph = ids.filter((id) => extracted.has(id));
    if (inGraph.length) return { where: where(hunk), reason: COPY.betweenSteps(inGraph.join(", ")) };
    return { where: where(hunk), reason: COPY.unreached(ids.join(", ")) };
  });
}
