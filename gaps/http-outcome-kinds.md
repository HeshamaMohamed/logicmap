---
code: OUTCOME_CONFLICT
status: supported
example: tests/fixtures/typescript-fastify src/server.ts:46
---
A TypeScript HTTP app's graph fails to assemble. The adapter asks for outcomes named after the HTTP status, but each unit picks the kind on its own. One unit gives BAD_REQUEST the kind user-error, and another gives it the kind rejected.

Support: extractor/languages/typescript/adapters/http.mjs defines the HTTP status outcomes once, each with one kind and one text, and the Express and Fastify adapters seed them, the way the Rails adapters seed theirs. Claude reuses them, and checkUnit refuses an answer that gives one a different kind. Guarded by "http outcomes: ..." in tests/fastify.test.mjs.
