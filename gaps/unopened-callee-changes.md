---
code: COVERAGE
status: supported
example: tests/fixtures/rails-graphql app/models/project.rb:14-16
---
A change inside a method the graph does not open (a one-liner its caller's step already states) is listed as "no extracted entry point reaches it", though a drawn step calls it, so the changed decision shows unmarked.

Support: markIndirect marks the most specific drawn step whose call reaches a changed, unopened method, directly or through up to four unopened methods. Guarded by "change: a change inside a method the graph does not open marks the step that calls it" (a two-hop chain) in tests/framework.test.mjs.
