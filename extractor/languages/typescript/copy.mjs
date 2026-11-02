// Every text the TypeScript pack writes for a reader, linted with the core's
// (tests/copy.test.mjs). Written to the vendored asd-ste100 and humanizer rules.

export const COPY = {
  errorThrown: "An error goes back to the caller",
  serverError: "Server error",
  badRequest: "The request is not valid",
  unprocessable: "The request data is not valid",
  tooLarge: "The request is too large",
  unauthorized: "The caller is not signed in",
  paymentRequired: "A payment is required",
  forbidden: "The caller may not do this",
  notFound: "Not found",
  conflict: "The request conflicts with the stored data",
  tooManyRequests: "Too many requests",
  libraryStep: (name) => `Runs ${name}, which a library defines`,
  libraryDetail: "The graph does not read library code.",
  testCode: "Test code. It does not run in production.",
  translations: "Translation text. It changes wording, not decisions.",
  migration: "A database migration. It changes the schema, not the decisions of a request.",
  schemaFile: "The database schema. It records the schema, not the decisions of a request.",
  lockfile: "A dependency lock file. It records library versions and holds no decision.",
  generated: "A generated or built file. Its source holds the decisions.",
  typesOnly: "Type declarations. They decide nothing at run time.",
  imports: "Changes which modules the file imports.",
  onlyComments: "Only comments or blank lines changed.",
  moduleCode: "Module code outside functions.",
};
