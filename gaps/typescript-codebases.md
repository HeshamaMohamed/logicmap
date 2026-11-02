---
code: UNSUPPORTED_LANGUAGE
status: supported
example: tests/fixtures/typescript-express src/app.ts:7
---
A TypeScript or JavaScript codebase got no graph. The framework parsed only Ruby, so an Express API or a plain JavaScript library stopped before its first entry point.

Support: the TypeScript pack (extractor/languages/typescript/) parses TypeScript and JavaScript with the TypeScript compiler API, whose type checker resolves calls through imports and path aliases. The express adapter reads routes, mounted routers and middleware from top-level registration calls; the plain adapter makes exported functions and public methods the entry points. A try/catch is a catch-all ("*") in the rollup. Guarded by tests/typescript.test.mjs, tests/languages.test.mjs, and the express-async-rethrow and javascript-thrown-error evals.
