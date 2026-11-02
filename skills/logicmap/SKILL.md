---
name: logicmap
description: Decision graph of a Ruby, TypeScript or JavaScript codebase, drawn as an expandable diagram. Use to review a PR, branch or commit by the decisions it changes, or to explain how a feature (an endpoint, a GraphQL operation, a job, a method) decides what it does.
---

# logicmap

Turns code into a **decision graph**: entry points at the top, decisions as diamonds, outcomes at the ends, every node traced to its lines. It reads a codebase through its language and framework: Ruby (Rails with graphql-ruby, plain Rails, plain Ruby), and TypeScript or JavaScript (Express, plain modules). The framework sits two folders above this file, symlinks resolved:

```bash
ROOT="$(cd "<this skill's base directory>" && pwd -P)/../.."
```

The CLI is `"$ROOT/bin/logicmap"`; `--help` lists its options. Every run writes `last-run.json` in the cache folder (`$LOGICMAP_CACHE`, else `~/.cache/logicmap`) with the status, the error code, the plan, the graph path and the coverage: read it after each run. Every text on the diagram is **reader text**, checked against the vendored asd-ste100 and humanizer rules before a graph is written.

A codebase's own conventions (its own guard DSL or result helpers, where its code lives, the entry points of a plain Ruby codebase) live in `.logicmap.json` at its root. `$ROOT/README.md` lists the keys.

## Steps

1. **Plan.** Find the target codebase's root (the folder with its `Gemfile`, `*.gemspec`, `package.json` or `tsconfig.json`) and plan the run the request asks for:
   - PR: `gh pr view N --json baseRefName,headRefName`, `git fetch origin <base> <head>`, then `--repo <root> --base origin/<base> --head origin/<head> --plan`.
   - Commit: `--repo <root> --change SHA --plan`.
   - Feature: `--repo <root> --list`, then `--entries a,b --plan` with the entry points that carry the feature. Any method works as an entry point too: `Class#method` or `Class.method`.

   Done when the plan exits 0 and the user has seen the entry points it will extract. Confirm the list with the user when it holds more than 12, or when choosing a feature's entry points took judgement.
2. **Extract.** Rerun the planned command without `--plan`, with `--entries` when the user narrowed the list. A new unit costs about $0.05; a cached unit is free. Done when it prints `Wrote` and last-run.json says `"status": "ok"`. A run that ends in `error[CODE]`:
   - `BAD_ARGUMENT`, `UNKNOWN_ENTRY`, `NOT_A_COMMIT`, `TOO_MANY_AFFECTED`, `NO_ENTRIES`: the command needs changing; follow the printed remedy and rerun.
   - `PRISM_MISSING`, `TYPESCRIPT_MISSING`, `PYTHON_MISSING`: the machine needs a tool; the remedy names it.
   - `CONFIG_INVALID`: the codebase's `.logicmap.json` needs fixing; the message names the key.
   - `UNSUPPORTED_LANGUAGE`: no language pack reads this codebase yet. Tell the user which languages have a pack (the message lists them), and stop.
   - `CLAUDE_FAILED`: rerun once, then hand a second failure to the user.
   - Every other code is a **gap**: run [EVOLVE.md](EVOLVE.md), then rerun this step.
3. **Show.** Start `"$ROOT/bin/logicmap" view` in the background when nothing serves port 8765, and open the `View:` URL the run printed. A link to one decision appends `&focus=<node id>` after `#ep=<entry point>`.
4. **Report.** From last-run.json and the graph file, tell the user:
   - each changed node (`changedNodes`): its text, the entry points that reach it, and what the change now decides there;
   - the notes inside the flows the change touches;
   - each `coverage.uncovered` hunk: changed lines the graph leaves out, to review in the diff.

   Write the report as **reader text**: STE-flavored mode of [vendor/asd-ste100/SKILL.md](vendor/asd-ste100/SKILL.md), then the embedded mode of [vendor/humanizer/SKILL.md](vendor/humanizer/SKILL.md). Done when every changed node and every uncovered hunk is in the report, and `python3 vendor/asd-ste100/scripts/ste-lint.py` on its prose reports no hard finding.
5. **Evolve.** After the report, each uncovered hunk in code the index reads, and each node the user finds misstating its code, is a **gap**: run [EVOLVE.md](EVOLVE.md) for each, one at a time. Done when every gap is supported, or recorded `open` with the reason it waits.
