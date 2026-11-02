// Rails: the entry points every Rails app has. A route runs a controller's
// filters and action; Action Cable runs a channel's methods after the
// connection's connect; rake tasks and jobs run outside any request. The
// rails-graphql adapter builds on this one; a Rails app without GraphQL uses it alone.

import { COPY } from "../copy.mjs";

export const NAME = "rails";

export function detect(index) {
  return Boolean(index.modules.ApplicationController || (index.routes || []).length);
}

const FILTER = /^(prepend_before_action|before_action|append_before_action|around_action|after_action|skip_before_action|skip_around_action|skip_after_action)\b\s*(.*)$/s;
const OPTION = /\b(only|except|if|unless|prepend|raise):/;

function camelize(path) {
  return path.split("/").map((part) => part.replace(/(^|_)([a-z0-9])/g, (_, __, c) => c.toUpperCase())).join("::");
}

function symbols(text) {
  return [...(text || "").matchAll(/:(\w+[!?]?)/g)].map((m) => m[1]).concat([...((text || "").match(/%i\[([^\]]*)\]/) || [, ""])[1].split(/\s+/).filter(Boolean)]);
}

// Initializers that set up Rack middleware run for every HTTP request before
// the app's code. Each becomes a unit of the whole file, "init:<file name>",
// that knows the routes, so it can tell a rule that never matches a route.
export function middlewareUnits({ index, resolver, source }) {
  const files = (index.files_read || []).filter((f) => f.startsWith("config/initializers/")).sort();
  const routes = (index.routes || []).map((r) => `${r.verb} ${r.path}${r.condition ? ` (only when ${r.condition})` : ""}`);
  const ids = [];
  for (const file of files) {
    const lines = source(file);
    if (!/\bRack::|config\.middleware/.test(lines.join("\n"))) continue;
    const id = `init:${file.split("/").pop()}`;
    const end = lines.length && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
    resolver.declarationUnits[id] = {
      id, kind: "declarations", owner: file, title: `${file}, run at startup`, file,
      allowExits: true, on: [], declarations: [], ranges: [[1, end]], start: 1, end,
      hint: [
        "These lines run once at startup and set up middleware that every HTTP request passes through before the app's own code.",
        "Each rule that decides something about a request (a throttle, a block list, an allowed origin) is one step: which requests it matches and what it does to them. A rule that refuses a request is an exit.",
        `The app serves these routes:\n${routes.map((r) => `  ${r}`).join("\n") || "  (none found)"}`,
        "A rule that matches only paths no route serves never refuses a request: say so in a note.",
      ].join("\n"),
    };
    ids.push(id);
  }
  return ids;
}

export function railsEntries({ index, resolver, exclude = () => false, middleware = [] }) {
  const found = [];
  const skipped = [];

  // The condition of an if:/unless: option: a method name or a one-line lambda body.
  function conditionOf(optionsPart) {
    const m = optionsPart.match(/\b(if|unless):\s*(?::(\w+[!?]?)|->\s*\{\s*([^}]*?)\s*\}|lambda\s*\{\s*([^}]*?)\s*\})/);
    if (!m) return /\b(if|unless):/.test(optionsPart) ? { unreadable: true } : null;
    const text = m[2] || m[3] || m[4];
    return { text: m[1] === "unless" ? `not ${text}` : text };
  }

  // Filters that run for one action, in the order Rails runs them. A filter
  // with if: or unless: becomes a fork on that condition.
  function filtersFor(controller, action) {
    const chain = resolver.ancestors(controller).filter((a) => index.modules[a]).reverse();
    const before = [];
    const after = [];
    const unsupported = [];
    for (const owner of chain) {
      for (const decl of index.modules[owner].declarations) {
        const m = decl.source.match(FILTER);
        if (!m) continue;
        const [, kind, rest] = m;
        const cut = rest.search(OPTION);
        const namesPart = cut === -1 ? rest : rest.slice(0, cut);
        const optionsPart = cut === -1 ? "" : rest.slice(cut);
        const names = symbols(namesPart);
        const condition = conditionOf(optionsPart);
        if (!names.length || /->|\bdo\b|\{|\bproc\b|\blambda\b/.test(namesPart) || condition?.unreadable) {
          unsupported.push({
            code: "UNSUPPORTED_FILTER_FORM",
            message: `${owner} (${decl.file}:${decl.start}): reads "${kind} :method" with only:, except:, and if: or unless: naming a method or a one-line lambda; found: ${decl.source.split("\n")[0]}`,
            remedy: "Teach the rails adapter this filter form (skills/logicmap/EVOLVE.md).",
          });
          continue;
        }
        const only = (optionsPart.match(/\bonly:\s*(%i\[[^\]]*\]|\[[^\]]*\]|:\w+[!?]?)/) || [])[1];
        const except = (optionsPart.match(/\bexcept:\s*(%i\[[^\]]*\]|\[[^\]]*\]|:\w+[!?]?)/) || [])[1];
        if (only && !symbols(only).includes(action)) continue;
        if (except && symbols(except).includes(action)) continue;
        const list = kind.includes("after") ? after : before;
        if (kind.startsWith("skip_")) {
          for (const name of names) for (const l of [before, after]) {
            const i = l.findIndex((f) => f.name === name);
            if (i === -1) continue;
            if (condition) l[i] = { ...l[i], skipWhen: condition.text };
            else l.splice(i, 1);
          }
        } else {
          const entries = names.map((name) => ({ name, runWhen: condition?.text }));
          if (kind === "prepend_before_action") list.unshift(...entries);
          else list.push(...entries);
        }
      }
    }
    // A filter defined in a gem (authenticate_user!) has no code here: it is drawn by name.
    const step = (filter) => {
      const id = resolver.findMethod(controller, filter.name, false);
      const base = id ? { node: id } : { external: { id: `gem:${filter.name}`, text: COPY.gemStep(filter.name), detail: COPY.gemDetail } };
      if (filter.skipWhen) return { fork: { name: filter.name, when: filter.skipWhen, then: [], otherwise: [base] } };
      if (filter.runWhen) return { fork: { name: filter.name, when: filter.runWhen, then: [base], otherwise: [] } };
      return base;
    };
    return { before: before.map(step), after: after.map(step), unsupported };
  }

  const byId = new Map();
  for (const route of index.routes || []) {
    const where = `${route.verb} ${route.path}`;
    const controller = `${camelize(route.controller)}Controller`;
    if (exclude(route, controller)) continue;
    if (!index.modules[controller]) {
      skipped.push(`${where}: ${controller} is not in the codebase (a gem or a missing controller)`);
      continue;
    }
    const action = resolver.findMethod(controller, route.action, false);
    if (!action) {
      skipped.push(`${where}: ${controller}#${route.action} comes from a gem`);
      continue;
    }
    const id = `${controller}#${route.action}`;
    if (byId.has(id)) continue;
    const middlewareSteps = () => middleware.map((id) => ({ node: id }));
    const { before, after, unsupported } = filtersFor(controller, route.action);
    const ep = {
      id,
      kind: "http",
      name: where,
      className: controller,
      method: action,
      trigger: `${where} · ${id}${route.condition ? ` (only when ${route.condition})` : ""}`,
      summary: index.methods[action].doc || undefined,
      steps: [...middlewareSteps(), ...before, { inline: action }, ...after],
      unsupported,
    };
    byId.set(id, ep);
    found.push(ep);
  }

  for (const [name, mod] of Object.entries(index.modules)) {
    if (mod.kind !== "class" || name === "ApplicationCable::Channel") continue;
    const chain = resolver.ancestors(name);
    if (chain.includes("ApplicationCable::Channel")) {
      const connect = index.methods["ApplicationCable::Connection#connect"] ? [{ node: "ApplicationCable::Connection#connect" }] : [];
      for (const m of Object.values(index.methods)) {
        if (m.owner !== name || m.singleton || m.visibility !== "public") continue;
        found.push({
          id: m.id, kind: "channel", name: m.id, className: name, method: m.id,
          trigger: `Action Cable · ${name} ${m.name}`, summary: m.doc || undefined,
          steps: [...connect, { inline: m.id }], unsupported: [],
        });
      }
    } else if (name !== "ApplicationJob" && chain.includes("ApplicationJob")) {
      const perform = resolver.findMethod(name, "perform", false);
      if (!perform || !perform.startsWith(`${name}#`)) {
        skipped.push(`${name}: defines no perform of its own (treated as an abstract base)`);
        continue;
      }
      found.push({
        id: name, kind: "job", name, className: name, method: perform,
        trigger: `Background job · ${name}#perform`, summary: index.methods[perform].doc || undefined,
        steps: [{ inline: perform }], unsupported: [],
      });
    }
  }

  for (const m of Object.values(index.methods)) {
    if (m.owner !== "rake") continue;
    found.push({
      id: m.id, kind: "rake", name: `rake ${m.id.slice("rake:".length)}`, className: "rake", method: m.id,
      trigger: `rake ${m.id.slice("rake:".length)} · ${m.file}`, summary: m.doc || undefined,
      steps: [{ inline: m.id }], unsupported: [],
    });
  }
  return { found, skipped };
}

export const RAILS_CONTEXT = [
  "Controllers: a route runs the controller's before filters, then the action, then its after filters. A before filter that renders, redirects or heads ends the request: that is an exit. An exception escaping an action becomes HTTP 500 (INTERNAL_SERVER_ERROR), and ActiveRecord::RecordNotFound becomes HTTP 404 (NOT_FOUND), unless a rescue_from in the controller handles it.",
  "Channels: Action Cable runs the connection's connect once, then the channel method; reject and reject_unauthorized_connection end the subscription.",
  "Jobs and rake tasks run outside any request: their exits are the job or task stopping.",
].join("\n");

export const RAILS_SEEDS = {
  NOT_FOUND: { kind: "rejected", text: "Record not found" },
  INTERNAL_SERVER_ERROR: { kind: "crash", text: "Server error" },
  VALIDATION_ERRORS: { kind: "user-error", text: COPY.validationErrors },
};

export function createAdapter({ index, resolver, source, config }) {
  const middleware = middlewareUnits({ index, resolver, source });
  const skip = config.skipCalls.map((p) => new RegExp(p));
  return {
    name: NAME,
    seedOutcomes: { ...RAILS_SEEDS },
    context: [RAILS_CONTEXT, ...config.context].join("\n"),
    hints: {},
    entryPoints: () => railsEntries({ index, resolver, middleware }),
    explainConstant: () => null,
    skipTarget: (id) => skip.some((re) => re.test(id)),
  };
}
