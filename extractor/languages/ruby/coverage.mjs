// Why a changed Ruby line has no node in the graph: files that hold no
// decisions, comment-only edits, startup settings, and class-body code outside
// methods. affected.mjs asks these in order, between its own checks.

import { COPY } from "./copy.mjs";

const STRUCTURE = new Set(["include", "extend", "prepend", "private", "protected", "public", "module_function", "private_constant"]);

export const coverage = {
  isSource: (file) => /\.(rb|rake)$/.test(file),

  // Before the index is consulted: whole files that hold no decisions of a request.
  fileReason(file) {
    if (/^(spec|test)\//.test(file)) return COPY.testCode;
    if (/^config\/locales\//.test(file)) return COPY.translations;
    if (/^db\/migrate\//.test(file)) return COPY.migration;
    if (/^db\/(schema\.rb|structure\.sql)$/.test(file)) return COPY.schemaDump;
    return null;
  },

  // An indexed file: the hunk's own lines, and the units it lies in.
  lineReason({ hunk, lines, unitIds }) {
    if (/^config\/initializers\//.test(hunk.file) && !unitIds.length) return COPY.startupSetting;
    if (lines.length && lines.every((l) => /^\s*(#.*)?$/.test(l))) return COPY.onlyComments;
    return null;
  },

  // A hunk in no unit and no constant: the class-body declarations it touches.
  bodyReason({ hunk, index }) {
    const decls = Object.values(index.modules).flatMap((m) => m.declarations).filter((d) => d.file === hunk.file && d.start <= hunk.end && d.end >= hunk.start);
    const names = [...new Set(decls.map((d) => d.name))];
    if (names.length && names.every((n) => STRUCTURE.has(n))) return COPY.structure;
    return names.length ? COPY.classBody(names.join(", ")) : COPY.classBodyCode;
  },
};
