// Plain Ruby: a gem, a CLI or a service with no framework the other adapters
// know. Its entry points are its public methods, or the ones the codebase's
// `.logicmap.json` names in entryPoints.

import { methodPattern } from "../../../config.mjs";
import { COPY } from "../copy.mjs";

export const NAME = "ruby";

export function detect(index) {
  return Object.keys(index.methods).length > 0;
}

export function createAdapter({ index, config }) {
  const patterns = config.entryPoints.map(methodPattern);
  const skip = config.skipCalls.map((p) => new RegExp(p));
  return {
    name: NAME,
    seedOutcomes: { ERROR_RAISED: { kind: "rejected", text: COPY.errorRaised } },
    context: [
      "Framework: plain Ruby. An entry point is a public method. It ends by returning a value (a success outcome you name) or by raising an exception that escapes to its caller (an exit: ERROR_RAISED, or a code you name after the exception).",
      ...config.context,
    ].join("\n"),
    hints: {},
    explainConstant: () => null,
    skipTarget: (id) => skip.some((re) => re.test(id)),
    entryPoints() {
      const found = Object.values(index.methods)
        .filter((m) => m.visibility === "public" && m.owner !== "rake" && m.owner !== "Object")
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
