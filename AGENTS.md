# logicmap

Turns a codebase into a decision graph: `extractor/` writes it (a core, plus one language pack per language in `extractor/languages/`), `viewer/` draws it, `lib/validate.mjs` defines what a valid graph is, and `skills/logicmap/` runs it for PRs and features.

## Rules

- **Agent-facing text follows writing-for-agents.** Read `vendor/writing-for-agents/SKILL.md` before writing or editing any text an agent reads: this file, `skills/**`, the prompts and hints in `extractor/prompt.mjs` and in each language pack, and error remedies.
- **Reader text follows asd-ste100 and humanizer.** Every text a person reads, on the diagram or in the skill's report, follows `skills/logicmap/vendor/asd-ste100/SKILL.md` and `skills/logicmap/vendor/humanizer/SKILL.md`. Fixed wording lives in `viewer/copy.mjs`, `extractor/copy.mjs` and each pack's `copy.mjs`, and `npm test` lints it; `extractor/text-lint.mjs` lints Claude's wording in every unit.
- **The core names no language; a pack names no codebase.** What a language means (its parser, call lookup, frameworks, file rules, wording) lives in its pack, which meets `extractor/languages/contract.mjs`. A convention of one codebase goes in that codebase's own `.logicmap.json` (`examples/` holds a sample), never in framework code, tests or gap records. Fixtures cover the shapes: `tests/fixtures/graphql-standard`, `rails-graphql`, `plain-ruby`.
- **Fail loud.** An unsupported input or an undefined state raises a coded error from `extractor/errors.mjs`: a code, a message naming the operation, subject and condition, and a remedy.
- **New support goes through the evolve loop**, `skills/logicmap/EVOLVE.md`: a gap record, a red test or eval, the change, green.
- **A prompt change** bumps `PROMPT_VERSION` in `extractor/prompt.mjs` and ends with `npm run eval` green. Evals call Claude: a few cents a case, free when the prompt is unchanged.
