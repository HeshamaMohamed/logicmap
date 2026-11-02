// The Fastify adapter against its fixture, with no Claude calls: registrations
// made inside functions and plugins, hooks in lifecycle order, plugin prefixes,
// and the error handler (gaps/fastify-apps.md).

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { HOME, loadCodebase } from "../extractor/load.mjs";
import { assemble } from "../extractor/assemble.mjs";
import { validate } from "../lib/validate.mjs";

const FASTIFY = join(HOME, "tests", "fixtures", "typescript-fastify");
const fastify = loadCodebase(FASTIFY);

test("fastify index: registrations inside functions and plugins are recorded, and their inline handlers are units", () => {
  const ids = Object.keys(fastify.index.methods);
  for (const id of [
    "src.server:app.setErrorHandler@14",
    "src.server:app.addHook@28",
    "src.server:app.get@36",
    "src.server:app.get@38",
    "src.server:app.post@43",
    "src.server:app.route@55",
    "src.admin.routes:fastify.addHook@6",
    "src.admin.routes:fastify.get@12",
  ]) assert.ok(ids.includes(id), `${id} is a unit`);
  const create = fastify.index.methods["src.server:createServer"];
  assert.ok(!create.calls.some((c) => c.name === "status"), "the error handler's calls belong to its own unit, not to createServer");
  const passed = fastify.index.handoffs.find((h) => h.to === "src.server:registerRoutes(0)");
  assert.equal(passed.from, "src.server:app", "createServer hands its app to registerRoutes");
});

test("fastify adapter: routes run the hooks in lifecycle order, then route hooks, then the handler; a plugin adds its prefix", () => {
  const { found, skipped } = fastify.adapter.entryPoints();
  assert.equal(fastify.adapter.name, "fastify");
  assert.deepEqual(skipped, []);
  assert.deepEqual(found.map((ep) => ep.name), ["GET /up", "GET /notes/:id", "POST /notes", "DELETE /notes/:id", "GET /admin/stats"]);
  const steps = (name) => found.find((ep) => ep.name === name).steps;
  assert.deepEqual(steps("POST /notes"), [{ node: "src.server:app.addHook@28" }, { node: "src.server:limitBody" }, { inline: "src.server:app.post@43" }]);
  assert.deepEqual(steps("DELETE /notes/:id"), [{ node: "src.server:app.addHook@28" }, { inline: "src.server:app.route@55" }]);
  assert.deepEqual(steps("GET /admin/stats"), [
    { node: "src.server:app.addHook@28" },
    { node: "src.admin.routes:fastify.addHook@6" },
    { inline: "src.admin.routes:fastify.get@12" },
  ], "a plugin inherits its parent's hooks and adds its own");
  assert.ok(!found.some((ep) => ep.steps.some((s) => s.node === "src.server:app.setErrorHandler@14")), "the error handler is not a step");
  assert.match(fastify.adapter.context, /error handler/);
  assert.match(fastify.adapter.context, /reply\.status\(404\)/, "the context shows the error handler's code, which maps thrown errors to replies");
});

test("fastify graph: a route assembles with its hook and route hook", () => {
  const step = (text, lines, extra = {}) => ({ text, detail: "", lines, exits: [], returns: [], calls: [], notes: [], question: "", pass: "", steps: [], branches: [], ...extra });
  const unit = (id, summary, steps) => [id, { unit: fastify.resolver.unit(id), output: { summary, question: "", pass: "", steps, outcomes: [] } }];
  const entries = fastify.adapter.entryPoints().found.filter((ep) => ep.name === "POST /notes");
  const units = new Map([
    unit("src.server:app.addHook@28", "Let only signed-in callers through", [step("No valid token: refuse with 401", [30, 33], { exits: [{ when: "No valid token", outcome: "INTERNAL_SERVER_ERROR", raises: "" }] })]),
    unit("src.server:limitBody", "Refuse a note that is too long", [step("Too long: refuse with 413", [65, 67])]),
    unit("src.server:app.post@43", "Add a note", [step("Store the note and answer 201", [49, 49])]),
  ]);
  const { graph, problems } = assemble({ codebase: {}, adapter: fastify.adapter, entries, units, stubs: new Map(), index: fastify.index });
  assert.deepEqual(problems, []);
  assert.deepEqual(validate(graph), []);
  assert.deepEqual(graph.entryPoints[0].steps, ["src.server:app.addHook@28", "src.server:limitBody", "src.server:app.post@43~1"]);
});

test("http outcomes: Express and Fastify define the HTTP status outcomes up front, each with one kind", () => {
  const express = loadCodebase(join(HOME, "tests", "fixtures", "typescript-express"));
  const kinds = { BAD_REQUEST: "user-error", UNPROCESSABLE_ENTITY: "user-error", PAYLOAD_TOO_LARGE: "user-error", UNAUTHORIZED: "rejected", PAYMENT_REQUIRED: "rejected", FORBIDDEN: "rejected", NOT_FOUND: "rejected", CONFLICT: "rejected", TOO_MANY_REQUESTS: "rejected", INTERNAL_SERVER_ERROR: "crash" };
  for (const adapter of [fastify.adapter, express.adapter]) {
    for (const [code, kind] of Object.entries(kinds)) assert.equal(adapter.seedOutcomes[code]?.kind, kind, `${adapter.name} ${code}`);
  }
});
