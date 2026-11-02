// Express: a route runs the middleware registered before it on its app or
// router, then its handlers. Read from the top-level registration calls the
// index records: app.use(...), app.get(path, ...handlers), router.post(...),
// app.use(prefix, ...middleware, router).

import { COPY } from "../copy.mjs";

export const NAME = "express";

const VERBS = ["get", "post", "put", "patch", "delete", "options", "head", "all"];
const isApp = (init) => /^express\(\)$/.test(init || "");
const isRouter = (init) => /(^|\.)Router\(/.test(init || "");
const join = (...parts) => {
  const path = `/${parts.filter(Boolean).join("/")}`.replace(/\/+/g, "/");
  return path.length > 1 ? path.replace(/\/$/, "") : path;
};

export function detect(index) {
  return (index.registrations || []).some((r) => isApp(r.receiver.init));
}

// The major version in package.json's express dependency, or null.
function expressMajor(source) {
  try {
    const pkg = JSON.parse(source("package.json").join("\n"));
    const spec = pkg.dependencies?.express || pkg.devDependencies?.express || "";
    const major = Number((spec.match(/\d+/) || [])[0]);
    return Number.isInteger(major) ? major : null;
  } catch {
    return null;
  }
}

export function createAdapter({ index, source, config }) {
  const skip = config.skipCalls.map((p) => new RegExp(p));
  const major = expressMajor(source);
  const byReceiver = new Map();
  for (const r of index.registrations || []) {
    if (!r.receiver.id) continue;
    if (!byReceiver.has(r.receiver.id)) byReceiver.set(r.receiver.id, []);
    byReceiver.get(r.receiver.id).push(r);
  }
  const apps = [...byReceiver.keys()].filter((id) => isApp(byReceiver.get(id)[0].receiver.init));

  function entryPoints() {
    const found = [];
    const skipped = [];
    const step = (a) => {
      if (a.kind === "unit") return { node: a.id };
      if (a.kind === "call") return { external: { id: `lib:${a.text.replace(/\//g, "_")}`, text: COPY.libraryStep(a.text), detail: COPY.libraryDetail } };
      return null;
    };
    // Error middleware (four parameters) runs only when a handler passes an error on.
    const errorHandler = (a) => a.kind === "unit" && index.methods[a.id]?.params === 4;
    const applies = (scope, path) => !scope || scope === "/" || path === scope || path.startsWith(`${scope}/`);

    const walk = (receiverId, prefix, inherited, seen) => {
      if (seen.has(receiverId)) return;
      seen.add(receiverId);
      const middleware = [...inherited];
      for (const r of byReceiver.get(receiverId) || []) {
        const [first, ...rest] = r.args;
        const at = first?.kind === "string" ? first.value : null;
        const handlers = at === null ? r.args : rest;
        if (r.method === "use") {
          const scope = at === null ? prefix : join(prefix, at);
          const local = [];
          let mounted = false;
          for (const h of handlers) {
            if (h.kind === "var" && isRouter(h.init)) {
              walk(h.id, scope, [...middleware, ...local], seen);
              mounted = true;
            } else if (!errorHandler(h)) {
              const s = step(h);
              if (s) local.push({ scope, step: s });
              else skipped.push(`${r.file}:${r.line}: ${r.receiver.text}.use(${h.text || h.id}) is not a function the index reads`);
            }
          }
          if (!mounted) middleware.push(...local);
        } else if (VERBS.includes(r.method) && at !== null) {
          const verb = r.method.toUpperCase();
          const path = join(prefix, at);
          const handler = handlers.at(-1);
          if (handler?.kind !== "unit") {
            skipped.push(`${verb} ${path} (${r.file}:${r.line}): the handler is not a function in the codebase`);
            continue;
          }
          found.push({
            id: `${r.module}:${r.method}@${r.line}`,
            kind: "http",
            name: `${verb} ${path}`,
            className: r.module,
            method: handler.id,
            trigger: `${verb} ${path} · ${r.file}:${r.line}`,
            summary: index.methods[handler.id]?.doc || undefined,
            steps: [
              ...middleware.filter((m) => applies(m.scope, path)).map((m) => m.step),
              ...handlers.slice(0, -1).map(step).filter(Boolean),
              { inline: handler.id },
            ],
            unsupported: [],
          });
        }
      }
    };
    for (const app of apps) walk(app, "", [], new Set());
    return { found, skipped };
  }

  return {
    name: NAME,
    seedOutcomes: { INTERNAL_SERVER_ERROR: { kind: "crash", text: COPY.serverError } },
    context: [
      "Framework: Express. A route runs the middleware registered before it, in order, then its handler.",
      "A middleware or handler ends the request when it sends a response (res.json, res.send, res.end, res.redirect, res.sendStatus): that is an exit. Name its outcome after the HTTP status (BAD_REQUEST, UNAUTHORIZED, FORBIDDEN, NOT_FOUND, UNPROCESSABLE_ENTITY), and give a 2xx response a success outcome you name (ORDER_CREATED). Calling next() passes the request on.",
      "next(err), or an error thrown in a synchronous handler, ends the request with INTERNAL_SERVER_ERROR through the error middleware.",
      major !== null && major >= 5
        ? "Express 5: a promise that an async handler rejects also reaches the error middleware (INTERNAL_SERVER_ERROR)."
        : "Express 4: an error thrown or a promise rejected inside an async handler reaches no error middleware, so the request never gets a response. Where the code lets that happen, say so in a note.",
      ...config.context,
    ].join("\n"),
    hints: {},
    explainConstant: () => null,
    skipTarget: (id) => skip.some((re) => re.test(id)),
    entryPoints,
  };
}
