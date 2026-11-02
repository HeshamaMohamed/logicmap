// The adapters on codebases written the standard way, without one codebase's own conventions.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { HOME, loadCodebase } from "../extractor/load.mjs";

const standard = loadCodebase(join(HOME, "tests", "fixtures", "graphql-standard"));
const plain = loadCodebase(join(HOME, "tests", "fixtures", "plain-ruby"));

test("graphql-ruby by its own conventions: root type fields, resolvers, inline query fields", () => {
  assert.equal(standard.adapter.name, "rails-graphql");
  const { found } = standard.adapter.entryPoints();
  const byId = Object.fromEntries(found.map((ep) => [ep.id, ep]));
  assert.deepEqual(found.filter((ep) => ep.kind.startsWith("graphql")).map((ep) => `${ep.kind} ${ep.id}`), [
    "graphql-mutation placeOrder",
    "graphql-query order",
    "graphql-query orders",
  ]);
  assert.deepEqual(byId.placeOrder.steps.map((s) => s.node || s.inline || (s.fields && "fields")), [
    "GraphqlController#execute",
    "Mutations::PlaceOrder@interface",
    "Mutations::PlaceOrder#authorized?",
    "Mutations::PlaceOrder#resolve",
    "fields",
  ]);
  assert.equal(byId.order.method, "Types::QueryType#order");
  assert.deepEqual(byId.order.steps.map((s) => s.node || s.inline || (s.fields && "fields")), [
    "GraphqlController#execute",
    "Types::QueryType@field:order",
    "Types::QueryType#order",
    "fields",
  ]);
  assert.deepEqual(standard.resolver.unit("Types::QueryType@field:order").ranges, [[3, 5]]);
  assert.equal(byId.orders.method, "Resolvers::Orders#resolve");
});

test("graphql-ruby by its own conventions: rescue_from maps exceptions to outcomes", () => {
  const seeds = standard.adapter.seedOutcomes;
  assert.equal(seeds.RECORD_NOT_FOUND.kind, "rejected");
  assert.equal(seeds.INVALID_RECORD.kind, "rejected", "a literal extensions code names the outcome");
  assert.equal(seeds.INTERNAL_SERVER_ERROR.kind, "crash");
  assert.match(standard.adapter.context, /ActiveRecord::RecordNotFound → RECORD_NOT_FOUND/);
  assert.doesNotMatch(standard.adapter.context, /success\(\.\.\.\)/, "result helpers are a codebase convention, not the framework's");
});

test("plain Ruby: every public method is an entry point, private helpers are not", () => {
  assert.equal(plain.adapter.name, "ruby");
  const ids = plain.adapter.entryPoints().found.map((ep) => ep.id);
  for (const id of ["Tally.run", "Tally::Counter#add", "Tally::Counter#initialize"]) assert.ok(ids.includes(id), id);
  assert.ok(!ids.includes("Tally::Counter#capped"));
  assert.ok(plain.adapter.entryPoints().found.every((ep) => ep.kind === "method"));
});

test("config: a codebase's own conventions, and loud refusal of anything the file can't mean", async () => {
  const { mkdtempSync, cpSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "logicmap-config-"));
  cpSync(join(HOME, "tests", "fixtures", "plain-ruby"), dir, { recursive: true });
  writeFileSync(join(dir, ".logicmap.json"), JSON.stringify({
    sourcePaths: ["lib"], entryPoints: ["Tally.*"], skipCalls: ["#capped$"], context: ["Amounts are whole units."],
  }));
  const { adapter, config } = loadCodebase(dir);
  assert.deepEqual(adapter.entryPoints().found.map((ep) => ep.id), ["Tally.run"]);
  assert.ok(adapter.skipTarget("Tally::Counter#capped"));
  assert.match(adapter.context, /Amounts are whole units\./);
  assert.equal(config.file, join(dir, ".logicmap.json"));

  writeFileSync(join(dir, ".logicmap.json"), JSON.stringify({ entrypoints: ["Tally.*"] }));
  assert.throws(() => loadCodebase(dir), (e) => e.code === "CONFIG_INVALID" && /unknown key "entrypoints"/.test(e.message));
});

test("cli: any method works as an entry point by its id", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const cache = mkdtempSync(join(tmpdir(), "logicmap-cache-"));
  const run = spawnSync("node", [join(HOME, "extractor", "cli.mjs"), "--repo", join(HOME, "tests", "fixtures", "graphql-standard"), "--entries", "Order#total_cents,placeOrder", "--plan"], { env: { ...process.env, LOGICMAP_CACHE: cache } });
  const report = JSON.parse(readFileSync(join(cache, "last-run.json"), "utf8"));
  assert.equal(run.status, 1, "Order#total_cents is not a method of the fixture");
  assert.equal(report.error.code, "UNKNOWN_ENTRY");
  const ok = spawnSync("node", [join(HOME, "extractor", "cli.mjs"), "--repo", join(HOME, "tests", "fixtures", "graphql-standard"), "--entries", "Types::OrderType#total,placeOrder", "--plan"], { env: { ...process.env, LOGICMAP_CACHE: cache } });
  assert.equal(ok.status, 0, ok.stderr.toString());
  assert.deepEqual(JSON.parse(readFileSync(join(cache, "last-run.json"), "utf8")).plan.entries, ["Types::OrderType#total", "placeOrder"]);
});

test("graphql-ruby: the request step is the routed action that runs the schema, not a channel that also runs it", async () => {
  const { mkdtempSync, cpSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "logicmap-channel-"));
  cpSync(join(HOME, "tests", "fixtures", "graphql-standard"), dir, { recursive: true });
  mkdirSync(join(dir, "app", "channels"), { recursive: true });
  writeFileSync(join(dir, "app", "channels", "graphql_channel.rb"), "class GraphqlChannel < ApplicationCable::Channel\n  def execute(data)\n    transmit(ShopSchema.execute(data[\"query\"]))\n  end\nend\n");
  const { adapter } = loadCodebase(dir);
  const order = adapter.entryPoints().found.find((ep) => ep.id === "order");
  assert.ok(order.steps.some((s) => s.node === "GraphqlController#execute"));
  assert.ok(!order.steps.some((s) => s.node === "GraphqlChannel#execute"));
});

test("view: serves the viewer from the framework and graphs from the cache", async () => {
  const { serve } = await import("../extractor/view.mjs");
  const { GRAPHS } = await import("../extractor/paths.mjs");
  const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  mkdirSync(GRAPHS, { recursive: true });
  const file = join(GRAPHS, "view-test.json");
  writeFileSync(file, "{\"ok\":true}");
  const server = await serve(18765);
  try {
    const page = await fetch("http://127.0.0.1:18765/viewer/");
    assert.equal(page.status, 200);
    assert.match(await page.text(), /viewer\.js/);
    assert.deepEqual(await (await fetch("http://127.0.0.1:18765/graphs/view-test.json")).json(), { ok: true });
    assert.equal((await fetch("http://127.0.0.1:18765/extractor/cli.mjs")).status, 404, "only the viewer, lib and graphs are served");
  } finally {
    server.close();
    rmSync(file);
  }
});

test("adapters: two entry points with one id are both marked, and the rest still extract", async () => {
  const { mkdtempSync, cpSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "logicmap-dup-"));
  cpSync(join(HOME, "tests", "fixtures", "graphql-standard"), dir, { recursive: true });
  writeFileSync(join(dir, "app", "graphql", "resolvers", "order.rb"), "module Resolvers\n  class Order < GraphQL::Schema::Resolver\n    def resolve\n      nil\n    end\n  end\nend\n");
  const found = loadCodebase(dir).adapter.entryPoints().found;
  const orders = found.filter((ep) => ep.id === "order");
  assert.equal(orders.length, 2);
  assert.ok(orders.every((ep) => ep.unsupported.some((u) => u.code === "DUPLICATE_ENTRY_POINT")));
  assert.deepEqual(found.find((ep) => ep.id === "placeOrder").unsupported, []);
});

test("view: with no graph named, the viewer lists the graphs in the cache", async () => {
  const { serve } = await import("../extractor/view.mjs");
  const server = await serve(18766);
  try {
    const names = await (await fetch("http://127.0.0.1:18766/graphs/")).json();
    assert.ok(Array.isArray(names));
  } finally {
    server.close();
  }
});
