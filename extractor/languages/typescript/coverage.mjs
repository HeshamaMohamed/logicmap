// Why a changed TypeScript or JavaScript line has no node in the graph: files
// that hold no decisions, comment-only and import-only edits, and module code
// outside functions. affected.mjs asks these in order, between its own checks.

import { COPY } from "./copy.mjs";

const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const COMMENT = /^\s*(\/\/.*|\/\*.*|\*.*|.*\*\/\s*)?$/;
const IMPORT = /^\s*(import\s|export\s+(\*|\{[^}]*\})\s+from\s|\}\s+from\s+["'])/;
const TYPES = new Set(["type", "interface", "enum"]);

export const coverage = {
  isSource: (file) => SOURCE.test(file) && !/\.d\.[cm]?ts$/.test(file),

  // Before the index is consulted: whole files that hold no decisions of a request.
  fileReason(file) {
    if (/(^|\/)(__tests__|__mocks__|tests?|e2e)\//.test(file) || /\.(test|spec|stories)\.[cm]?[jt]sx?$/.test(file)) return COPY.testCode;
    if (/(^|\/)(locales?|i18n|translations)\//.test(file)) return COPY.translations;
    if (/(^|\/)migrations?\//.test(file)) return COPY.migration;
    if (/(^|\/)schema\.prisma$/.test(file)) return COPY.schemaFile;
    if (/(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/.test(file)) return COPY.lockfile;
    if (/\.d\.[cm]?ts$/.test(file)) return COPY.typesOnly;
    if (/(^|\/)(dist|build|out|\.next)\//.test(file)) return COPY.generated;
    return null;
  },

  // An indexed file: the hunk's own lines, and the units it lies in.
  lineReason({ lines, unitIds }) {
    if (lines.length && lines.every((l) => COMMENT.test(l))) return COPY.onlyComments;
    if (!unitIds.length && lines.length && lines.every((l) => !l.trim() || IMPORT.test(l))) return COPY.imports;
    return null;
  },

  // A hunk in no function and no constant: the module-level declarations it touches.
  bodyReason({ hunk, index }) {
    const decls = Object.values(index.modules).flatMap((m) => m.declarations).filter((d) => d.file === hunk.file && d.start <= hunk.end && d.end >= hunk.start);
    if (decls.length && decls.every((d) => TYPES.has(d.name))) return COPY.typesOnly;
    return COPY.moduleCode;
  },
};
