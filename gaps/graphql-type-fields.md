---
code: COVERAGE
status: supported
example: tests/fixtures/rails-graphql app/graphql/types/objects/project_type.rb:7
---
graphql-ruby calls an object type's field methods by field name, so no static call reaches them and their decisions stay out of every graph. A change to a type is listed as uncovered instead of drawn.

Support: the rails-graphql adapter reads the type a query declares (`type`) or a mutation returns (`result_field`), then each `field` of that type whose method is in the codebase (by name, `method:`, `resolver_method:` or `resolver:`), down to `--field-depth` levels of nested types (default 1). They become one "Resolve the fields the client asks for" step at the end of the operation. A change to a field method reaches every operation that returns its type, through up to three levels. Guarded by the two "type fields: …" tests in tests/framework.test.mjs.
