// TypeScript and JavaScript: the TypeScript compiler API indexes the code
// (index.mjs) and its type checker resolves the calls; adapters read Express
// and Fastify apps and plain modules. The contract is ../contract.mjs.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { indexTypescript } from "./index.mjs";
import { createResolver } from "./resolve.mjs";
import { coverage } from "./coverage.mjs";
import * as express from "./adapters/express.mjs";
import * as fastify from "./adapters/fastify.mjs";
import * as plain from "./adapters/plain.mjs";

const ADAPTERS = [express, fastify, plain];
// What makes a call inside a function a registration: every adapter's instances.
const RECEIVERS = Object.fromEntries(["init", "paramType", "plugin"].map((k) => [k, ADAPTERS.flatMap((a) => a.RECEIVERS?.[k] || [])]));

const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "coverage", "vendor"]);
const MAX_DEPTH = 6;

// 2 for a tsconfig.json, jsconfig.json or package.json at the root, 1 for a
// source file in the folders below it, 0 for neither.
function detect(root) {
  if (["tsconfig.json", "jsconfig.json", "package.json"].some((f) => existsSync(join(root, f)))) return 2;
  return holdsSource(root, 0) ? 1 : 0;
}

function holdsSource(dir, depth) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  if (entries.some((e) => e.isFile() && SOURCE.test(e.name) && !/\.d\.[cm]?ts$/.test(e.name))) return true;
  if (depth >= MAX_DEPTH) return false;
  return entries.some((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name) && holdsSource(join(dir, e.name), depth + 1));
}

export default {
  name: "typescript",
  label: "TypeScript or JavaScript",
  detect,
  defaults: { sourcePaths: ["."] },
  configKeys: {},
  treePaths: (config) => (config.sourcePaths.includes(".") ? ["."] : [...config.sourcePaths, "package.json", "tsconfig.json"]),
  index: ({ root, paths }) => indexTypescript({ root, paths, receivers: RECEIVERS }),
  createResolver,
  adapters: ADAPTERS,
  prompt: {
    branchPoints: "if, else, switch, ternary, && and || that skip work, ?? fallback, optional chaining that skips a call, try/catch, throw, early return, an awaited call that can reject",
    exceptionExample: "ValidationError",
    exceptionName: /^([A-Za-z_$][\w$]*\.)*[A-Z][\w$]*$/,
  },
  coverage,
};
