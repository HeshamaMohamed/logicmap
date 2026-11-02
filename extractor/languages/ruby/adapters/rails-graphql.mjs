import { COPY } from "../copy.mjs";
import { RAILS_CONTEXT, RAILS_SEEDS, middlewareUnits, railsEntries } from "./rails.mjs";

// Rails + graphql-ruby, read through graphql-ruby's own conventions: a schema
// class (< GraphQL::Schema), the controller method that runs it, root types
// (`mutation(...)`, `query(...)`) and their fields, mutation and resolver
// classes, `ready?`/`authorized?`, and `rescue_from`. Conventions of one
// codebase (a guard DSL, result helpers) come from its .logicmap.json.

export const NAME = "rails-graphql";

const MUTATION_BASES = ["GraphQL::Schema::RelayClassicMutation", "GraphQL::Schema::Mutation"];
const RESOLVER_BASES = ["GraphQL::Schema::Resolver"];

// An operation's arguments and result, declared in its class body.
const INTERFACE = {
  suffix: "interface", pattern: /^(argument|result_field|field|type|null|validates|payload_type)$/, title: "arguments and result", on: [], exits: true,
  hint: (o) => `These declare the arguments and the result of ${o}. graphql-ruby checks the arguments before anything else runs: a missing required argument or a value of the wrong type ends the request with INVALID_ARGUMENTS. Each argument that decides something (required, a default, allowed values, a prepare step) is one step; the result fields share one step.`,
};

const lowerCamel = (snake) => snake.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const upperSnake = (camel) => camel.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
const words = (camel) => camel.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().replace(/^./, (c) => c.toUpperCase());

function schemasOf(index, resolver) {
  return Object.keys(index.modules).filter((n) => index.modules[n].kind === "class" && resolver.ancestors(n).includes("GraphQL::Schema"));
}

export function detect(index, resolver) {
  return schemasOf(index, resolver).length > 0;
}

export function createAdapter({ index, resolver, source, config }) {
  const middleware = middlewareUnits({ index, resolver, source });
  const schemas = schemasOf(index, resolver);
  const decls = (owner) => index.modules[owner]?.declarations || [];
  const constIn = (text, owner) => (text.match(/\b[A-Z][\w]*(?:::[A-Z][\w]*)*/g) || [])
    .map((c) => resolver.resolveConst(c.replace(/::(connection_type|edge_type)$/, ""), owner.split("::")))
    .filter(Boolean);

  // The method that runs a schema for an HTTP request: `SomeSchema.execute(...)` in the action a
  // route reaches, else in a controller. A channel that runs the schema is its own entry point.
  const runners = Object.values(index.methods).filter((m) => m.calls.some((c) => c.name === "execute" && c.receiver?.const
    && schemas.includes(resolver.resolveConst(c.receiver.const, m.owner.split("::"))))).map((m) => m.id).sort();
  const routed = new Set((index.routes || []).map((r) => `${r.controller.split("/").map((p) => p.replace(/(^|_)([a-z0-9])/g, (_, __, c) => c.toUpperCase())).join("::")}Controller#${r.action}`));
  const requestUnit = runners.find((id) => routed.has(id)) || runners.find((id) => /Controller#/.test(id)) || null;

  // Root types the schema declares, or the generator's names.
  const roots = { mutation: [], query: [] };
  for (const schema of schemas) {
    for (const d of decls(schema)) if (d.name in roots) roots[d.name].push(...constIn(d.source.replace(/^\w+/, ""), schema));
  }
  if (!roots.mutation.length && index.modules["Types::MutationType"]) roots.mutation.push("Types::MutationType");
  if (!roots.query.length && index.modules["Types::QueryType"]) roots.query.push("Types::QueryType");

  // Root fields: `mutation:` and `resolver:` name a class; otherwise the field is inline, resolved by a method of the root type.
  const fieldNameOf = new Map();
  const inline = [];
  for (const [kind, types] of [["graphql-mutation", roots.mutation], ["graphql-query", roots.query]]) {
    for (const root of types) {
      for (const d of decls(root)) {
        if (d.name !== "field") continue;
        const field = (d.source.match(/^field\s+:(\w+)/) || [])[1];
        if (!field) continue;
        const target = d.source.match(/\b(?:mutation|resolver):\s*([A-Z][\w:]*)/);
        if (target) {
          const cls = resolver.resolveConst(target[1], root.split("::"));
          if (cls) fieldNameOf.set(cls, lowerCamel(field));
          continue;
        }
        const named = (d.source.match(/\b(?:method|resolver_method):\s*:(\w+[?!]?)/) || [])[1];
        const method = resolver.findMethod(root, named || field, false);
        if (method) inline.push({ kind, root, field, decl: d, method });
      }
    }
  }

  // Exceptions: a codebase's own table of { class:, code:, status_code: } rows, and the schemas' rescue_from.
  const seedOutcomes = {
    ...RAILS_SEEDS,
    INVALID_ARGUMENTS: { kind: "rejected", text: COPY.invalidArguments },
    UNAUTHORIZED: { kind: "rejected", text: COPY.unauthorized },
    GRAPHQL_EXECUTION_ERROR: { kind: "rejected", text: COPY.executionError },
  };
  const mapping = [];
  const tables = index.constants.filter((c) => c.rows.length && c.rows.every((row) => row.class && row.code && row.status_code));
  for (const t of tables) {
    for (const row of t.rows) {
      seedOutcomes[row.code] = { kind: row.status_code >= 500 ? "crash" : row.status_code >= 400 ? "rejected" : "success", text: row.message || words(row.code) };
      mapping.push(`  ${row.class} → ${row.code} (${row.status_code})`);
    }
  }
  for (const schema of schemas) {
    for (const d of decls(schema)) {
      if (d.name !== "rescue_from") continue;
      const head = d.source.split(/\bdo\b|\{|\bwith:/)[0];
      const literal = (d.source.match(/\bcode:\s*["'](\w+)["']/) || [])[1];
      for (const cls of (head.match(/\b[A-Z][\w]*(?:::[A-Z][\w]*)*/g) || [])) {
        const short = cls.split("::").pop();
        const code = literal || upperSnake(short);
        const kind = ["StandardError", "Exception"].includes(short) ? "crash" : "rejected";
        seedOutcomes[code] = { kind, text: words(short) };
        mapping.push(`  ${cls} → ${code}`);
      }
    }
  }

  // A type's field methods: each `field :name` whose method (name, method:, resolver_method:,
  // or a resolver class's resolve) is defined in the codebase.
  function fieldsOf(type) {
    const out = [];
    for (const owner of resolver.ancestors(type)) {
      for (const d of decls(owner)) {
        if (d.name !== "field") continue;
        const field = (d.source.match(/^field\s+:(\w+[?!]?)/) || [])[1];
        if (!field || out.some((f) => f.field === field)) continue;
        const named = (d.source.match(/\b(?:method|resolver_method):\s*:(\w+[?!]?)/) || [])[1];
        const resolverClass = (d.source.match(/\bresolver:\s*([A-Z][\w:]*)/) || [])[1];
        const method = resolverClass
          ? resolver.findMethod(resolver.resolveConst(resolverClass, owner.split("::")) || resolverClass, "resolve", false)
          : resolver.findMethod(type, named || field, false);
        out.push({ field, method, types: constIn(d.source.replace(/^field\s+:\w+[?!]?/, ""), owner).filter((t) => index.modules[t]) });
      }
    }
    return out;
  }

  // Field methods of the types an operation returns, down to `depth` levels of nested types.
  function fieldStep(returned, depth) {
    const seen = new Set();
    const fields = [];
    let level = [...new Set(returned)];
    for (let d = 0; d <= depth && level.length; d++) {
      const next = [];
      for (const type of level) {
        if (seen.has(type)) continue;
        seen.add(type);
        for (const f of fieldsOf(type)) {
          if (f.method) fields.push({ type, field: f.field, method: f.method });
          next.push(...f.types);
        }
      }
      level = next;
    }
    return fields.length ? [{ fields, text: COPY.fieldsText, detail: COPY.fieldsDetail }] : [];
  }
  const returnedBy = (cls, chain) => chain.flatMap((owner) => decls(owner)
    .filter((d) => d.name === "type" || d.name === "result_field" || d.name === "payload_type" || (d.name === "field" && owner === cls))
    .flatMap((d) => constIn(d.source.replace(/^\w+(\s+:\w+[?!]?)?/, ""), owner)))
    .filter((t) => index.modules[t]);

  // Guards: graphql-ruby's ready? and authorized?, then the codebase's guard DSL.
  function guardsOf(cls, chain) {
    const steps = [];
    const unsupported = [];
    for (const name of ["ready?", "authorized?"]) {
      const id = resolver.findMethod(cls, name, false);
      if (id) steps.push({ node: id });
    }
    for (const owner of chain) {
      for (const d of decls(owner)) {
        if (!config.guardDsl.includes(d.name)) continue;
        const symbol = d.source.match(new RegExp(`^${d.name}\\s+:(\\w+[!?]?)\\s*$`));
        if (!symbol) {
          unsupported.push({ code: "UNSUPPORTED_GUARD_FORM", message: `${owner} (${d.file}:${d.start}): reads only "${d.name} :method_name", found: ${d.source}`, remedy: "Teach the adapter this guard form, or name it in guardDsl of .logicmap.json (skills/logicmap/EVOLVE.md)." });
          continue;
        }
        const viaAncestors = resolver.findMethod(owner, symbol[1], false);
        const sameName = resolver.byName.get(`#${symbol[1]}`) || [];
        const id = viaAncestors || (sameName.length === 1 ? sameName[0] : null);
        if (id) steps.push({ node: id });
        else unsupported.push({ code: "AMBIGUOUS_GUARD", message: `${owner} (${d.file}:${d.start}): ${d.name} :${symbol[1]} matches ${sameName.length} methods (${sameName.join(", ") || "none"}), so the one that runs is unknown`, remedy: "Teach resolve.mjs the include path that brings the guard in (skills/logicmap/EVOLVE.md)." });
      }
    }
    return { steps, unsupported };
  }

  const before = [...middleware.map((id) => ({ node: id })), ...(requestUnit ? [{ node: requestUnit }] : [])];
  const trigger = (kind, field) => `POST /graphql · ${kind === "graphql-mutation" ? "mutation" : "query"} ${field}`;

  function entryPoints({ fieldDepth = 1 } = {}) {
    const found = [];
    const skipped = [];
    for (const [name, mod] of Object.entries(index.modules)) {
      if (mod.kind !== "class") continue;
      const chain = resolver.ancestors(name);
      const kind = MUTATION_BASES.some((b) => chain.includes(b)) ? "graphql-mutation"
        : RESOLVER_BASES.some((b) => chain.includes(b)) ? "graphql-query" : null;
      if (!kind) continue;
      const method = resolver.findMethod(name, "resolve", false);
      if (!method || !method.startsWith(`${name}#`)) {
        skipped.push(`${name}: defines no resolve of its own (treated as an abstract base)`);
        continue;
      }
      const short = name.split("::").pop();
      const field = fieldNameOf.get(name) || short[0].toLowerCase() + short.slice(1);
      const description = mod.declarations.find((d) => d.name === "description");
      const summary = description ? (description.source.match(/description\s+["'](.+?)["']/) || [])[1] : undefined;
      const guards = guardsOf(name, chain);
      // graphql-ruby reads and checks the arguments before ready? and authorized? run.
      const iface = resolver.declarationUnit(name, INTERFACE);
      const steps = [...before, ...(iface ? [{ node: iface.id }] : []), ...guards.steps, { inline: method }, ...fieldStep(returnedBy(name, chain), fieldDepth)];
      found.push({ id: field, kind, name: field, className: name, trigger: trigger(kind, field), summary, steps, method, unsupported: guards.unsupported });
    }

    for (const f of inline) {
      const id = `${f.root}@field:${f.field}`;
      resolver.declarationUnits[id] ||= {
        id, kind: "declarations", owner: f.root, title: `the ${f.field} field of ${f.root}`, hint: INTERFACE.hint(`the ${f.field} field`),
        allowExits: true, on: [], file: f.decl.file, declarations: [f.decl], ranges: [[f.decl.start, f.decl.end]], start: f.decl.start, end: f.decl.end,
      };
      const field = lowerCamel(f.field);
      const steps = [...before, { node: id }, { inline: f.method }, ...fieldStep(constIn(f.decl.source.replace(/^field\s+:\w+/, ""), f.root).filter((t) => index.modules[t]), fieldDepth)];
      found.push({ id: field, kind: f.kind, name: field, className: f.root, trigger: trigger(f.kind, field), summary: undefined, steps, method: f.method, unsupported: [] });
    }

    // Routes, channels, jobs and rake tasks; the route to the schema is every GraphQL entry point's request step.
    const rails = railsEntries({ index, resolver, middleware, exclude: (route, controller) => `${controller}#${route.action}` === requestUnit });
    found.push(...rails.found);
    skipped.push(...rails.skipped);
    const order = ["graphql-mutation", "graphql-query", "http", "channel", "job", "rake"];
    found.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.name.localeCompare(b.name));
    return { found, skipped };
  }

  const context = [
    `Framework: a Rails app with a GraphQL API (graphql-ruby). A GraphQL request reaches ${requestUnit || "the controller method that runs the schema"}, which runs the operation. graphql-ruby checks the operation's arguments, then runs its ready? and authorized? methods, then resolve. An authorized? that returns false ends the request with UNAUTHORIZED; a GraphQL::ExecutionError raised anywhere ends it with GRAPHQL_EXECUTION_ERROR.`,
    "",
    mapping.length
      ? "Exceptions: an exception escaping an operation becomes the outcome below for its class or an ancestor; any other becomes INTERNAL_SERVER_ERROR:"
      : "Exceptions: no rescue_from or exception table maps exceptions here, so an exception escaping an operation becomes INTERNAL_SERVER_ERROR.",
    ...mapping,
    "",
    "Mutation results: resolve returns the payload fields; a payload field holding user errors is a user-error outcome (VALIDATION_ERRORS when the errors come from a record).",
    "Models: validations, callbacks, associations, attribute rules and default scopes live in class bodies. A step that saves, deletes or queries a model lists the offered \"<Owner>@<kind>\" units that apply in calls.",
    RAILS_CONTEXT,
    ...config.context,
  ].join("\n");

  const hints = requestUnit ? {
    [requestUnit]: "This method wraps every GraphQL request. Its steps cover what happens before and around the operation, and the operation itself is one step, \"Run the requested operation\", with no calls and no exits. Its exits are the requests refused before the operation runs and the errors escaping it; the operation's own steps decide every other ending.",
  } : {};

  const skip = config.skipCalls.map((p) => new RegExp(p));
  const tableNames = new Set(tables.map((t) => `${t.owner}::${t.name}`));
  return {
    name: NAME,
    seedOutcomes,
    context,
    hints,
    entryPoints,
    skipTarget: (id) => skip.some((re) => re.test(id)),
    // A change to the exception table changes how errors map to outcome codes.
    explainConstant: (name) => (tableNames.has(name) ? COPY.exceptionTable : null),
  };
}
