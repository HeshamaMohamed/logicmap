// One headless Claude Code call with a JSON schema. It runs on the user's
// existing Claude Code login, with no tools: everything the model needs is in
// the prompt.

import { spawn } from "node:child_process";

export function runClaude({ system, prompt, schema, model, effort, cwd, timeoutMs = 600_000 }) {
  const args = [
    "-p",
    "--output-format", "json",
    "--json-schema", JSON.stringify(schema),
    "--system-prompt", system,
    "--tools", "",
    "--disallowedTools", "mcp__*",
    "--model", model,
    "--effort", effort,
    "--no-session-persistence",
    "--setting-sources", "",
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.CLAUDE_BIN || "claude", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`claude did not finish within ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`could not start claude: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exited with ${code}: ${(err || out).trim().slice(0, 600)}`));
      let parsed;
      try {
        parsed = JSON.parse(out);
      } catch {
        return reject(new Error(`claude printed something other than JSON: ${out.slice(0, 300)}`));
      }
      const result = Array.isArray(parsed) ? parsed.findLast((e) => e.type === "result") : parsed;
      if (!result) return reject(new Error("claude returned no result event"));
      if (result.is_error || result.subtype !== "success") {
        return reject(new Error(`claude returned ${result.subtype}: ${String(result.result).slice(0, 300)}`));
      }
      if (!result.structured_output) return reject(new Error("claude returned no structured output"));
      resolve({ output: result.structured_output, cost: result.total_cost_usd || 0 });
    });
    child.stdin.end(prompt);
  });
}
