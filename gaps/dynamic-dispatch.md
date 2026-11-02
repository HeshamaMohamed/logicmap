---
code: COVERAGE
status: supported
example: tests/fixtures/rails-graphql app/graphql/concerns/session_checks.rb:7, app/services/payment_notifier.rb:7
---
Calls through send, public_send, define_method or a Concern's `included` block are matched by method name only, and names shared by more than six methods are dropped, so a decision behind such a call can be missing from the graph and from the affected entry points.

Support: index.rb records includes inside conditionals of a class body or `included` block, methods made by define_method with a literal name, and send, public_send or __send__ with a literal name as a call to that name. resolve.mjs picks the class a receiver names ("@project" → Project) before matching by name alone. Guarded by "dynamic dispatch: conditional includes, define_method, send with a literal name, receiver names" in tests/framework.test.mjs. A name built at runtime (public_send(status)) stays unresolved: no static reading can know it.
