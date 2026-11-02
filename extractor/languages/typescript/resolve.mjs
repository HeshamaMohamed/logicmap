// The TypeScript resolver. The type checker already resolved most calls in the
// index; a call it could not resolve (an untyped value in JavaScript) is
// matched by method name, narrowed by the receiver's name when it names a class.

const MAX_SAME_NAME = 6;
// Methods of built-in objects and of Express's request and response: a call
// to one of these on an untyped value is never a codebase method of that name.
const BUILTIN_NAMES = new Set(["then", "catch", "finally", "map", "filter", "reduce", "forEach", "some", "every", "find", "findIndex", "includes",
  "push", "pop", "shift", "slice", "splice", "concat", "join", "split", "sort", "keys", "values", "entries", "get", "set", "has", "delete", "add",
  "toString", "trim", "replace", "match", "test", "parse", "stringify", "log", "error", "warn", "info", "debug", "json", "send", "status",
  "end", "redirect", "next", "use", "listen", "emit", "on", "resolve", "reject", "all", "assign", "freeze", "round", "floor", "ceil", "min", "max"]);

export function createResolver(index) {
  const { methods } = index;
  const byName = new Map();
  for (const m of Object.values(methods)) {
    if (m.kind === "inline") continue;
    if (!byName.has(m.name)) byName.set(m.name, []);
    byName.get(m.name).push(m.id);
  }
  const declarationUnits = {};
  const pascal = (w) => w.replace(/^_+/, "").replace(/^./, (c) => c.toUpperCase());
  const classOf = (id) => (id.match(/:([^:#.]+)[#.]/) || [])[1];

  function callTargets(method) {
    const out = new Map();
    const add = (id, line, how) => {
      if (id === method.id) return;
      if (!out.has(id)) out.set(id, { id, lines: [], how });
      if (!out.get(id).lines.includes(line)) out.get(id).lines.push(line);
    };
    for (const call of method.calls) {
      if (call.targets.length) {
        call.targets.forEach((id) => add(id, call.line, "resolved"));
        continue;
      }
      if (call.resolved || BUILTIN_NAMES.has(call.name)) continue;
      const ids = byName.get(call.name) || [];
      const word = call.receiver && (call.receiver.match(/([A-Za-z_$][\w$]*)\s*$/) || [])[1];
      if (word) {
        const wanted = new Set([pascal(word), pascal(word).replace(/s$/, ""), `${pascal(word).replace(/s$/, "")}Service`]);
        const matching = ids.filter((id) => wanted.has(classOf(id)));
        if (matching.length) {
          matching.forEach((id) => add(id, call.line, "receiver name"));
          continue;
        }
      }
      if (ids.length >= 1 && ids.length <= MAX_SAME_NAME) ids.forEach((id) => add(id, call.line, "same name"));
    }
    return [...out.values()];
  }

  function unit(id) {
    if (declarationUnits[id]) return declarationUnits[id];
    const m = methods[id];
    if (!m) return null;
    return { ...m, kind: "method", ranges: [[m.start, m.end]], title: id };
  }

  const constantId = (def) => `${def.owner}:${def.name}`;
  const readsConstant = (method, def) => (method.consts || []).filter((c) => c.id === constantId(def)).map((c) => c.line);

  return { callTargets, unit, declarationUnits, readsConstant, constantId, byName };
}
