# Evolve loop

A **gap** is a case the framework does not support yet: a coded error, a changed line the graph leaves out, or a node that misstates its code. Each pass through this loop ends with the gap supported and a test guarding it; this is how the framework grows. It grows for every Ruby codebase.

Work in the framework repo, `ROOT`. Every agent-facing text you write or edit (prompts, remedies, skills, `AGENTS.md`) follows `ROOT/vendor/writing-for-agents/SKILL.md`. Every reader text (anything the diagram shows) follows `vendor/asd-ste100/SKILL.md` and `vendor/humanizer/SKILL.md` in this skill.

## Steps

1. **Record.** Read `last-run.json` in the cache folder (`$LOGICMAP_CACHE`, else `~/.cache/logicmap`): `error`, `failures`, `problems`, `coverage`. Find the gap's record in `ROOT/gaps/` by code and what happens, or create one (format below). Everyone who uses the framework reads its gap records, so write each one in Ruby, Rails and fixture terms; the classes, files, commits and features of the codebase where the gap showed up stay out of it. Done when the record names the code and what happens, with `status: open`.
2. **Red.** Reproduce the gap at its smallest in the fixture of the same shape: `ROOT/tests/fixtures/graphql-standard/` (graphql-ruby by its own conventions), `rails-graphql/` (a codebase with its own GraphQL conventions), or `plain-ruby/`; a new kind of codebase gets its own fixture folder. Guard it:
   - in the deterministic layers (index, resolver, adapter, assembly, change, format) with a test in `ROOT/tests/*.test.mjs`;
   - in what Claude states about a unit with a case in `ROOT/evals/cases/`; a new kind of check goes into `CHECKS` in `evals/run.mjs`.

   Done when `npm test`, or `npm run eval -- <case>`, goes red on exactly this gap, and the record's `example:` names the fixture lines that show it.
3. **Support.** Decide whose gap it is. A convention many codebases of a language share (the language itself, a framework such as Rails or graphql-ruby, a common library) is framework support: change the layer that owns it (table below), and name no one codebase's classes there. A convention only one codebase has (its own DSL, helpers or layout) goes in that codebase's `.logicmap.json`; when no key can say it, add the key to `extractor/config.mjs` and `README.md`. A construct that stays unsupported after the change still ends in a coded error: add its code to `extractor/errors.mjs`, with a remedy that points here.
4. **Green.** Done when `npm test` and `npm run eval` pass, and the original command (`argv` in the gap's last-run.json) completes or stops at a different gap; that one starts its own pass at step 1.
5. **Close.** Set the record to `status: supported`, naming what changed and the test that guards it.

## Layers

| The gap is in | Change |
|---|---|
| Ruby syntax or a construct the index reads wrongly or skips | `extractor/languages/ruby/index.rb` |
| A call, ancestor or model declaration left unresolved | `extractor/languages/ruby/resolve.mjs` |
| Entry points, guards, filters, outcome codes or framework context of one kind of codebase | `extractor/languages/<language>/adapters/<kind>.mjs`; plain Rails (routes, filters, channels, jobs, rake, middleware) is `rails.mjs`, which `rails-graphql.mjs` builds on |
| Routes, rake tasks, visibility or rescue ranges read wrongly | `extractor/languages/ruby/index.rb` (`RoutesReader` for routes) |
| A changed line given the wrong reason in `coverage` | the pack's `coverage.mjs`, or `uncoveredChanges` in `extractor/affected.mjs` for a rule every language shares |
| A new kind of codebase in a language that has a pack | a new adapter, listed in the pack's `adapters` (`extractor/languages/<language>/pack.mjs`) before its plain fallback |
| A new language | a new pack in `extractor/languages/<language>/` that meets `contract.mjs`, listed in `extractor/languages/index.mjs`, with its own fixture (`CONTRIBUTING.md`) |
| A setting one codebase needs that no key of `.logicmap.json` holds | `extractor/config.mjs` (`KEYS`), or the pack's `configKeys` when only that language needs it, and the config table in `README.md` |
| What Claude states about a unit, or how | `extractor/prompt.mjs`, with `PROMPT_VERSION` bumped |
| An answer shape the framework must refuse | `checkUnit` in `extractor/extract.mjs` |
| A new field in the graph | `lib/validate.mjs`, `extractor/assemble.mjs`, `viewer/viewer.js`, and the format in `README.md` |
| Reader text: fixed wording, or a tell the checks miss | `viewer/copy.mjs`, `extractor/copy.mjs`, the pack's `copy.mjs`, `extractor/text-lint.mjs` |
| Which entry points a change reaches, or what counts as covered | `extractor/affected.mjs`, `extractor/change.mjs` |

## Gap records

One file per gap, `gaps/<slug>.md`:

```markdown
---
code: <error code | COVERAGE for changed lines the graph leaves out | MISSTATED for a node that misstates its code>
status: open | supported
example: tests/fixtures/<shape> <path>:<line>
---
What happens, in a sentence or two, and what a reviewer misses because of it.

Support: what changed and the test that guards it; while open, the plan.
```
