// Indexes a TypeScript or JavaScript codebase with the TypeScript compiler API:
// every function, method and inline handler with its lines and its calls (the
// type checker resolves them where it can), try/catch ranges, module-level
// constants and the constants each function reads, type declarations, and the
// top-level registration calls (app.get("/x", handler)) the adapters read.
//
// Ids: "<module>:<name>" for a module's functions ("src.routes.health:healthCheck"),
// "<module>:<Class>#<method>" and "<module>:<Class>.<static>" for a class,
// "<module>:<object>.<key>" for the functions of an object literal, and
// "<module>:<callee>@<line>" for a function passed inline to a top-level call
// ("src.routes.orders:ordersRouter.post@13"). <module> is the file's path
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

export function indexTypescript({ root, paths }) {
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

    const addUnit = (u) => {
      let id = u.id;
      for (let k = 2; methods[id] || units.some((x) => x.id === id); k++) id = `${u.id}.${k}`;
      const unit = { ...u, id, file: rel, sf, start: line(u.fn.getStart(sf)), end: line(u.fn.end) };
      units.push(unit);
      unitByDecl.set(u.fn, id);
      if (u.decl) unitByDecl.set(u.decl, id);
      return id;
    };
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
        // A top-level call such as app.get("/x", handler): its function arguments are units.
        const call = stmt.expression;
        const callee = call.expression.getText(sf).replace(/\s+/g, "");
        const calleeId = callee.replace(/[^\w.$]/g, "_");
        call.arguments.forEach((a) => {
          if (isFunction(a)) addUnit({ id: `${mod}:${calleeId}@${line(a.getStart(sf))}`, name: `${callee} handler`, owner: mod, fn: a, decl: null, docNode: stmt, exported: false, visibility: "public", kind: "inline" });
        });
        if (ts.isPropertyAccessExpression(call.expression)) registrations.push({ stmt: call, sf, mod, rel });
      } else if (ts.isExpressionStatement(stmt) && ts.isBinaryExpression(stmt.expression) && stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        // CommonJS: module.exports = function ..., exports.name = (...) => ...
        const left = stmt.expression.left.getText(sf);
        const right = stmt.expression.right;
        const m = left.match(/^(?:module\.)?exports(?:\.(\w+))?$/);
        if (m && isFunction(right)) addUnit({ id: `${mod}:${m[1] || "default"}`, name: m[1] || "default", owner: mod, fn: right, decl: stmt.expression, docNode: stmt, exported: true, visibility: "public", kind: "function" });
      }
    }
  }

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
    registrations: registrations.map((r) => registration(ts, checker, r, unitByDecl, resolve)),
  };
}

// The comment just above a statement or member: JSDoc or line comments.
function docOf(n, sf, ts) {
  const ranges = ts.getLeadingCommentRanges(sf.text, n.pos) || [];
  const text = ranges.map((r) => sf.text.slice(r.pos, r.end)).join("\n")
    .replace(/^\s*\/\*\*?|\*\/\s*$/gm, "").replace(/^\s*(\*|\/\/)\s?/gm, "").replace(/\s+/g, " ").trim();
  return text || null;
}

// A top-level call on a variable (app.get, router.use): the variable it is
// made on, and each argument as a string, a codebase function, a variable, or
// a call to library code.
function registration(ts, checker, { stmt, sf, mod, rel }, unitByDecl, resolve) {
  const line = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const variable = (node) => {
    const sym = resolve(node);
    const d = (sym?.declarations || []).find((x) => ts.isVariableDeclaration(x) && ts.isIdentifier(x.name));
    if (!d) return null;
    const file = d.getSourceFile();
    return { id: `${moduleOf(relativeTo(file.fileName, sf.fileName, rel))}:${d.name.text}`, init: d.initializer ? d.initializer.getText(file).replace(/\s+/g, "").slice(0, 80) : null };
  };
  const arg = (a) => {
    if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) return { kind: "string", value: a.text };
    const own = unitByDecl.get(a);
    if (own) return { kind: "unit", id: own };
    if (ts.isIdentifier(a) || ts.isPropertyAccessExpression(a)) {
      const sym = resolve(ts.isPropertyAccessExpression(a) ? a.name : a);
      const unit = (sym?.declarations || []).map((d) => unitByDecl.get(d)).find(Boolean);
      if (unit) return { kind: "unit", id: unit };
      const v = variable(ts.isPropertyAccessExpression(a) ? a.name : a);
      if (v) return { kind: "var", ...v };
    }
    if (ts.isCallExpression(a)) return { kind: "call", text: a.getText(sf).replace(/\s+/g, " ").slice(0, 80) };
    return { kind: "other", text: a.getText(sf).replace(/\s+/g, " ").slice(0, 80) };
  };
  const target = stmt.expression;
  return {
    file: rel,
    module: mod,
    line: line(stmt.getStart(sf)),
    method: target.name.text,
    receiver: { text: target.expression.getText(sf).replace(/\s+/g, ""), ...(variable(target.expression) || {}) },
    args: stmt.arguments.map(arg),
  };
}

// The path of another source file, relative to the codebase root.
function relativeTo(fileName, currentFileName, currentRel) {
  const root = currentFileName.slice(0, currentFileName.length - currentRel.length);
  return fileName.startsWith(root) ? fileName.slice(root.length) : fileName;
}
