// Every text the Ruby pack writes for a reader, linted with the core's
// (tests/copy.test.mjs). Written to the vendored asd-ste100 and humanizer rules.

export const COPY = {
  validationErrors: "The form has errors",
  invalidArguments: "The arguments are not valid",
  unauthorized: "The caller may not run this operation",
  executionError: "The operation refused the request",
  errorRaised: "An error goes back to the caller",
  classBody: (names) => `In a class-body declaration that holds no decision the graph draws: ${names}.`,
  onlyComments: "Only comments or blank lines changed.",
  structure: "Changes which modules the class includes, or which methods are private.",
  testCode: "Test code. It does not run in production.",
  translations: "Translation text. It changes wording, not decisions.",
  migration: "A database migration. It changes the schema, not the decisions of a request.",
  startupSetting: "A startup setting outside the request middleware. The graph does not draw it.",
  exceptionTable: "Changes the table that maps errors to outcome codes.",
  schemaDump: "The database schema dump. It records the schema, not the decisions of a request.",
  classBodyCode: "Code in a class body, outside methods and declarations.",
  fieldsText: "Resolve the fields the client asks for",
  fieldsDetail: "Each field runs only when the request asks for it.",
  gemStep: (name) => `Runs ${name}, which a gem defines`,
  gemDetail: "The graph does not read gem code.",
};
