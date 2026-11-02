// The TypeScript pack against its fixtures, with no Claude calls: the index,
// the resolver, the Express and plain adapters, coverage, and change marking.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HOME, loadCodebase } from "../extractor/load.mjs";
import { assemble } from "../extractor/assemble.mjs";
import { markChanges, readChange, resolveChange } from "../extractor/change.mjs";
import { affectedEntries, changedUnits, markIndirect, staticCalls, uncoveredChanges } from "../extractor/affected.mjs";
import { validate } from "../lib/validate.mjs";
import { buildIndex, caught } from "../lib/rollup.mjs";
import { COPY } from "../extractor/copy.mjs";
import { COPY as TS } from "../extractor/languages/typescript/copy.mjs";

const EXPRESS = join(HOME, "tests", "fixtures", "typescript-express");
const PLAIN = join(HOME, "tests", "fixtures", "javascript-plain");
const express = loadCodebase(EXPRESS);
const plain = loadCodebase(PLAIN);

const targets = (codebase, id) => codebase.resolver.callTargets(codebase.index.methods[id]).map((t) => `${t.id} (${t.how})`);
const step = (text, lines, extra = {}) => ({ text, detail: "", lines, exits: [], returns: [], calls: [], notes: [], question: "", pass: "", steps: [], branches: [], ...extra });
const unit = (codebase, id, summary, steps, extra = {}) => [id, { unit: codebase.resolver.unit(id), output: { summary, question: "", pass: "", steps, outcomes: [], ...extra } }];

function folder(files) {
  const dir = mkdtempSync(join(tmpdir(), "logicmap-ts-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

test("typescript index: functions, class methods and inline handlers, with test files left out", () => {
  const { index } = express;
  assert.deepEqual(Object.keys(index.methods).sort(), [
    "src.app:app.use@17",
    "src.middleware.auth:requireUser",
    "src.routes.health:healthCheck",
    "src.routes.orders:ordersRouter.get@24",
    "src.routes.orders:ordersRouter.get@8",
    "src.routes.orders:ordersRouter.post@12",
    "src.services.orders:OrderService#create",
    "src.services.orders:OrderService#find",
    "src.services.orders:OrderService#list",
    "src.services.users:findUserByToken",
  ]);
  assert.ok(!index.files_read.includes("src/orders.test.ts"));
  const requireUser = index.methods["src.middleware.auth:requireUser"];
  assert.deepEqual([requireUser.start, requireUser.end, requireUser.exported, requireUser.params], [5, 16, true, 3]);
  assert.equal(requireUser.doc, "Lets a request through only with a valid bearer token.");
  assert.deepEqual(index.methods["src.routes.orders:ordersRouter.post@12"].rescues, [{ exceptions: ["*"], protects: [13, 16] }]);
  assert.deepEqual(index.constant_defs.map((c) => `${c.owner}:${c.name}`), ["src.services.orders:MAX_ITEMS", "src.services.users:TOKENS"]);
  assert.deepEqual(index.methods["src.services.orders:OrderService#create"].consts.map((c) => c.line), [23, 24]);
});

test("typescript resolver: the type checker follows imports, path aliases and class instances; untyped calls match by name", () => {
  assert.deepEqual(targets(express, "src.middleware.auth:requireUser"), ["src.services.users:findUserByToken (resolved)"]);
  assert.deepEqual(targets(express, "src.routes.orders:ordersRouter.post@12"), ["src.services.orders:OrderService#create (resolved)"]);
  assert.deepEqual(targets(plain, "src.index:cartTotal"), ["src.discount:applyDiscount (resolved)"], "a JavaScript import resolves too");

  const js = loadCodebase(folder({
    "package.json": "{}",
    "src/billing.js": "export class Billing {\n  charge(order) {\n    return order.total;\n  }\n}\n",
    "src/checkout.js": "export function checkout(billing, order) {\n  billing.charge(order);\n  return order.items.map((i) => i.id);\n}\n",
  }));
  assert.deepEqual(targets(js, "src.checkout:checkout"), ["src.billing:Billing#charge (receiver name)"], "an untyped receiver named like a class picks it; map is a built-in");
});

test("express adapter: routes with their mount prefix, global and route middleware, library middleware by name", () => {
  const { found, skipped } = express.adapter.entryPoints();
  assert.equal(express.adapter.name, "express");
  assert.deepEqual(found.map((ep) => ep.name), ["GET /health", "GET /api/orders", "POST /api/orders", "GET /api/orders/:id"]);
  assert.deepEqual(skipped, []);
  const post = found.find((ep) => ep.name === "POST /api/orders");
  assert.equal(post.id, "src.routes.orders:post@12");
  assert.deepEqual(post.steps, [
    { external: { id: "lib:cors()", text: TS.libraryStep("cors()"), detail: TS.libraryDetail } },
    { external: { id: "lib:express.json()", text: TS.libraryStep("express.json()"), detail: TS.libraryDetail } },
    { node: "src.middleware.auth:requireUser" },
    { inline: "src.routes.orders:ordersRouter.post@12" },
  ]);
  assert.ok(!found.some((ep) => ep.steps.some((s) => s.node === "src.app:app.use@17")), "error middleware is not a step of every route");
  assert.match(express.adapter.context, /Express 4: an error thrown or a promise rejected inside an async handler/);
});

test("plain adapter: exported functions of a JavaScript module are the entry points", () => {
  assert.equal(plain.adapter.name, "plain");
  assert.deepEqual(plain.adapter.entryPoints().found.map((ep) => ep.id), ["src.discount:applyDiscount", "src.index:cartTotal"]);
  assert.equal(plain.adapter.seedOutcomes.ERROR_THROWN.kind, "rejected");
});

test("typescript graph: an Express route assembles, and a catch-all try drops the callee's thrown exit past it", () => {
  const entries = express.adapter.entryPoints().found.filter((ep) => ep.name === "POST /api/orders");
  const units = new Map([
    unit(express, "src.middleware.auth:requireUser", "Let only signed-in users through", [step("No bearer token: refuse with 401", [7, 9], { exits: [{ when: "No bearer token", outcome: "UNAUTHORIZED", raises: "" }] })]),
    unit(express, "src.routes.orders:ordersRouter.post@12", "Create an order for the signed-in user", [
      step("Create the order and answer 201", [14, 15], { calls: ["src.services.orders:OrderService#create"] }),
      step("A validation error: answer 422", [18, 20], { exits: [{ when: "The order is not valid", outcome: "UNPROCESSABLE_ENTITY", raises: "" }] }),
    ], { outcomes: [{ code: "UNAUTHORIZED", kind: "rejected", text: "Not signed in" }, { code: "UNPROCESSABLE_ENTITY", kind: "user-error", text: "The order is not valid" }] }),
    unit(express, "src.services.orders:OrderService#create", "Check and store a new order", [
      step("No items: refuse", [20, 22], { exits: [{ when: "The order has no items", outcome: "ERROR_THROWN", raises: "ValidationError" }] }),
      step("Store the order", [26, 28]),
    ], { outcomes: [{ code: "ERROR_THROWN", kind: "rejected", text: "An error goes back" }] }),
  ]);
  const { graph, problems } = assemble({ codebase: { name: "shop", language: "typescript" }, adapter: express.adapter, entries, units, stubs: new Map(), index: express.index });
  assert.deepEqual(problems, []);
  assert.deepEqual(validate(graph), []);
  assert.deepEqual(graph.entryPoints[0].steps.slice(0, 2), ["lib:cors()", "lib:express.json()"]);
  assert.deepEqual(graph.nodes["src.routes.orders:ordersRouter.post@12~1"].catches, ["*"]);
  const rollup = buildIndex(graph);
  assert.ok(rollup.rollup("src.services.orders:OrderService#create").exits.has("ERROR_THROWN"));
  assert.ok(!rollup.rollup("src.routes.orders:ordersRouter.post@12~1").exits.has("ERROR_THROWN"), "the handler's try catches every error");
  assert.ok(caught("errors.ValidationError", ["ValidationError"]) && caught("Foo", ["*"]) && !caught("Foo", ["Bar"]));
});

test("typescript change: a changed constant marks the step that reads it and reaches the route", () => {
  const dir = mkdtempSync(join(tmpdir(), "logicmap-ts-change-"));
  cpSync(EXPRESS, dir, { recursive: true });
  const git = (...args) => execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "pipe" });
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "base");
  const file = join(dir, "src/services/orders.ts");
  writeFileSync(file, readFileSync(file, "utf8").replace("MAX_ITEMS = 20", "MAX_ITEMS = 10"));
  git("commit", "-qam", "change");
  const codebase = loadCodebase(dir);
  const change = readChange(dir, resolveChange(dir, { base: "HEAD~1" }));
  const changed = changedUnits(codebase.index, codebase.resolver, change);
  assert.ok(changed.has("src.services.orders:OrderService#create"));
  const { affected } = affectedEntries(codebase.adapter.entryPoints().found, staticCalls(codebase.index, codebase.resolver, codebase.source), changed);
  assert.deepEqual(affected.map((ep) => ep.name), ["POST /api/orders"]);

  const units = new Map([unit(codebase, "src.services.orders:OrderService#create", "Check and store a new order", [
    step("Too many items: refuse", [23, 25]),
    step("Store the order", [26, 28]),
  ])]);
  const entries = [{ id: "x", kind: "method", name: "x", steps: [{ inline: "src.services.orders:OrderService#create" }] }];
  const { graph, ranges } = assemble({ codebase: {}, adapter: codebase.adapter, entries, units, stubs: new Map(), index: codebase.index });
  const { unmatched } = markChanges(graph, ranges, change);
  const indirect = markIndirect({ graph, ranges, unmatched, ...codebase });
  assert.equal(graph.nodes["src.services.orders:OrderService#create~1"].change, "modified");
  assert.deepEqual(indirect.unmatched, []);
});

test("typescript coverage: lines the graph can't draw get a reason a reviewer can act on", () => {
  const hunk = (file, start, end = start) => ({ file, start, end, pureAdd: false });
  const reasons = uncoveredChanges({
    unmatched: [
      hunk("src/orders.test.ts", 1),
      hunk("package-lock.json", 1),
      hunk("src/services/orders.ts", 5, 10),
      hunk("src/routes/orders.ts", 1, 3),
      hunk("src/middleware/auth.ts", 4),
      hunk("src/routes/orders.ts", 6),
      hunk("README.md", 1),
    ],
    ...express, extracted: new Set(), sourceDirs: ["."],
  }).map((u) => u.reason);
  assert.deepEqual(reasons, [TS.testCode, TS.lockfile, TS.typesOnly, TS.imports, TS.onlyComments, TS.moduleCode, COPY.outsideIndex("TypeScript or JavaScript", ".")]);
});
