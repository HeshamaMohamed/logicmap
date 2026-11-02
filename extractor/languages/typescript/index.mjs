// Indexes a TypeScript or JavaScript codebase with the TypeScript compiler API:
// every function, method and inline handler with its lines and its calls (the
// type checker resolves them where it can), try/catch ranges, module-level
// constants and the constants each function reads, type declarations, and the
// registration calls the adapters read (app.get("/x", handler)): every one at
// the top level of a file, and inside functions every one made on a framework
// instance (see `receivers` below).
//
// Ids: "<module>:<name>" for a module's functions ("src.routes.health:healthCheck"),
// "<module>:<Class>#<method>" and "<module>:<Class>.<static>" for a class,
// "<module>:<object>.<key>" for the functions of an object literal, and
// "<module>:<callee>@<line>" for a function passed inline to a registration
// call ("src.routes.orders:ordersRouter.post@13"). <module> is the file's path
// without its extension, with dots for slashes.

import { createRequire } from "node:module";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { HOME } from "../../paths.mjs";
import { coded } from "../../errors.mjs";

const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SKIP_FILE = /(\.d\.[cm]?ts|\.(test|spec|stories)\.[cm]?[jt]sx?)$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "coverage", "__tests__", "__mocks__", "test", "tests", "e2e"]);

// The TypeScript compiler the framework installs (package.json), or LOGICMAP_TYPESCRIPT.
let loaded;
export function loadTypescript() {
  if (loaded) return loaded;
  const remedy = `Run \`npm install\` in ${HOME} (it installs the TypeScript parser), or set LOGICMAP_TYPESCRIPT to the folder of a TypeScript 5 or 6 package.`;
  let ts;
  try {
    ts = createRequire(join(HOME, "package.json"))(process.env.LOGICMAP_TYPESCRIPT || "typescript");
  } catch (e) {
    throw coded("TYPESCRIPT_MISSING", `no TypeScript compiler could be loaded: ${e.message.split("\n")[0]}`, remedy);
  }
  if (typeof ts.createProgram !== "function") {
    throw coded("TYPESCRIPT_MISSING", `TypeScript ${ts.version} has no JavaScript compiler API`, remedy);
  }
  loaded = ts;
  return ts;
}

export function sourceFiles(root, paths) {
  const out = new Set();
  const walk = (abs) => {
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      return;
    }
    if (stat.isFile()) {
      const rel = relative(root, abs).split("\\").join("/");
      if (SOURCE.test(rel) && !SKIP_FILE.test(rel)) out.add(rel);
      return;
    }
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.isDirectory() && (e.name.startsWith(".") || SKIP_DIRS.has(e.name))) continue;
      walk(join(abs, e.name));
    }
  };
  for (const p of paths) walk(p === "." ? root : join(root, p));
  return [...out].sort();
}

export const moduleOf = (rel) => rel.replace(SOURCE, "").split("/").join(".");

function compilerOptions(ts, root) {
  const base = {
    allowJs: true, checkJs: false, noEmit: true, skipLibCheck: true, types: [],
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve, esModuleInterop: true,
  };
  const file = join(root, "tsconfig.json");
  if (!existsSync(file)) return base;
  const read = ts.readConfigFile(file, ts.sys.readFile);
  if (read.error) return base;
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
  return { ...parsed.options, allowJs: true, checkJs: false, noEmit: true, skipLibCheck: true, types: [] };
}

// receivers: what makes a call inside a function a registration, from the
// adapters: { init: [RegExp] } for the factory call that makes an instance
// (express(), Fastify()), { paramType: [RegExp] } for a parameter typed as one
// (FastifyInstance), and { plugin: [method] } for the methods whose function
// argument receives the instance as its first parameter (register).
export function indexTypescript({ root, paths, receivers = { init: [], paramType: [], plugin: [] } }) {
  const ts = loadTypescript();
  const files = sourceFiles(root, paths);
  const program = ts.createProgram(files.map((f) => join(root, f)), compilerOptions(ts, root));
  const checker = program.getTypeChecker();

  const methods = {};
  const modules = {};
  const constantDefs = [];
  const registrations = [];
  const units = [];
  const unitByDecl = new Map();
  const ctorByClass = new Map();
  const constByDecl = new Map();
  const exportedDecls = new Set();
  const unitIds = new Map();
  const handoffs = [];
  const receiverIds = new Set();
  const recorded = new Set();
  let queue = null;

  const isFunction = (n) => n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n));
  const literalish = (n) => n && (ts.isStringLiteral(n) || ts.isNumericLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)
    || ts.isObjectLiteralExpression(n) || ts.isArrayLiteralExpression(n) || ts.isPrefixUnaryExpression(n)
    || n.kind === ts.SyntaxKind.TrueKeyword || n.kind === ts.SyntaxKind.FalseKeyword || n.kind === ts.SyntaxKind.NullKeyword
    || ((ts.isAsExpression(n) || ts.isSatisfiesExpression?.(n) || ts.isParenthesizedExpression(n)) && literalish(n.expression)));
  const resolve = (node) => {
    let sym = checker.getSymbolAtLocation(node);
    if (sym && sym.flags & ts.SymbolFlags.Alias) {
      try {
        sym = checker.getAliasedSymbol(sym);
      } catch {
        return null;
      }
    }
    return sym;
  };
  const flat = (n) => n.getText(n.getSourceFile()).replace(/\s+/g, "");
  const moduleOfFile = (file) => moduleOf(relative(root, file.fileName).split("\\").join("/"));

  // A unit once per function node. Units made while bodies are scanned join the scan.
  function makeUnit(u, sf, rel) {
    if (unitByDecl.has(u.fn)) return unitByDecl.get(u.fn);
    const line = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
    let id = u.id;
    for (let k = 2; unitIds.has(id); k++) id = `${u.id}.${k}`;
    const unit = { ...u, id, file: rel, sf, start: line(u.fn.getStart(sf)), end: line(u.fn.end) };
    units.push(unit);
    unitIds.set(id, unit);
    unitByDecl.set(u.fn, id);
    if (u.decl) unitByDecl.set(u.decl, id);
    if (queue) queue.push(unit);
    return id;
  }

  // The instance a registration is made on: a variable, or a unit's parameter.
  // `known` says it is a framework instance by its factory call, its type, or a hand-off.
  function receiverOf(node) {
    if (!ts.isIdentifier(node)) return null;
    const d = (resolve(node)?.declarations || [])[0];
    if (d && ts.isVariableDeclaration(d) && ts.isIdentifier(d.name)) {
      const id = `${moduleOfFile(d.getSourceFile())}:${d.name.text}`;
      const init = d.initializer ? flat(d.initializer).replace(/^await/, "").slice(0, 80) : null;
      return { id, init, known: receiverIds.has(id) || receivers.init.some((re) => re.test(init || "")) };
    }
    if (d && ts.isParameter(d) && unitByDecl.has(d.parent)) {
      const id = `${unitByDecl.get(d.parent)}(${d.parent.parameters.indexOf(d)})`;
      const type = d.type ? flat(d.type) : null;
      return { id, type, known: receiverIds.has(id) || receivers.paramType.some((re) => re.test(type || "")) };
    }
    return null;
  }

  // The codebase function a call runs, or null.
  function calledUnit(call) {
    const callee = call.expression;
    const nameNode = ts.isIdentifier(callee) ? callee : ts.isPropertyAccessExpression(callee) ? callee.name : null;
    if (!nameNode || !ts.isIdentifier(nameNode)) return null;
    return (resolve(nameNode)?.declarations || []).map((d) => unitByDecl.get(d)).find(Boolean) || null;
  }

  const markReceiver = (id) => {
    if (receiverIds.has(id)) return;
    receiverIds.add(id);
    // A unit scanned before it was known to receive an instance is scanned again.
    const unit = unitIds.get(id.replace(/\(\d+\)$/, ""));
    if (unit && queue && unit.scanned) {
      unit.scanned = false;
      queue.push(unit);
    }
  };

  // A call on an instance, such as app.get("/x", handler): its function
  // arguments, also inside an options object or a list, become units, and the
  // call is recorded for the adapters. At the top level of a file every such
  // call counts; inside a function, only one on a known instance.
  function registrationAt(call, sf, rel, topLevel) {
    if (recorded.has(call)) return;
    const mod = moduleOf(rel);
    const line = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
    const callee = flat(call.expression);
    const calleeId = callee.replace(/[^\w.$]/g, "_");
    const onInstance = ts.isPropertyAccessExpression(call.expression);
    const receiver = onInstance ? receiverOf(call.expression.expression) : null;
    if (!topLevel && !receiver?.known) return;
    recorded.add(call);
    const inline = (fn, key, docNode) => makeUnit({ id: `${mod}:${calleeId}@${line(fn.getStart(sf))}`, name: `${callee} ${key}`, owner: mod, fn, decl: null, docNode, exported: false, visibility: "public", kind: "inline" }, sf, rel);
    for (const a of call.arguments) {
      if (isFunction(a)) inline(a, "handler", call);
      else if (ts.isArrayLiteralExpression(a)) a.elements.filter(isFunction).forEach((fn) => inline(fn, "handler", call));
      else if (ts.isObjectLiteralExpression(a)) {
        for (const p of a.properties) {
          const key = p.name?.getText(sf) || "handler";
          if (ts.isMethodDeclaration(p)) inline(p, key, p);
          else if (ts.isPropertyAssignment(p) && isFunction(p.initializer)) inline(p.initializer, key, p);
          else if (ts.isPropertyAssignment(p) && ts.isArrayLiteralExpression(p.initializer)) p.initializer.elements.filter(isFunction).forEach((fn) => inline(fn, key, p));
        }
      }
    }
    if (!onInstance) return;
    registrations.push({ call, sf, rel });
    // A plugin: the function it registers receives the instance as its first parameter.
    if (receivers.plugin.includes(call.expression.name.text) && call.arguments[0]) {
      const plugin = unitByDecl.get(call.arguments[0]) || (ts.isIdentifier(call.arguments[0]) ? (resolve(call.arguments[0])?.declarations || []).map((d) => unitByDecl.get(d)).find(Boolean) : null);
      if (plugin) markReceiver(`${plugin}(0)`);
    }
  }

  for (const rel of files) {
    const sf = program.getSourceFile(join(root, rel));
    if (!sf) continue;
    const mod = moduleOf(rel);
    const line = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
    const firstLine = (n) => n.getText(sf).split("\n")[0].slice(0, 160);
    modules[mod] = { kind: "module", file: rel, declarations: [] };

    const moduleSymbol = checker.getSymbolAtLocation(sf);
    for (let exp of moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : []) {
      if (exp.flags & ts.SymbolFlags.Alias) {
        try {
          exp = checker.getAliasedSymbol(exp);
        } catch {
          continue;
        }
      }
      (exp.declarations || []).forEach((d) => exportedDecls.add(d));
    }

    const addUnit = (u) => makeUnit(u, sf, rel);
    const exported = (...nodes) => nodes.some((n) => n && exportedDecls.has(n));

    for (const stmt of sf.statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.body) {
        const name = stmt.name?.text || "default";
        addUnit({ id: `${mod}:${name}`, name, owner: mod, fn: stmt, decl: stmt, docNode: stmt, exported: exported(stmt) || Boolean(stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)), visibility: "public", kind: "function" });
      } else if (ts.isClassDeclaration(stmt) && stmt.name) {
        const owner = `${mod}:${stmt.name.text}`;
        const heritage = stmt.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.getText(sf);
        modules[owner] = { kind: "class", file: rel, superclass: heritage || null, declarations: [] };
        const classExported = exported(stmt);
        for (const member of stmt.members) {
          const flags = ts.getCombinedModifierFlags(member);
          const singleton = Boolean(flags & ts.ModifierFlags.Static);
          const visibility = flags & ts.ModifierFlags.Private || (member.name && ts.isPrivateIdentifier(member.name)) ? "private" : flags & ts.ModifierFlags.Protected ? "protected" : "public";
          const fn = ts.isConstructorDeclaration(member) || ts.isMethodDeclaration(member) || ts.isGetAccessor(member) || ts.isSetAccessor(member) ? member
            : ts.isPropertyDeclaration(member) && isFunction(member.initializer) ? member.initializer : null;
          const name = ts.isConstructorDeclaration(member) ? "constructor" : member.name?.getText(sf);
          if (fn && (fn.body || isFunction(fn))) {
            const id = addUnit({ id: `${owner}${singleton ? "." : "#"}${name}`, name, owner, fn, decl: member, docNode: member, exported: classExported && visibility === "public", visibility, singleton, kind: "method" });
            if (ts.isConstructorDeclaration(member)) ctorByClass.set(stmt, id);
          } else if (ts.isPropertyDeclaration(member)) {
            modules[owner].declarations.push({ name: "property", file: rel, start: line(member.getStart(sf)), end: line(member.end), source: firstLine(member) });
          }
        }
      } else if (ts.isVariableStatement(stmt)) {
        const isConst = Boolean(stmt.declarationList.flags & ts.NodeFlags.Const);
        for (const d of stmt.declarationList.declarations) {
          if (!ts.isIdentifier(d.name)) continue;
          const name = d.name.text;
          const init = d.initializer;
          if (isFunction(init)) {
            addUnit({ id: `${mod}:${name}`, name, owner: mod, fn: init, decl: d, docNode: stmt, exported: exported(d), visibility: "public", kind: "function" });
          } else if (init && ts.isObjectLiteralExpression(init) && init.properties.some((p) => ts.isMethodDeclaration(p) || (ts.isPropertyAssignment(p) && isFunction(p.initializer)))) {
            for (const p of init.properties) {
              const fn = ts.isMethodDeclaration(p) ? p : ts.isPropertyAssignment(p) && isFunction(p.initializer) ? p.initializer : null;
              if (fn) addUnit({ id: `${mod}:${name}.${p.name.getText(sf)}`, name: p.name.getText(sf), owner: `${mod}:${name}`, fn, decl: p, docNode: p, exported: exported(d), visibility: "public", kind: "function" });
            }
          } else if (init && ts.isCallExpression(init) && init.arguments.some(isFunction)) {
            // A wrapped function: export const handler = withAuth(async (req) => ...).
            addUnit({ id: `${mod}:${name}`, name, owner: mod, fn: init.arguments.find(isFunction), decl: d, docNode: stmt, exported: exported(d), visibility: "public", kind: "function" });
          } else if (isConst && literalish(init)) {
            const def = { owner: mod, name, file: rel, start: line(stmt.getStart(sf)), end: line(stmt.end) };
            constantDefs.push(def);
            constByDecl.set(d, `${mod}:${name}`);
            modules[mod].declarations.push({ name: "const", file: rel, start: def.start, end: def.end, source: firstLine(stmt) });
          }
        }
      } else if (ts.isExportAssignment(stmt)) {
        const e = stmt.expression;
        const fn = isFunction(e) ? e : ts.isCallExpression(e) ? e.arguments.find(isFunction) : null;
        if (fn) addUnit({ id: `${mod}:default`, name: "default", owner: mod, fn, decl: stmt, docNode: stmt, exported: true, visibility: "public", kind: "function" });
      } else if (ts.isTypeAliasDeclaration(stmt) || ts.isInterfaceDeclaration(stmt) || ts.isEnumDeclaration(stmt)) {
        const kind = ts.isEnumDeclaration(stmt) ? "enum" : ts.isInterfaceDeclaration(stmt) ? "interface" : "type";
        modules[mod].declarations.push({ name: kind, file: rel, start: line(stmt.getStart(sf)), end: line(stmt.end), source: firstLine(stmt) });
      } else if (ts.isExpressionStatement(stmt) && ts.isCallExpression(stmt.expression)) {
        registrationAt(stmt.expression, sf, rel, true);
      } else if (ts.isExpressionStatement(stmt) && ts.isBinaryExpression(stmt.expression) && stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        // CommonJS: module.exports = function ..., exports.name = (...) => ...
        const left = stmt.expression.left.getText(sf);
        const right = stmt.expression.right;
        const m = left.match(/^(?:module\.)?exports(?:\.(\w+))?$/);
        if (m && isFunction(right)) addUnit({ id: `${mod}:${m[1] || "default"}`, name: m[1] || "default", owner: mod, fn: right, decl: stmt.expression, docNode: stmt, exported: true, visibility: "public", kind: "function" });
      }
    }
  }

  // Every unit's body, for registrations on known instances and for hand-offs:
  // a codebase function called with an instance receives it as that parameter.
  queue = [...units];
  while (queue.length) {
    const u = queue.shift();
    if (u.scanned) continue;
    u.scanned = true;
    const visit = (n) => {
      if (n !== u.fn && unitByDecl.has(n) && unitIds.get(unitByDecl.get(n))?.fn === n) return;
      if (ts.isCallExpression(n)) {
        if (ts.isPropertyAccessExpression(n.expression)) registrationAt(n, u.sf, u.file, false);
        const target = calledUnit(n);
        if (target) {
          n.arguments.forEach((a, i) => {
            const r = receiverOf(a);
            if (!r?.known) return;
            const to = `${target}(${i})`;
            if (!handoffs.some((h) => h.from === r.id && h.to === to)) handoffs.push({ from: r.id, to });
            markReceiver(to);
          });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(u.fn);
  }
  queue = null;

  // Calls, constant reads and try/catch ranges of each unit's own code.
  const unitNodes = new Set(units.map((u) => u.fn));
  for (const u of units) {
    const { sf } = u;
    const line = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
    const calls = [];
    const consts = [];
    const rescues = [];
    const visit = (n) => {
      if (n !== u.fn && unitNodes.has(n)) return;
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        const callee = n.expression;
        const nameNode = ts.isIdentifier(callee) ? callee : ts.isPropertyAccessExpression(callee) ? callee.name : null;
        if (nameNode && ts.isIdentifier(nameNode)) {
          const sym = resolve(nameNode);
          let target = null;
          for (const d of sym?.declarations || []) {
            target = unitByDecl.get(d) || (ts.isNewExpression(n) && ts.isClassDeclaration(d) ? ctorByClass.get(d) : null) || null;
            if (target) break;
          }
          calls.push({
            name: nameNode.text,
            line: line(n.getStart(sf)),
            receiver: ts.isPropertyAccessExpression(callee) ? callee.expression.getText(sf).replace(/\s+/g, " ").slice(0, 80) : null,
            targets: target && target !== u.id ? [target] : [],
            resolved: Boolean(sym),
          });
        }
      }
      if (ts.isIdentifier(n) && !(n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) {
        const sym = resolve(n);
        const id = (sym?.declarations || []).map((d) => constByDecl.get(d)).find(Boolean);
        const at = line(n.getStart(sf));
        if (id && !consts.some((c) => c.id === id && c.line === at)) consts.push({ name: n.text, line: at, id });
      }
      if (ts.isTryStatement(n) && n.catchClause) {
        rescues.push({ exceptions: ["*"], protects: [line(n.tryBlock.getStart(sf)), line(n.tryBlock.end)] });
      }
      ts.forEachChild(n, visit);
    };
    visit(u.fn);
    methods[u.id] = {
      id: u.id, name: u.name, owner: u.owner, file: u.file, start: u.start, end: u.end, doc: docOf(u.docNode, sf, ts),
      kind: u.kind, visibility: u.visibility, exported: u.exported, singleton: Boolean(u.singleton), params: u.fn.parameters?.length ?? 0,
      calls, consts, rescues,
    };
  }

  return {
    root,
    files_read: files,
    methods,
    modules,
    constant_defs: constantDefs,
    registrations: registrations.map(registrationRecord).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
    handoffs,
  };

  // A recorded call as data: the instance it is made on, and each argument as
  // a string, a codebase function, a variable, a call to library code, an
  // options object or a list.
  function registrationRecord({ call, sf, rel }) {
    const line = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
    const arg = (a) => {
      if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) return { kind: "string", value: a.text };
      const own = unitByDecl.get(a);
      if (own) return { kind: "unit", id: own };
      if (ts.isArrayLiteralExpression(a)) return { kind: "array", items: a.elements.map(arg) };
      if (ts.isObjectLiteralExpression(a)) {
        const props = {};
        for (const p of a.properties) {
          if (ts.isPropertyAssignment(p)) props[p.name.getText(sf)] = arg(p.initializer);
          else if (ts.isShorthandPropertyAssignment(p)) props[p.name.text] = arg(p.name);
          else if (ts.isMethodDeclaration(p)) props[p.name.getText(sf)] = { kind: "unit", id: unitByDecl.get(p) };
        }
        return { kind: "object", props };
      }
      if (ts.isIdentifier(a) || ts.isPropertyAccessExpression(a)) {
        const nameNode = ts.isPropertyAccessExpression(a) ? a.name : a;
        const unit = (resolve(nameNode)?.declarations || []).map((d) => unitByDecl.get(d)).find(Boolean);
        if (unit) return { kind: "unit", id: unit };
        const v = receiverOf(nameNode);
        if (v) return { kind: "var", id: v.id, init: v.init ?? null };
      }
      if (ts.isCallExpression(a)) return { kind: "call", text: a.getText(sf).replace(/\s+/g, " ").slice(0, 80) };
      return { kind: "other", text: a.getText(sf).replace(/\s+/g, " ").slice(0, 80) };
    };
    const target = call.expression;
    const receiver = receiverOf(target.expression);
    return {
      file: rel,
      module: moduleOf(rel),
      line: line(call.getStart(sf)),
      method: target.name.text,
      receiver: { text: flat(target.expression), ...(receiver ? { id: receiver.id, init: receiver.init ?? null, type: receiver.type ?? null } : {}) },
      args: call.arguments.map(arg),
    };
  }
}

// The comment just above a statement or member: JSDoc or line comments.
function docOf(n, sf, ts) {
  const ranges = ts.getLeadingCommentRanges(sf.text, n.pos) || [];
  const text = ranges.map((r) => sf.text.slice(r.pos, r.end)).join("\n")
    .replace(/^\s*\/\*\*?|\*\/\s*$/gm, "").replace(/^\s*(\*|\/\/)\s?/gm, "").replace(/\s+/g, " ").trim();
  return text || null;
}
