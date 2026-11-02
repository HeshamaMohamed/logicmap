---
code: UNSUPPORTED_CODEBASE
status: supported
example: tests/fixtures/typescript-fastify src/server.ts:12
---
A Fastify app gets the plain adapter, so its exported functions become the entry points. The function that builds the server is then one entry point, and its whole body is one unit. No route, hook or error handler shows, so a reviewer cannot see what one request decides.

Support: the TypeScript index records registration calls inside functions when they are made on a framework instance: a variable made by the adapter's factory call (Fastify()), a parameter typed as one (FastifyInstance), a parameter the instance is handed to (registerRoutes(app)), or the first parameter of a plugin passed to register. Their inline functions become units, so the function that builds the server no longer holds the routes. The fastify adapter reads routes (get, post, route({...})), hooks in lifecycle order, route-level hooks, plugins with their prefix and the parent's hooks, and puts the error handler's code in the context. Guarded by tests/fastify.test.mjs and the fastify-error-handler eval.
