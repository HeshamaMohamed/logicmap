// Validation for decision-graph/0.1, shared by the viewer and the extractor.
// A graph with a broken reference is refused, never half-drawn.

export const FORMAT = "decision-graph/0.1";
export const OUTCOME_KINDS = ["success", "user-error", "rejected", "crash"];
export const CHANGE_KINDS = ["added", "modified", "removed"];

export function childIds(node) {
  return [...(node.steps || []), ...(node.branches || []).flatMap((b) => b.steps)];
}

export function validate(g) {
  if (!g || typeof g !== "object") return ["The graph is not a JSON object."];
  const errors = [];
  if (g.format !== FORMAT) errors.push(`format is ${JSON.stringify(g.format)}; this reader takes ${FORMAT}`);

  const nodes = g.nodes && typeof g.nodes === "object" ? g.nodes : null;
  const outcomes = g.outcomes && typeof g.outcomes === "object" ? g.outcomes : null;
  if (!nodes) errors.push("nodes is missing");
  if (!outcomes) errors.push("outcomes is missing");
  if (!nodes || !outcomes) return errors;

  for (const [code, outcome] of Object.entries(outcomes)) {
    if (!OUTCOME_KINDS.includes(outcome.kind)) {
      errors.push(`outcome ${code}: kind ${JSON.stringify(outcome.kind)} is not one of ${OUTCOME_KINDS.join(", ")}`);
    }
    if (typeof outcome.text !== "string" || !outcome.text) errors.push(`outcome ${code}: text is missing`);
  }

  const checkSteps = (where, steps) => {
    if (!Array.isArray(steps)) {
      errors.push(`${where}: steps is not a list`);
      return;
    }
    for (const id of steps) if (!(id in nodes)) errors.push(`${where}: step "${id}" names no node`);
  };

  if (g.coverage !== undefined) {
    const list = g.coverage && g.coverage.uncovered;
    if (!Array.isArray(list)) errors.push("coverage.uncovered is not a list");
    else list.forEach((u, i) => {
      if (typeof u.where !== "string" || !u.where || typeof u.reason !== "string" || !u.reason) errors.push(`coverage.uncovered ${i}: needs where and reason`);
    });
  }

  if (!Array.isArray(g.entryPoints) || g.entryPoints.length === 0) {
    errors.push("entryPoints is empty or missing");
  } else {
    const seen = new Set();
    for (const ep of g.entryPoints) {
      if (!ep.id) {
        errors.push("an entry point has no id");
        continue;
      }
      if (seen.has(ep.id)) errors.push(`entry point ${ep.id}: id used twice`);
      seen.add(ep.id);
      if (ep.id.includes("/")) errors.push(`entry point ${ep.id}: ids may not contain "/"`);
      if (typeof ep.name !== "string" || !ep.name) errors.push(`entry point ${ep.id}: name is missing`);
      checkSteps(`entry point ${ep.id}`, ep.steps);
    }
  }

  for (const [id, node] of Object.entries(nodes)) {
    if (id.includes("/") || id.startsWith("#")) errors.push(`node ${id}: ids may not contain "/" or start with "#"`);
    if (typeof node.text !== "string" || !node.text) errors.push(`node ${id}: text is missing`);
    if (node.steps !== undefined) checkSteps(`node ${id}`, node.steps);
    if (node.branches !== undefined) {
      if (!Array.isArray(node.branches)) {
        errors.push(`node ${id}: branches is not a list`);
      } else {
        node.branches.forEach((branch, i) => {
          if (typeof branch.when !== "string" || !branch.when) errors.push(`node ${id}: branch ${i} has no "when"`);
          checkSteps(`node ${id} branch ${i}`, branch.steps);
        });
      }
    }
    if (node.steps && node.branches) errors.push(`node ${id}: has both steps and branches; put the fork in its own node`);
    if (node.exits !== undefined && !Array.isArray(node.exits)) errors.push(`node ${id}: exits is not a list`);
    for (const exit of Array.isArray(node.exits) ? node.exits : []) {
      if (!(exit.outcome in outcomes)) errors.push(`node ${id}: exit outcome "${exit.outcome}" is not in outcomes`);
      if (typeof exit.when !== "string" || !exit.when) errors.push(`node ${id}: an exit has no "when"`);
      if (exit.raises !== undefined && (typeof exit.raises !== "string" || !exit.raises)) errors.push(`node ${id}: an exit's raises must be a non-empty string`);
    }
    if (node.catches !== undefined && (!Array.isArray(node.catches) || node.catches.some((c) => typeof c !== "string" || !c))) {
      errors.push(`node ${id}: catches must be a list of exception class names`);
    }
    if (node.change != null && !CHANGE_KINDS.includes(node.change)) {
      errors.push(`node ${id}: change ${JSON.stringify(node.change)} is not one of ${CHANGE_KINDS.join(", ")}`);
    }
    if (node.notes !== undefined && !Array.isArray(node.notes)) errors.push(`node ${id}: notes is not a list`);
    if (node.returns !== undefined) {
      if (!Array.isArray(node.returns)) errors.push(`node ${id}: returns is not a list`);
      else node.returns.forEach((r, i) => {
        if (typeof r.when !== "string" || !r.when) errors.push(`node ${id}: return ${i} has no "when"`);
        if (typeof r.value !== "string" || !r.value) errors.push(`node ${id}: return ${i} has no "value"`);
      });
    }
    // question and pass belong to decisions: a node that ends the flow, hands back a result, forks, or holds steps that might.
    const decides = [node.exits, node.returns, node.branches, node.steps].some((list) => Array.isArray(list) && list.length > 0);
    for (const field of ["question", "pass"]) {
      if (node[field] === undefined) continue;
      if (typeof node[field] !== "string" || !node[field].trim()) errors.push(`node ${id}: ${field} must be a non-empty string`);
      else if (!decides) errors.push(`node ${id}: has a ${field} but no exits, returns, branches or steps, so it decides nothing`);
    }
  }
  if (errors.length) return errors;

  // Cycles would make a node contain itself.
  const mark = {};
  const visit = (id, trail) => {
    if (mark[id] === "done") return;
    if (mark[id] === "active") {
      errors.push(`cycle: ${[...trail, id].join(" → ")}`);
      return;
    }
    mark[id] = "active";
    for (const child of childIds(nodes[id])) visit(child, [...trail, id]);
    mark[id] = "done";
  };
  Object.keys(nodes).forEach((id) => visit(id, []));
  if (errors.length) return errors;

  // A node no entry point reaches is dead content, most likely a typo.
  const reached = new Set();
  const reach = (id) => {
    if (reached.has(id)) return;
    reached.add(id);
    childIds(nodes[id]).forEach(reach);
  };
  g.entryPoints.forEach((ep) => ep.steps.forEach(reach));
  for (const id of Object.keys(nodes)) {
    if (!reached.has(id)) errors.push(`node ${id}: no entry point reaches it`);
  }
  return errors;
}
