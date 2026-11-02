// What a language pack gives the core, and what its index must hold. The core
// (cli, load, extract, assemble, affected) reads a codebase only through this.
// A pack is extractor/languages/<name>/pack.mjs, listed in ./index.mjs:
//
//   name                 the language id the graph records ("ruby")
//   label                its name in reader text and prompts ("Ruby")
//   detect(root)         2 for a project file of this language at the root, 1 for its source
//                        files below the root, 0 for neither; the highest score wins, ties by order
//   defaults             .logicmap.json defaults, at least { sourcePaths }
//   configKeys           extra .logicmap.json keys, each { doc, default } (a list of strings)
//   treePaths(config)    the paths to check out when the code under review is a commit
//   index({ root, cwd, paths })   the index (below); cwd is where to run the language's tools
//   createResolver(index)         { unit(id), callTargets(method, sourceText), declarationUnits,
//                                   readsConstant(method, def), constantId(def) }
//   adapters             entry-point adapters, tried in order: { NAME, detect(index, resolver),
//                        createAdapter({ index, resolver, source, config }) }
//   prompt               { branchPoints, exceptionExample, exceptionName (a RegExp) }
//   coverage             { isSource(file), fileReason(file), lineReason({ hunk, lines, unitIds }),
//                          bodyReason({ hunk, index }) }: why a changed line has no node
//
// The index:
//   files_read           the paths the index parsed
//   methods              { id: { id, name, owner, file, start, end, doc?, rescues?, consts? } }
//                        rescues: [{ exceptions, protects: [first, last] }]; consts: [{ name, line }]
//   modules              { name: { declarations?: [{ name, file, start, end, source }] } }
//   constant_defs        [{ owner, name, file, start, end }]

const FUNCTIONS = ["detect", "treePaths", "index", "createResolver"];
const COVERAGE = ["isSource", "fileReason", "lineReason", "bodyReason"];
const strings = (v) => Array.isArray(v) && v.every((s) => typeof s === "string");
const line = (v) => Number.isInteger(v) && v > 0;

// The problems that keep a pack from meeting the contract; [] when it does.
export function checkPack(pack) {
  const problems = [];
  if (!/^[a-z][a-z0-9-]*$/.test(pack?.name || "")) problems.push("name must be a lowercase id");
  if (typeof pack?.label !== "string" || !pack.label) problems.push("label must be a string");
  for (const f of FUNCTIONS) if (typeof pack?.[f] !== "function") problems.push(`${f} must be a function`);
  if (!strings(pack?.defaults?.sourcePaths)) problems.push("defaults.sourcePaths must be a list of strings");
  for (const [key, spec] of Object.entries(pack?.configKeys || {})) {
    if (typeof spec?.doc !== "string" || !strings(spec?.default)) problems.push(`configKeys.${key} must be { doc, default: [strings] }`);
  }
  if (!Array.isArray(pack?.adapters) || !pack.adapters.length) problems.push("adapters must be a non-empty list");
  for (const a of pack?.adapters || []) {
    if (typeof a.NAME !== "string" || typeof a.detect !== "function" || typeof a.createAdapter !== "function") problems.push(`adapter ${a.NAME || "?"} must have NAME, detect and createAdapter`);
  }
  for (const k of ["branchPoints", "exceptionExample"]) if (typeof pack?.prompt?.[k] !== "string") problems.push(`prompt.${k} must be a string`);
  if (!(pack?.prompt?.exceptionName instanceof RegExp)) problems.push("prompt.exceptionName must be a RegExp");
  for (const f of COVERAGE) if (typeof pack?.coverage?.[f] !== "function") problems.push(`coverage.${f} must be a function`);
  return problems;
}

// The problems that keep an index from meeting the contract, at most `limit` of them.
export function checkIndex(index, limit = 5) {
  const problems = [];
  const add = (p) => problems.length < limit && problems.push(p);
  if (!strings(index?.files_read)) add("files_read must be a list of paths");
  if (!index?.methods || typeof index.methods !== "object") add("methods must be an object");
  for (const [id, m] of Object.entries(index?.methods || {})) {
    if (m.id !== id) add(`methods[${id}].id is ${JSON.stringify(m.id)}`);
    for (const k of ["name", "owner", "file"]) if (typeof m[k] !== "string") add(`methods[${id}].${k} must be a string`);
    if (!line(m.start) || !line(m.end) || m.end < m.start) add(`methods[${id}] needs lines start <= end`);
    if (m.doc != null && typeof m.doc !== "string") add(`methods[${id}].doc must be a string`);
    for (const r of m.rescues || []) if (!Array.isArray(r.protects) || r.protects.length !== 2) add(`methods[${id}].rescues needs protects [first, last]`);
    for (const c of m.consts || []) if (typeof c.name !== "string" || !line(c.line)) add(`methods[${id}].consts needs { name, line }`);
  }
  if (!index?.modules || typeof index.modules !== "object") add("modules must be an object");
  for (const [name, mod] of Object.entries(index?.modules || {})) {
    if (mod.declarations !== undefined && !Array.isArray(mod.declarations)) add(`modules[${name}].declarations must be a list`);
  }
  if (!Array.isArray(index?.constant_defs)) add("constant_defs must be a list");
  for (const c of index?.constant_defs || []) {
    if (typeof c.owner !== "string" || typeof c.name !== "string" || typeof c.file !== "string" || !line(c.start) || !line(c.end)) add(`constant_defs entry ${JSON.stringify(c).slice(0, 80)} needs owner, name, file, start, end`);
  }
  return problems;
}
