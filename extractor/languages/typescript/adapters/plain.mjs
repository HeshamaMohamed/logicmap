// Plain TypeScript or JavaScript: a library, a CLI or a service with no
// framework the other adapters know. Its entry points are its exported
// functions and the public methods of its exported classes, or the ones the
// codebase's `.logicmap.json` names in entryPoints.

import { methodPattern } from "../../../config.mjs";
import { COPY } from "../copy.mjs";

export const NAME = "plain";

export function detect(index) {
  return Object.keys(index.methods).length > 0;
}

export function createAdapter({ index, config }) {
  const patterns = config.entryPoints.map(methodPattern);
  const skip = config.skipCalls.map((p) => new RegExp(p));
  return {
    name: NAME,
    seedOutcomes: { ERROR_THROWN: { kind: "rejected", text: COPY.errorThrown } },
    context: [
      "Framework: none, a plain TypeScript or JavaScript module. An entry point is an exported function or a public method of an exported class. It ends by returning a value (a success outcome you name) or by throwing an error that escapes to its caller (an exit: ERROR_THROWN, or a code you name after the error class). A returned promise that rejects ends the same way as a throw.",
      ...config.context,
    ].join("\n"),
    hints: {},
    explainConstant: () => null,
    skipTarget: (id) => skip.some((re) => re.test(id)),
    entryPoints() {
      const found = Object.values(index.methods)
        .filter((m) => m.exported && m.kind !== "inline" && m.visibility === "public")
        .filter((m) => !patterns.length || patterns.some((re) => re.test(m.id)))
        .map((m) => ({
          id: m.id, kind: "method", name: m.id, className: m.owner, method: m.id,
          trigger: `${m.file}:${m.start}`, summary: m.doc || undefined, steps: [{ inline: m.id }], unsupported: [],
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
      return { found, skipped: [] };
    },
  };
}
