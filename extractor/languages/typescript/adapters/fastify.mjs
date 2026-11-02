// Fastify: a route runs its instance's hooks in lifecycle order, then its own
// route hooks, then its handler. An instance is a Fastify() app plus every
// function it is handed to (registerRoutes(app)); a plugin passed to register
// is a child instance with the parent's hooks and its own prefix. Errors that
// hooks and handlers throw go to the instance's error handler.

import { HTTP_EXITS, HTTP_OUTCOMES } from "./http.mjs";

export const NAME = "fastify";

// What the index treats as a Fastify instance inside a function.
export const RECEIVERS = {
  init: [/^(Fastify|fastify)\(/, /^require\(["']fastify["']\)\(/],
  paramType: [/\bFastifyInstance\b/],
  plugin: ["register"],
};

const VERBS = ["get", "post", "put", "patch", "delete", "head", "options", "all"];
// The hooks that run before the handler, in lifecycle order.
const STAGES = ["onRequest", "preParsing", "preValidation", "preHandler"];
const MAX_HANDLER_LINES = 60;
const isApp = (init) => RECEIVERS.init.some((re) => re.test(init || ""));
const join = (...parts) => {
  const path = `/${parts.filter(Boolean).join("/")}`.replace(/\/+/g, "/");
  return path.length > 1 ? path.replace(/\/$/, "") : path;
};

export function detect(index) {
  return (index.registrations || []).some((r) => isApp(r.receiver.init));
}

export function createAdapter({ index, source, config }) {
  const skip = config.skipCalls.map((p) => new RegExp(p));

  // A receiver handed to a function is the same instance: follow hand-offs back to where it was made.
  const handedFrom = new Map((index.handoffs || []).map((h) => [h.to, h.from]));
  const instanceOf = (id) => {
    const seen = new Set();
    while (handedFrom.has(id) && !seen.has(id)) {
      seen.add(id);
      id = handedFrom.get(id);
    }
    return id;
  };
  const byInstance = new Map();
  for (const r of index.registrations || []) {
    if (!r.receiver.id) continue;
    const id = instanceOf(r.receiver.id);
    if (!byInstance.has(id)) byInstance.set(id, []);
    byInstance.get(id).push(r);
  }
  const apps = [...new Set((index.registrations || []).filter((r) => isApp(r.receiver.init)).map((r) => instanceOf(r.receiver.id)))];

  const units = (a) => (a?.kind === "unit" ? [a.id] : a?.kind === "array" ? a.items.filter((i) => i.kind === "unit").map((i) => i.id) : []);
  const routeHooks = (options) => Object.fromEntries(STAGES.map((stage) => [stage, units(options?.props?.[stage])]));
  const errorHandlers = new Set();

  function entryPoints() {
    const found = [];
    const skipped = [];
    const walk = (instance, prefix, inheritedHooks, seen) => {
      if (seen.has(instance)) return;
      seen.add(instance);
      const regs = byInstance.get(instance) || [];
      // Hooks and the error handler apply to every route of the instance, wherever they are added.
      const hooks = Object.fromEntries(STAGES.map((stage) => [stage, [...inheritedHooks[stage]]]));
      for (const r of regs) {
        if (r.method === "addHook" && r.args[0]?.kind === "string" && STAGES.includes(r.args[0].value)) hooks[r.args[0].value].push(...units(r.args[1]));
        if (r.method === "setErrorHandler") units(r.args[0]).forEach((id) => errorHandlers.add(id));
      }
      const route = (r, verb, path, options, handler) => {
        if (!handler) {
          skipped.push(`${verb} ${path} (${r.file}:${r.line}): the handler is not a function in the codebase`);
          return;
        }
        const own = routeHooks(options);
        found.push({
          id: `${r.module}:${verb.toLowerCase()}@${r.line}`,
          kind: "http",
          name: `${verb} ${path}`,
          className: r.module,
          method: handler,
          trigger: `${verb} ${path} · ${r.file}:${r.line}`,
          summary: index.methods[handler]?.doc || undefined,
          steps: [...STAGES.flatMap((stage) => [...hooks[stage], ...own[stage]]).map((id) => ({ node: id })), { inline: handler }],
          unsupported: [],
        });
      };
      for (const r of regs) {
        if (VERBS.includes(r.method) && r.args[0]?.kind === "string") {
          const options = r.args.length > 2 && r.args[1].kind === "object" ? r.args[1] : null;
          route(r, r.method.toUpperCase(), join(prefix, r.args[0].value), options, units(r.args.at(-1))[0]);
        } else if (r.method === "route" && r.args[0]?.kind === "object") {
          const { method, url, handler } = r.args[0].props;
          const verbs = method?.kind === "string" ? [method.value] : method?.kind === "array" ? method.items.filter((m) => m.kind === "string").map((m) => m.value) : [];
          if (url?.kind !== "string" || !verbs.length) {
            skipped.push(`${r.file}:${r.line}: route() without a literal method and url`);
            continue;
          }
          for (const verb of verbs) route(r, verb.toUpperCase(), join(prefix, url.value), r.args[0], units(handler)[0]);
        }
      }
      // Plugins load after the instance's own routes.
      for (const r of regs.filter((x) => x.method === "register")) {
        const plugin = units(r.args[0])[0];
        const at = r.args[1]?.props?.prefix;
        if (plugin) walk(instanceOf(`${plugin}(0)`), join(prefix, at?.kind === "string" ? at.value : ""), hooks, seen);
      }
    };
    for (const app of apps) walk(app, "", Object.fromEntries(STAGES.map((stage) => [stage, []])), new Set());
    return { found, skipped };
  }
  entryPoints();

  // The error handler's own code: it decides the reply for every error a hook or handler throws.
  const handlerText = [...errorHandlers].map((id) => {
    const m = index.methods[id];
    const lines = source(m.file).slice(m.start - 1, m.end);
    const shown = lines.slice(0, MAX_HANDLER_LINES).map((l, i) => `${String(m.start + i).padStart(4)}| ${l}`).join("\n");
    return `Errors that a hook or handler throws, and promises they reject, go to this error handler (${m.file}:${m.start}-${m.end}), which picks the reply:\n${shown}${lines.length > MAX_HANDLER_LINES ? "\n     (cut at 60 lines)" : ""}`;
  });

  return {
    name: NAME,
    seedOutcomes: { ...HTTP_OUTCOMES },
    context: [
      "Framework: Fastify. A request runs the hooks of its route's instance in lifecycle order (onRequest, preParsing, preValidation, preHandler), each stage followed by the route's own hooks of that stage, then the handler. The hooks of a parent instance also run for the routes of the plugins it registers.",
      `A hook or handler ends the request when it sends a reply (reply.send, reply.code(...).send, reply.status(...).send, reply.redirect): that is an exit. ${HTTP_EXITS}. A hook that returns without a reply passes the request on. An async handler that returns a value sends it as a 200 reply: a success outcome you name.`,
      ...(handlerText.length ? handlerText : ["Errors that a hook or handler throws go to Fastify's default error handler: INTERNAL_SERVER_ERROR, or the status in the error's statusCode."]),
      ...config.context,
    ].join("\n"),
    hints: {},
    explainConstant: () => null,
    skipTarget: (id) => skip.some((re) => re.test(id)),
    entryPoints,
  };
}
