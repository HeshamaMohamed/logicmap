// Every deterministic layer against the fixture app, with no Claude calls.
// A gap in the evolve loop starts as a red test here (skills/logicmap/EVOLVE.md).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOME, loadCodebase } from "../extractor/load.mjs";
import ruby from "../extractor/languages/ruby/pack.mjs";
import { COPY as RUBY } from "../extractor/languages/ruby/copy.mjs";
import { assemble } from "../extractor/assemble.mjs";
import { markChanges, readChange, resolveChange } from "../extractor/change.mjs";
import { affectedEntries, changedUnits, markIndirect, staticCalls, uncoveredChanges } from "../extractor/affected.mjs";
import { validate } from "../lib/validate.mjs";
import { COPY } from "../extractor/copy.mjs";

const FIXTURE = join(HOME, "tests", "fixtures", "rails-graphql");
const fixture = loadCodebase(FIXTURE);
const SOURCE_DIRS = ruby.defaults.sourcePaths;

function copyFixture() {
  const dir = mkdtempSync(join(tmpdir(), "logicmap-"));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args]).toString().trim();
}

// A unit answer the way Claude returns it, with every field present.
function step(text, lines, extra = {}) {
  return { text, detail: "", lines, exits: [], returns: [], calls: [], notes: [], question: "", pass: "", steps: [], branches: [], ...extra };
}
function unit(id, summary, steps, extra = {}) {
  return [id, { unit: fixture.resolver.unit(id), output: { summary, question: "", pass: "", steps, outcomes: [], ...extra } }];
}

function cannedCreatePayment() {
  return new Map([
    unit("GraphqlController#execute", "Gate the app version, then run the request", [
      step("Refuse old clients", [3, 3], { calls: ["GraphqlController#reject_old_client"] }),
      step("Run the requested operation", [5, 6]),
    ]),
    unit("GraphqlController#reject_old_client", "Refuse clients older than version 1.0.0", [
      step("App older than 1.0.0: ask for an update", [16, 19], { exits: [{ when: "Version below 1.0.0", outcome: "UPGRADE_REQUIRED" }], question: "Is the app recent enough?", pass: "1.0.0 or newer" }),
    ], { outcomes: [{ code: "UPGRADE_REQUIRED", kind: "rejected", text: "App must be updated" }] }),
    unit("SessionChecks::Guards#authenticated!", "Require a signed-in user", [
      step("No signed-in user: refuse", [10, 10], { exits: [{ when: "No user", outcome: "UNAUTHENTICATED" }], question: "Is the caller signed in?", pass: "Signed in" }),
    ]),
    unit("Mutations::Payments::CreatePayment#resolve", "Record a payment on a project", [
      step("Amount must be at most 1,000,000 cents", [14, 14]),
      step("Find the project", [16, 16], { exits: [{ when: "No such project", outcome: "NOT_FOUND" }] }),
      step("Caller must be permitted on the project", [17, 17], { calls: ["AccessPolicy.permitted?"], exits: [{ when: "Not permitted", outcome: "FORBIDDEN" }], question: "May the caller record payments?", pass: "Permitted" }),
      step("Payment must be valid", [19, 20], { calls: ["Payment@validations"], exits: [{ when: "Invalid", outcome: "VALIDATION_ERRORS" }] }),
      step("Save and return the payment", [22, 23], { exits: [{ when: "Saved", outcome: "PAYMENT_RECORDED" }] }),
    ], { outcomes: [{ code: "PAYMENT_RECORDED", kind: "success", text: "Payment recorded" }] }),
    unit("AccessPolicy.permitted?", "Check the permission", [
      step("Ask the permission rules", [3, 3], { calls: ["AccessPolicy#permitted?"], returns: [{ when: "Permitted", value: "Allow" }] }),
    ]),
    unit("AccessPolicy#permitted?", "Decide whether the user may act on the project", [
      step("Inactive user: deny", [12, 12], { returns: [{ when: "User inactive", value: "Deny" }], question: "Is the user active?", pass: "Active" }),
      step("Admin: allow", [13, 13], { returns: [{ when: "User is an admin", value: "Allow" }], question: "Is the user an admin?", pass: "Not an admin" }),
      step("Archived project: deny", [14, 14], { returns: [{ when: "Project archived", value: "Deny" }], question: "Is the project archived?", pass: "Not archived" }),
    ]),
    unit("Mutations::Payments::CreatePayment@interface", "Read the project and the amount", [
      step("Project id and amount are required", [8, 9], { exits: [{ when: "An argument is missing", outcome: "INVALID_ARGUMENTS" }] }),
    ]),
    unit("Types::Objects::PaymentType#receipt_url", "Give the receipt link of a payment", [
      step("Refunded payment: no receipt link", [9, 9], { returns: [{ when: "Payment refunded", value: "No link" }] }),
      step("Return the receipt path", [11, 11]),
    ]),
    unit("Types::Objects::ProjectType#status_label", "Label the project status", [
      step("Archived project: Archived, otherwise Open", [8, 8]),
    ]),
    unit("init:rack_attack.rb", "Limit how often one address may call", [
      step("At most 100 GraphQL requests a minute from one address", [6, 8], { exits: [{ when: "More than 100 in a minute", outcome: "RATE_LIMITED" }] }),
    ], { outcomes: [{ code: "RATE_LIMITED", kind: "rejected", text: "Too many requests" }] }),
    unit("Payment@validations", "Rules a payment must pass", [
      step("Amount is a whole number above zero", [4, 4]),
      step("Received date is required", [5, 5]),
    ]),
  ]);
}

function assembleCreatePayment() {
  const entries = fixture.adapter.entryPoints().found.filter((ep) => ep.name === "createPayment");
  return assemble({ codebase: { name: "fixture" }, adapter: fixture.adapter, entries, units: cannedCreatePayment(), stubs: new Map(), index: fixture.index });
}

test("index: methods, concern includes, declarations and constant tables", () => {
  const { index } = fixture;
  assert.ok(index.methods["Mutations::Payments::CreatePayment#resolve"]);
  assert.equal(index.methods["AccessPolicy.permitted?"].singleton, true);
  assert.deepEqual(index.modules.SessionChecks.includes, ["Guards"], "an include inside `included do` belongs to the concern");
  const names = index.modules.Payment.declarations.map((d) => d.name);
  assert.deepEqual(names.filter((n) => n.startsWith("validates")), ["validates", "validates"]);
  assert.equal(index.constants.find((c) => c.name === "EXCEPTIONS").rows.length, 4);
});

test("resolver: ancestors through concerns, call targets and model declaration units", () => {
  const { resolver, index } = fixture;
  assert.equal(resolver.findMethod("Mutations::Payments::CreatePayment", "authenticated!", false), "SessionChecks::Guards#authenticated!");
  const m = index.methods["Mutations::Payments::CreatePayment#resolve"];
  const text = fixture.source(m.file).slice(m.start - 1, m.end).join("\n");
  const ids = resolver.callTargets({ ...m, kind: "method" }, text).map((t) => t.id);
  assert.ok(ids.includes("AccessPolicy.permitted?"), "a constant receiver resolves to the singleton method");
  assert.ok(ids.includes("Payment@validations"), "a method that saves a payment reaches its validations");
  assert.ok(!ids.includes("Project@validations"), "Project declares no validations");
});

test("resolver: model declarations count only for methods that save or validate", () => {
  const { resolver, index } = fixture;
  const m = index.methods["ReminderJob#perform"];
  const text = fixture.source(m.file).slice(m.start - 1, m.end).join("\n");
  const ids = resolver.callTargets({ ...m, kind: "method" }, text).map((t) => t.id);
  assert.ok(!ids.includes("Payment@validations"), "find_by on a payment runs no validations");
});

test("adapter: entry points, guards and seeded outcomes", () => {
  const { found } = fixture.adapter.entryPoints();
  assert.deepEqual(found.filter((ep) => ep.kind.startsWith("graphql") || ep.kind === "job").map((ep) => ep.name), ["createPayment", "refundPayment", "payment", "RecordPaymentJob", "ReminderJob"]);
  const create = found.find((ep) => ep.name === "createPayment");
  assert.deepEqual(create.steps, [
    { node: "init:rack_attack.rb" },
    { node: "GraphqlController#execute" },
    { node: "Mutations::Payments::CreatePayment@interface" },
    { node: "SessionChecks::Guards#authenticated!" },
    { inline: "Mutations::Payments::CreatePayment#resolve" },
    { fields: [
      { type: "Types::Objects::PaymentType", field: "receipt_url", method: "Types::Objects::PaymentType#receipt_url" },
      { type: "Types::Objects::ProjectType", field: "status_label", method: "Types::Objects::ProjectType#status_label" },
    ], text: RUBY.fieldsText, detail: RUBY.fieldsDetail },
  ]);
  assert.equal(create.summary, "Record a payment on a project");
  assert.equal(fixture.adapter.seedOutcomes.UNAUTHENTICATED.kind, "rejected");
  assert.equal(fixture.adapter.seedOutcomes.INTERNAL_SERVER_ERROR.kind, "crash");
});

test("adapter: an unknown guard form fails with UNSUPPORTED_GUARD_FORM", () => {
  const dir = copyFixture();
  const file = join(dir, "app/graphql/mutations/payments/create_payment.rb");
  writeFileSync(file, readFileSync(file, "utf8").replace("guard :authenticated!", "guard ->(args, ctx) { ctx[:current_user].admin? }"));
  const ep = loadCodebase(dir).adapter.entryPoints().found.find((e) => e.name === "createPayment");
  assert.equal(ep.unsupported[0].code, "UNSUPPORTED_GUARD_FORM", "only this entry point is marked; the others still extract");
});

test("assemble: a valid graph, resolve steps at the top, hand-off wrappers folded", () => {
  const { graph, problems } = assembleCreatePayment();
  assert.deepEqual(problems, []);
  assert.deepEqual(validate(graph), []);
  const ep = graph.entryPoints[0];
  assert.equal(ep.steps[0], "init:rack_attack.rb");
  assert.equal(ep.steps[1], "GraphqlController#execute");
  assert.equal(ep.steps[2], "Mutations::Payments::CreatePayment@interface");
  assert.equal(ep.steps[4], "Mutations::Payments::CreatePayment#resolve~1");
  assert.deepEqual(graph.nodes["Mutations::Payments::CreatePayment#resolve~3"].steps, ["AccessPolicy#permitted?"], "the one-step wrapper is drawn as the method it hands off to");
  assert.ok(!graph.nodes["AccessPolicy.permitted?"]);
  assert.deepEqual(graph.nodes["AccessPolicy#permitted?~1"].returns, [{ when: "User inactive", value: "Deny" }]);
  assert.equal(graph.outcomes.PAYMENT_RECORDED.kind, "success");
});

test("assemble: one outcome code with two kinds is an OUTCOME_CONFLICT", () => {
  const units = cannedCreatePayment();
  units.get("SessionChecks::Guards#authenticated!").output.outcomes = [{ code: "PAYMENT_RECORDED", kind: "rejected", text: "x" }];
  const entries = fixture.adapter.entryPoints().found.filter((ep) => ep.name === "createPayment");
  const { problems } = assemble({ codebase: {}, adapter: fixture.adapter, entries, units, stubs: new Map(), index: fixture.index });
  assert.equal(problems[0].code, "OUTCOME_CONFLICT");
});

test("change: a PR range marks the touched decision, picks the entry points, reports what it can't show", () => {
  const dir = copyFixture();
  git(dir, "init", "-q");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "base");
  const file = join(dir, "app/models/payment.rb");
  writeFileSync(file, readFileSync(file, "utf8").replace("validates :received_at, presence: true", "validates :received_at, presence: true\n  validates :currency, inclusion: { in: %w[EUR USD] }"));
  writeFileSync(join(dir, "app/models/project.rb"), readFileSync(join(dir, "app/models/project.rb"), "utf8").replace("has_many :payments", "has_many :payments\n  scope :open, -> { where(status: \"open\") }"));
  git(dir, "commit", "-qam", "Restrict currencies");

  const range = resolveChange(dir, { base: "HEAD~1" });
  const change = readChange(dir, range);
  assert.equal(change.title, "Restrict currencies");
  const codebase = loadCodebase(dir);
  const changed = changedUnits(codebase.index, codebase.resolver, change);
  assert.deepEqual([...changed.keys()], ["Payment@validations", "Project.open"], "a new scope is the class method it defines");

  const { affected } = affectedEntries(codebase.adapter.entryPoints().found, staticCalls(codebase.index, codebase.resolver, codebase.source), changed);
  assert.deepEqual(affected.map((ep) => [ep.name, ep.distance]), [["createPayment", 1], ["refundPayment", 1], ["RecordPaymentJob", 3]]);

  // The canned validations unit gains the new rule on line 6.
  const units = cannedCreatePayment();
  units.set("Payment@validations", { unit: codebase.resolver.unit("Payment@validations"), output: { ...units.get("Payment@validations").output, steps: [
    step("Amount is a whole number above zero", [4, 4]),
    step("Received date is required", [5, 5]),
    step("Currency is EUR or USD", [6, 6]),
  ] } });
  const entries = codebase.adapter.entryPoints().found.filter((ep) => ep.name === "createPayment");
  const { graph, ranges, extracted } = assemble({ codebase: {}, adapter: codebase.adapter, entries, units, stubs: new Map(), index: codebase.index });
  const { marked, unmatched } = markChanges(graph, ranges, change);
  assert.equal(marked, 1);
  assert.equal(graph.nodes["Payment@validations~3"].change, "added");
  const uncovered = uncoveredChanges({ unmatched, index: codebase.index, resolver: codebase.resolver, language: codebase.language, extracted, sourceDirs: SOURCE_DIRS, source: codebase.source });
  assert.deepEqual(uncovered, [{ where: "app/models/project.rb:3", reason: COPY.unreached("Project.open") }]);
});

test("validate: decisions need something to decide, coverage needs where and reason", () => {
  const { graph } = assembleCreatePayment();
  graph.nodes["Payment@validations~1"].question = "Is it valid?";
  graph.coverage = { uncovered: [{ where: "x.rb:1" }] };
  const errors = validate(graph);
  assert.ok(errors.some((e) => e.includes("Payment@validations~1: has a question")));
  assert.ok(errors.some((e) => e.includes("coverage.uncovered 0")));
});

test("cli: an unsupported request ends in error[CODE] with a remedy and a run report", () => {
  const cache = mkdtempSync(join(tmpdir(), "logicmap-cache-"));
  const run = spawnSync("node", [join(HOME, "extractor", "cli.mjs"), "--repo", FIXTURE, "--entries", "nope"], { env: { ...process.env, LOGICMAP_CACHE: cache } });
  assert.equal(run.status, 1);
  assert.match(run.stderr.toString(), /^error\[UNKNOWN_ENTRY\]: no entry point or method named nope\n {2}remedy: /);
  const reportFile = JSON.parse(readFileSync(join(cache, "last-run.json"), "utf8"));
  assert.equal(reportFile.status, "error");
  assert.equal(reportFile.error.code, "UNKNOWN_ENTRY");
});

test("adapters: GraphQL, then plain Rails, then plain Ruby; a codebase with no Ruby methods is UNSUPPORTED_CODEBASE", () => {
  const dir = copyFixture();
  rmSync(join(dir, "app/graphql/app_schema.rb"));
  const rails = loadCodebase(dir);
  assert.equal(rails.adapter.name, "rails", "no GraphQL schema class: a plain Rails app");
  assert.ok(rails.adapter.entryPoints().found.some((ep) => ep.id === "HealthController#check"));

  const plain = mkdtempSync(join(tmpdir(), "logicmap-plain-"));
  mkdirSync(join(plain, "lib"));
  writeFileSync(join(plain, "lib", "tool.rb"), "class Tool\n  def run\n    1\n  end\nend\n");
  assert.equal(loadCodebase(plain).adapter.name, "ruby");

  const empty = mkdtempSync(join(tmpdir(), "logicmap-empty-"));
  mkdirSync(join(empty, "lib"));
  writeFileSync(join(empty, "lib", "version.rb"), "VERSION = \"1.0\"\n");
  assert.throws(() => loadCodebase(empty), (e) => e.code === "UNSUPPORTED_CODEBASE");
});

// A commit on a fresh git copy of the fixture, then its change marked on the canned graph.
function commitChange(edit) {
  const dir = copyFixture();
  git(dir, "init", "-q");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "base");
  edit(dir);
  git(dir, "commit", "-qam", "change");
  const change = readChange(dir, resolveChange(dir, { base: "HEAD~1" }));
  const codebase = loadCodebase(dir);
  const entries = codebase.adapter.entryPoints().found.filter((ep) => ep.name === "createPayment");
  const units = cannedCreatePayment();
  for (const [id, u] of units) u.unit = codebase.resolver.unit(id);
  const { graph, ranges } = assemble({ codebase: {}, adapter: codebase.adapter, entries, units, stubs: new Map(), index: codebase.index });
  const { unmatched } = markChanges(graph, ranges, change);
  const indirect = markIndirect({ graph, ranges, unmatched, ...codebase });
  return { codebase, change, graph, indirect };
}

function replaceIn(dir, file, from, to) {
  const path = join(dir, file);
  writeFileSync(path, readFileSync(path, "utf8").replace(from, to));
}

test("change: a changed constant marks the steps that read it, and reaches their entry points", () => {
  const { codebase, change, graph, indirect } = commitChange((dir) =>
    replaceIn(dir, "app/graphql/mutations/payments/create_payment.rb", "MAX_AMOUNT_CENTS = 1_000_000", "MAX_AMOUNT_CENTS = 500_000"));
  assert.equal(graph.nodes["Mutations::Payments::CreatePayment#resolve~1"].change, "modified");
  assert.deepEqual(indirect.unmatched, []);
  const changed = changedUnits(codebase.index, codebase.resolver, change);
  assert.ok(changed.has("Mutations::Payments::CreatePayment#resolve"), "the method reading the constant counts as changed");
});

test("change: a change inside a method the graph does not open marks the step that calls it", () => {
  // closed_statuses is two unopened calls away: permitted? → archived? → closed_statuses.
  const { graph, indirect } = commitChange((dir) =>
    replaceIn(dir, "app/models/project.rb", "%w[archived]", "%w[archived closed]"));
  assert.equal(graph.nodes["AccessPolicy#permitted?~3"].change, "modified");
  assert.deepEqual(indirect.unmatched, []);
});

test("resolver: self.class.<name> is the owner's class method", () => {
  const m = fixture.index.methods["ReminderJob#perform"];
  const text = fixture.source(m.file).slice(m.start - 1, m.end).join("\n");
  const ids = fixture.resolver.callTargets({ ...m, kind: "method" }, text).map((t) => t.id);
  assert.ok(ids.includes("ReminderJob.window"));
});

test("dynamic dispatch: conditional includes, define_method, send with a literal name, receiver names", () => {
  const { index, resolver, source } = fixture;
  assert.deepEqual(index.modules.SessionChecks.includes, ["Guards"], "an include inside a conditional in `included do` still counts");
  assert.ok(index.methods["PaymentNotifier#notify_by_email"], "define_method with a literal name is a method");
  const targets = (id) => {
    const m = index.methods[id];
    return resolver.callTargets({ ...m, kind: "method" }, source(m.file).slice(m.start - 1, m.end).join("\n")).map((t) => t.id);
  };
  assert.ok(targets("PaymentNotifier#notify").includes("PaymentNotifier#notify_by_email"), "public_send(:name) calls name");
  assert.ok(targets("PaymentNotifier#notify_by_email").includes("PaymentNotifier#deliver"), "calls inside define_method belong to it");
  const permitted = targets("AccessPolicy#permitted?");
  assert.ok(permitted.includes("Project#archived?"), "@project.archived? reaches Project#archived?");
  assert.ok(!permitted.includes("Payment#archived?"), "the receiver's name rules out Payment#archived?");
});

test("rescued exits: a caller that rescues an exception drops the callee's exit from its rollup", async () => {
  const { buildIndex } = await import("../lib/rollup.mjs");
  const rescues = fixture.index.methods["PaymentRecorder#record"].rescues;
  assert.deepEqual(rescues.map((r) => [r.exceptions, r.protects]), [[["ActiveRecord::RecordNotUnique"], [3, 3]]]);

  const units = new Map([
    unit("RecordPaymentJob#perform", "Record a payment for a project", [
      step("Record the payment, keeping the first copy of a duplicate", [3, 3], { calls: ["PaymentRecorder#record"] }),
    ]),
    unit("PaymentRecorder#record", "Store a payment once", [
      step("Store the payment", [3, 3], { calls: ["PaymentRecorder#store"] }),
      step("Duplicate payment: return the stored one", [4, 5], { returns: [{ when: "Duplicate", value: "Stored payment" }] }),
    ]),
    unit("PaymentRecorder#store", "Store a new payment", [
      step("Duplicate amount: refuse", [9, 9], { exits: [{ when: "A payment with this amount exists", outcome: "CONFLICT", raises: "ActiveRecord::RecordNotUnique" }] }),
      step("Create the payment", [11, 11], { exits: [{ when: "Project missing", outcome: "NOT_FOUND", raises: "ActiveRecord::RecordNotFound" }] }),
    ], { outcomes: [{ code: "CONFLICT", kind: "rejected", text: "The payment exists" }] }),
  ]);
  const entries = fixture.adapter.entryPoints().found.filter((ep) => ep.name === "RecordPaymentJob");
  const { graph, problems } = assemble({ codebase: {}, adapter: fixture.adapter, entries, units, stubs: new Map(), index: fixture.index });
  assert.deepEqual(problems, []);
  assert.deepEqual(validate(graph), []);
  assert.deepEqual(graph.nodes["PaymentRecorder#record~1"].catches, ["ActiveRecord::RecordNotUnique"]);
  assert.equal(graph.nodes["PaymentRecorder#store~1"].exits[0].raises, "ActiveRecord::RecordNotUnique");

  const index = buildIndex(graph);
  assert.deepEqual([...index.rollup("PaymentRecorder#store").exits.keys()].sort(), ["CONFLICT", "NOT_FOUND"], "the callee itself still ends that way");
  assert.deepEqual([...index.rollup("PaymentRecorder#record~1").exits.keys()], ["NOT_FOUND"], "the caller rescues RecordNotUnique");
  assert.deepEqual([...index.epRollup(graph.entryPoints[0]).exits.keys()], ["NOT_FOUND"]);
});

test("class-body declarations: scopes, default scopes, associations, attributes and GraphQL arguments are units", () => {
  const { index, resolver, source } = fixture;
  assert.ok(index.methods["Payment.refunded"], "a scope is the class method it defines");
  assert.deepEqual(resolver.unit("Payment@associations").ranges, [[2, 2], [9, 9]]);
  assert.deepEqual(resolver.unit("Payment@attributes").ranges, [[10, 10]]);
  const scoped = resolver.unit("ProjectScoped@default_scope");
  assert.equal(scoped.allowExits, true, "a default scope may refuse a query");
  const iface = resolver.unit("Mutations::Payments::CreatePayment@interface");
  assert.deepEqual(iface.ranges, [[8, 8], [9, 9], [10, 10]]);
  assert.equal(iface.allowExits, true);
  const m = index.methods["Mutations::Payments::RefundPayment#resolve"];
  const ids = resolver.callTargets({ ...m, kind: "method" }, source(m.file).slice(m.start - 1, m.end).join("\n")).map((t) => t.id);
  for (const id of ["Payment@attributes", "Payment@associations", "Payment@callbacks", "ProjectScoped@default_scope"]) assert.ok(ids.includes(id), `${id} is offered`);
});

test("change: lines the graph can't draw get a reason a reviewer can act on", () => {
  const dir = copyFixture();
  git(dir, "init", "-q");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "base");
  replaceIn(dir, "app/models/project.rb", "  has_many :payments\n", "  # Payments recorded on this project.\n  has_many :payments\n");
  replaceIn(dir, "app/jobs/reminder_job.rb", "class ReminderJob < ApplicationJob\n", "class ReminderJob < ApplicationJob\n  include Retryable\n");
  writeFileSync(join(dir, "config_note.yml"), "a: 1\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "change");
  const codebase = loadCodebase(dir);
  const change = readChange(dir, resolveChange(dir, { base: "HEAD~1" }));
  const uncovered = uncoveredChanges({ unmatched: change.hunks, ...codebase, extracted: new Set(), sourceDirs: SOURCE_DIRS });
  const reasons = Object.fromEntries(uncovered.map((u) => [u.where.split(":")[0], u.reason]));
  assert.equal(reasons["app/models/project.rb"], RUBY.onlyComments);
  assert.equal(reasons["app/jobs/reminder_job.rb"], RUBY.structure);
  assert.equal(reasons["config_note.yml"], COPY.outsideIndex("Ruby", SOURCE_DIRS.join(", ")));
});

test("type fields: an operation's result type and the types under it bring their field methods", () => {
  const { found } = fixture.adapter.entryPoints();
  const query = found.find((ep) => ep.name === "payment");
  assert.equal(query.kind, "graphql-query");
  assert.deepEqual(query.steps.at(-1).fields.map((f) => f.method), ["Types::Objects::PaymentType#receipt_url", "Types::Objects::ProjectType#status_label"]);
  const { graph, problems } = assembleCreatePayment();
  assert.deepEqual(problems, []);
  const fields = graph.nodes["createPayment@fields"];
  assert.deepEqual(fields.steps, ["Types::Objects::PaymentType#receipt_url", "Types::Objects::ProjectType#status_label"]);
  assert.equal(fields.text, RUBY.fieldsText);
});

test("type fields: a change to a field method reaches the operations that return its type", () => {
  const { codebase, change } = commitChange((dir) =>
    replaceIn(dir, "app/graphql/types/objects/project_type.rb", '"Archived" : "Open"', '"Closed" : "Open"'));
  const changed = changedUnits(codebase.index, codebase.resolver, change);
  const { affected } = affectedEntries(codebase.adapter.entryPoints({ fieldDepth: 3 }).found, staticCalls(codebase.index, codebase.resolver, codebase.source), changed);
  assert.deepEqual(affected.map((ep) => ep.name).sort(), ["createPayment", "payment"]);
});

test("entry points beyond GraphQL: routes, controller filters, channels and rake tasks", () => {
  const { index } = fixture;
  const routes = index.routes.map((r) => `${r.verb} ${r.path} ${r.controller}#${r.action}${r.condition ? ` if ${r.condition}` : ""}`);
  assert.deepEqual(routes, [
    "POST /graphql graphql#execute",
    "GET /health health#check",
    "GET /up rails/health#show",
    "GET /admin/payments admin/payments#index",
    "DELETE /admin/payments/:id admin/payments#destroy",
    "POST /test/reset test_helpers#reset if Rails.env.test?",
  ]);
  assert.equal(index.methods["PaymentsChannel#recent"].visibility, "private");
  assert.equal(index.methods["rake:payments:remind"].doc, "Queue a reminder for every unpaid payment older than three days");

  const { found, skipped } = fixture.adapter.entryPoints();
  const byId = Object.fromEntries(found.map((ep) => [ep.id, ep]));
  assert.equal(byId["HealthController#check"].name, "GET /health");
  assert.equal(byId["HealthController#check"].kind, "http");
  assert.deepEqual(byId["Admin::PaymentsController#destroy"].steps, [
    { node: "init:rack_attack.rb" },
    { node: "Admin::ApplicationController#require_admin!" },
    { node: "Admin::PaymentsController#load_payment" },
    { inline: "Admin::PaymentsController#destroy" },
    { node: "Admin::PaymentsController#log_access" },
  ]);
  assert.deepEqual(byId["Admin::PaymentsController#index"].steps.map((s) => s.node || s.inline), [
    "init:rack_attack.rb",
    "Admin::ApplicationController#require_admin!",
    "Admin::PaymentsController#index",
  ]);
  assert.ok(!byId["GraphqlController#execute"], "the GraphQL route is the request step of every GraphQL entry point");
  assert.ok(skipped.some((s) => s.startsWith("POST /test/reset")), "a route to a controller the codebase lacks is listed as skipped");
  assert.ok(skipped.some((s) => s.startsWith("GET /up")));
  assert.deepEqual(byId["PaymentsChannel#refresh"].steps, [{ node: "ApplicationCable::Connection#connect" }, { inline: "PaymentsChannel#refresh" }]);
  assert.ok(byId["PaymentsChannel#subscribed"]);
  assert.ok(!byId["PaymentsChannel#recent"], "a private method is not a channel action");
  assert.equal(byId["rake:payments:remind"].name, "rake payments:remind");
});

test("entry points beyond GraphQL: a filter the adapter can't read marks that entry point", () => {
  const dir = copyFixture();
  replaceIn(dir, "app/controllers/health_controller.rb", "class HealthController < ApplicationController\n", "class HealthController < ApplicationController\n  before_action -> { head :forbidden if maintenance? }\n");
  const ep = loadCodebase(dir).adapter.entryPoints().found.find((e) => e.id === "HealthController#check");
  assert.equal(ep.unsupported[0].code, "UNSUPPORTED_FILTER_FORM");
});

test("entry points beyond GraphQL: a filter with if: or unless: is a fork on its condition", () => {
  const dir = copyFixture();
  replaceIn(dir, "app/controllers/admin/payments_controller.rb", "    after_action :log_access, except: %i[index]\n",
    "    after_action :log_access, except: %i[index]\n    skip_before_action :require_admin!, only: :index, if: -> { request.format.json? }\n    before_action :warm_cache, unless: :fresh?\n");
  const { found } = loadCodebase(dir).adapter.entryPoints();
  const index = found.find((e) => e.id === "Admin::PaymentsController#index");
  assert.deepEqual(index.unsupported, []);
  assert.deepEqual(index.steps.slice(1, 3), [
    { fork: { name: "require_admin!", when: "request.format.json?", then: [], otherwise: [{ node: "Admin::ApplicationController#require_admin!" }] } },
    { fork: { name: "warm_cache", when: "not fresh?", then: [{ external: { id: "gem:warm_cache", text: RUBY.gemStep("warm_cache"), detail: RUBY.gemDetail } }], otherwise: [] } },
  ]);
  const destroy = found.find((e) => e.id === "Admin::PaymentsController#destroy");
  assert.deepEqual(destroy.steps[1], { node: "Admin::ApplicationController#require_admin!" }, "the skip applies to index only");
});

test("entry points beyond GraphQL: an HTTP entry point with filters, a gem filter and a fork assembles", () => {
  const dir = copyFixture();
  replaceIn(dir, "app/controllers/admin/payments_controller.rb", "    after_action :log_access, except: %i[index]\n",
    "    after_action :log_access, except: %i[index]\n    before_action :verify_authenticity_token, unless: :api_request?\n");
  const codebase = loadCodebase(dir);
  const entries = codebase.adapter.entryPoints().found.filter((e) => e.id === "Admin::PaymentsController#destroy");
  const u = (id, summary, steps) => [id, { unit: codebase.resolver.unit(id), output: { summary, question: "", pass: "", steps, outcomes: [] } }];
  const units = new Map([
    u("Admin::ApplicationController#require_admin!", "Refuse anyone but an active admin", [step("No active admin: refuse with 403", [8, 8], { exits: [{ when: "Not an active admin", outcome: "FORBIDDEN" }] })]),
    u("Admin::PaymentsController#load_payment", "Load the payment to delete", [step("Find the payment by id", [19, 19], { exits: [{ when: "No such payment", outcome: "NOT_FOUND" }] })]),
    u("Admin::PaymentsController#destroy", "Delete the payment", [step("Delete the payment and answer with no content", [11, 12], { calls: ["Payment@associations"] })]),
    u("Admin::PaymentsController#log_access", "Log the admin action", [step("Write the action name to the log", [23, 23])]),
    u("init:rack_attack.rb", "Limit how often one address may call", [step("At most 100 GraphQL requests a minute from one address", [6, 8])]),
    u("Payment@associations", "What a payment belongs to and owns", [step("A payment belongs to a project", [2, 2]), step("Deleting a payment deletes its notes", [9, 9])]),
  ]);
  const { graph, problems } = assemble({ codebase: {}, adapter: codebase.adapter, entries, units, stubs: new Map(), index: codebase.index });
  assert.deepEqual(problems, []);
  assert.deepEqual(validate(graph), []);
  const [, first, second, third] = graph.entryPoints[0].steps;
  assert.equal(first, "Admin::ApplicationController#require_admin!");
  assert.equal(second, "Admin::PaymentsController#load_payment");
  assert.deepEqual(graph.nodes[third].branches.map((b) => [b.when, b.steps]), [["When not api_request?", ["gem:verify_authenticity_token"]], ["Otherwise", []]]);
});

test("config initializers: request middleware is the first step, sees the routes, and other settings get a reason", () => {
  const unit = fixture.resolver.unit("init:rack_attack.rb");
  assert.equal(unit.kind, "declarations");
  assert.equal(unit.allowExits, true);
  assert.deepEqual(unit.ranges, [[1, 9]]);
  assert.match(unit.hint, /GET \/health/, "the unit knows which paths the app serves");
  const job = fixture.adapter.entryPoints().found.find((e) => e.id === "ReminderJob");
  assert.ok(!job.steps.some((s) => s.node === "init:rack_attack.rb"), "a job passes no request middleware");

  const { codebase, change } = commitChange((dir) => replaceIn(dir, "config/initializers/money.rb", '"EUR"', '"USD"'));
  const uncovered = uncoveredChanges({ unmatched: change.hunks, ...codebase, extracted: new Set(), sourceDirs: SOURCE_DIRS });
  assert.deepEqual(uncovered.map((u) => u.reason), [RUBY.startupSetting]);
});

test("coverage: reasons for lines between steps, folded wrappers, constants, the exception table and the schema dump", () => {
  const { index, resolver, adapter, source } = fixture;
  const hunk = (file, start, end = start) => ({ file, start, end, pureAdd: false });
  const reasons = uncoveredChanges({
    unmatched: [
      hunk("app/graphql/mutations/payments/create_payment.rb", 13),
      hunk("app/services/access_policy.rb", 3),
      hunk("app/graphql/mutations/payments/create_payment.rb", 11),
      hunk("app/graphql/app_schema.rb", 3),
      hunk("db/schema.rb", 10),
    ],
    index, resolver, source, language: fixture.language, sourceDirs: SOURCE_DIRS,
    extracted: new Set(["Mutations::Payments::CreatePayment#resolve", "AccessPolicy.permitted?"]),
    folded: new Set(["AccessPolicy.permitted?"]),
    explainConstant: adapter.explainConstant,
  }).map((u) => u.reason);
  assert.deepEqual(reasons, [
    COPY.betweenSteps("Mutations::Payments::CreatePayment#resolve"),
    COPY.foldedInto("AccessPolicy.permitted?"),
    COPY.constantUnread("Mutations::Payments::CreatePayment::MAX_AMOUNT_CENTS"),
    RUBY.exceptionTable,
    RUBY.schemaDump,
  ]);
});

test("change: a mark follows only resolved calls, and Ruby or Rails basics are never matched by name", () => {
  const { codebase, change } = commitChange((dir) => replaceIn(dir, "app/services/receipt_template.rb", "Receipt #", "Payment receipt #"));
  const m = codebase.index.methods["HealthController#check"];
  const targets = codebase.resolver.callTargets({ ...m, kind: "method" }, codebase.source(m.file).slice(m.start - 1, m.end).join("\n")).map((t) => t.id);
  assert.ok(!targets.includes("ReceiptTemplate#render"), "render in a controller is Rails's render");

  const entries = codebase.adapter.entryPoints().found.filter((e) => e.id === "HealthController#check");
  const u = (id, steps) => [id, { unit: codebase.resolver.unit(id), output: { summary: "s", question: "", pass: "", steps, outcomes: [] } }];
  const units = new Map([
    u("init:rack_attack.rb", [step("Throttle GraphQL calls", [6, 8])]),
    u("HealthController#check", [step("Answer ok while the database answers", [3, 4]), step("Otherwise answer service unavailable", [5, 6])]),
  ]);
  const { graph, ranges } = assemble({ codebase: {}, adapter: codebase.adapter, entries, units, stubs: new Map(), index: codebase.index });
  const { unmatched } = markChanges(graph, ranges, change);
  markIndirect({ graph, ranges, unmatched, ...codebase });
  assert.deepEqual(Object.entries(graph.nodes).filter(([, n]) => n.change).map(([id]) => id), []);
});
