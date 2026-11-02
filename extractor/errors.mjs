// Every unsupported input or undefined state ends the run with one of these:
// a machine-matchable code, a message naming the operation, the subject and
// the condition, and a remedy. The codes are the keys of gaps/ records.

export class ExtractError extends Error {
  constructor(code, message, remedy, subject) {
    super(message);
    this.code = code;
    this.remedy = remedy;
    this.subject = subject;
  }
}

export const CODES = {
  BAD_ARGUMENT: "a command-line argument is missing or malformed",
  CONFIG_INVALID: "the codebase's .logicmap.json is not valid",
  NOT_A_COMMIT: "a --base, --head or --change ref is not a commit",
  INDEX_FAILED: "a language pack's indexer could not run or parse the code, or its index breaks the contract",
  PRISM_MISSING: "no Ruby with the prism parser was found",
  PYTHON_MISSING: "python3, which runs the STE linter, was not found",
  UNSUPPORTED_LANGUAGE: "no language pack recognises the codebase",
  PACK_INVALID: "a language pack does not meet extractor/languages/contract.mjs",
  UNSUPPORTED_CODEBASE: "no adapter recognises the codebase",
  UNSUPPORTED_GUARD_FORM: "a guard declaration has a form the adapter does not read",
  UNSUPPORTED_FILTER_FORM: "a controller filter has a form the adapter does not read",
  AMBIGUOUS_GUARD: "a guard name matches zero or several methods",
  DUPLICATE_ENTRY_POINT: "two entry points share a name",
  SPLIT_DECLARATIONS: "a model's validations or callbacks span several files",
  UNKNOWN_ENTRY: "--entries names an entry point that does not exist",
  NO_ENTRIES: "the run has no entry points to extract",
  TOO_MANY_AFFECTED: "the change reaches more entry points than --max-entries",
  UNIT_REJECTED: "Claude's answer for a unit failed its checks on every attempt",
  CLAUDE_FAILED: "the headless Claude call itself failed",
  OUTCOME_CONFLICT: "two units declare one outcome code with different kinds",
  GRAPH_INVALID: "the assembled graph fails lib/validate.mjs",
  INTERNAL: "an exception with no code: a bug in the framework itself",
};

export function coded(code, message, remedy, subject) {
  if (!CODES[code]) throw new Error(`errors.mjs: unknown error code ${code}; add it to CODES`);
  return new ExtractError(code, message, remedy, subject);
}
