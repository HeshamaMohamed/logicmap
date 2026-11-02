import { coded } from "../../errors.mjs";

// The Ruby resolver, over the Prism index: constants by lexical nesting,
// ancestors through superclass/include/extend, call-site targets, constant
// reads, and declaration units (validations, callbacks and other rules live in
// class bodies, not methods).

const OPERATORS = new Set(["==", "!=", "!", "[]", "[]=", "+", "-", "*", "/", "<", ">", "<=", ">=", "<<", "=~", "<=>", "&", "|", "%"]);
const MAX_SAME_NAME = 6;
// Ruby and Rails methods every object or controller has: a call to one of these
// by name means the framework's method, never an app method that shares the name.
const FRAMEWORK_NAMES = new Set(["render", "head", "redirect_to", "request", "response", "params", "session", "cookies", "respond_to",
  "blank?", "present?", "nil?", "empty?", "any?", "to_s", "to_i", "to_h", "to_a", "to_json", "as_json", "inspect", "dup", "freeze", "tap", "then"]);
// Calls that run a model's validations, callbacks and attribute rules, delete it, or query it.
const PERSIST = new Set(["save", "save!", "create", "create!", "update", "update!", "valid?", "invalid?", "validate", "validate!", "update_attribute", "update_attributes", "update_attributes!", "find_or_create_by", "find_or_create_by!", "create_or_find_by", "create_or_find_by!", "touch", "new", "build"]);
const DESTROY = new Set(["destroy", "destroy!", "destroy_all", "delete", "delete_all"]);
const QUERY = new Set(["find", "find_by", "find_by!", "where", "all", "exists?", "first", "last", "count", "pluck", "find_each", "order", "joins", "includes", "none", "sum"]);

// Class-body declarations that decide something, one unit per kind and owner
// (a class, or a concern whose `included` block declares them). `on` names the
// calls that make a method reach the unit.
export const DECLARATION_KINDS = [
  { suffix: "validations", pattern: /^(validates?|validates_\w+)$/, title: "validations", on: ["persist"], exits: false,
    hint: (o) => `These run whenever a ${o} is validated or saved. Each rule is one step with exits [], since the caller decides what a failed validation means.` },
  { suffix: "callbacks", pattern: /^((before|after|around)_\w+|counter_culture)$/, title: "callbacks and running totals", on: ["persist", "destroy"], exits: false,
    hint: (o) => `These run around saving or deleting a ${o}. Each callback is one step that states when it runs and what it does.` },
  { suffix: "associations", pattern: /^(has_many|has_one|belongs_to|has_and_belongs_to_many|has_one_attached|has_many_attached|accepts_nested_attributes_for)$/, title: "associations", on: ["persist", "destroy"], exits: false,
    hint: (o) => `These decide what a ${o} must belong to and what happens to its related records when it is deleted. Each association that decides something (required or optional, dependent destroy or restrict) is one step; plain links share one step.` },
  { suffix: "attributes", pattern: /^(enum|attribute|normalizes|encrypts|store_accessor|serialize|has_secure_password|has_secure_token)$/, title: "attribute rules", on: ["persist"], exits: false,
    hint: (o) => `These decide which values a ${o} accepts and how it stores them. Each rule is one step.` },
  { suffix: "default_scope", pattern: /^default_scope$/, title: "default scope", on: ["query", "persist", "destroy"], exits: true,
    hint: (o) => `This scope limits every query of a ${o}. A scope that raises ends the request: that is an exit.` },
];

export function createResolver(index) {
  const { modules, methods } = index;

  const byName = new Map();
  for (const m of Object.values(methods)) {
    const key = `${m.singleton ? "." : "#"}${m.name}`;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(m.id);
  }

  function resolveConst(name, nesting) {
    if (!name) return null;
    if (name.startsWith("::")) return modules[name.slice(2)] ? name.slice(2) : null;
    for (let i = nesting.length; i >= 0; i--) {
      const candidate = [...nesting.slice(0, i), name].join("::");
      if (modules[candidate]) return candidate;
    }
    return null;
  }

  const ancestorCache = new Map();
  function ancestors(name, seen = new Set()) {
    if (ancestorCache.has(name)) return ancestorCache.get(name);
    if (seen.has(name)) return [];
    seen.add(name);
    const mod = modules[name];
    const list = [name];
    if (mod) {
      const scope = name.split("::");
      for (const inc of [...mod.includes].reverse()) {
        const resolved = resolveConst(inc, scope);
        if (resolved) list.push(...ancestors(resolved, seen));
      }
      if (mod.superclass) {
        // Unresolved superclasses (gems, Rails) end the chain but keep their name.
        const sup = resolveConst(mod.superclass, mod.nesting) || mod.superclass.replace(/^::/, "");
        list.push(...ancestors(sup, seen));
      }
    }
    const unique = [...new Set(list)];
    ancestorCache.set(name, unique);
    return unique;
  }

  function findMethod(owner, name, singleton) {
    for (const a of ancestors(owner)) {
      const id = `${a}${singleton ? "." : "#"}${name}`;
      if (methods[id]) return id;
      if (singleton) {
        for (const ext of modules[a]?.extends || []) {
          const mod = resolveConst(ext, a.split("::"));
          if (mod && methods[`${mod}#${name}`]) return `${mod}#${name}`;
        }
      }
    }
    return null;
  }

  // ---- Declaration units ------------------------------------------------

  const declarationUnits = {};
  // Builds the unit for one owner's declarations matching a pattern, or null when it declares none.
  function declarationUnit(owner, kind) {
    const id = `${owner}@${kind.suffix}`;
    if (declarationUnits[id]) return declarationUnits[id];
    const picked = (modules[owner]?.declarations || []).filter((d) => kind.pattern.test(d.name));
    if (!picked.length) return null;
    const files = [...new Set(picked.map((d) => d.file))];
    if (files.length !== 1) {
      // Refused when a flow reaches it, not here: other owners still extract.
      declarationUnits[id] = { id, error: `${owner} declares its ${kind.title} in ${files.length} files (${files.join(", ")}); a declaration unit must come from one file` };
      return declarationUnits[id];
    }
    declarationUnits[id] = {
      id,
      kind: "declarations",
      owner,
      title: `${owner} ${kind.title}`,
      hint: kind.hint(owner),
      allowExits: kind.exits,
      on: kind.on,
      file: files[0],
      declarations: picked,
      ranges: picked.map((d) => [d.start, d.end]),
      start: Math.min(...picked.map((d) => d.start)),
      end: Math.max(...picked.map((d) => d.end)),
    };
    return declarationUnits[id];
  }
  for (const owner of Object.keys(modules)) for (const kind of DECLARATION_KINDS) declarationUnit(owner, kind);

  const models = Object.keys(modules).filter((n) => modules[n].kind === "class" && ancestors(n).includes("ApplicationRecord") && n !== "ApplicationRecord");
  // A model reaches its own units and those of the concerns it includes.
  const unitsOfModel = new Map(models.map((model) => [model, ancestors(model).flatMap((a) =>
    DECLARATION_KINDS.map((k) => declarationUnits[`${a}@${k.suffix}`]).filter(Boolean))]));

  const modelWords = models.map((model) => {
    const short = model.split("::").pop();
    const snake = short.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
    return { model, pattern: new RegExp(`\\b(${short}|${snake}|${snake}s|${snake}es)\\b`) };
  });

  // ---- Call targets -------------------------------------------------------

  function callTargets(method, sourceText) {
    const out = new Map();
    const add = (id, line, how) => {
      if (id === method.id) return;
      if (!out.has(id)) out.set(id, { id, lines: [], how });
      if (!out.get(id).lines.includes(line)) out.get(id).lines.push(line);
    };
    // A call on another object: the receiver's name ("project", "@project",
    // "payment.project") picks the class when one matches; otherwise every
    // method of that name, up to MAX_SAME_NAME, is offered.
    const sameName = (name, line, receiver) => {
      if (FRAMEWORK_NAMES.has(name)) return;
      const ids = byName.get(`#${name}`) || [];
      const word = receiver && (receiver.match(/([a-z_][a-z0-9_]*)\s*$/i) || [])[1];
      if (word) {
        const camel = (w) => w.replace(/(^|_)([a-z])/g, (_, __, c) => c.toUpperCase());
        const wanted = new Set([camel(word), camel(word.split("_").pop())]);
        const matching = ids.filter((id) => wanted.has(id.split("#")[0].split("::").pop()));
        if (matching.length) {
          matching.forEach((id) => add(id, line, "receiver name"));
          return;
        }
      }
      if (ids.length >= 1 && ids.length <= MAX_SAME_NAME) ids.forEach((id) => add(id, line, "same name"));
    };

    for (const call of method.calls) {
      if (OPERATORS.has(call.name)) continue;
      const r = call.receiver;
      if (!r || r.self) {
        const id = findMethod(method.owner, call.name, method.singleton);
        if (id) add(id, call.line, "self");
        else sameName(call.name, call.line);
      } else if (r.const) {
        const mod = resolveConst(r.const, method.owner.split("::"));
        if (!mod) continue;
        const id = call.name === "new" ? findMethod(mod, "initialize", false) : findMethod(mod, call.name, true);
        if (id) add(id, call.line, "constant");
      } else if (r.expr === "self.class") {
        const id = findMethod(method.owner, call.name, true);
        if (id) add(id, call.line, "self.class");
      } else if (call.name !== "new") {
        sameName(call.name, call.line, r.expr);
      }
    }

    const does = new Set();
    for (const c of method.calls) {
      if (PERSIST.has(c.name)) does.add("persist");
      if (DESTROY.has(c.name)) does.add("destroy");
      if (QUERY.has(c.name)) does.add("query");
    }
    if (does.size) {
      for (const { model, pattern } of modelWords) {
        if (!pattern.test(sourceText)) continue;
        for (const u of unitsOfModel.get(model)) if (u.on.some((x) => does.has(x))) add(u.id, null, "model declarations");
      }
    }
    return [...out.values()];
  }

  function unit(id) {
    if (declarationUnits[id]?.error) {
      throw coded("SPLIT_DECLARATIONS", declarationUnits[id].error, "Teach extractor/languages/ruby/resolve.mjs to build a declaration unit from several files (skills/logicmap/EVOLVE.md).", id);
    }
    if (declarationUnits[id]) return declarationUnits[id];
    const m = methods[id];
    if (!m) return null;
    return { ...m, kind: "method", ranges: [[m.start, m.end]], title: id };
  }

  // A constant read inside a method refers to a definition when the full path
  // matches, or when a bare name is defined in the method's class, an enclosing
  // module, or an ancestor. Returns the lines that read it.
  function readsConstant(method, def) {
    const full = constantId(def);
    return (method.consts || []).filter((read) => {
      if (read.name.includes("::")) return full.endsWith(read.name.replace(/^::/, ""));
      if (read.name !== def.name) return false;
      return method.owner === def.owner || method.owner.startsWith(`${def.owner}::`) || ancestors(method.owner).includes(def.owner);
    }).map((read) => read.line);
  }

  return { resolveConst, ancestors, findMethod, callTargets, unit, byName, models, declarationUnits, declarationUnit, readsConstant, constantId };
}

function constantId(def) {
  return `${def.owner}::${def.name}`;
}
