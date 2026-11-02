---
code: UNSUPPORTED_CODEBASE
status: supported
example: tests/fixtures/graphql-standard app/graphql/shop_schema.rb:1
---
The framework knew one codebase's conventions, not graphql-ruby's: a GraphQL app without the first codebase's exception table failed outright, mutations and queries were found only under that codebase's base class names, inline query fields were never entry points, and plain Ruby got no entry points at all.

Support: the rails-graphql adapter reads graphql-ruby's own conventions (a GraphQL::Schema class, the routed action that runs it, root type fields with mutation: and resolver:, inline query fields, ready? and authorized?, rescue_from), with a codebase's own exception table as an option. A plain Ruby fallback adapter makes public methods the entry points, and any Class#method works as one. A codebase's own conventions live in its .logicmap.json. Guarded by tests/adapters.test.mjs against the graphql-standard and plain-ruby fixtures.
