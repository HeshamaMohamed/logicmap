# Contributing

## How the framework grows

Every case it can't handle yet is a **gap**: a coded error (`error[CODE]: …` plus a remedy), a changed line the graph leaves out, or a diagram node that gets the code wrong. Gaps are recorded in `gaps/`, one file each, and closed through the evolve loop in `skills/logicmap/EVOLVE.md`: reproduce the gap in the fixture app, add a failing test or eval, change the layer that owns it, get everything green, and mark the record supported. An agent running the skill follows the same loop on its own, so the list in `gaps/` is also the roadmap.

`npm test` checks the deterministic layers against `tests/fixtures/rails-graphql` in a few seconds. `npm run eval` asks Claude about fixture units and checks the answers; it costs a few cents and is free to rerun until the prompt changes.

## Languages and codebases

The core in `extractor/` names no language. Each language is a **pack** in `extractor/languages/<language>/`, and the core reads a codebase only through the pack contract in `extractor/languages/contract.mjs`. Ruby is the first pack. It reads Rails with graphql-ruby, plain Rails and plain Ruby, each through its own conventions.

Nothing in the framework names one codebase's classes. What only one codebase does (a custom guard DSL, its own result helpers, an unusual folder layout) goes in that codebase's `.logicmap.json`. `examples/rails-graphql.logicmap.json` is a sample. The fixtures under `tests/fixtures/` keep each shape tested.

### Adding a language

1. Create `extractor/languages/<language>/pack.mjs`. The comment at the top of `contract.mjs` lists every field, and `extractor/languages/ruby/pack.mjs` is a complete example.
2. Write the index in any language you like, as long as it prints the index shape that `contract.mjs` describes. `npm test` checks every pack and every fixture index against the contract.
3. Write at least one adapter. An adapter finds the entry points and gives Claude the framework context.
4. Put the pack's reader text in its own `copy.mjs`. `npm test` lints it with the rest.
5. List the pack in `extractor/languages/index.mjs`.
6. Add a fixture under `tests/fixtures/`, tests for the pack's deterministic parts, and eval cases for what Claude states about its units.

## Writing for readers

Everything a person reads on the diagram is written in Simplified Technical English and checked for AI writing habits. The two guides are vendored unmodified in `skills/logicmap/vendor/`: asd-ste100 (with its linter) and humanizer. The fixed wording sits in `viewer/copy.mjs`, `extractor/copy.mjs` and each language pack's `copy.mjs`, and `npm test` lints all of it. Claude's wording is linted per method during extraction; an answer that fails goes back to Claude with the reasons. Add new wording to a copy module, not inline in the code.

## Writing for agents

Part of this repo is written for agents rather than people: `AGENTS.md`, the skill under `skills/`, the extractor's prompts, and error remedies. All of it follows Matt Pocock's writing-for-agents guide, vendored unmodified in `vendor/writing-for-agents/` so every contributor and every agent has the same copy. `AGENTS.md` holds the rule; read the guide before you change any of those files.
